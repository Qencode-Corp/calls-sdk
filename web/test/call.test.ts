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
    mediaStreamTrack: { kind, settings: {} as Record<string, unknown>, getSettings() { return this.settings; } }, attach: vi.fn((el?: any) => el), detach: vi.fn(), stop: vi.fn(), isMuted: false,
    restartTrack: vi.fn(async function (this: any, opts: any) { const s = this.mediaStreamTrack.settings; const id = opts?.deviceId?.exact ?? opts?.deviceId; if (id === 'gone') throw Object.assign(new Error('no such camera'), { name: 'OverconstrainedError' }); if (id) s.deviceId = id; if (opts?.facingMode && this.honourFacing) s.facingMode = opts.facingMode; }),
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
        setCameraEnabled: vi.fn(async (enabled: boolean, capture?: any) => { if (enabled) { const id = capture?.deviceId?.exact ?? capture?.deviceId; if (id === 'gone') throw Object.assign(new Error('no such camera'), { name: 'OverconstrainedError' }); const pub = self.pubs.get('camera') ?? { track: fakeTrack('video'), isMuted: false, kind: 'video' }; pub.isMuted = false; pub.track.isMuted = false; if (id) pub.track.mediaStreamTrack.settings.deviceId = id; self.pubs.set('camera', pub); return pub; } const p = self.pubs.get('camera'); if (p) { p.isMuted = true; p.track.isMuted = true; } return p; }),
        unpublishTrack: vi.fn(async (track: any, stop?: boolean) => { for (const [k, p] of self.pubs) if (p.track === track) self.pubs.delete(k); if (stop !== false) track.mediaStreamTrack?.stop?.(); }),
        publishTrack: vi.fn(async (mst: any, opts: any) => { const t = fakeTrack('video'); t.mediaStreamTrack = mst; const pub = { track: t, isMuted: false, kind: 'video', options: opts }; self.pubs.set(opts?.source ?? 'camera', pub); return pub; }),
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
  it('a join refused with a bare websocket close is roomFull when validate still accepts the token', async () => {
    const realFetch = globalThis.fetch;
    const probe = vi.fn(async (url: string) => new Response(url.includes('/rtc/validate?access_token=') ? 'success' : 'no', { status: 200 }));
    (globalThis as any).fetch = probe;
    MockRoom.connectError = new ConnectionError('could not establish signal connection: Encountered websocket error during connection establishment', ConnectionErrorReason.WebSocket);
    const full = Call.create(credential(), { telemetry: false });
    await expect(full.connect()).rejects.toMatchObject({ code: 'roomFull' });
    expect(full.endReason).toBe('roomFull');
    expect(String(probe.mock.calls[0]![0])).toMatch(/^https:\/\/calls-eu\.example\.com\/rtc\/validate\?access_token=/);
    // validate rejecting the token means it really was the network or the token, not capacity
    (globalThis as any).fetch = vi.fn(async () => new Response('bad', { status: 401 }));
    MockRoom.connectError = new ConnectionError('ws', ConnectionErrorReason.WebSocket);
    await expect(Call.create(credential(), { telemetry: false }).connect()).rejects.toMatchObject({ code: 'network' });
    // a timeout is not probed at all
    (globalThis as any).fetch = vi.fn(async () => new Response('success', { status: 200 }));
    MockRoom.connectError = new ConnectionError('slow', ConnectionErrorReason.Timeout);
    await expect(Call.create(credential(), { telemetry: false }).connect()).rejects.toMatchObject({ code: 'network' });
    globalThis.fetch = realFetch;
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
  it('lists devices with labels, fallbacks and a facing hint, and switches through the engine', async () => {
    installMediaDevices([{ deviceId: 'c1', kind: 'videoinput', label: 'FaceTime HD Camera' }, { deviceId: 'c2', kind: 'videoinput', label: 'camera2 0, facing back' }, { deviceId: 'm1', kind: 'audioinput', label: '' }, { deviceId: 's1', kind: 'audiooutput', label: 'Speakers' }]);
    const { call, room } = await connected();
    const list = await call.devices.list();
    expect(list.cameras).toEqual([{ id: 'c1', label: 'FaceTime HD Camera', facing: null }, { id: 'c2', label: 'camera2 0, facing back', facing: 'environment' }]); expect(list.microphones[0]!.label).toBe('microphone 3');
    const track = room.pubs.get('camera').track;
    await call.devices.setCamera('c2');
    expect(track.restartTrack).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'c2' }, resolution: expect.objectContaining({ width: 960 }) }));
    expect(call.devices.cameraId).toBe('c2');
    await call.setVideoProfile('p540_30');                      // a profile change keeps the chosen camera
    expect(track.restartTrack).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: { exact: 'c2' }, resolution: expect.objectContaining({ frameRate: 30 }) }));
    await call.devices.setMicrophone('m1'); expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'm1', true);
    // a camera that cannot be opened: the failure is reported and the previous camera is reopened
    await expect(call.devices.setCamera('gone')).rejects.toMatchObject({ code: 'deviceUnavailable' });
    expect(track.restartTrack).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: { exact: 'c2' } }));
    expect(call.devices.cameraId).toBe('c2');
    await call.leave();
  });
  it('a camera chosen before connect or while the camera is off is used when it is next published', async () => {
    const call = Call.create(credential(), { telemetry: false });
    await call.devices.setCamera('c9');
    await call.devices.setMicrophone('m9');
    await call.connect();
    const r = room();
    expect(r.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ deviceId: { exact: 'c9' } }), expect.anything());
    expect(r.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ deviceId: 'm9' }), expect.anything());
    await call.setCameraEnabled(false);
    const track = r.pubs.get('camera').track;
    track.restartTrack.mockClear();
    await call.devices.setCamera('c10');
    expect(track.restartTrack).not.toHaveBeenCalled();           // deferred: the camera is off
    await call.setCameraEnabled(true);
    expect(track.restartTrack).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'c10' } }));
    expect(call.devices.cameraId).toBe('c10');
    await call.leave();
  });
  it('a remembered camera that is gone at connect falls back to the default one', async () => {
    const { call, room } = await connected({ cameraId: 'gone' });
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, expect.not.objectContaining({ deviceId: expect.anything() }), expect.anything());
    expect(call.localVideo).not.toBeNull(); expect(call.devices.cameraId).toBeNull();
    await call.leave();
  });
  it('setCameraFacing uses the browser hint on phones and a labelled camera elsewhere', async () => {
    installMediaDevices([{ deviceId: 'front', kind: 'videoinput', label: 'Front Camera' }, { deviceId: 'back', kind: 'videoinput', label: 'Back Camera' }]);
    const { call, room } = await connected();
    const track = room.pubs.get('camera').track;
    track.honourFacing = true;                                   // a phone: the constraint picks the camera
    await call.devices.setCameraFacing('environment');
    expect(track.restartTrack).toHaveBeenLastCalledWith(expect.objectContaining({ facingMode: 'environment' }));
    expect(call.devices.cameraFacing).toBe('environment');
    track.honourFacing = false; track.mediaStreamTrack.settings = {};  // a desktop: the hint is ignored
    await call.devices.setCameraFacing('user');
    expect(track.restartTrack).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: { exact: 'front' } }));
    expect(call.devices.cameraId).toBe('front'); expect(call.devices.cameraFacing).toBe('user');
    installMediaDevices([{ deviceId: 'only', kind: 'videoinput', label: 'USB Camera' }]);
    await expect(call.devices.setCameraFacing('environment')).rejects.toMatchObject({ code: 'deviceUnavailable' });
    await expect(call.devices.setCameraFacing('sideways' as any)).rejects.toThrow(/Unknown camera facing/);
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

