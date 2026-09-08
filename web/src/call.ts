import {
  Room, RoomEvent, ConnectionState, DisconnectReason, Track, setLogLevel,
  type RemoteParticipant, type RemoteTrack, type Participant, type TrackPublication,
  type RoomConnectOptions, type TrackPublishOptions, type VideoCaptureOptions, type AudioCaptureOptions,
  type LocalVideoTrack, DataPacket_Kind, ConnectionError, ConnectionErrorReason } from 'livekit-client';
import { CallError, mapEngineError } from './errors';
import { Emitter } from './events';
import { parseCredential, isExpired, msUntilExpiryWarning, type CallCredential, type ParsedCredential } from './credential';
import { resolveProfile, DEFAULT_PROFILE, AUDIO_BITRATE, type VideoProfileName, type VideoProfile } from './profiles';
import { latencySettings, applyJitterBufferTarget, applyDegradationPreference, DEFAULT_LATENCY_MODE, type LatencyMode } from './latency';
import { chooseRegion, type RegionChoice } from './regions';
import { DeltaTracker, QualityTracker, collectRecv, collectSend, estimateLatency, absCaptureLatency, type CallStats, type Quality, type Direction, type AudioRoute } from './stats';
import { Telemetry, type TelemetryFields } from './telemetry';
import { Devices, type DeviceList } from './devices';
import { wrapTrack, type VideoHandle } from './render';
import { SDK_VERSION } from './version';

export type CallState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndReason = 'left' | 'peerLeft' | 'roomClosed' | 'network' | 'credential' | 'error' | 'roomFull';
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Peer {
  identity: string;
  name: string | null;
  audioMuted: boolean;
  videoMuted: boolean;
}

/** A data message from the peer. Strings and JSON objects arrive as sent; bytes arrive as Uint8Array. */
export type MessagePayload = string | Uint8Array | Record<string, unknown> | unknown[];

export interface ModerationEvent { level: 'warn' | 'mute' | 'end'; classes: string[]; at: number }

/** Video codecs an app may ask for. H.264 is the default; the engine negotiates VP8 when a peer cannot decode the choice. */
export type VideoCodec = 'h264' | 'vp8' | 'vp9' | 'av1';
export const VIDEO_CODECS: readonly VideoCodec[] = Object.freeze(['h264', 'vp8', 'vp9', 'av1']);

/**
 * Builds the video track to publish for a profile: size a canvas, open a screen, wrap a processed
 * camera. Called on every publish and republish, so a profile switch reaches it with the new size.
 */
export type VideoSourceFactory = (profile: VideoProfile) => MediaStreamTrack | Promise<MediaStreamTrack>;
export type VideoSource = MediaStreamTrack | VideoSourceFactory;

/** Which receiver property took the jitter buffer target; null before the first remote video track. */
export type JitterBufferSupport = 'jitterBufferTarget' | 'playoutDelayHint' | 'unsupported' | null;

/**
 * App fields for every telemetry row, called once per row with its direction. `g2g_p50`, `g2g_p95`
 * and `g2g_samples` (the app's own measured glass-to-glass latency, ms) are stored as columns;
 * every other key lands in the row's `extra` object.
 */
export type TelemetryExtra = (direction: Direction) => TelemetryFields | null | undefined;

export interface CallOptions {
  /** Publish the microphone on connect. Default true. */
  audio?: boolean;
  /** Publish the camera on connect. Default true. */
  video?: boolean;
  /** Named media tier. Default p540_60. */
  videoProfile?: VideoProfileName;
  /** `lowest` (default) or `smooth`. */
  latencyMode?: LatencyMode;
  /** Pin a region name from the credential; default picks the fastest by probe. */
  region?: string | null;
  /** Post quality stats to Qencode every 5 s. Default true. */
  telemetry?: boolean;
  /** Resume after network changes for up to 60 s. Default true. */
  autoReconnect?: boolean;
  /** Default 'warn'. Never logs media or credentials. */
  logLevel?: LogLevelName;
  /** API base used only by telemetry. Default https://api.qencode.com, or the credential's api_base. */
  apiBase?: string;
  /** Initial camera and microphone device ids. */
  cameraId?: string;
  microphoneId?: string;
  /** End the call when the peer leaves. Default true: a 1:1 call is over when one side is gone. */
  endOnPeerLeft?: boolean;
  /**
   * Let the engine adapt what it sends and receives to how the video is displayed (default true).
   * The receiver asks for the layer matching the rendered size, and a video element that is
   * hidden or in a background tab pauses that track on the server. Set false to always
   * receive and send the full profile regardless of visibility, as a measurement bench does.
   */
  adaptiveStream?: boolean;
  /**
   * Publish this track instead of opening the camera: a canvas, a screen, a processed camera. A
   * factory is called with the profile on every publish and republish. The SDK stops a track a
   * factory returned when it is replaced or the call ends; a track passed directly stays yours to
   * stop. `devices.setCamera` does not apply while a custom source is published.
   */
  videoSource?: VideoSource;
  /** Video codec to publish. Default `h264`. */
  codec?: VideoCodec;
  /** Override the profile's simulcast setting. Default follows the profile. */
  simulcast?: boolean;
  /** Jitter buffer target in ms, overriding the latency mode's. `setLatencyMode` clears it. */
  jitterBufferTargetMs?: number;
  /** Fields appended to every telemetry row. */
  telemetryExtra?: TelemetryExtra;
  /** Forces TURN relay, for measuring the relay path. */
  forceRelay?: boolean;
}

