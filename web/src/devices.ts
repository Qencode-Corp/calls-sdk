import { Track, type Room, type LocalVideoTrack, type VideoCaptureOptions } from 'livekit-client';
import { Emitter } from './events';
import { CallError, mapEngineError } from './errors';

/** Which way a camera points: `user` faces the person, `environment` faces away (the rear camera on a phone). */
export type CameraFacing = 'user' | 'environment';

export interface DeviceInfo {
  id: string;
  label: string;
  /** For cameras: which way it points when the label says so (phones do); null when unknown. */
  facing?: CameraFacing | null;
}
export interface DeviceList { cameras: DeviceInfo[]; microphones: DeviceInfo[]; speakers: DeviceInfo[] }

type DevicesEvents = { change: [DeviceList] };

/**
 * Device selection. Labels are empty until the first getUserMedia permission is granted; after
 * `connect()` the list is complete. A camera or microphone chosen before `connect()` is used
 * when the track is first published; chosen mid-call it is switched in place; chosen while the
 * camera is off it takes effect when the camera is turned back on. Speaker selection needs
 * `setSinkId`, which Safari lacks.
 */
export class Devices {
  private readonly emitter = new Emitter<DevicesEvents>();
  private room: Room | null = null;
  private readonly audioElements = new Set<HTMLMediaElement>();
  private speakerId = '';
  private customVideo = false;
  private cameraIdValue: string | null = null;
  private microphoneIdValue: string | null = null;
  /** A facing request not yet turned into a concrete device id. */
  private facingWish: CameraFacing | null = null;
  /** True when a camera choice is waiting for the camera to be published or unmuted. */
  private pending = false;
  private captureOptions: (() => VideoCaptureOptions) | null = null;
  private readonly onDeviceChange = () => { void this.list().then((l) => this.emitter.emit('change', l)); };

  /** @internal */
  _attachRoom(room: Room | null): void { this.room = room; }
  /** @internal The call publishes a custom video source, so the engine must not replace it with a camera. */
  _setCustomVideo(on: boolean): void { this.customVideo = on; }
  /** @internal Initial ids from CallOptions. */
  _setInitial(cameraId?: string, microphoneId?: string): void {
    this.cameraIdValue = cameraId || null;
    this.microphoneIdValue = microphoneId || null;
  }
  /** @internal The call's capture options (profile resolution plus the selection below), used to restart the camera. */
  _setCaptureOptions(fn: () => VideoCaptureOptions): void { this.captureOptions = fn; }
  /** @internal The camera selection part of the capture constraints. */
  _videoSelection(): Pick<VideoCaptureOptions, 'deviceId' | 'facingMode'> {
    if (this.facingWish) return { facingMode: this.facingWish };
    if (this.cameraIdValue) return { deviceId: this.cameraIdValue };
    return {};
  }
  /** @internal */
  _microphoneSelection(): string | undefined { return this.microphoneIdValue ?? undefined; }
  /** @internal Called by the call when the camera is (re)published or unmuted: applies a deferred choice and records what is in use. */
  async _cameraPublished(): Promise<void> {
    const track = this.cameraTrack();
    if (!track) return;
    if (this.pending && !track.isMuted && this.captureOptions) {
      try { await track.restartTrack(this.captureOptions()); } catch (e) { throw mapEngineError(e); }
    }
    this.pending = false;
    this.syncFromTrack(track);
  }
  /** @internal */
  _registerAudioElement(el: HTMLMediaElement): void {
    this.audioElements.add(el);
    if (this.speakerId) void this.applySink(el);
  }
  /** @internal */
  _start(): void {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
  }
  /** @internal */
  _stop(): void {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.audioElements.clear();
  }

