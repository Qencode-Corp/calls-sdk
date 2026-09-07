import { describe, it, expect } from 'vitest';
import { PROFILES, resolveProfile, DEFAULT_PROFILE } from '../src/profiles';
import { latencySettings, LATENCY_SETTINGS } from '../src/latency';

describe('profiles', () => {
  it('has the seven tiers with sane shapes', () => {
    expect(Object.keys(PROFILES)).toEqual(['audioOnly', 'p360_30', 'p540_30', 'p540_60', 'p720_30', 'p720_60', 'p1080_30']);
    for (const p of Object.values(PROFILES)) {
      if (!p.video) { expect(p.width).toBe(0); continue; }
      expect(p.width / p.height).toBeCloseTo(16 / 9, 2);
      expect(p.maxBitrate).toBeGreaterThan(0);
      expect(p.simulcast).toBe(p.height >= 720);
    }
  });
  it('bitrate caps rise with resolution and frame rate', () => {
    expect(PROFILES.p540_60.maxBitrate).toBeGreaterThan(PROFILES.p540_30.maxBitrate);
    expect(PROFILES.p1080_30.maxBitrate).toBeGreaterThan(PROFILES.p720_60.maxBitrate);
  });
  it('resolves the default and rejects unknown names', () => {
    expect(resolveProfile(undefined).name).toBe(DEFAULT_PROFILE);
    expect(resolveProfile('p720_30').fps).toBe(30);
    expect(() => resolveProfile('p4k' as any)).toThrow(/Unknown video profile/);
  });
  it('latency modes move the three knobs together', () => {
    expect(latencySettings('lowest')).toEqual(LATENCY_SETTINGS.lowest);
    expect(LATENCY_SETTINGS.lowest.jitterBufferTargetMs).toBe(0);
    expect(LATENCY_SETTINGS.lowest.degradationPreference).toBe('maintain-framerate');
    expect(LATENCY_SETTINGS.smooth.jitterBufferTargetMs).toBe(150);
    expect(LATENCY_SETTINGS.smooth.degradationPreference).toBe('maintain-resolution');
    expect(() => latencySettings('turbo' as any)).toThrow(/Unknown latency mode/);
  });
});
