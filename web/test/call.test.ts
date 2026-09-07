import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { credential, installMediaDevices, report } from './helpers';

// ------------------------------------------------------------------ engine mock (livekit-client 2.22 shapes)
const H = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Set<(...a: any[]) => void>>();
    on(ev: string, h: (...a: any[]) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(h); return this; }
    off(ev: string, h: (...a: any[]) => void) { this.handlers.get(ev)?.delete(h); return this; }
    emit(ev: string, ...a: any[]) { this.handlers.get(ev)?.forEach((h) => h(...a)); }
  }
  const ConnectionErrorReason = { NotAllowed: 0, ServerUnreachable: 1, InternalError: 2, Cancelled: 3, LeaveRequest: 4, Timeout: 5, WebSocket: 6, ServiceNotFound: 7 };
  class ConnectionError extends Error { reason: number; status?: number; constructor(m: string, reason: number, status?: number) { super(m); this.reason = reason; this.status = status; this.name = 'ConnectionError'; } }
  const fakeTrack = (kind: 'video' | 'audio') => ({
    kind, receiver: { getStats: vi.fn(async () => new Map()) }, sender: { getStats: vi.fn(async () => new Map()), getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => {}) },
    mediaStreamTrack: { kind }, attach: vi.fn((el?: any) => el), detach: vi.fn(), restartTrack: vi.fn(async () => {}), stop: vi.fn(),
  });
  class MockRoom extends Emitter {
    static instances: MockRoom[] = [];
    static connectError: unknown = null;
    static connectDelayMs = 0;
    static onConnect: ((room: any) => void) | null = null;
    state = 'disconnected';
    remoteParticipants = new Map<string, any>();
    serverInfo: any = { region: 'eu-central', nodeId: 'ND_1', version: '1.13.6' };
    options: any;
    connectArgs: any = null;
    pubs = new Map<string, any>();
    localParticipant: any;
    constructor(options: any) {
      super(); this.options = options; MockRoom.instances.push(this);
      const self = this;
      this.localParticipant = {
        identity: 'alice',
        getTrackPublication: (source: string) => self.pubs.get(source),
        setMicrophoneEnabled: vi.fn(async (enabled: boolean) => { if (enabled) { const pub = { track: fakeTrack('audio'), isMuted: false, kind: 'audio' }; self.pubs.set('microphone', pub); return pub; } const p = self.pubs.get('microphone'); if (p) p.isMuted = true; return p; }),
        setCameraEnabled: vi.fn(async (enabled: boolean) => { if (enabled) { const pub = self.pubs.get('camera') ?? { track: fakeTrack('video'), isMuted: false, kind: 'video' }; pub.isMuted = false; self.pubs.set('camera', pub); return pub; } const p = self.pubs.get('camera'); if (p) p.isMuted = true; return p; }),
        unpublishTrack: vi.fn(async (track: any) => { for (const [k, p] of self.pubs) if (p.track === track) self.pubs.delete(k); }),
        publishData: vi.fn(async () => {}),
      };
    }
    connect = vi.fn(async (url: string, token: string, opts: any) => {
      this.connectArgs = { url, token, opts };
      if (MockRoom.connectDelayMs) await new Promise((r) => setTimeout(r, MockRoom.connectDelayMs));
      if (MockRoom.connectError) { const e = MockRoom.connectError; MockRoom.connectError = null; throw e; }
      if (MockRoom.onConnect) { const h = MockRoom.onConnect; MockRoom.onConnect = null; h(this); }
      this.state = 'connected';
    });
    disconnect = vi.fn(async () => { this.state = 'disconnected'; this.emit('disconnected', 1 /* CLIENT_INITIATED */); });
    switchActiveDevice = vi.fn(async () => true);
  }
  return { MockRoom, ConnectionError, ConnectionErrorReason, fakeTrack };
});