  async list(): Promise<DeviceList> {
    const out: DeviceList = { cameras: [], microphones: [], speakers: [] };
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return out;
    let devs: MediaDeviceInfo[] = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return out; }
    devs.forEach((d, i) => {
      const info: DeviceInfo = { id: d.deviceId, label: d.label || `${kindLabel(d.kind)} ${i + 1}` };
      if (d.kind === 'videoinput') { info.facing = facingFromLabel(d.label); out.cameras.push(info); }
      else if (d.kind === 'audioinput') out.microphones.push(info);
      else if (d.kind === 'audiooutput' && this.canSelectSpeaker) out.speakers.push(info);
    });
    return out;
  }

  get canSelectSpeaker(): boolean {
    return typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
  }

  /** The camera in use, or the one chosen for when the camera is next published; null for the system default. */
  get cameraId(): string | null { return this.cameraIdValue; }
  get microphoneId(): string | null { return this.microphoneIdValue; }
  /** Which way the camera in use points, when the browser says (phones do); otherwise the last facing asked for, or null. */
  get cameraFacing(): CameraFacing | null {
    const f = this.trackSettings()?.facingMode;
    if (f === 'user' || f === 'environment') return f;
    return this.facingWish;
  }

  /** Use this camera: now when it is published and on, otherwise as soon as it is. */
  async setCamera(deviceId: string): Promise<void> {
    this.refuseIfCustomVideo();
    this.cameraIdValue = deviceId;
    this.facingWish = null;
    await this.applyCamera();
  }

  /**
   * Use the camera that faces the given way: the front (`user`) or the rear (`environment`)
   * camera on a phone. Browsers on phones honour the request directly; elsewhere a camera whose
   * label says which way it points is used, and `deviceUnavailable` is thrown when there is none.
   */
  async setCameraFacing(mode: CameraFacing): Promise<void> {
    if (mode !== 'user' && mode !== 'environment') throw new RangeError(`Unknown camera facing "${String(mode)}". Known: user, environment`);
    this.refuseIfCustomVideo();
    this.facingWish = mode;
    this.cameraIdValue = null;
    const applied = await this.applyCamera();
    if (!applied) return;                                   // takes effect when the camera is next published or unmuted
    if (this.trackSettings()?.facingMode === mode) return;  // the browser honoured the hint
    // The hint was ignored, as desktops do; fall back to a camera whose label says which way it points.
    const list = await this.list();
    const alt = list.cameras.find((c) => c.facing === mode);
    if (!alt) throw new CallError('deviceUnavailable', mode === 'user' ? 'No camera facing the user was found.' : 'No camera facing away from the user was found.');
    this.cameraIdValue = alt.id;
    this.facingWish = null;
    await this.applyCamera();
    this.facingWish = mode;                                 // remembered for `cameraFacing` where settings stay silent
  }

  async setMicrophone(deviceId: string): Promise<void> {
    this.microphoneIdValue = deviceId;
    if (!this.room) return;                                 // used when the microphone is first published
    await this.switch('audioinput', deviceId);
  }

  async setSpeaker(deviceId: string): Promise<void> {
    if (!this.canSelectSpeaker) throw new CallError('unsupported', 'This browser cannot choose the audio output device.', { retryable: false });
    this.speakerId = deviceId;
    for (const el of this.audioElements) await this.applySink(el);
    if (this.room) { try { await this.room.switchActiveDevice('audiooutput', deviceId, true); } catch { /* elements already switched */ } }
  }

  onChange(handler: (list: DeviceList) => void): () => void { return this.emitter.on('change', handler); }

  /** Restarts the published, unmuted camera with the current selection. Returns false when that has to wait. */
  private async applyCamera(): Promise<boolean> {
    const track = this.cameraTrack();
    if (!track || track.isMuted || !this.captureOptions) { this.pending = true; return false; }
    try { await track.restartTrack(this.captureOptions()); } catch (e) { throw mapEngineError(e); }
    this.pending = false;
    this.syncFromTrack(track);
    return true;
  }

  private syncFromTrack(track: LocalVideoTrack): void {
    const s = settingsOf(track);
    if (s?.deviceId) { this.cameraIdValue = s.deviceId; this.facingWish = null; }
  }

  private cameraTrack(): LocalVideoTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  }

  private trackSettings(): MediaTrackSettings | undefined {
    const t = this.cameraTrack();
    return t ? settingsOf(t) : undefined;
  }

  private refuseIfCustomVideo(): void {
    if (this.customVideo) throw new CallError('unsupported', 'The video comes from a custom videoSource; switch cameras in the code that produces it.', { retryable: false });
  }

  private async switch(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    if (!this.room) throw new CallError('internal', 'Not connected.', { retryable: false });
    try {
      const ok = await this.room.switchActiveDevice(kind, deviceId, true);
      if (!ok) throw new CallError('deviceUnavailable', `Could not switch to device ${deviceId}.`);
    } catch (e) {
      throw mapEngineError(e);
    }
  }

  private async applySink(el: HTMLMediaElement): Promise<void> {
    const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (typeof sink !== 'function') return;
    try { await sink.call(el, this.speakerId); } catch (e) { throw new CallError('deviceUnavailable', `Speaker switch failed: ${(e as Error)?.message ?? e}`, { cause: e }); }
  }
}

function settingsOf(track: LocalVideoTrack): MediaTrackSettings | undefined {
  const mst = track.mediaStreamTrack as MediaStreamTrack | undefined;
  return typeof mst?.getSettings === 'function' ? mst.getSettings() : undefined;
}

/** Phones label their cameras by direction ("Back Camera", "camera2 0, facing back"); desktops rarely do. */
export function facingFromLabel(label: string): CameraFacing | null {
  const l = (label || '').toLowerCase();
  if (/\b(back|rear|environment|world)\b/.test(l)) return 'environment';
  if (/\b(front|user|face|selfie)\b/.test(l)) return 'user';
  return null;
}

function kindLabel(k: MediaDeviceKind): string {
  return k === 'videoinput' ? 'camera' : k === 'audioinput' ? 'microphone' : 'speaker';
}
