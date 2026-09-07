/**
 * Per-second quality numbers from WebRTC getStats, ported from the bench page. Everything here is
 * pure over an RTCStatsReport-like map so it can be tested without a browser.
 */

export type Transport = 'udp' | 'tcp' | 'relay-udp' | 'relay-tcp';
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type AudioRoute = 'speaker' | 'earpiece' | 'wired' | 'bluetooth' | 'unknown';
export type Quality = 'good' | 'fair' | 'poor';
export type Direction = 'recv' | 'send';

/** What this participant receives from the peer. */
export interface RecvStats {
  rttMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  kbps: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  freezes: number | null;
  freezeMs: number | null;
  codec: string | null;
  transport: Transport | null;
  candidateType: CandidateType | null;
}

/** What this participant sends. */
export interface SendStats {
  rttMs: number | null;
  encodeMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  kbps: number | null;
  qualityLimitation: string | null;
  /** Loss the media node reports for our outbound stream (remote-inbound-rtp), percent. */
  lossPct: number | null;
  codec: string | null;
  transport: Transport | null;
  candidateType: CandidateType | null;
}

/** One snapshot, emitted once per second on `stats`. */
export interface CallStats {
  /** Epoch milliseconds. */
  ts: number;
  recv: RecvStats;
  send: SendStats;
  /** The peer's own RTT to the media node, exchanged over the data channel; null until received. */
  peerRttMs: number | null;
  /** rtt/2 + peerRtt/2 + jitter buffer + decode + one frame interval. An estimate, not a measurement. */
  estimatedLatencyMs: number | null;
  quality: { recv: Quality; send: Quality };
  region: string | null;
  nodeId: string | null;
  serverVersion: string | null;
  joinMs: number | null;
  audioRoute: AudioRoute;
}

type StatsLike = { forEach(cb: (s: any) => void): void; get(id: string): any };

interface Prev { t: number; [k: string]: number }

/** Delta tracker across polls; one instance per direction per call. */
export class DeltaTracker {
  private prev: Prev | null = null;

  /** Returns per-interval deltas of the given counters, or null on the first sample. */
  step(nowMs: number, counters: Record<string, number | undefined>): { dt: number; d: (k: string) => number } | null {
    const cur: Prev = { t: nowMs };
    for (const [k, v] of Object.entries(counters)) cur[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return null;
    const dt = Math.max(1, nowMs - prev.t) / 1000;
    return { dt, d: (k) => (cur[k] ?? 0) - (prev[k] ?? 0) };
  }

  reset(): void { this.prev = null; }
}

export function pickSelectedPair(report: StatsLike): any | null {
  let pair: any = null;
  report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) ?? pair; });
  if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  return pair;
}

export function transportOf(report: StatsLike, pair: any | null): { transport: Transport | null; candidateType: CandidateType | null; rttMs: number | null } {
  if (!pair) return { transport: null, candidateType: null, rttMs: null };
  const local = report.get(pair.localCandidateId) ?? {};
  const proto = String(local.relayProtocol ?? local.protocol ?? '').toLowerCase();
  const ctype = (local.candidateType ?? null) as CandidateType | null;
  const base = proto === 'tcp' || proto === 'tls' ? 'tcp' : 'udp';
  const transport: Transport | null = ctype === 'relay' ? (`relay-${base}` as Transport) : (proto ? base : null);
  const rtt = typeof pair.currentRoundTripTime === 'number' ? round1(pair.currentRoundTripTime * 1000) : null;
  return { transport, candidateType: ctype, rttMs: rtt };
}

function codecName(report: StatsLike, codecId: string | undefined): string | null {
  if (!codecId) return null;
  const c = report.get(codecId);
  const mime: string | undefined = c?.mimeType;
  return mime ? mime.replace(/^video\//i, '').replace(/^audio\//i, '').toUpperCase() : null;
}

export function collectRecv(report: StatsLike, tracker: DeltaTracker, nowMs: number): RecvStats {
  let inbound: any = null;
  report.forEach((s) => { if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) inbound = s; });
  const pair = pickSelectedPair(report);
  const t = transportOf(report, pair);
  const empty: RecvStats = { rttMs: t.rttMs, jitterBufferMs: null, decodeMs: null, fps: null, width: null, height: null, kbps: null, lossPct: null, jitterMs: null, freezes: null, freezeMs: null, codec: null, transport: t.transport, candidateType: t.candidateType };
  if (!inbound) return empty;
  const step = tracker.step(nowMs, {
    jbd: inbound.jitterBufferDelay, jbc: inbound.jitterBufferEmittedCount,
    dec: inbound.totalDecodeTime, frames: inbound.framesDecoded,
    lost: inbound.packetsLost, recv: inbound.packetsReceived, bytes: inbound.bytesReceived,
    freezes: inbound.freezeCount, freezeMs: inbound.totalFreezesDuration,
  });
  const out: RecvStats = { ...empty,
    fps: typeof inbound.framesPerSecond === 'number' ? round1(inbound.framesPerSecond) : null,
    width: inbound.frameWidth ?? null, height: inbound.frameHeight ?? null,
    jitterMs: typeof inbound.jitter === 'number' ? round1(inbound.jitter * 1000) : null,
    codec: codecName(report, inbound.codecId),
  };
  if (!step) return out;
  const { dt, d } = step;
  out.jitterBufferMs = d('jbc') > 0 ? round1((d('jbd') / d('jbc')) * 1000) : null;
  out.decodeMs = d('frames') > 0 ? round1((d('dec') / d('frames')) * 1000) : null;
  const lostAndRecv = d('lost') + d('recv');
  out.lossPct = lostAndRecv > 0 ? round1((d('lost') / lostAndRecv) * 100) : 0;
  out.kbps = round1((d('bytes') * 8) / dt / 1000);
  out.freezes = Math.max(0, d('freezes'));
  out.freezeMs = round1(Math.max(0, d('freezeMs')) * 1000);
  return out;
}