type OptionalKey = 'cameraId' | 'microphoneId' | 'region' | 'forceRelay' | 'videoSource' | 'simulcast' | 'jitterBufferTargetMs' | 'telemetryExtra';

export type CallEvents = {
  stateChanged: [CallState, EndReason | null];
  peerJoined: [Peer];
  peerLeft: [Peer];
  remoteVideo: [VideoHandle | null];
  remoteAudio: [VideoHandle | null];
  peerMuted: ['audio' | 'video', boolean];
  stats: [CallStats];
  qualityChanged: [Quality, Direction];
  message: [MessagePayload, boolean];
  credentialExpiring: [number];
  devicesChanged: [DeviceList];
  moderation: [ModerationEvent];
  error: [CallError];
};

const DEFAULT_API_BASE = 'https://api.qencode.com';
const MSG_TOPIC = 'qencode:msg';
const STATS_TOPIC = 'qencode:stats';
const MSG_MAX_BYTES = 15 * 1024;
const MSG_MAX_PER_SECOND = 30;
const STATS_INTERVAL_MS = 1000;
const RECONNECT_WINDOW_MS = 60_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * One 1:1 call. Create it from a credential minted by your backend, attach the video handles to
 * your views, and call `connect()`. The engine underneath is not part of this API.
 */
export class Call {
  static create(credential: CallCredential, options: CallOptions = {}): Call {
    return new Call(parseCredential(credential), options);
  }

  readonly devices = new Devices();
  readonly options: Readonly<Required<Omit<CallOptions, OptionalKey>> & Pick<CallOptions, OptionalKey>>;

  private readonly emitter = new Emitter<CallEvents>();
  private cred: ParsedCredential;
  private _state: CallState = 'idle';
  private _endReason: EndReason | null = null;
  private room: Room | null = null;
  private profile: VideoProfile;
  private latency: LatencyMode;
  private _codec: VideoCodec;
  private simulcastOverride: boolean | null;
  private jbOverride: number | null;
  private jbSupport: JitterBufferSupport = null;
  private videoSource: VideoSource | null;
  /** The MediaStreamTrack currently published from `videoSource`, and whether a factory made it (then the SDK stops it). */
  private sourceTrack: MediaStreamTrack | null = null;
  private sourceOwned = false;
  private regionChoice: RegionChoice | null = null;
  private _peer: Peer | null = null;
  private agentPresent = false;
  private remoteVideoTrack: RemoteTrack | null = null;
  private remoteAudioTrack: RemoteTrack | null = null;
  private _localVideo: VideoHandle | null = null;
  private _remoteVideo: VideoHandle | null = null;
  private _remoteAudio: VideoHandle | null = null;
  private audioEl: HTMLMediaElement | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetry: Telemetry | null = null;
  private readonly recvTracker = new DeltaTracker();
  private readonly sendTracker = new DeltaTracker();
  private readonly recvQuality = new QualityTracker();
  private readonly sendQuality = new QualityTracker();
  private peerRttMs: number | null = null;
  private joinMs: number | null = null;
  private _stats: CallStats | null = null;
  private msgTimes: number[] = [];
  private leaving = false;
  private pendingEnd: EndReason | null = null;

  private constructor(cred: ParsedCredential, options: CallOptions) {
    this.cred = cred;
    this.options = Object.freeze({
      audio: options.audio ?? true,
      video: options.video ?? true,
      videoProfile: options.videoProfile ?? DEFAULT_PROFILE,
      latencyMode: options.latencyMode ?? DEFAULT_LATENCY_MODE,
      telemetry: options.telemetry ?? true,
      autoReconnect: options.autoReconnect ?? true,
      logLevel: options.logLevel ?? 'warn',
      apiBase: options.apiBase ?? cred.apiBase ?? DEFAULT_API_BASE,
      endOnPeerLeft: options.endOnPeerLeft ?? true,
      adaptiveStream: options.adaptiveStream ?? true,
      codec: options.codec ?? 'h264',
      cameraId: options.cameraId, microphoneId: options.microphoneId, region: options.region ?? null, forceRelay: options.forceRelay,
      videoSource: options.videoSource, simulcast: options.simulcast, jitterBufferTargetMs: options.jitterBufferTargetMs, telemetryExtra: options.telemetryExtra,
    });
    this.profile = resolveProfile(this.options.videoProfile);
    this.latency = this.options.latencyMode;
    latencySettings(this.latency); // validates
    this._codec = checkCodec(this.options.codec);
    this.simulcastOverride = typeof options.simulcast === 'boolean' ? options.simulcast : null;
    this.jbOverride = options.jitterBufferTargetMs === undefined ? null : checkJitterTarget(options.jitterBufferTargetMs);
    this.videoSource = options.videoSource ?? null;
    this.devices._setCustomVideo(this.videoSource !== null);
    this.devices._setInitial(options.cameraId, options.microphoneId);
    this.devices._setCaptureOptions(() => this.captureOptions());
    try { setLogLevel(this.options.logLevel); } catch { /* logger unavailable in this build */ }
  }

