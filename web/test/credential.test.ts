import { describe, it, expect, vi } from 'vitest';
import { parseCredential, isExpired, msUntilExpiryWarning, parseExpiry, decodeJwtPayload, EXPIRY_WARNING_MS } from '../src/credential';
import { CallError } from '../src/errors';
import { credential, fakeJwt } from './helpers';

describe('parseCredential', () => {
  it('reads the contract fields', () => {
    const c = parseCredential(credential({ regions: [{ name: 'eu', url: 'wss://a' }, { name: 'us', url: 'wss://b' }], api_base: 'https://api.example' }));
    expect(c.identity).toBe('alice'); expect(c.roomName).toBe('call-1'); expect(c.callId).toBe('c-1');
    expect(c.regions.map((r) => r.name)).toEqual(['eu', 'us']); expect(c.apiBase).toBe('https://api.example');
  });
  it('falls back to the JWT payload for identity, room and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const c = parseCredential({ token: fakeJwt({ sub: 'bob', video: { room: 'r-9' }, exp }), url: 'wss://x' });
    expect(c.identity).toBe('bob'); expect(c.roomName).toBe('r-9'); expect(c.expiresAt).toBe(exp * 1000);
    expect(c.regions).toEqual([{ name: 'default', url: 'wss://x' }]); expect(c.callId).toBeNull();
  });
  it('rejects a malformed token and a bad url with credentialInvalid', () => {
    expect(() => parseCredential({ token: 'nope', url: 'wss://x' })).toThrowError(CallError);
    try { parseCredential({ token: 'nope', url: 'wss://x' }); } catch (e) { expect((e as CallError).code).toBe('credentialInvalid'); }
    expect(() => parseCredential(credential({ url: 'ftp://x' }))).toThrowError(/ws\(s\) or http\(s\)/);
  });
  it('rejects a token without identity or room', () => {
    expect(() => parseCredential({ token: fakeJwt({ exp: 1 }), url: 'wss://x' })).toThrowError(/identity/);
    expect(() => parseCredential({ token: fakeJwt({ sub: 'a', exp: 1 }), url: 'wss://x' })).toThrowError(/room/);
  });
  it('drops malformed region entries', () => {
    const c = parseCredential(credential({ regions: [{ name: 'eu', url: 'wss://a' }, { name: 5 }, null] }));
    expect(c.regions).toEqual([{ name: 'eu', url: 'wss://a' }]);
  });
});

describe('expiry', () => {
  it('parses ISO, API "YYYY-MM-DD HH:MM:SS" (UTC), epoch seconds and epoch millis', () => {
    expect(parseExpiry('2026-09-08T10:00:00Z')).toBe(Date.UTC(2026, 8, 8, 10));
    expect(parseExpiry('2026-09-08 10:00:00')).toBe(Date.UTC(2026, 8, 8, 10));
    expect(parseExpiry(1_788_000_000)).toBe(1_788_000_000_000);
    expect(parseExpiry(1_788_000_000_000)).toBe(1_788_000_000_000);
    expect(parseExpiry('1788000000')).toBe(1_788_000_000_000);
    expect(parseExpiry(undefined)).toBeNull(); expect(parseExpiry('garbage')).toBeNull();
  });
  it('isExpired and the warning lead time', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    const c = parseCredential(credential({ expires_at: '2026-09-08T10:10:00Z' }));
    expect(isExpired(c)).toBe(false);
    expect(msUntilExpiryWarning(c)).toBe(10 * 60_000 - EXPIRY_WARNING_MS);
    vi.setSystemTime(new Date('2026-09-08T10:09:00Z')); expect(msUntilExpiryWarning(c)).toBe(0);
    vi.setSystemTime(new Date('2026-09-08T10:10:01Z')); expect(isExpired(c)).toBe(true);
    vi.useRealTimers();
  });
  it('unknown expiry never expires and has no warning', () => {
    const c = parseCredential({ token: fakeJwt({ sub: 'a', video: { room: 'r' } }), url: 'wss://x' });
    expect(c.expiresAt).toBeNull(); expect(isExpired(c)).toBe(false); expect(msUntilExpiryWarning(c)).toBeNull();
  });
  it('decodeJwtPayload tolerates garbage', () => {
    expect(decodeJwtPayload('a.b.c')).toEqual({}); expect(decodeJwtPayload('')).toEqual({});
  });
});
