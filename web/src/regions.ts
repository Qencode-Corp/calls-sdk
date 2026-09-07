import type { Region } from './credential';

export interface RegionChoice {
  region: Region;
  /** Probe result per region name in milliseconds; Infinity when unreachable. Empty when no probe ran. */
  probe: Record<string, number>;
  /** How the choice was made. */
  how: 'single' | 'pinned' | 'probe' | 'fallback';
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Turns a signaling URL into the media node's HTTPS root, which LiveKit answers with "OK". */
export function probeUrl(signalingUrl: string): string {
  const u = new URL(signalingUrl);
  const proto = u.protocol === 'ws:' || u.protocol === 'http:' ? 'http:' : 'https:';
  return `${proto}//${u.host}/`;
}

/**
 * Times one request to a region after one warm-up request. `no-cors` so the timing works even
 * when the node sends no CORS headers; the body is not readable and does not need to be.
 */
export async function probeRegion(region: Region, opts: ProbeOptions = {}): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const f = opts.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  if (!f) return Infinity;
  let url: string;
  try { url = probeUrl(region.url); } catch { return Infinity; }
  const once = async (): Promise<number> => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    const t0 = now();
    try {
      await f(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl?.signal });
      return now() - t0;
    } catch {
      return Infinity;
    } finally {
      clearTimeout(timer);
    }
  };
  const warm = await once();
  if (warm === Infinity) return Infinity;
  return once();
}

/** Picks the region to connect through. Pinned wins; one region skips the probe; otherwise the fastest probe. */
export async function chooseRegion(regions: Region[], pinned?: string | null, opts: ProbeOptions = {}): Promise<RegionChoice> {
  if (regions.length === 0) throw new RangeError('No regions to choose from');
  if (pinned) {
    const r = regions.find((x) => x.name === pinned);
    if (!r) throw new RangeError(`Region "${pinned}" is not in the credential. Available: ${regions.map((x) => x.name).join(', ')}`);
    return { region: r, probe: {}, how: 'pinned' };
  }
  if (regions.length === 1) return { region: regions[0]!, probe: {}, how: 'single' };
  const results = await Promise.all(regions.map((r) => probeRegion(r, opts)));
  const probe: Record<string, number> = {};
  regions.forEach((r, i) => { probe[r.name] = Math.round(results[i]! * 10) / 10; });
  let best = -1;
  results.forEach((ms, i) => { if (ms !== Infinity && (best < 0 || ms < results[best]!)) best = i; });
  if (best < 0) return { region: regions[0]!, probe, how: 'fallback' };
  return { region: regions[best]!, probe, how: 'probe' };
}
