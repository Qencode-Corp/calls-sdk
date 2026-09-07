/** Named media tiers. Quality, cost and the pricing tier line up on these; apps pick a name, never raw constraints. */
export type VideoProfileName = 'audioOnly' | 'p360_30' | 'p540_30' | 'p540_60' | 'p720_30' | 'p720_60' | 'p1080_30';

export interface VideoProfile {
  name: VideoProfileName;
  width: number;
  height: number;
  fps: number;
  /** Encoder bitrate cap in bits per second. */
  maxBitrate: number;
  /** Simulcast layers are published at 720p and above; below, the single layer is cheaper to encode. */
  simulcast: boolean;
  video: boolean;
}

export const PROFILES: Readonly<Record<VideoProfileName, VideoProfile>> = Object.freeze({
  audioOnly: { name: 'audioOnly', width: 0, height: 0, fps: 0, maxBitrate: 0, simulcast: false, video: false },
  p360_30:  { name: 'p360_30',  width: 640,  height: 360,  fps: 30, maxBitrate: 450_000,   simulcast: false, video: true },
  p540_30:  { name: 'p540_30',  width: 960,  height: 540,  fps: 30, maxBitrate: 800_000,   simulcast: false, video: true },
  p540_60:  { name: 'p540_60',  width: 960,  height: 540,  fps: 60, maxBitrate: 1_200_000, simulcast: false, video: true },
  p720_30:  { name: 'p720_30',  width: 1280, height: 720,  fps: 30, maxBitrate: 1_200_000, simulcast: true,  video: true },
  p720_60:  { name: 'p720_60',  width: 1280, height: 720,  fps: 60, maxBitrate: 1_800_000, simulcast: true,  video: true },
  p1080_30: { name: 'p1080_30', width: 1920, height: 1080, fps: 30, maxBitrate: 2_200_000, simulcast: true,  video: true },
});

export const DEFAULT_PROFILE: VideoProfileName = 'p540_60';

/** Opus bitrate for the microphone track, bits per second. */
export const AUDIO_BITRATE = 48_000;

export function resolveProfile(name: VideoProfileName | undefined): VideoProfile {
  const p = PROFILES[name ?? DEFAULT_PROFILE];
  if (!p) throw new RangeError(`Unknown video profile "${String(name)}". Known: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}
