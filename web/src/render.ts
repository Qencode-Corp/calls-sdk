/** A renderable track. `attach` returns the element for chaining; `detach` with no element releases all. */
export interface VideoHandle {
  readonly kind: 'video' | 'audio';
  readonly mediaStreamTrack: MediaStreamTrack;
  /** Accepts a `<video>`/`<audio>` element or a `<qencode-video>` element; returns the media element that plays it. */
  attach(element: HTMLMediaElement | QencodeVideoElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement | QencodeVideoElement): void;
}

/** True for `<qencode-video>` and anything else exposing a `track` setter and a `videoElement`. */
function isVideoFrame(el: unknown): el is QencodeVideoElement {
  return !!el && typeof el === 'object' && 'videoElement' in (el as object) && 'track' in (el as object);
}

type EngineTrack = {
  kind: string;
  mediaStreamTrack: MediaStreamTrack;
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[];
};

/** @internal Wraps an engine track so no engine type reaches the public API. */
export function wrapTrack(track: EngineTrack): VideoHandle {
  const handle: VideoHandle = {
    kind: track.kind === 'audio' ? 'audio' : 'video',
    get mediaStreamTrack() { return track.mediaStreamTrack; },
    attach: (el) => {
      if (isVideoFrame(el)) { el.track = handle; return el.videoElement; }
      return track.attach(el);
    },
    detach: (el) => {
      if (isVideoFrame(el)) { if (el.track === handle) el.track = null; return; }
      if (el) track.detach(el); else track.detach();
    },
  };
  return handle;
}

const TEMPLATE = `
<style>
  :host{display:block;position:relative;overflow:hidden;background:#000;aspect-ratio:16/9}
  video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
  :host([fit="cover"]) video{object-fit:cover}
  :host([mirror]) video{transform:scaleX(-1)}
</style>
<video autoplay playsinline muted></video>`;

/**
 * `<qencode-video>`: a frame that renders a VideoHandle at its own aspect ratio.
 * Attributes: `mirror` (self view), `fit="contain|cover"`. Property: `track` (VideoHandle | null).
 * Audio is never played by this element; the SDK plays remote audio itself.
 */
export class QencodeVideoElement extends HTMLElement {
  private _track: VideoHandle | null = null;
  private readonly video: HTMLVideoElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    this.video = root.querySelector('video') as HTMLVideoElement;
    this.video.addEventListener('loadedmetadata', () => this.updateAspect());
    this.video.addEventListener('resize', () => this.updateAspect());
  }

  /** The inner `<video>` that plays the track. */
  get videoElement(): HTMLVideoElement { return this.video; }

  get track(): VideoHandle | null { return this._track; }
  set track(t: VideoHandle | null) {
    if (this._track === t) return;
    if (this._track) this._track.detach(this.video);
    this._track = t;
    if (t) t.attach(this.video);
    else this.video.srcObject = null;
  }

  disconnectedCallback(): void { if (this._track) this._track.detach(this.video); }

  private updateAspect(): void {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (w && h && this.getAttribute('fit') !== 'cover') this.style.aspectRatio = `${w} / ${h}`;
  }
}

/** Registers `<qencode-video>` once; safe to call repeatedly and outside browsers. */
export function registerVideoElement(tag = 'qencode-video'): boolean {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return false;
  if (!customElements.get(tag)) customElements.define(tag, QencodeVideoElement);
  return true;
}