vi.mock('livekit-client', () => ({
  Room: H.MockRoom,
  RoomEvent: {
    Connected: 'connected', Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected',
    ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
    TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed', TrackMuted: 'trackMuted', TrackUnmuted: 'trackUnmuted',
    DataReceived: 'dataReceived', MediaDevicesError: 'mediaDevicesError', MediaDevicesChanged: 'mediaDevicesChanged',
  },
  ConnectionState: { Disconnected: 'disconnected', Connecting: 'connecting', Connected: 'connected', Reconnecting: 'reconnecting' },
  DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, STATE_MISMATCH: 6, JOIN_FAILURE: 7, MIGRATION: 8, SIGNAL_CLOSE: 9, ROOM_CLOSED: 10, USER_UNAVAILABLE: 11, USER_REJECTED: 12 },
  Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera', Microphone: 'microphone' } },
  ConnectionError: H.ConnectionError,
  ConnectionErrorReason: H.ConnectionErrorReason,
  DataPacket_Kind: { RELIABLE: 0, LOSSY: 1 },
  setLogLevel: vi.fn(),
}));

import { Call, CallError, encodeMessage, decodeMessage } from '../src/index';

const { MockRoom, ConnectionError, ConnectionErrorReason, fakeTrack } = H;
const bob = () => ({ identity: 'bob', name: 'Bob', isAgent: false, kind: 0, getTrackPublication: () => undefined });
const agent = () => ({ identity: 'moderator', name: '', isAgent: true, kind: 4, getTrackPublication: () => undefined });
const room = () => MockRoom.instances[MockRoom.instances.length - 1]!;

async function connected(opts: Record<string, unknown> = {}, cred: Record<string, unknown> = {}) {
  const call = Call.create(credential(cred), { telemetry: false, ...opts });
  const states: string[] = [];
  call.on('stateChanged', (s, r) => states.push(r ? `${s}:${r}` : s));
  await call.connect();
  return { call, states, room: room() };
}

beforeEach(() => { MockRoom.instances = []; MockRoom.connectError = null; MockRoom.connectDelayMs = 0; MockRoom.onConnect = null; installMediaDevices(); });
afterEach(() => { vi.useRealTimers(); });

describe('Call lifecycle', () => {
  it('connects, publishes both tracks and exposes state', async () => {
    const { call, states, room } = await connected();
    expect(states).toEqual(['connecting', 'connected']);
    expect(room.connectArgs.url).toBe('wss://calls-eu.example.com');
    expect(room.connectArgs.opts).toEqual({ autoSubscribe: true });
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ echoCancellation: true }), expect.objectContaining({ dtx: false }));
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ resolution: expect.objectContaining({ width: 960, height: 540, frameRate: 60 }) }), expect.objectContaining({ videoCodec: 'h264', simulcast: false, videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 60 }, degradationPreference: 'maintain-framerate' }));
    expect(call.localVideo).not.toBeNull(); expect(call.state).toBe('connected'); expect(call.region).toBe('default'); expect(call.identity).toBe('alice');
    await call.leave();
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('left'); expect(states[states.length - 1]).toBe('ended:left');
    expect(room.disconnect).toHaveBeenCalled();
  });
  it('room options carry adaptive stream, dynacast and the profile', async () => {
    const { room, call } = await connected({ videoProfile: 'p720_60', latencyMode: 'smooth' });
    expect(room.options.adaptiveStream).toBe(true); expect(room.options.dynacast).toBe(true);
    expect(room.options.publishDefaults).toMatchObject({ simulcast: true, videoEncoding: { maxBitrate: 1_800_000, maxFramerate: 60 }, degradationPreference: 'maintain-resolution' });
    await call.leave();
  });
  it('audio-only and video-off options skip publishing', async () => {
    const { room, call } = await connected({ videoProfile: 'audioOnly' });
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    await call.leave();
    const c2 = await connected({ video: false, audio: false });
    expect(c2.room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(c2.room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    await c2.call.leave();
  });
  it('forceRelay passes an ICE policy through connect options', async () => {
    const { room, call } = await connected({ forceRelay: true });
    expect(room.connectArgs.opts.rtcConfig).toEqual({ iceTransportPolicy: 'relay' });
    await call.leave();
  });
  it('a pinned region is used without probing', async () => {
    const regions = [{ name: 'us', url: 'wss://us.example' }, { name: 'eu', url: 'wss://eu.example' }];
    const { room, call } = await connected({ region: 'eu' }, { regions });
    expect(room.connectArgs.url).toBe('wss://eu.example'); expect(call.region).toBe('eu');
    await call.leave();
  });
  it('refuses to connect twice and rejects an expired credential before touching the network', async () => {
    const { call } = await connected();
    await expect(call.connect()).rejects.toMatchObject({ code: 'internal' });
    await call.leave();
    const expired = Call.create(credential({ expires_at: Math.floor(Date.now() / 1000) - 5 }), { telemetry: false });
    const warned = vi.fn(); expired.on('credentialExpiring', warned);
    await expect(expired.connect()).rejects.toMatchObject({ code: 'credentialExpired' });
    expect(warned).toHaveBeenCalled(); expect(MockRoom.instances).toHaveLength(1);
  });
  it('maps a rejected join to credential and ends the call', async () => {
    MockRoom.connectError = new ConnectionError('invalid token', ConnectionErrorReason.NotAllowed, 401);
    const call = Call.create(credential(), { telemetry: false });
    const errors: CallError[] = []; call.on('error', (e) => errors.push(e));
    await expect(call.connect()).rejects.toMatchObject({ code: 'credentialInvalid' });
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('credential'); expect(errors[0]?.code).toBe('credentialInvalid');
  });
  it('a third human means roomFull, whether the server says so or the room already has two', async () => {
    MockRoom.connectError = new ConnectionError('room is full', ConnectionErrorReason.NotAllowed, 403);
    await expect(Call.create(credential(), { telemetry: false }).connect()).rejects.toMatchObject({ code: 'roomFull' });
    const call = Call.create(credential(), { telemetry: false });
    // two humans already present when we join
    MockRoom.onConnect = (r) => { r.remoteParticipants.set('bob', bob()); r.remoteParticipants.set('carol', { ...bob(), identity: 'carol' }); };
    await expect(call.connect()).rejects.toMatchObject({ code: 'roomFull' });
    expect(call.endReason).toBe('roomFull');
  });
  it('leaving while connecting ends with reason left', async () => {
    MockRoom.connectDelayMs = 30;
    const call = Call.create(credential(), { telemetry: false });
    const p = call.connect();
    await call.leave();
    await expect(p).rejects.toBeInstanceOf(CallError);
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('left');
  });
});