export function collectSend(report: StatsLike, tracker: DeltaTracker, nowMs: number): SendStats {
  let outbound: any = null;
  report.forEach((s) => { if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video') && (outbound === null || (s.bytesSent ?? 0) > (outbound.bytesSent ?? 0))) outbound = s; });
  const pair = pickSelectedPair(report);
  const t = transportOf(report, pair);
  let remoteInbound: any = null;
  report.forEach((s) => { if (s.type === 'remote-inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) remoteInbound = s; });
  const lossPct = remoteInbound && typeof remoteInbound.fractionLost === 'number' ? round1(remoteInbound.fractionLost * 100) : null;
  const empty: SendStats = { rttMs: t.rttMs, encodeMs: null, fps: null, width: null, height: null, kbps: null, qualityLimitation: null, lossPct, codec: null, transport: t.transport, candidateType: t.candidateType };
  if (!outbound) return empty;
  const step = tracker.step(nowMs, { enc: outbound.totalEncodeTime, frames: outbound.framesEncoded, bytes: outbound.bytesSent });
  const out: SendStats = { ...empty,
    fps: typeof outbound.framesPerSecond === 'number' ? round1(outbound.framesPerSecond) : null,
    width: outbound.frameWidth ?? null, height: outbound.frameHeight ?? null,
    qualityLimitation: outbound.qualityLimitationReason ?? null,
    codec: codecName(report, outbound.codecId),
  };
  if (!step) return out;
  const { dt, d } = step;
  out.encodeMs = d('frames') > 0 ? round1((d('enc') / d('frames')) * 1000) : null;
  out.kbps = round1((d('bytes') * 8) / dt / 1000);
  return out;
}

/** rtt/2 + peerRtt/2 + jitter buffer + decode + one frame interval. Null until the pieces exist. */
export function estimateLatency(p: { rttMs: number | null; peerRttMs: number | null; jitterBufferMs: number | null; decodeMs: number | null; fps: number | null }): number | null {
  if (p.rttMs === null || p.jitterBufferMs === null) return null;
  const peer = p.peerRttMs ?? p.rttMs;                 // assume symmetry until the peer reports
  const frame = p.fps && p.fps > 0 ? 1000 / p.fps : 33;
  return round1(p.rttMs / 2 + peer / 2 + p.jitterBufferMs + (p.decodeMs ?? 0) + frame);
}

/**
 * good / fair / poor with hysteresis: a new level must be observed on two consecutive polls
 * before it is reported, so a single bad second does not flip the indicator.
 *
 * poor: loss > 3 % or jitter buffer > 200 ms or any freeze in the interval
 * fair: loss > 1 % or jitter buffer > 120 ms or rtt > 300 ms
 * good: otherwise
 */
export class QualityTracker {
  private current: Quality = 'good';
  private candidate: Quality | null = null;
  private streak = 0;

  static classify(s: { lossPct: number | null; jitterBufferMs: number | null; freezes: number | null; rttMs: number | null }): Quality {
    const loss = s.lossPct ?? 0, jb = s.jitterBufferMs ?? 0, fr = s.freezes ?? 0, rtt = s.rttMs ?? 0;
    if (loss > 3 || jb > 200 || fr > 0) return 'poor';
    if (loss > 1 || jb > 120 || rtt > 300) return 'fair';
    return 'good';
  }

  /** Feed one poll; returns the reported level after hysteresis. */
  update(s: { lossPct: number | null; jitterBufferMs: number | null; freezes: number | null; rttMs: number | null }): Quality {
    const observed = QualityTracker.classify(s);
    if (observed === this.current) { this.candidate = null; this.streak = 0; return this.current; }
    if (observed === this.candidate) this.streak += 1; else { this.candidate = observed; this.streak = 1; }
    if (this.streak >= 2) { this.current = observed; this.candidate = null; this.streak = 0; }
    return this.current;
  }

  get value(): Quality { return this.current; }
  reset(): void { this.current = 'good'; this.candidate = null; this.streak = 0; }
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
