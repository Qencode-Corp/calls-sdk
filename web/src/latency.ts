/**
 * Latency modes move several engine knobs together.
 *
 * - `lowest`: jitter buffer target at the platform minimum (0 ms asks the browser for its floor),
 *   degradation drops resolution before frame rate, 10 ms Opus frames where the platform lets us.
 * - `smooth`: jitter buffer target 150 ms, degradation drops frame rate before resolution,
 *   20 ms Opus frames.
 */
export type LatencyMode = 'lowest' | 'smooth';

export interface LatencySettings {
  jitterBufferTargetMs: number;
  degradationPreference: RTCDegradationPreference;
  audioFrameMs: 10 | 20;
}

export const LATENCY_SETTINGS: Readonly<Record<LatencyMode, LatencySettings>> = Object.freeze({
  lowest: { jitterBufferTargetMs: 0, degradationPreference: 'maintain-framerate', audioFrameMs: 10 },
  smooth: { jitterBufferTargetMs: 150, degradationPreference: 'maintain-resolution', audioFrameMs: 20 },
});

export const DEFAULT_LATENCY_MODE: LatencyMode = 'lowest';

export function latencySettings(mode: LatencyMode | undefined): LatencySettings {
  const s = LATENCY_SETTINGS[mode ?? DEFAULT_LATENCY_MODE];
  if (!s) throw new RangeError(`Unknown latency mode "${String(mode)}". Known: lowest, smooth`);
  return s;
}

type ReceiverWithTarget = RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null };

/**
 * Applies a jitter buffer target to a receiver. Returns which property took it:
 * `jitterBufferTarget` (Chromium 108+, Safari 17.4+), `playoutDelayHint` (older Chromium), or
 * `null` when the browser exposes neither (Firefox). Never throws.
 */
export function applyJitterBufferTarget(receiver: RTCRtpReceiver | undefined | null, ms: number): 'jitterBufferTarget' | 'playoutDelayHint' | null {
  if (!receiver) return null;
  const r = receiver as unknown as Record<string, unknown>;
  try {
    if ('jitterBufferTarget' in r) { (receiver as ReceiverWithTarget).jitterBufferTarget = ms; return 'jitterBufferTarget'; }
    if ('playoutDelayHint' in r) { (receiver as ReceiverWithTarget).playoutDelayHint = ms / 1000; return 'playoutDelayHint'; }
  } catch { /* unsupported value range or read-only implementation */ }
  return null;
}

/** Applies a degradation preference to a live sender without republishing. Returns false when unsupported. */
export async function applyDegradationPreference(sender: RTCRtpSender | undefined | null, pref: RTCDegradationPreference): Promise<boolean> {
  if (!sender || typeof sender.getParameters !== 'function') return false;
  try {
    const params = sender.getParameters();
    (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = pref;
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}