describe('Peer and tracks', () => {
  it('adopts an existing peer and ignores agents', async () => {
    MockRoom.onConnect = (r) => { r.remoteParticipants.set('bob', bob()); r.remoteParticipants.set('moderator', agent()); };
    const { call } = await connected();
    expect(call.peer).toEqual({ identity: 'bob', name: 'Bob', audioMuted: false, videoMuted: false }); expect(call.agentJoined).toBe(true);
    await call.leave();
  });
  it('emits peerJoined, remote tracks, peerMuted, and ends on peerLeft by default', async () => {
    const { call, room, states } = await connected();
    const joined = vi.fn(), video = vi.fn(), audio = vi.fn(), muted = vi.fn(), left = vi.fn();
    call.on('peerJoined', joined); call.on('remoteVideo', video); call.on('remoteAudio', audio); call.on('peerMuted', muted); call.on('peerLeft', left);
    const b = bob();
    room.emit('participantConnected', b);
    expect(joined).toHaveBeenCalledWith(expect.objectContaining({ identity: 'bob' }));
    room.emit('participantConnected', agent()); expect(joined).toHaveBeenCalledTimes(1); expect(call.agentJoined).toBe(true);
    const v = fakeTrack('video'), a = fakeTrack('audio');
    room.emit('trackSubscribed', v, {}, b); room.emit('trackSubscribed', a, {}, b);
    expect(video).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video' })); expect(call.remoteVideo?.kind).toBe('video');
    expect(audio).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio' })); expect(a.attach).toHaveBeenCalled();
    room.emit('trackMuted', { kind: 'audio' }, b); expect(muted).toHaveBeenCalledWith('audio', true); expect(call.peer?.audioMuted).toBe(true);
    room.emit('trackUnmuted', { kind: 'video' }, { identity: 'someone-else' }); expect(muted).toHaveBeenCalledTimes(1);
    room.emit('trackUnsubscribed', v); expect(video).toHaveBeenLastCalledWith(null); expect(call.remoteVideo).toBeNull();
    room.emit('participantDisconnected', b);
    await new Promise((r) => setTimeout(r, 0));
    expect(left).toHaveBeenCalledWith(expect.objectContaining({ identity: 'bob' }));
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('peerLeft'); expect(states[states.length - 1]).toBe('ended:peerLeft');
  });
  it('endOnPeerLeft false keeps the call open', async () => {
    const { call, room } = await connected({ endOnPeerLeft: false });
    const b = bob(); room.emit('participantConnected', b); room.emit('participantDisconnected', b);
    await new Promise((r) => setTimeout(r, 0));
    expect(call.state).toBe('connected'); expect(call.peer).toBeNull();
    await call.leave();
  });
  it('a second human after the peer is ignored', async () => {
    const { call, room } = await connected();
    room.emit('participantConnected', bob()); room.emit('participantConnected', { ...bob(), identity: 'carol' });
    expect(call.peer?.identity).toBe('bob');
    await call.leave();
  });
});