  // ------------------------------------------------------------------ public state

  get state(): CallState { return this._state; }
  get endReason(): EndReason | null { return this._endReason; }
  get peer(): Peer | null { return this._peer ? { ...this._peer } : null; }
  get localVideo(): VideoHandle | null { return this._localVideo; }
  get remoteVideo(): VideoHandle | null { return this._remoteVideo; }
  get remoteAudio(): VideoHandle | null { return this._remoteAudio; }
  get stats(): CallStats | null { return this._stats; }
  get videoProfile(): VideoProfileName { return this.profile.name; }
  get latencyMode(): LatencyMode { return this.latency; }
  get videoCodec(): VideoCodec { return this._codec; }
  /** Whether video is published with simulcast layers: the override when set, else the profile's setting. */
  get simulcast(): boolean { return this.simulcastOverride ?? this.profile.simulcast; }
  /** The jitter buffer target in force: the override when set, else the latency mode's. */
  get jitterBufferTargetMs(): number { return this.jbOverride ?? latencySettings(this.latency).jitterBufferTargetMs; }
  get jitterBufferSupport(): JitterBufferSupport { return this.jbSupport; }
  /** Region probe results in ms by name, or null when no probe ran (one region, or a pinned one). */
  get regionProbe(): Record<string, number> | null { const p = this.regionChoice?.probe; return p && Object.keys(p).length ? { ...p } : null; }
  get identity(): string { return this.cred.identity; }
  get callId(): string | null { return this.cred.callId; }
  get region(): string | null { return this.regionChoice?.region.name ?? null; }
  get credentialExpiresAt(): number | null { return this.cred.expiresAt; }
  get agentJoined(): boolean { return this.agentPresent; }

  on<K extends keyof CallEvents>(event: K, handler: (...args: CallEvents[K]) => void): () => void { return this.emitter.on(event, handler); }
  once<K extends keyof CallEvents>(event: K, handler: (...args: CallEvents[K]) => void): () => void { return this.emitter.once(event, handler); }
  off<K extends keyof CallEvents>(event: K, handler: (...args: CallEvents[K]) => void): void { this.emitter.off(event, handler); }

  // ------------------------------------------------------------------ lifecycle

