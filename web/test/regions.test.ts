import { describe, it, expect, vi } from 'vitest';
import { chooseRegion, probeRegion, probeUrl } from '../src/regions';

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
