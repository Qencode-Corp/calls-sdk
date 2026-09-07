/** Test helpers shared across suites. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}.sig`;
}

export function credential(overrides: Record<string, unknown> = {}) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  return {
    token: fakeJwt({ iss: 'APIkey', sub: 'alice', video: { room: 'call-1', roomJoin: true }, exp }),
    url: 'wss://calls-eu.example.com',
    identity: 'alice',
    room_name: 'call-1',
    call_id: 'c-1',
    expires_at: exp,
    ...overrides,
  };
}

/** A minimal RTCStatsReport-like map. */
export function report(entries: Record<string, unknown>[]): Map<string, any> {
  const m = new Map<string, any>();
  entries.forEach((e, i) => m.set((e as { id?: string }).id ?? `s${i}`, e));
  return m;
}

export function installMediaDevices(devices: Array<Partial<MediaDeviceInfo>> = []) {
  const listeners = new Set<() => void>();
  const md = {
    enumerateDevices: async () => devices as MediaDeviceInfo[],
    addEventListener: (_: string, h: () => void) => { listeners.add(h); },
    removeEventListener: (_: string, h: () => void) => { listeners.delete(h); },
    fire: () => listeners.forEach((h) => h()),
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
  return md;
}