  async connect(): Promise<void> {
    if (this._state !== 'idle') throw new CallError('internal', `connect() called in state "${this._state}"; create a new Call to connect again.`, { retryable: false });
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) throw new CallError('unsupported', 'WebRTC media devices are not available here; a secure context (HTTPS or localhost) is required.');
    if (isExpired(this.cred)) {
      this.emitter.emit('credentialExpiring', this.cred.expiresAt ?? Date.now());
      throw new CallError('credentialExpired', 'The credential has expired; fetch a new one from your backend.');
    }
    this.setState('connecting', null);
    const t0 = now();
    try {
      this.regionChoice = await chooseRegion(this.cred.regions, this.options.region);
      const room = this.buildRoom();
      this.room = room;
      this.devices._attachRoom(room);
      this.devices._start();
      const connectOpts: RoomConnectOptions = { autoSubscribe: true };
      if (this.options.forceRelay) connectOpts.rtcConfig = { iceTransportPolicy: 'relay' };
      await room.connect(this.regionChoice.region.url, this.cred.token, connectOpts);
      if (this.leaving) throw new CallError('internal', 'Left during connect.', { retryable: false });
      this.adoptExistingParticipants(room);
      if (this.countHumans(room) >= 2) {
        this.pendingEnd = 'roomFull';
        await this.teardown();
        throw new CallError('roomFull', 'The call already has two participants.');
      }
      if (this.options.audio) await this.publishAudio();
      if (this.options.video && this.profile.video) await this.publishVideo();
      this.joinMs = Math.round(now() - t0);
      this.setState('connected', null);
      // A peer already in the room never triggers ParticipantConnected; report it the same way.
      if (this._peer) this.emitter.emit('peerJoined', { ...this._peer });
      this.scheduleExpiryWarning();
      this.startStats();
      this.telemetry = new Telemetry({ apiBase: this.options.apiBase, callId: this.cred.callId, token: this.cred.token, enabled: this.options.telemetry, sdkVersion: SDK_VERSION });
      this.telemetry.start(this.joinMs);
      this.sendHello();
    } catch (e) {
      let err = mapEngineError(e);
      if (err.code === 'network' && await this.joinRefusedByServer(e)) err = new CallError('roomFull', 'The call already has two participants.', { cause: e });
      this.pendingEnd = this.pendingEnd ?? reasonForError(err);
      // End first so the error reaches listeners; the engine's Disconnected during teardown then finds the call already ended.
      this.finish(this.pendingEnd, err);
      await this.teardown();
      throw err;
    }
  }

  async leave(): Promise<void> {
    if (this._state === 'ended') return;
    this.leaving = true;
    this.pendingEnd = this.pendingEnd ?? 'left';
    await this.teardown();
    this.finish(this.pendingEnd, null);
  }

  /** Replace the credential (same call, same identity) so the next reconnect uses a fresh token. */
  updateCredential(credential: CallCredential): void {
    const next = parseCredential(credential);
    if (next.roomName !== this.cred.roomName || next.identity !== this.cred.identity) {
      throw new CallError('credentialInvalid', 'The new credential is for a different call or identity.', { retryable: false });
    }
    this.cred = next;
    if (this._state === 'connected' || this._state === 'reconnecting') this.scheduleExpiryWarning();
  }

  /**
   * A media server refuses a join with a bare websocket close, and a browser never sees the
   * reason. When the server's validate endpoint still accepts the very same credential, the
   * refusal was not the token, the room or the network; on a two-person room it is capacity.
   * One short request on the failure path only.
   */
  private async joinRefusedByServer(e: unknown): Promise<boolean> {
    if (!(e instanceof ConnectionError)) return false;
    if (e.reason !== ConnectionErrorReason.WebSocket && e.reason !== ConnectionErrorReason.InternalError) return false;
    const region = this.regionChoice?.region;
    if (!region || typeof fetch !== 'function') return false;
    try {
      const url = new URL(region.url);
      url.protocol = url.protocol === 'ws:' || url.protocol === 'http:' ? 'http:' : 'https:';
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/rtc/validate`;
      url.search = `access_token=${encodeURIComponent(this.cred.token)}`;
      const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = setTimeout(() => ctl?.abort(), 3000);
      try {
        const r = await fetch(url.toString(), { cache: 'no-store', credentials: 'omit', signal: ctl?.signal });
        return r.status === 200;
      } finally { clearTimeout(timer); }
    } catch { return false; }
  }

  // ------------------------------------------------------------------ media controls

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const room = this.requireRoom();
    try {
      if (enabled && !room.localParticipant.getTrackPublication(Track.Source.Microphone)) await this.publishAudio();
      else await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch (e) { throw mapEngineError(e); }
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    const room = this.requireRoom();
    try {
      if (enabled) {
        if (!this.profile.video) this.profile = resolveProfile(DEFAULT_PROFILE);
        if (!room.localParticipant.getTrackPublication(Track.Source.Camera)) await this.publishVideo();
        else { await room.localParticipant.setCameraEnabled(true); if (!this.videoSource) await this.devices._cameraPublished(); }
      } else {
        await room.localParticipant.setCameraEnabled(false);
      }
    } catch (e) { throw mapEngineError(e); }
  }

  /**
   * Switch resolution, frame rate and bitrate cap mid-call. A simulcast change or a factory video
   * source republishes the track; a camera restarts capture in place; a fixed custom track only
   * gets the new encoding parameters.
   */
  async setVideoProfile(name: VideoProfileName): Promise<void> {
    const next = resolveProfile(name);
    const prev = this.profile;
    this.profile = next;
    const room = this.room;
    if (!room || this._state === 'ended') return;
    try {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (!next.video) { await this.unpublishVideo(); return; }
      if (!pub?.track) { await this.publishVideo(); return; }
      const simulcastChanged = (this.simulcastOverride ?? prev.simulcast) !== (this.simulcastOverride ?? next.simulcast);
      if (simulcastChanged || typeof this.videoSource === 'function') { await this.republishVideo(); return; }
      const track = pub.track as LocalVideoTrack;
      if (!this.videoSource) await track.restartTrack(this.captureOptions());
      await this.applyEncoding(track.sender, next);
    } catch (e) { throw mapEngineError(e); }
  }

  async setLatencyMode(mode: LatencyMode): Promise<void> {
    const s = latencySettings(mode);
    this.latency = mode;
    this.jbOverride = null;
    this.applyJitterTarget();
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const sender = (pub?.track as LocalVideoTrack | undefined)?.sender;
    if (sender) await applyDegradationPreference(sender, s.degradationPreference);
  }

  /**
   * Pin the receiver's jitter buffer target in ms regardless of the latency mode (0 asks the
   * browser for its floor). Returns which receiver property took it; `unsupported` on Firefox.
   * `setLatencyMode` clears the pin.
   */
  setJitterBufferTarget(ms: number): JitterBufferSupport {
    this.jbOverride = checkJitterTarget(ms);
    return this.applyJitterTarget();
  }

  /** Change the codec or the simulcast setting mid-call; the video track is republished. */
  async setVideoEncoding(opts: { codec?: VideoCodec; simulcast?: boolean | null }): Promise<void> {
    if (opts.codec !== undefined) this._codec = checkCodec(opts.codec);
    if (opts.simulcast !== undefined) this.simulcastOverride = opts.simulcast;
    if (!this.room || this._state === 'ended') return;
    try { await this.republishVideo(); } catch (e) { throw mapEngineError(e); }
  }

  /** Replace the video source mid-call; `null` returns to the camera. Republishes when video is published. */
  async setVideoSource(source: VideoSource | null): Promise<void> {
    this.videoSource = source;
    this.devices._setCustomVideo(source !== null);
    if (!this.room || this._state === 'ended') return;
    try { await this.republishVideo(); } catch (e) { throw mapEngineError(e); }
  }

  /** Send up to 15 KB to the peer. Strings and JSON-able objects arrive as sent; Uint8Array arrives as bytes. */
  async sendMessage(payload: MessagePayload, reliable = true): Promise<void> {
    const room = this.requireRoom();
    const bytes = encodeMessage(payload);
    if (bytes.byteLength > MSG_MAX_BYTES) throw new CallError('internal', `Message is ${bytes.byteLength} bytes; the limit is ${MSG_MAX_BYTES}.`, { retryable: false });
    const t = Date.now();
    this.msgTimes = this.msgTimes.filter((x) => t - x < 1000);
    if (this.msgTimes.length >= MSG_MAX_PER_SECOND) throw new CallError('internal', `Message rate limit: at most ${MSG_MAX_PER_SECOND} messages per second.`, { retryable: true });
    this.msgTimes.push(t);
    try { await room.localParticipant.publishData(toNonShared(bytes), { reliable, topic: MSG_TOPIC }); }
    catch (e) { throw mapEngineError(e); }
  }

  // ------------------------------------------------------------------ engine wiring

  private buildRoom(): Room {
    const s = latencySettings(this.latency);
    const adaptive = this.options.adaptiveStream !== false;
    const room = new Room({
      adaptiveStream: adaptive,
      dynacast: adaptive,
      publishDefaults: this.publishOptions(s.degradationPreference),
      videoCaptureDefaults: this.captureOptions(),
      audioCaptureDefaults: this.audioCaptureOptions(),
    });
    room.on(RoomEvent.ParticipantConnected, (p) => this.onParticipantConnected(p));
    room.on(RoomEvent.ParticipantDisconnected, (p) => this.onParticipantDisconnected(p));
    room.on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.onTrackSubscribed(track, p));
    room.on(RoomEvent.TrackUnsubscribed, (track) => this.onTrackUnsubscribed(track));
    room.on(RoomEvent.TrackMuted, (pub, p) => this.onMuteChange(pub, p, true));
    room.on(RoomEvent.TrackUnmuted, (pub, p) => this.onMuteChange(pub, p, false));
    room.on(RoomEvent.DataReceived, (payload, p, kind, topic) => this.onData(payload, p, topic, kind !== DataPacket_Kind.LOSSY));
    room.on(RoomEvent.Reconnecting, () => this.onReconnecting());
    room.on(RoomEvent.Reconnected, () => this.onReconnected());
    room.on(RoomEvent.Disconnected, (reason) => this.onDisconnected(reason));
    room.on(RoomEvent.MediaDevicesError, (e) => this.emitter.emit('error', mapEngineError(e)));
    room.on(RoomEvent.MediaDevicesChanged, () => { void this.devices.list().then((l) => this.emitter.emit('devicesChanged', l)); });
    return room;
  }

  private publishOptions(degradation: RTCDegradationPreference): TrackPublishOptions {
    return {
      videoCodec: this._codec,
      simulcast: this.simulcast,
      videoEncoding: this.profile.video ? { maxBitrate: this.profile.maxBitrate, maxFramerate: this.profile.fps } : undefined,
      degradationPreference: degradation,
      dtx: false,
      audioPreset: { maxBitrate: AUDIO_BITRATE },
    };
  }

  /** Profile resolution plus the camera the devices object currently selects (an id, a facing, or the default). */
  private captureOptions(): VideoCaptureOptions {
    const p = this.profile.video ? this.profile : resolveProfile(DEFAULT_PROFILE);
    return { resolution: { width: p.width, height: p.height, frameRate: p.fps, aspectRatio: p.width / p.height }, ...this.devices._videoSelection() };
  }

  private audioCaptureOptions(): AudioCaptureOptions {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: this.devices._microphoneSelection() };
  }

  private async publishAudio(): Promise<void> {
    const room = this.requireRoom();
    try { await room.localParticipant.setMicrophoneEnabled(true, this.audioCaptureOptions(), this.publishOptions(latencySettings(this.latency).degradationPreference)); }
    catch (e) { throw mapEngineError(e); }
  }

  private async publishVideo(): Promise<void> {
    const room = this.requireRoom();
    try {
      const opts = this.publishOptions(latencySettings(this.latency).degradationPreference);
      let track: unknown;
      if (this.videoSource) {
        const source = await this.resolveSource();
        const pub = await room.localParticipant.publishTrack(source, { ...opts, source: Track.Source.Camera, name: 'camera' });
        track = pub?.track;
      } else {
        const pub = await room.localParticipant.setCameraEnabled(true, this.captureOptions(), opts);
        track = pub?.track;
        await this.devices._cameraPublished();
      }
      this._localVideo = track ? wrapTrack(track as Parameters<typeof wrapTrack>[0]) : null;
    } catch (e) { this.releaseSource(); throw mapEngineError(e); }
  }

  /** Takes the track from `videoSource`; a factory's result is owned by the SDK, a passed track is not. */
  private async resolveSource(): Promise<MediaStreamTrack> {
    const src = this.videoSource as VideoSource;
    const track = typeof src === 'function' ? await src(this.profile.video ? this.profile : resolveProfile(DEFAULT_PROFILE)) : src;
    if (!track || typeof track !== 'object' || (track as MediaStreamTrack).kind !== 'video') {
      throw new CallError('internal', 'videoSource must be, or return, a video MediaStreamTrack.', { retryable: false });
    }
    this.sourceTrack = track;
    this.sourceOwned = typeof src === 'function';
    return track;
  }

  private releaseSource(): void {
    if (this.sourceTrack && this.sourceOwned) { try { this.sourceTrack.stop(); } catch { /* already ended */ } }
    this.sourceTrack = null;
    this.sourceOwned = false;
  }

  private async unpublishVideo(): Promise<void> {
    const room = this.room;
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Camera);
    // A track the app handed us is never stopped by the SDK; everything else is.
    if (room && pub?.track) await room.localParticipant.unpublishTrack(pub.track, this.sourceTrack ? this.sourceOwned : true);
    this.releaseSource();
    this._localVideo = null;
    this.sendTracker.reset();
  }

  /** Unpublish and publish again with the current source, codec, simulcast and profile. A muted camera stays off. */
  private async republishVideo(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (!pub?.track) return;                       // video off or audio-only: the next enable publishes fresh
    const wasMuted = !!pub.isMuted;
    await this.unpublishVideo();
    if (!wasMuted && this.profile.video) await this.publishVideo();
  }

  private async applyEncoding(sender: RTCRtpSender | undefined, p: VideoProfile): Promise<void> {
    if (!sender) return;
    const params = sender.getParameters();
    params.encodings = (params.encodings && params.encodings.length ? params.encodings : [{}]).map((e) => ({ ...e, maxBitrate: p.maxBitrate, maxFramerate: p.fps }));
    await sender.setParameters(params);
  }

  private applyJitterTarget(): JitterBufferSupport {
    const receiver = this.remoteVideoTrack?.receiver;
    if (!receiver) return this.jbSupport;
    const took = applyJitterBufferTarget(receiver, this.jitterBufferTargetMs);
    this.jbSupport = took ?? 'unsupported';
    return this.jbSupport;
  }

  private adoptExistingParticipants(room: Room): void {
    room.remoteParticipants.forEach((p) => {
      if (isAgent(p)) { this.agentPresent = true; return; }
      if (!this._peer) this._peer = peerOf(p);
    });
  }

  private countHumans(room: Room): number {
    let n = 0;
    room.remoteParticipants.forEach((p) => { if (!isAgent(p)) n += 1; });
    return n;
  }

  private onParticipantConnected(p: RemoteParticipant): void {
    if (isAgent(p)) { this.agentPresent = true; return; }
    if (this._peer && this._peer.identity !== p.identity) return; // a third human; the room cap should have rejected it
    this._peer = peerOf(p);
    this.emitter.emit('peerJoined', { ...this._peer });
    this.sendHello();
  }

  private onParticipantDisconnected(p: RemoteParticipant): void {
    if (isAgent(p)) { this.agentPresent = false; return; }
    if (!this._peer || this._peer.identity !== p.identity) return;
    const left = { ...this._peer };
    this._peer = null;
    this.peerRttMs = null;
    this.emitter.emit('peerLeft', left);
    if (this.options.endOnPeerLeft) void this.endWith('peerLeft');
  }

  private onTrackSubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    if (isAgent(p)) return;
    if (track.kind === Track.Kind.Video) {
      this.remoteVideoTrack = track;
      this.recvTracker.reset();
      this.applyJitterTarget();
      this._remoteVideo = wrapTrack(track as unknown as Parameters<typeof wrapTrack>[0]);
      this.emitter.emit('remoteVideo', this._remoteVideo);
    } else if (track.kind === Track.Kind.Audio) {
      this.remoteAudioTrack = track;
      const el = this.ensureAudioElement();
      if (el) track.attach(el);
      this._remoteAudio = wrapTrack(track as unknown as Parameters<typeof wrapTrack>[0]);
      this.emitter.emit('remoteAudio', this._remoteAudio);
    }
  }

  private onTrackUnsubscribed(track: RemoteTrack): void {
    if (track === this.remoteVideoTrack) { this.remoteVideoTrack = null; this._remoteVideo = null; this.emitter.emit('remoteVideo', null); }
    if (track === this.remoteAudioTrack) { this.remoteAudioTrack = null; this._remoteAudio = null; this.emitter.emit('remoteAudio', null); }
    try { track.detach(); } catch { /* already detached */ }
  }

  private onMuteChange(pub: TrackPublication, p: Participant, muted: boolean): void {
    if (!this._peer || p.identity !== this._peer.identity) return;
    const kind = pub.kind === Track.Kind.Audio ? 'audio' : 'video';
    if (kind === 'audio') this._peer.audioMuted = muted; else this._peer.videoMuted = muted;
    this.emitter.emit('peerMuted', kind, muted);
  }

  private onData(payload: Uint8Array, p: RemoteParticipant | undefined, topic: string | undefined, reliable = true): void {
    if (p && isAgent(p)) return;
    if (topic === STATS_TOPIC) {
      try { const m = JSON.parse(dec.decode(payload)); if (typeof m.rtt === 'number') this.peerRttMs = m.rtt; } catch { /* ignore */ }
      return;
    }
    if (topic === MSG_TOPIC) {
      try { this.emitter.emit('message', decodeMessage(payload), reliable); } catch { /* malformed */ }
    }
  }

  private onReconnecting(): void {
    if (this._state !== 'connected') return;
    this.setState('reconnecting', null);
    if (this.cred.expiresAt !== null && isExpired(this.cred)) this.emitter.emit('credentialExpiring', this.cred.expiresAt);
    if (!this.options.autoReconnect) { void this.endWith('network'); return; }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { if (this._state === 'reconnecting') void this.endWith('network'); }, RECONNECT_WINDOW_MS);
  }

  private onReconnected(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this._state === 'reconnecting') this.setState('connected', null);
    this.recvTracker.reset(); this.sendTracker.reset();
  }

  private onDisconnected(reason?: DisconnectReason): void {
    if (this._state === 'ended') return;
    void this.endWith(this.pendingEnd ?? endReasonOf(reason, this.leaving));
  }

  // ------------------------------------------------------------------ stats loop

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => { void this.pollStats(); }, STATS_INTERVAL_MS);
  }

  private async pollStats(): Promise<void> {
    const room = this.room;
    if (!room || (this._state !== 'connected' && this._state !== 'reconnecting')) return;
    const t = Date.now();
    try {
      const recvReport = await (this.remoteVideoTrack ?? this.remoteAudioTrack)?.receiver?.getStats?.();
      const lp = room.localParticipant;
      const localTrack = (lp.getTrackPublication(Track.Source.Camera)?.track ?? lp.getTrackPublication(Track.Source.Microphone)?.track) as LocalVideoTrack | undefined;
      const sendReport = await localTrack?.sender?.getStats?.();
      const recv = recvReport ? collectRecv(recvReport, this.recvTracker, t) : emptyRecv();
      const send = sendReport ? collectSend(sendReport, this.sendTracker, t) : emptySend();
      try {
        const rx = this.remoteVideoTrack?.receiver as (RTCRtpReceiver & { getSynchronizationSources?: () => RTCRtpSynchronizationSource[] }) | undefined;
        if (rx?.getSynchronizationSources) recv.absCaptureLatencyMs = absCaptureLatency(rx.getSynchronizationSources(), t, now());
      } catch { /* not exposed here */ }
      const estimatedLatencyMs = estimateLatency({ rttMs: recv.rttMs ?? send.rttMs, peerRttMs: this.peerRttMs, jitterBufferMs: recv.jitterBufferMs, decodeMs: recv.decodeMs, fps: recv.fps });
      const qr = this.recvQuality.update({ lossPct: recv.lossPct, jitterBufferMs: recv.jitterBufferMs, freezes: recv.freezes, rttMs: recv.rttMs });
      const qs = this.sendQuality.update({ lossPct: send.lossPct, jitterBufferMs: null, freezes: null, rttMs: send.rttMs });
      const prev = this._stats;
      const snap: CallStats = {
        ts: t, recv, send, peerRttMs: this.peerRttMs, estimatedLatencyMs,
        quality: { recv: qr, send: qs },
        region: room.serverInfo?.region ?? this.regionChoice?.region.name ?? null,
        nodeId: room.serverInfo?.nodeId ?? null,
        serverVersion: room.serverInfo?.version ?? null,
        joinMs: this.joinMs,
        audioRoute: this.audioRoute(),
      };
      this._stats = snap;
      this.emitter.emit('stats', snap);
      if (!prev || prev.quality.recv !== qr) this.emitter.emit('qualityChanged', qr, 'recv');
      if (!prev || prev.quality.send !== qs) this.emitter.emit('qualityChanged', qs, 'send');
      if (this.telemetry?.enabled) this.telemetry.push(snap, this._peer?.identity ?? null, this.extraFields());
      const rtt = recv.rttMs ?? send.rttMs;
      if (rtt !== null && room.state === ConnectionState.Connected) {
        try { await lp.publishData(enc.encode(JSON.stringify({ t: 'rtt', rtt })), { reliable: false, topic: STATS_TOPIC }); } catch { /* channel not ready */ }
      }
    } catch (e) {
      this.emitter.emit('error', new CallError('internal', `Stats collection failed: ${(e as Error)?.message ?? e}`, { cause: e }));
    }
  }

  private extraFields(): { recv: TelemetryFields | null; send: TelemetryFields | null } | undefined {
    const fn = this.options.telemetryExtra;
    if (!fn) return undefined;
    const one = (d: Direction): TelemetryFields | null => {
      try { const v = fn(d); return v && typeof v === 'object' ? v : null; }
      catch (e) { this.emitter.emit('error', new CallError('internal', `telemetryExtra threw: ${(e as Error)?.message ?? e}`, { cause: e })); return null; }
    };
    return { recv: one('recv'), send: one('send') };
  }

  private audioRoute(): AudioRoute {
    if (typeof navigator === 'undefined') return 'unknown';
    const label = (this.audioEl as { sinkId?: string } | null)?.sinkId ?? '';
    if (!label) return 'unknown';
    return 'unknown';
  }

  private sendHello(): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    void room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'hello', sdk: SDK_VERSION })), { reliable: true, topic: STATS_TOPIC }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ housekeeping

  private scheduleExpiryWarning(): void {
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    const ms = msUntilExpiryWarning(this.cred);
    if (ms === null) return;
    const at = this.cred.expiresAt as number;
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; if (this._state === 'connected' || this._state === 'reconnecting') this.emitter.emit('credentialExpiring', at); }, ms);
  }

  private ensureAudioElement(): HTMLMediaElement | null {
    if (this.audioEl) return this.audioEl;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body?.appendChild(el);
    this.audioEl = el;
    this.devices._registerAudioElement(el);
    return el;
  }

  private requireRoom(): Room {
    if (!this.room || this._state === 'ended' || this._state === 'idle') throw new CallError('internal', `Not connected (state "${this._state}").`, { retryable: false });
    return this.room;
  }

  private setState(state: CallState, reason: EndReason | null): void {
    if (this._state === state && state !== 'ended') return;
    this._state = state;
    if (state === 'ended') this._endReason = reason;
    this.emitter.emit('stateChanged', state, state === 'ended' ? reason : null);
  }

  private async endWith(reason: EndReason): Promise<void> {
    if (this._state === 'ended') return;
    // teardown() disconnects the engine, which emits Disconnected(CLIENT_INITIATED) before we
    // get back here; remember why we are ending so that handler does not relabel it as 'left'.
    this.pendingEnd = this.pendingEnd ?? reason;
    await this.teardown();
    this.finish(this.pendingEnd, null);
  }

  private finish(reason: EndReason, err: CallError | null): void {
    if (this._state === 'ended') return;
    if (err) this.emitter.emit('error', err);
    this.setState('ended', reason);
  }

  private async teardown(): Promise<void> {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.telemetry) { await this.telemetry.stop(); this.telemetry = null; }
    this.devices._stop();
    this.devices._attachRoom(null);
    const room = this.room;
    this.room = null;
    if (room) {
      // The engine's disconnect stops every published track; a track the app handed us must survive it.
      if (this.sourceTrack && !this.sourceOwned) {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (pub?.track) { try { await room.localParticipant.unpublishTrack(pub.track, false); } catch { /* already gone */ } }
      }
      try { await room.disconnect(true); } catch { /* already closed */ }
    }
    this.releaseSource();
    this.jbSupport = null;
    if (this.audioEl) { try { this.audioEl.srcObject = null; this.audioEl.remove(); } catch { /* detached */ } this.audioEl = null; }
    this.remoteVideoTrack = null; this.remoteAudioTrack = null;
    this._remoteVideo = null; this._remoteAudio = null; this._localVideo = null;
  }
}

// ------------------------------------------------------------------ helpers

function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

/** The engine requires a Uint8Array over a plain ArrayBuffer (never a SharedArrayBuffer). */
function toNonShared(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

function isAgent(p: Participant): boolean {
  const asAny = p as { isAgent?: boolean; kind?: unknown };
  if (typeof asAny.isAgent === 'boolean') return asAny.isAgent;
  return asAny.kind === 4; // ParticipantKind.AGENT
}

function peerOf(p: RemoteParticipant): Peer {
  return {
    identity: p.identity,
    name: p.name || null,
    audioMuted: p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? false,
    videoMuted: p.getTrackPublication(Track.Source.Camera)?.isMuted ?? false,
  };
}

function reasonForError(err: CallError): EndReason {
  switch (err.code) {
    case 'roomFull': return 'roomFull';
    case 'roomClosed': return 'roomClosed';
    case 'credentialInvalid': case 'credentialExpired': return 'credential';
    case 'network': return 'network';
    default: return 'error';
  }
}

/** Engine disconnect reasons to the SDK's end reasons. */
function endReasonOf(reason: DisconnectReason | undefined, leaving: boolean): EndReason {
  if (leaving) return 'left';
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return 'left';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
    case DisconnectReason.SERVER_SHUTDOWN:
    case DisconnectReason.PARTICIPANT_REMOVED: return 'roomClosed';
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.USER_REJECTED: return 'credential';
    case DisconnectReason.JOIN_FAILURE: return 'error';
    default: return 'network';
  }
}

function emptyRecv(): CallStats['recv'] {
  return { rttMs: null, jitterBufferMs: null, decodeMs: null, fps: null, width: null, height: null, kbps: null, lossPct: null, jitterMs: null, freezes: null, freezeMs: null, processingMs: null, absCaptureLatencyMs: null, codec: null, transport: null, candidateType: null };
}
function emptySend(): CallStats['send'] {
  return { rttMs: null, encodeMs: null, fps: null, width: null, height: null, kbps: null, targetKbps: null, qualityLimitation: null, lossPct: null, codec: null, transport: null, candidateType: null };
}

function checkCodec(c: unknown): VideoCodec {
  if (typeof c === 'string' && (VIDEO_CODECS as readonly string[]).includes(c)) return c as VideoCodec;
  throw new RangeError(`Unknown video codec "${String(c)}". Known: ${VIDEO_CODECS.join(', ')}`);
}

function checkJitterTarget(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 4000) throw new RangeError('jitterBufferTargetMs must be a number between 0 and 4000.');
  return ms;
}

/** Envelope: 1 tag byte (1 string, 2 json, 3 bytes) followed by the payload. */
export function encodeMessage(payload: MessagePayload): Uint8Array {
  let tag: number, body: Uint8Array;
  if (typeof payload === 'string') { tag = 1; body = enc.encode(payload); }
  else if (payload instanceof Uint8Array) { tag = 3; body = payload; }
  else { tag = 2; body = enc.encode(JSON.stringify(payload)); }
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = tag; out.set(body, 1);
  return out;
}

export function decodeMessage(bytes: Uint8Array): MessagePayload {
  const tag = bytes[0], body = bytes.subarray(1);
  if (tag === 1) return dec.decode(body);
  if (tag === 2) return JSON.parse(dec.decode(body)) as MessagePayload;
  if (tag === 3) return body.slice();
  throw new Error('unknown message envelope');
}
