import { CallError } from './errors';

/** One region a credential may connect through. */
export interface Region { name: string; url: string }

/**
 * The token response from `POST /v1/calls/{id}/tokens`, passed to the app unchanged by the
 * customer's backend. Only `token` and `url` are required; the rest is read from the JWT
 * payload when missing.
 */
export interface CallCredential {
  token: string;
  url: string;
  regions?: Region[];
  identity?: string;
  room_name?: string;
  /** ISO 8601 string, epoch seconds, or epoch milliseconds. */
  expires_at?: string | number;
  call_id?: string;
  /** Optional API base for telemetry; overrides the SDK default. */
  api_base?: string;
}

export interface ParsedCredential {
  token: string;
  url: string;
  regions: Region[];
  identity: string;
  roomName: string;
  /** Epoch milliseconds, or null when unknown. */
  expiresAt: number | null;
  callId: string | null;
  apiBase: string | null;
}

/** Fires `credentialExpiring` this long before `expiresAt`. */
export const EXPIRY_WARNING_MS = 2 * 60 * 1000;

export function parseCredential(input: CallCredential): ParsedCredential {
  if (!input || typeof input !== 'object') throw new CallError('credentialInvalid', 'Credential must be an object.');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token || token.split('.').length !== 3) throw new CallError('credentialInvalid', 'Credential token is missing or not a JWT.');
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!/^(wss?|https?):\/\/\S+$/i.test(url)) throw new CallError('credentialInvalid', 'Credential url must be a ws(s) or http(s) URL.');

  const payload = decodeJwtPayload(token);
  const video = (payload.video ?? {}) as { room?: unknown };
  const identity = firstString(input.identity, payload.sub);
  const roomName = firstString(input.room_name, video.room);
  if (!identity) throw new CallError('credentialInvalid', 'Credential has no identity (neither identity nor the JWT sub claim).');
  if (!roomName) throw new CallError('credentialInvalid', 'Credential has no room (neither room_name nor the JWT video.room grant).');

  let expiresAt = parseExpiry(input.expires_at);
  if (expiresAt === null && typeof payload.exp === 'number') expiresAt = payload.exp * 1000;

  const regions = Array.isArray(input.regions)
    ? input.regions.filter((r): r is Region => !!r && typeof r.name === 'string' && typeof r.url === 'string')
    : [];
  if (regions.length === 0) regions.push({ name: 'default', url });

  return {
    token, url, regions, identity, roomName, expiresAt,
    callId: firstString(input.call_id) || null,
    apiBase: firstString(input.api_base) || null,
  };
}

export function isExpired(c: ParsedCredential, now: number = Date.now()): boolean {
  return c.expiresAt !== null && now >= c.expiresAt;
}

/** Milliseconds until the expiry warning should fire; 0 when already due; null when unknown. */
export function msUntilExpiryWarning(c: ParsedCredential, now: number = Date.now()): number | null {
  if (c.expiresAt === null) return null;
  return Math.max(0, c.expiresAt - EXPIRY_WARNING_MS - now);
}

export function parseExpiry(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const asNum = Number(v);
    if (v.trim() !== '' && Number.isFinite(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
    // The API returns 'YYYY-MM-DD HH:MM:SS' in UTC without a zone; make that explicit.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Decodes the JWT payload without verifying the signature; the media server verifies it. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    if (typeof atob !== 'function') return {};
    const json = atob(b64);
    const bytes = new Uint8Array(json.length);
    for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}
