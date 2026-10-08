import { describe, it, expect, vi } from 'vitest';
import { chooseRegion, placeCall, probeRegion, probeUrl } from '../src/regions';

const regions = [{ name: 'us', url: 'wss://us.example' }, { name: 'eu', url: 'wss://eu.example' }, { name: 'ap', url: 'wss://ap.example' }];

// Probes run concurrently, so the fake waits for real (scaled-down) time instead of bumping a shared clock.
function fakeFetch(latency: Record<string, number>) {
  return vi.fn(async (url: string) => {
    const host = new URL(url).host.split('.')[0]!;
    const ms = latency[host];
    if (ms === undefined) throw new Error('unreachable');
    await new Promise((r) => setTimeout(r, ms));
    return new Response('');
  });
}

describe('regions', () => {
  it('probeUrl turns a signaling url into the node root', () => {
    expect(probeUrl('wss://calls-us.example.com')).toBe('https://calls-us.example.com/');
    expect(probeUrl('ws://localhost:7880/x')).toBe('http://localhost:7880/');
  });
  it('a single region is chosen without probing', async () => {
    const f = vi.fn(); const c = await chooseRegion([regions[0]!], null, { fetchFn: f as any });
    expect(c.how).toBe('single'); expect(c.region.name).toBe('us'); expect(f).not.toHaveBeenCalled();
  });
  it('a pinned region wins without probing and must exist', async () => {
    const f = vi.fn(); const c = await chooseRegion(regions, 'eu', { fetchFn: f as any });
    expect(c.how).toBe('pinned'); expect(c.region.name).toBe('eu'); expect(f).not.toHaveBeenCalled();
    await expect(chooseRegion(regions, 'mars', { fetchFn: f as any })).rejects.toThrow(/not in the credential/);
  });
  it('probes every region once warm and picks the fastest', async () => {
    const f = fakeFetch({ us: 90, eu: 20, ap: 140 });
    const c = await chooseRegion(regions, null, { fetchFn: f as any });
    expect(c.how).toBe('probe'); expect(c.region.name).toBe('eu');
    expect(c.probe.eu).toBeLessThan(c.probe.us); expect(c.probe.us).toBeLessThan(c.probe.ap);
    expect(f).toHaveBeenCalledTimes(6); // warm-up + timed per region
  });
  it('unreachable regions are Infinity and the first region is the fallback when all fail', async () => {
    const one = await probeRegion({ name: 'x', url: 'wss://x.example' }, { fetchFn: fakeFetch({}) as any });
    expect(one).toBe(Infinity);
    const c = await chooseRegion(regions, null, { fetchFn: fakeFetch({}) as any });
    expect(c.how).toBe('fallback'); expect(c.region.name).toBe('us');
  });
  it('an unreachable region does not win over a reachable one', async () => {
    const f = fakeFetch({ ap: 30 });
    const c = await chooseRegion(regions, null, { fetchFn: f as any });
    expect(c.region.name).toBe('ap'); expect(c.probe.us).toBe(Infinity);
  });
});

describe('placeCall', () => {
  const API = 'https://api.example/';
  // Probes go to the region hosts; the placement goes to the API. `answers` is consumed one per POST.
  function api(answers: Array<Response | Error>, latency: Record<string, number> = { us: 30, eu: 5 }) {
    const posts: Array<{ url: string; init: any }> = [];
    const probes = fakeFetch(latency);
    const f = vi.fn(async (url: string, init: any) => {
      if (init?.method === 'POST') {
        posts.push({ url, init });
        const a = answers.shift();
        if (!a) throw new Error('no answer left');
        if (a instanceof Error) throw a;
        return a;
      }
      return probes(url);
    });
    return { f, posts };
  }
  const placed = (region: string) => new Response(JSON.stringify({ region, url: `wss://${region}.example`, regions: [{ name: region, url: `wss://${region}.example` }] }), { status: 200 });
  const opts = (f: any, extra: Record<string, unknown> = {}) => ({ apiBase: API, callId: 'c 1', token: 'tok', fetchFn: f, ...extra });

  it('probes, posts the results with the token and connects where the API says', async () => {
    const { f, posts } = api([placed('us')]);
    const c = await placeCall(regions.slice(0, 2), opts(f));
    expect(c).toMatchObject({ how: 'placed', region: { name: 'us', url: 'wss://us.example' } });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.example/v1/calls/c%201/placement');
    expect(posts[0]!.init.headers.authorization).toBe('Bearer tok');
    const sent = JSON.parse(posts[0]!.init.body).probe;
    expect(Object.keys(sent).sort()).toEqual(['eu', 'us']); expect(sent.eu).toBeLessThan(sent.us);
    expect(c.probe).toEqual(sent);
  });
  it('leaves unreachable regions out of the probe', async () => {
    const { f, posts } = api([placed('eu')], { eu: 5 });
    await placeCall(regions.slice(0, 2), opts(f));
    expect(Object.keys(JSON.parse(posts[0]!.init.body).probe)).toEqual(['eu']);
  });
  it('a pinned region is sent as the only result, without probing', async () => {
    const { f, posts } = api([placed('eu')]);
    await placeCall(regions, opts(f, { pinned: 'eu' }));
    expect(f).toHaveBeenCalledTimes(1); expect(JSON.parse(posts[0]!.init.body)).toEqual({ probe: { eu: 0 } });
    await expect(placeCall(regions, opts(f, { pinned: 'mars' }))).rejects.toThrow(/not in the credential/);
  });
  it('retries once on a 5xx or a network error', async () => {
    const a = api([new Response('', { status: 503 }), placed('us')]);
    expect((await placeCall(regions.slice(0, 1), opts(a.f))).region.name).toBe('us'); expect(a.posts).toHaveLength(2);
    const b = api([new Error('offline'), placed('us')]);
    expect((await placeCall(regions.slice(0, 1), opts(b.f))).region.name).toBe('us');
    const c = api([new Error('offline'), new Error('offline')]);
    await expect(placeCall(regions.slice(0, 1), opts(c.f))).rejects.toMatchObject({ code: 'network', retryable: true });
  });
  it('maps an ended call and a refused token, without retrying', async () => {
    const ended = api([new Response('', { status: 409 })]);
    await expect(placeCall(regions.slice(0, 1), opts(ended.f))).rejects.toMatchObject({ code: 'roomClosed', retryable: false });
    const refused = api([new Response('', { status: 401 })]);
    await expect(placeCall(regions.slice(0, 1), opts(refused.f))).rejects.toMatchObject({ code: 'credentialInvalid', retryable: false });
    expect(ended.posts).toHaveLength(1); expect(refused.posts).toHaveLength(1);
  });
});
