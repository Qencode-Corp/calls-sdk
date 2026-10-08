import type { Region } from './credential';
import { CallError } from './errors';

export interface RegionChoice {
  region: Region;
  /** Probe result per region name in milliseconds; Infinity when unreachable. Empty when no probe ran. */
  probe: Record<string, number>;
  /** How the choice was made; `placed` means the API placed the call (see placeCall). */
  how: 'single' | 'pinned' | 'probe' | 'fallback' | 'placed';
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

export interface PlaceOptions extends ProbeOptions {
  apiBase: string;
  callId: string;
  token: string;
  /** A region name the app asked for; sent as the only probe result instead of probing. */
  pinned?: string | null;
  /** Timeout of each placement request; 5000 ms by default. */
  placeTimeoutMs?: number;
}

/**
 * Asks the API where an unplaced (region `auto`) call lives. Probes every region, or sends the
 * pinned one, to `POST /v1/calls/{id}/placement`; the first participant's answer pins the call
 * and everyone after gets the same region whatever their own probe says. A network error or a
 * 5xx is retried once.
 */
export async function placeCall(regions: Region[], opts: PlaceOptions): Promise<RegionChoice> {
  const probe: Record<string, number> = {};
  if (opts.pinned) {
    if (!regions.some((r) => r.name === opts.pinned)) {
      throw new RangeError(`Region "${opts.pinned}" is not in the credential. Available: ${regions.map((x) => x.name).join(', ')}`);
    }
    probe[opts.pinned] = 0;
  } else {
    const results = await Promise.all(regions.map((r) => probeRegion(r, opts)));
    regions.forEach((r, i) => { if (results[i] !== Infinity) probe[r.name] = Math.round(results[i]! * 10) / 10; });
  }
  const f = opts.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!f) throw new CallError('unsupported', 'fetch is not available, so the call cannot be placed.');
  const url = `${opts.apiBase.replace(/\/+$/, '')}/v1/calls/${encodeURIComponent(opts.callId)}/placement`;
  for (let attempt = 1; ; attempt++) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = setTimeout(() => ctl?.abort(), opts.placeTimeoutMs ?? 5000);
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ probe }),
        signal: ctl?.signal,
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw new CallError('network', 'Could not reach the API to place the call.', { cause: e });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500 && attempt < 2) continue;
    if (res.status === 409) throw new CallError('roomClosed', 'The call has ended.');
    if (res.status === 401 || res.status === 404) {
      throw new CallError('credentialInvalid', `The API refused the credential when placing the call (${res.status}).`);
    }
    if (!res.ok) throw new CallError('network', `Placing the call failed with HTTP ${res.status}.`);
    const body = (await res.json().catch(() => null)) as { region?: unknown; url?: unknown } | null;
    if (!body || typeof body.region !== 'string' || typeof body.url !== 'string') {
      throw new CallError('internal', 'The API answered the placement without a region.');
    }
    return { region: { name: body.region, url: body.url }, probe, how: 'placed' };
  }
}