describe('Disconnect and reconnect', () => {
  it('maps engine disconnect reasons to end reasons', async () => {
    const cases: Array<[number, string]> = [[1, 'left'], [5, 'roomClosed'], [10, 'roomClosed'], [4, 'roomClosed'], [2, 'credential'], [7, 'error'], [9, 'network'], [0, 'network']];
    for (const [reason, expected] of cases) {
      const { call, room } = await connected();
      room.emit('disconnected', reason);
      await new Promise((r) => setTimeout(r, 0));
      expect(call.state).toBe('ended'); expect(call.endReason).toBe(expected);
    }
  });
  it('reconnecting then reconnected round-trips the state; the window expires to network', async () => {
    vi.useFakeTimers();
    const { call, room, states } = await connected();
    room.emit('reconnecting'); expect(call.state).toBe('reconnecting');
    room.emit('reconnected'); expect(call.state).toBe('connected');
    room.emit('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('network');
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'reconnecting', 'ended:network']);
  });
  it('autoReconnect false ends on the first drop', async () => {
    const { call, room } = await connected({ autoReconnect: false });
    room.emit('reconnecting');
    await new Promise((r) => setTimeout(r, 0));
    expect(call.state).toBe('ended'); expect(call.endReason).toBe('network');
  });
});

describe('Credential expiry', () => {
  it('warns two minutes before expiry and again on reconnect when already expired', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    const { call, room } = await connected({}, { expires_at: '2026-09-08T10:05:00Z' });
    const warn = vi.fn(); call.on('credentialExpiring', warn);
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1); expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2); expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-09-08T10:06:00Z'));
    room.emit('reconnecting'); expect(warn).toHaveBeenCalledTimes(2);
    call.updateCredential(credential({ expires_at: '2026-09-08T10:30:00Z' }));
    expect(call.credentialExpiresAt).toBe(Date.parse('2026-09-08T10:30:00Z'));
    expect(() => call.updateCredential(credential({ identity: 'mallory' }))).toThrow(/different call or identity/);
    await call.leave();
  });
});

