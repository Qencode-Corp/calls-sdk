import type { Room } from 'livekit-client';
import { Emitter } from './events';
import { CallError, mapEngineError } from './errors';

export interface DeviceInfo { id: string; label: string }
export interface DeviceList { cameras: DeviceInfo[]; microphones: DeviceInfo[]; speakers: DeviceInfo[] }

type DevicesEvents = { change: [DeviceList] };

/**
 * Device selection. Labels are empty until the first getUserMedia permission is granted; after
 * `connect()` the list is complete. Speaker selection needs `setSinkId`, which Safari lacks.
 */
export class Devices {
  private readonly emitter = new Emitter<DevicesEvents>();
  private room: Room | null = null;
  private readonly audioElements = new Set<HTMLMediaElement>();
  private speakerId = '';
  private readonly onDeviceChange = () => { void this.list().then((l) => this.emitter.emit('change', l)); };

  /** @internal */
  _attachRoom(room: Room | null): void { this.room = room; }
  /** @internal */
  _registerAudioElement(el: HTMLMediaElement): void {
    this.audioElements.add(el);
    if (this.speakerId) void this.applySink(el);
  }
  /** @internal */
  _start(): void {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
  }
  /** @internal */
  _stop(): void {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.audioElements.clear();
  }

  async list(): Promise<DeviceList> {
    const out: DeviceList = { cameras: [], microphones: [], speakers: [] };
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return out;
    let devs: MediaDeviceInfo[] = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return out; }
    devs.forEach((d, i) => {
      const info = { id: d.deviceId, label: d.label || `${kindLabel(d.kind)} ${i + 1}` };
      if (d.kind === 'videoinput') out.cameras.push(info);
      else if (d.kind === 'audioinput') out.microphones.push(info);
      else if (d.kind === 'audiooutput' && this.canSelectSpeaker) out.speakers.push(info);
    });
    return out;
  }

  get canSelectSpeaker(): boolean {
    return typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
  }

  async setCamera(deviceId: string): Promise<void> { await this.switch('videoinput', deviceId); }
  async setMicrophone(deviceId: string): Promise<void> { await this.switch('audioinput', deviceId); }

  async setSpeaker(deviceId: string): Promise<void> {
    if (!this.canSelectSpeaker) throw new CallError('unsupported', 'This browser cannot choose the audio output device.', { retryable: false });
    this.speakerId = deviceId;
    for (const el of this.audioElements) await this.applySink(el);
    if (this.room) { try { await this.room.switchActiveDevice('audiooutput', deviceId, true); } catch { /* elements already switched */ } }
  }

  onChange(handler: (list: DeviceList) => void): () => void { return this.emitter.on('change', handler); }

  private async switch(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    if (!this.room) throw new CallError('internal', 'Devices can be switched after connect(); before that, pass the device id in options.', { retryable: false });
    try {
      const ok = await this.room.switchActiveDevice(kind, deviceId, true);
      if (!ok) throw new CallError('deviceUnavailable', `Could not switch to device ${deviceId}.`);
    } catch (e) {
      throw mapEngineError(e);
    }
  }

  private async applySink(el: HTMLMediaElement): Promise<void> {
    const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (typeof sink !== 'function') return;
    try { await sink.call(el, this.speakerId); } catch (e) { throw new CallError('deviceUnavailable', `Speaker switch failed: ${(e as Error)?.message ?? e}`, { cause: e }); }
  }
}

function kindLabel(k: MediaDeviceKind): string {
  return k === 'videoinput' ? 'camera' : k === 'audioinput' ? 'microphone' : 'speaker';
}
