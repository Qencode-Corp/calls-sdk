import { ConnectionError, ConnectionErrorReason } from 'livekit-client';

/** Stable error codes, identical on every platform (web, iOS, Android). */
export type CallErrorCode =
  | 'credentialInvalid'
  | 'credentialExpired'
  | 'roomFull'
  | 'roomClosed'
  | 'permissionDenied'
  | 'deviceUnavailable'
  | 'network'
  | 'unsupported'
  | 'internal';

export class CallError extends Error {
  readonly code: CallErrorCode;
  /** Whether trying again, possibly after user action, can succeed. */
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: CallErrorCode, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'CallError';
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    this.cause = opts.cause;
  }
}

const DEFAULT_RETRYABLE: Record<CallErrorCode, boolean> = {
  credentialInvalid: false,
  credentialExpired: true, // after the app fetches a new credential
  roomFull: false,
  roomClosed: false,
  permissionDenied: true, // after the user grants access
  deviceUnavailable: true,
  network: true,
  unsupported: false,
  internal: true,
};

export function isCallError(e: unknown): e is CallError {
  return e instanceof CallError;
}

/**
 * Map an engine or browser error to a CallError. Engine mapping (livekit-client 2.22):
 *
 * - message matches "room is full" / "max participants"        -> roomFull
 * - ConnectionError NotAllowed (HTTP 401/403 on join)            -> credentialInvalid
 * - ConnectionError ServerUnreachable / WebSocket / Timeout      -> network
 *   (Call.connect() turns a WebSocket refusal into roomFull when the server's validate
 *   endpoint still accepts the credential; the server sends no reason a browser can read)
 * - ConnectionError ServiceNotFound (wrong URL path)             -> credentialInvalid (the url in the credential is wrong)
 * - ConnectionError Cancelled / LeaveRequest                     -> internal, not retryable (connect() was abandoned by leave())
 * - ConnectionError InternalError                                -> internal
 * - DOMException NotAllowedError / PermissionDeniedError         -> permissionDenied
 * - DOMException NotFoundError / NotReadableError / OverconstrainedError / AbortError -> deviceUnavailable
 * - anything else                                                -> internal, with the original message attached
 */
export function mapEngineError(e: unknown): CallError {
  if (isCallError(e)) return e;
  const msg = messageOf(e);
  if (/room is full|max(imum)? participants|participant limit/i.test(msg)) {
    return new CallError('roomFull', 'The call already has two participants.', { cause: e });
  }
  if (e instanceof ConnectionError) {
    switch (e.reason) {
      case ConnectionErrorReason.NotAllowed:
        return new CallError('credentialInvalid', `The credential was rejected by the media server (${e.status ?? 'no status'}): ${msg}`, { cause: e });
      case ConnectionErrorReason.ServerUnreachable:
      case ConnectionErrorReason.WebSocket:
      case ConnectionErrorReason.Timeout:
        return new CallError('network', `Could not reach the media server: ${msg}`, { cause: e });
      case ConnectionErrorReason.ServiceNotFound:
        return new CallError('credentialInvalid', `The credential's url does not point at a media server: ${msg}`, { cause: e });
      case ConnectionErrorReason.Cancelled:
      case ConnectionErrorReason.LeaveRequest:
        return new CallError('internal', `Connection was cancelled: ${msg}`, { retryable: false, cause: e });
      default:
        return new CallError('internal', `Media server error: ${msg}`, { cause: e });
    }
  }
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return new CallError('permissionDenied', 'Camera or microphone permission was not granted.', { cause: e });
  }
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError' || name === 'TrackInvalidError') {
    return new CallError('deviceUnavailable', `The requested device is unavailable: ${msg}`, { cause: e });
  }
  return new CallError('internal', msg || 'Unknown error', { cause: e });
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}
