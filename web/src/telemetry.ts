import type { CallStats, Direction } from './stats';

/** One row of the calls stats contract (`POST /v1/calls/{id}/stats`). */
export interface TelemetrySample {
  ts: number;
  direction: Direction;
  peer_identity?: string | null;
  rtt_ms?: number | null; net_one_way_ms?: number | null;
  jb_ms?: number | null; decode_ms?: number | null; encode_ms?: number | null;
  fps?: number | null; kbps?: number | null; loss_pct?: number | null; jitter_ms?: number | null;
  freezes?: number | null; freeze_ms?: number | null;
  transport?: string | null; candidate_type?: string | null; codec?: string | null;
  width?: number | null; height?: number | null;
  server_region?: string | null; server_version?: string | null; node_id?: string | null;
  join_ms?: number | null;
  extra?: Record<string, unknown>;
}

export interface TelemetryOptions {
  apiBase: string;
  callId: string | null;
  token: string;
  enabled: boolean;
  sdkVersion: string;
  /** Flush interval in ms; 5000 by default. */
  intervalMs?: number;
  fetchFn?: typeof fetch;
  userAgent?: string;
}

/**
 * Batches stats snapshots and posts them every 5 s with the participant token. Silent when
 * disabled or when the credential carries no call id (manual credentials). Never throws.
 */
export class Telemetry {
  private queue: TelemetrySample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstPost = true;
  private joinMs: number | null = null;
  readonly enabled: boolean;
  readonly url: string | null;

  constructor(private readonly opts: TelemetryOptions) {
    this.enabled = !!opts.enabled && !!opts.callId && typeof (opts.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined)) === 'function';
    this.url = opts.callId ? `${opts.apiBase.replace(/\/+$/, '')}/v1/calls/${encodeURIComponent(opts.callId)}/stats` : null;
  }

  start(joinMs: number | null): void {
    this.joinMs = joinMs;
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.opts.intervalMs ?? 5000);
  }

  /** Converts one snapshot into the two contract rows and queues them. */
  push(s: CallStats, peerIdentity: string | null): void {
    if (!this.enabled) return;
    const common = { ts: s.ts, peer_identity: peerIdentity, server_region: s.region, server_version: s.serverVersion, node_id: s.nodeId };
    const oneWay = s.recv.rttMs !== null ? Math.round(((s.recv.rttMs + (s.peerRttMs ?? s.recv.rttMs)) / 2) * 10) / 10 : null;
    this.queue.push({ ...common, direction: 'recv',
      rtt_ms: s.recv.rttMs, net_one_way_ms: oneWay, jb_ms: s.recv.jitterBufferMs, decode_ms: s.recv.decodeMs,
      fps: s.recv.fps, kbps: s.recv.kbps, loss_pct: s.recv.lossPct, jitter_ms: s.recv.jitterMs,
      freezes: s.recv.freezes, freeze_ms: s.recv.freezeMs, transport: s.recv.transport, candidate_type: s.recv.candidateType,
      codec: s.recv.codec, width: s.recv.width, height: s.recv.height,
      extra: { estimated_latency_ms: s.estimatedLatencyMs, quality: s.quality.recv, audio_route: s.audioRoute } });
    this.queue.push({ ...common, direction: 'send',
      rtt_ms: s.send.rttMs, encode_ms: s.send.encodeMs, fps: s.send.fps, kbps: s.send.kbps,
      transport: s.send.transport, candidate_type: s.send.candidateType, codec: s.send.codec, width: s.send.width, height: s.send.height,
      extra: { quality_limitation: s.send.qualityLimitation, quality: s.quality.send } });
    if (this.queue.length > 120) this.queue.splice(0, this.queue.length - 120);
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.url || this.queue.length === 0) return;
    const samples = this.queue.splice(0, this.queue.length);
    const ua = this.opts.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    for (const s of samples) {
      s.extra = { ...(s.extra ?? {}), sdk: this.opts.sdkVersion, platform: 'web', user_agent: ua };
      if (this.firstPost && this.joinMs !== null) s.join_ms = this.joinMs;
    }
    this.firstPost = false;
    const f = this.opts.fetchFn ?? fetch;
    try {
      await f(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify({ samples }),
        keepalive: true,
      });
    } catch {
      /* telemetry is best effort; a failed post is dropped, never retried, never surfaced */
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }
}
