import { describe, it, expect } from 'vitest';
import { ConnectionError, ConnectionErrorReason } from 'livekit-client';
import { CallError, mapEngineError, isCallError } from '../src/errors';
import { applyJitterBufferTarget } from '../src/latency';

function connErr(reason: ConnectionErrorReason, message = 'x', status?: number): ConnectionError {
  const e = Object.create(ConnectionError.prototype) as ConnectionError;
  Object.assign(e, { message, reason, status, name: 'ConnectionError' });
  return e;
}

describe('errors', () => {
  it('CallError carries code, retryable default and cause', () => {
    const e = new CallError('network', 'down', { cause: 'c' });
    expect(e.code).toBe('network'); expect(e.retryable).toBe(true); expect(e.cause).toBe('c'); expect(isCallError(e)).toBe(true);
    expect(new CallError('roomFull', 'x').retryable).toBe(false);
    expect(new CallError('network', 'x', { retryable: false }).retryable).toBe(false);
  });
  it('passes CallErrors through untouched', () => {
    const e = new CallError('unsupported', 'x'); expect(mapEngineError(e)).toBe(e);
  });
  it('maps engine connection reasons', () => {
    expect(mapEngineError(connErr(ConnectionErrorReason.NotAllowed, 'invalid token', 401)).code).toBe('credentialInvalid');
    expect(mapEngineError(connErr(ConnectionErrorReason.ServerUnreachable)).code).toBe('network');
    expect(mapEngineError(connErr(ConnectionErrorReason.WebSocket)).code).toBe('network');
    expect(mapEngineError(connErr(ConnectionErrorReason.Timeout)).code).toBe('network');
    expect(mapEngineError(connErr(ConnectionErrorReason.ServiceNotFound)).code).toBe('credentialInvalid');
    const c = mapEngineError(connErr(ConnectionErrorReason.Cancelled)); expect(c.code).toBe('internal'); expect(c.retryable).toBe(false);
    expect(mapEngineError(connErr(ConnectionErrorReason.InternalError)).code).toBe('internal');
  });
  it('room full is recognised from the message regardless of reason', () => {
    expect(mapEngineError(connErr(ConnectionErrorReason.NotAllowed, 'room is full', 403)).code).toBe('roomFull');
    expect(mapEngineError(new Error('max participants reached')).code).toBe('roomFull');
  });
  it('maps browser media errors', () => {
    const dom = (name: string) => Object.assign(new Error(name), { name });
    expect(mapEngineError(dom('NotAllowedError')).code).toBe('permissionDenied');
    expect(mapEngineError(dom('NotFoundError')).code).toBe('deviceUnavailable');
    expect(mapEngineError(dom('NotReadableError')).code).toBe('deviceUnavailable');
    expect(mapEngineError(dom('OverconstrainedError')).code).toBe('deviceUnavailable');
    expect(mapEngineError('boom').code).toBe('internal');
    expect(mapEngineError('boom').message).toBe('boom');
  });
  it('applyJitterBufferTarget reports which property took the value', () => {
    const r1 = { jitterBufferTarget: null } as unknown as RTCRtpReceiver;
    expect(applyJitterBufferTarget(r1, 150)).toBe('jitterBufferTarget'); expect((r1 as any).jitterBufferTarget).toBe(150);
    const r2 = { playoutDelayHint: null } as unknown as RTCRtpReceiver;
    expect(applyJitterBufferTarget(r2, 150)).toBe('playoutDelayHint'); expect((r2 as any).playoutDelayHint).toBe(0.15);
    expect(applyJitterBufferTarget({} as RTCRtpReceiver, 0)).toBeNull();
    expect(applyJitterBufferTarget(null, 0)).toBeNull();
  });
});
