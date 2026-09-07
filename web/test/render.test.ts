import { describe, it, expect, vi } from 'vitest';
import { wrapTrack, registerVideoElement, QencodeVideoElement } from '../src/render';

describe('render', () => {
  it('wrapTrack hides the engine track behind attach/detach', () => {
    const t = { kind: 'video', mediaStreamTrack: { id: 'x' } as any, attach: vi.fn((el: any) => el), detach: vi.fn() };
    const h = wrapTrack(t as any);
    const el = document.createElement('video');
    expect(h.kind).toBe('video'); expect(h.mediaStreamTrack).toEqual({ id: 'x' });
    h.attach(el); expect(t.attach).toHaveBeenCalledWith(el);
    h.detach(el); expect(t.detach).toHaveBeenCalledWith(el);
    h.detach(); expect(t.detach).toHaveBeenLastCalledWith();
  });
  it('<qencode-video> registers once and swaps tracks', () => {
    expect(registerVideoElement()).toBe(true); expect(registerVideoElement()).toBe(true);
    const el = document.createElement('qencode-video') as QencodeVideoElement;
    document.body.appendChild(el);
    const a = { kind: 'video' as const, mediaStreamTrack: {} as any, attach: vi.fn((e: any) => e), detach: vi.fn() };
    const b = { kind: 'video' as const, mediaStreamTrack: {} as any, attach: vi.fn((e: any) => e), detach: vi.fn() };
    el.track = a; expect(a.attach).toHaveBeenCalledTimes(1);
    el.track = b; expect(a.detach).toHaveBeenCalledTimes(1); expect(b.attach).toHaveBeenCalledTimes(1);
    el.track = null; expect(b.detach).toHaveBeenCalledTimes(1); expect(el.track).toBeNull();
    el.remove();
  });
});

describe('VideoHandle.attach with <qencode-video>', () => {
  it('routes a <qencode-video> element through its track setter and returns the inner video', () => {
    registerVideoElement();
    const attached: HTMLMediaElement[] = [];
    const engine = {
      kind: 'video',
      mediaStreamTrack: {} as MediaStreamTrack,
      attach: (el: HTMLMediaElement) => { attached.push(el); return el; },
      detach: (el?: HTMLMediaElement) => { if (el) attached.splice(attached.indexOf(el), 1); else attached.length = 0; return el ?? []; },
    };
    const handle = wrapTrack(engine);
    const frame = document.createElement('qencode-video') as unknown as { track: unknown; videoElement: HTMLVideoElement };
    const inner = handle.attach(frame as unknown as HTMLMediaElement);
    expect(inner).toBe(frame.videoElement);
    expect(frame.track).toBe(handle);
    expect(attached).toEqual([frame.videoElement]);
    handle.detach(frame as unknown as HTMLMediaElement);
    expect(frame.track).toBeNull();
    expect(attached).toEqual([]);
  });
});