describe('Custom video source, encoding and jitter target (0.2.0)', () => {
  const mst = (): MediaStreamTrack => ({ kind: 'video', stop: vi.fn(), id: Math.random().toString(36).slice(2) } as unknown as MediaStreamTrack);
  it('publishes a passed track under the camera source and never stops it', async () => {
    const track = mst();
    const { call, room } = await connected({ videoSource: track, codec: 'vp9', simulcast: true });
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(track, expect.objectContaining({ source: 'camera', videoCodec: 'vp9', simulcast: true, videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 60 } }));
    expect(call.localVideo?.mediaStreamTrack).toBe(track); expect(call.videoCodec).toBe('vp9'); expect(call.simulcast).toBe(true);
    await expect(call.devices.setCamera('cam-2')).rejects.toMatchObject({ code: 'unsupported' });
    await call.setVideoProfile('p720_30');                       // fixed track: encoding only, no republish
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(room.pubs.get('camera').track.sender.setParameters).toHaveBeenCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000, maxFramerate: 30 })] }));
    await call.leave();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(expect.anything(), false);
    expect((track as any).stop).not.toHaveBeenCalled();
  });
  it('calls a factory with the profile on every publish and stops what it returned', async () => {
    const made: MediaStreamTrack[] = [];
    const factory = vi.fn((p: { name: string }) => { const t = mst(); (t as any).profile = p.name; made.push(t); return t; });
    const { call, room } = await connected({ videoSource: factory, videoProfile: 'p540_30' });
    expect(factory).toHaveBeenCalledTimes(1); expect(factory.mock.calls[0]![0]).toMatchObject({ name: 'p540_30', width: 960, height: 540 });
    await call.setVideoProfile('p540_60');                       // factory: republish at the new size
    expect(factory).toHaveBeenCalledTimes(2); expect(factory.mock.calls[1]![0]).toMatchObject({ name: 'p540_60' });
    expect((made[0] as any).stop).toHaveBeenCalled(); expect((made[1] as any).stop).not.toHaveBeenCalled();
    await call.setVideoEncoding({ codec: 'av1' });
    expect(factory).toHaveBeenCalledTimes(3);
    expect(room.localParticipant.publishTrack).toHaveBeenLastCalledWith(made[2], expect.objectContaining({ videoCodec: 'av1' }));
    await call.setVideoSource(null);                             // back to the camera
    expect((made[2] as any).stop).toHaveBeenCalled();
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, expect.anything(), expect.objectContaining({ videoCodec: 'av1' }));
    await call.leave();
  });
  it('a republish while the camera is muted leaves it off, and a factory failure surfaces as a CallError', async () => {
    const { call, room } = await connected();
    await call.setCameraEnabled(false);
    await call.setVideoEncoding({ simulcast: true });
    expect(room.pubs.get('camera')).toBeUndefined();
    await call.setCameraEnabled(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, expect.anything(), expect.objectContaining({ simulcast: true }));
    await expect(call.setVideoSource(() => ({ kind: 'audio' }) as unknown as MediaStreamTrack)).rejects.toMatchObject({ code: 'internal' });
    await call.leave();
    expect(() => Call.create(credential(), { codec: 'h265' as any })).toThrow(/Unknown video codec/);
    expect(() => Call.create(credential(), { jitterBufferTargetMs: -1 })).toThrow(/between 0 and 4000/);
  });
  it('jitter target override wins over the mode until the mode is set again, and reports support', async () => {
    const { call, room } = await connected({ jitterBufferTargetMs: 50 });
    expect(call.jitterBufferSupport).toBeNull();
    const v = fakeTrack('video'); (v.receiver as any).jitterBufferTarget = null;
    room.emit('trackSubscribed', v, {}, bob());
    expect((v.receiver as any).jitterBufferTarget).toBe(50); expect(call.jitterBufferSupport).toBe('jitterBufferTarget');
    expect(call.setJitterBufferTarget(100)).toBe('jitterBufferTarget'); expect((v.receiver as any).jitterBufferTarget).toBe(100); expect(call.jitterBufferTargetMs).toBe(100);
    await call.setLatencyMode('smooth'); expect((v.receiver as any).jitterBufferTarget).toBe(150); expect(call.jitterBufferTargetMs).toBe(150);
    const legacy = fakeTrack('video'); (legacy.receiver as any).playoutDelayHint = null;
    room.emit('trackSubscribed', legacy, {}, bob());
    expect(call.jitterBufferSupport).toBe('playoutDelayHint'); expect((legacy.receiver as any).playoutDelayHint).toBe(0.15);
    room.emit('trackSubscribed', fakeTrack('video'), {}, bob());
    expect(call.setJitterBufferTarget(0)).toBe('unsupported');
    await call.leave();
  });
  it('telemetryExtra reaches the posted rows and exposes the region probe', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response('{}'));
    const extra = vi.fn((d: string) => (d === 'recv' ? { g2g_p50: 88, lock: true } : { g2g_p50: 91 }));
    const call = Call.create(credential(), { telemetry: true, telemetryExtra: extra, apiBase: 'https://api.example' });
    await call.connect();
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = f;                               // Telemetry resolves fetch at flush time
    const v = fakeTrack('video'); (v.receiver as any).getStats = vi.fn(async () => report([{ id: 'I', type: 'inbound-rtp', kind: 'video', framesPerSecond: 30 }]));
    room().emit('trackSubscribed', v, {}, bob());
    await vi.advanceTimersByTimeAsync(5100);
    expect(extra).toHaveBeenCalledWith('recv'); expect(extra).toHaveBeenCalledWith('send');
    expect(f).toHaveBeenCalled();
    const body = JSON.parse(((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    const recvRow = body.samples.find((s: any) => s.direction === 'recv'), sendRow = body.samples.find((s: any) => s.direction === 'send');
    expect(recvRow).toMatchObject({ g2g_p50: 88 }); expect(recvRow.extra).toMatchObject({ lock: true, sdk: expect.any(String) });
    expect(sendRow).toMatchObject({ g2g_p50: 91 });
    expect(call.regionProbe).toBeNull();
    await call.leave();
    globalThis.fetch = realFetch;
  });
});

describe('regressions found in the first live smoke test', () => {
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