describe('Controls and messages', () => {
  it('mute and camera toggles go through the engine', async () => {
    const { call, room } = await connected();
    await call.setMicrophoneEnabled(false); expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await call.setCameraEnabled(false); expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
    await call.setCameraEnabled(true); expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true);
    await call.leave();
    await expect(call.setMicrophoneEnabled(true)).rejects.toMatchObject({ code: 'internal' });
  });
  it('setVideoProfile restarts capture in place, republishes when simulcast changes, unpublishes for audioOnly', async () => {
    const { call, room } = await connected();
    const track = room.pubs.get('camera').track;
    await call.setVideoProfile('p540_30');
    expect(track.restartTrack).toHaveBeenCalledWith(expect.objectContaining({ resolution: expect.objectContaining({ frameRate: 30 }) }));
    expect(track.sender.setParameters).toHaveBeenCalled(); expect(call.videoProfile).toBe('p540_30');
    await call.setVideoProfile('p720_30');
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1); expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, expect.anything(), expect.objectContaining({ simulcast: true }));
    await call.setVideoProfile('audioOnly'); expect(call.localVideo).toBeNull(); expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(2);
    await expect(call.setVideoProfile('p9000' as any)).rejects.toThrow(/Unknown video profile/);
    await call.leave();
  });
  it('setLatencyMode applies the jitter target to the current receiver', async () => {
    const { call, room } = await connected();
    const v = fakeTrack('video'); (v.receiver as any).jitterBufferTarget = null;
    room.emit('trackSubscribed', v, {}, bob());
    expect((v.receiver as any).jitterBufferTarget).toBe(0);
    await call.setLatencyMode('smooth'); expect((v.receiver as any).jitterBufferTarget).toBe(150); expect(call.latencyMode).toBe('smooth');
    await call.leave();
  });
  it('sendMessage enforces the size and rate limits and uses the message topic', async () => {
    const { call, room } = await connected();
    await call.sendMessage({ hi: 1 }); await call.sendMessage('text', false);
    expect(room.localParticipant.publishData).toHaveBeenLastCalledWith(expect.any(Uint8Array), { reliable: false, topic: 'qencode:msg' });
    await expect(call.sendMessage('x'.repeat(15 * 1024))).rejects.toThrow(/limit is 15360/);
    for (let i = 0; i < 28; i++) await call.sendMessage('m');
    await expect(call.sendMessage('one too many')).rejects.toThrow(/rate limit/);
    await call.leave();
  });
  it('delivers peer messages and peer rtt from the data channel', async () => {
    const { call, room } = await connected();
    const got = vi.fn(); call.on('message', got);
    room.emit('dataReceived', encodeMessage({ a: 1 }), bob(), 1, 'qencode:msg');
    room.emit('dataReceived', encodeMessage('hey'), bob(), 1, 'qencode:msg');
    room.emit('dataReceived', encodeMessage(new Uint8Array([1, 2])), bob(), 1, 'qencode:msg');
    room.emit('dataReceived', new TextEncoder().encode('{"t":"rtt","rtt":41}'), bob(), 0, 'qencode:stats');
    room.emit('dataReceived', encodeMessage('from agent'), agent(), 1, 'qencode:msg');
    expect(got.mock.calls.map((c) => c[0])).toEqual([{ a: 1 }, 'hey', new Uint8Array([1, 2])]);
    expect((call as any).peerRttMs).toBe(41);
    await call.leave();
  });
  it('message envelope round-trips every payload kind', () => {
    expect(decodeMessage(encodeMessage('s'))).toBe('s');
    expect(decodeMessage(encodeMessage({ k: [1, 2] }))).toEqual({ k: [1, 2] });
    expect(decodeMessage(encodeMessage(new Uint8Array([9])))).toEqual(new Uint8Array([9]));
    expect(() => decodeMessage(new Uint8Array([7]))).toThrow(/envelope/);
  });
});

describe('Stats loop', () => {
  it('emits stats every second with quality and posts rtt to the peer', async () => {
    vi.useFakeTimers();
    const { call, room } = await connected();
    const v = fakeTrack('video');
    const rep = (t: number) => report([
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }, { id: 'P', type: 'candidate-pair', localCandidateId: 'L', currentRoundTripTime: 0.03 },
      { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }, { id: 'C', type: 'codec', mimeType: 'video/H264' },
      { id: 'I', type: 'inbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 50, frameWidth: 960, frameHeight: 540, jitter: 0.003, jitterBufferDelay: 2 * t, jitterBufferEmittedCount: 50 * t, totalDecodeTime: 0.05 * t, framesDecoded: 50 * t, packetsLost: 0, packetsReceived: 100 * t, bytesReceived: 100_000 * t, freezeCount: 0, totalFreezesDuration: 0 },
    ]);
    let n = 0; (v.receiver as any).getStats = vi.fn(async () => rep(++n));
    room.emit('trackSubscribed', v, {}, bob());
    const stats = vi.fn(), quality = vi.fn(); call.on('stats', stats); call.on('qualityChanged', quality);
    await vi.advanceTimersByTimeAsync(2100);
    expect(stats).toHaveBeenCalledTimes(2);
    const s = call.stats!;
    expect(s.recv.rttMs).toBe(30); expect(s.recv.jitterBufferMs).toBe(40); expect(s.recv.transport).toBe('udp'); expect(s.region).toBe('eu-central'); expect(s.nodeId).toBe('ND_1');
    expect(s.estimatedLatencyMs).toBe(91); // 15 + 15 + 40 + 1 + 20
    expect(quality).toHaveBeenCalledWith('good', 'recv');
    expect(room.localParticipant.publishData.mock.calls.some((c: any[]) => c[1]?.topic === 'qencode:stats' && c[1]?.reliable === false)).toBe(true);
    await call.leave();
    const calls = stats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(stats).toHaveBeenCalledTimes(calls); // loop stopped on leave
  });
});

