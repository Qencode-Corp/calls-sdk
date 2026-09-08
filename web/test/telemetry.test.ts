import { describe, it, expect, vi, afterEach } from 'vitest';
import { Telemetry } from '../src/telemetry';
import type { CallStats } from '../src/stats';

const snap = (ts: number): CallStats => ({
  ts, recv: { rttMs: 20, jitterBufferMs: 40, decodeMs: 1, fps: 55, width: 960, height: 540, kbps: 900, lossPct: 0, jitterMs: 4, freezes: 0, freezeMs: 0, processingMs: 45, absCaptureLatencyMs: null, codec: 'H264', transport: 'udp', candidateType: 'srflx' },
  send: { rttMs: 22, encodeMs: 1, fps: 60, width: 960, height: 540, kbps: 1000, targetKbps: 1100, qualityLimitation: 'none', lossPct: 0, codec: 'H264', transport: 'udp', candidateType: 'srflx' },
  peerRttMs: 30, estimatedLatencyMs: 85, quality: { recv: 'good', send: 'good' }, region: 'eu-central', nodeId: 'ND_1', serverVersion: '1.13.6', joinMs: 900, audioRoute: 'unknown',
});

describe('Telemetry', () => {
  afterEach(() => vi.useRealTimers());
  it('posts batches to the contract URL with the participant token', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response('{}'));
    const t = new Telemetry({ apiBase: 'https://api.example/', callId: 'c 1', token: 'tok', enabled: true, sdkVersion: '0.1.0', fetchFn: f as any, userAgent: 'UA' });
    expect(t.enabled).toBe(true); expect(t.url).toBe('https://api.example/v1/calls/c%201/stats');
    t.start(900);
    t.push(snap(1000), 'bob'); t.push(snap(2000), 'bob');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/calls/c%201/stats');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string);
    expect(body.samples).toHaveLength(4);
    expect(body.samples[0]).toMatchObject({ direction: 'recv', ts: 1000, rtt_ms: 20, net_one_way_ms: 25, jb_ms: 40, peer_identity: 'bob', server_region: 'eu-central', join_ms: 900, transport: 'udp' });
    expect(body.samples[1]).toMatchObject({ direction: 'send', encode_ms: 1, kbps: 1000 });
    expect(body.samples[0].extra).toMatchObject({ sdk: '0.1.0', platform: 'web', user_agent: 'UA', estimated_latency_ms: 85, quality: 'good' });
    // join_ms only on the first post
    t.push(snap(3000), 'bob');
    await vi.advanceTimersByTimeAsync(5000);
    const body2 = JSON.parse(((f.mock.calls[1] as unknown as [string, RequestInit])[1]).body as string);
    expect(body2.samples[0].join_ms).toBeUndefined();
    await t.stop();
  });
  it('is inert when disabled or without a call id, and never throws on network failure', async () => {
    const f = vi.fn(async () => { throw new Error('offline'); });
    const off = new Telemetry({ apiBase: 'https://api.example', callId: 'c-1', token: 't', enabled: false, sdkVersion: '0', fetchFn: f as any });
    off.start(1); off.push(snap(1), null); await off.flush(); expect(f).not.toHaveBeenCalled();
    const manual = new Telemetry({ apiBase: 'https://api.example', callId: null, token: 't', enabled: true, sdkVersion: '0', fetchFn: f as any });
    expect(manual.enabled).toBe(false); expect(manual.url).toBeNull();
    const on = new Telemetry({ apiBase: 'https://api.example', callId: 'c-1', token: 't', enabled: true, sdkVersion: '0', fetchFn: f as any });
    on.push(snap(1), null); await expect(on.flush()).resolves.toBeUndefined(); expect(f).toHaveBeenCalledTimes(1);
    await on.stop();
  });
  it('routes app fields: measured-latency columns stay columns, the rest goes under extra, SDK keys win', async () => {
    const f = vi.fn(async () => new Response('{}'));
    const t = new Telemetry({ apiBase: 'https://api.example', callId: 'c-1', token: 'tok', enabled: true, sdkVersion: '0.2.0', fetchFn: f as any, userAgent: 'UA' });
    t.push(snap(1000), 'bob', { recv: { g2g_p50: 84.4, g2g_p95: 101, g2g_samples: 590, lock: true, quality: 'spoofed', opts: { jb: 0 } }, send: { g2g_p50: 90, note: 'peer side' } });
    t.push(snap(2000), 'bob', { recv: { g2g_p50: 'bad' as unknown as number }, send: null });
    await t.flush();
    const body = JSON.parse(((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.samples[0]).toMatchObject({ direction: 'recv', g2g_p50: 84.4, g2g_p95: 101, g2g_samples: 590 });
    expect(body.samples[0].extra).toMatchObject({ lock: true, opts: { jb: 0 }, quality: 'good', estimated_latency_ms: 85, processing_ms: 45, sdk: '0.2.0' });
    expect(body.samples[0].lock).toBeUndefined();
    expect(body.samples[1]).toMatchObject({ direction: 'send', g2g_p50: 90 });
    expect(body.samples[1].extra).toMatchObject({ note: 'peer side', target_kbps: 1100 });
    expect(body.samples[2].g2g_p50).toBeNull();                 // a non-number is stored as null, never as a string
    expect(body.samples[3].g2g_p50).toBeUndefined();            // no fields for that direction
    await t.stop();
  });
  it('caps the queue at 120 rows', () => {
    const t = new Telemetry({ apiBase: 'x', callId: 'c', token: 't', enabled: true, sdkVersion: '0', fetchFn: vi.fn() as any });
    for (let i = 0; i < 100; i++) t.push(snap(i), null);
    expect((t as any).queue.length).toBe(120);
  });
});