describe('Devices', () => {
  it('lists devices with labels or fallbacks and switches through the engine', async () => {
    installMediaDevices([{ deviceId: 'c1', kind: 'videoinput', label: 'FaceTime' }, { deviceId: 'm1', kind: 'audioinput', label: '' }, { deviceId: 's1', kind: 'audiooutput', label: 'Speakers' }]);
    const { call, room } = await connected();
    const list = await call.devices.list();
    expect(list.cameras).toEqual([{ id: 'c1', label: 'FaceTime' }]); expect(list.microphones[0]!.label).toBe('microphone 2');
    await call.devices.setCamera('c1'); expect(room.switchActiveDevice).toHaveBeenCalledWith('videoinput', 'c1', true);
    await call.devices.setMicrophone('m1'); expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'm1', true);
    room.switchActiveDevice.mockResolvedValueOnce(false);
    await expect(call.devices.setCamera('gone')).rejects.toMatchObject({ code: 'deviceUnavailable' });
    await call.leave();
  });
  it('speaker selection reports unsupported without setSinkId', async () => {
    const { call } = await connected();
    if (!call.devices.canSelectSpeaker) await expect(call.devices.setSpeaker('s1')).rejects.toMatchObject({ code: 'unsupported' });
    await call.leave();
  });
  it('devicesChanged fires on hot-plug', async () => {
    const md = installMediaDevices([]);
    const { call, room } = await connected();
    const changed = vi.fn(); call.on('devicesChanged', changed);
    room.emit('mediaDevicesChanged'); await new Promise((r) => setTimeout(r, 0));
    expect(changed).toHaveBeenCalledWith({ cameras: [], microphones: [], speakers: [] });
    const onChange = vi.fn(); call.devices.onChange(onChange); md.fire(); await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalled();
    await call.leave();
  });
});

describe('regressions found in the stage smoke test', () => {
  it('reports a peer already in the room as peerJoined right after connected', async () => {
    MockRoom.onConnect = (r: any) => { r.remoteParticipants.set('bob', bob()); };
    const call = Call.create(credential(), { telemetry: false });
    const seen: string[] = [];
    call.on('stateChanged', (s) => seen.push('state:' + s));
    call.on('peerJoined', (p) => seen.push('peerJoined:' + p.identity));
    await call.connect();
    expect(seen).toEqual(['state:connecting', 'state:connected', 'peerJoined:bob']);
    expect(call.peer?.identity).toBe('bob');
    await call.leave();
  });
  it('keeps the peerLeft reason even though the engine emits Disconnected during teardown', async () => {
    const { call, room, states } = await connected();
    const b = bob(); room.emit('participantConnected', b); room.emit('participantDisconnected', b);
    await new Promise((r) => setTimeout(r, 0));
    expect(room.disconnect).toHaveBeenCalled();
    expect(states[states.length - 1]).toBe('ended:peerLeft');
  });
  it('flags lossy data messages as unreliable', async () => {
    const { call, room } = await connected();
    const got: Array<[unknown, boolean]> = [];
    call.on('message', (m, reliable) => got.push([m, reliable]));
    room.emit('dataReceived', encodeMessage({ n: 1 }), bob(), 0, 'qencode:msg');
    room.emit('dataReceived', encodeMessage({ n: 2 }), bob(), 1, 'qencode:msg');
    expect(got).toEqual([[{ n: 1 }, true], [{ n: 2 }, false]]);
    await call.leave();
  });
});
