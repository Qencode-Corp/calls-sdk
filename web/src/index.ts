export { Call, encodeMessage, decodeMessage } from './call';
export type { CallOptions, CallEvents, CallState, EndReason, Peer, MessagePayload, ModerationEvent, LogLevelName, VideoCodec, VideoSource, VideoSourceFactory, JitterBufferSupport, TelemetryExtra } from './call';
export { VIDEO_CODECS } from './call';
export type { TelemetryFields } from './telemetry';
export { CallError, isCallError } from './errors';
export type { CallErrorCode } from './errors';
export type { CallCredential, Region } from './credential';
export { PROFILES, DEFAULT_PROFILE } from './profiles';
export type { VideoProfileName, VideoProfile } from './profiles';
export { LATENCY_SETTINGS, DEFAULT_LATENCY_MODE } from './latency';
export type { LatencyMode, LatencySettings } from './latency';
export type { CallStats, RecvStats, SendStats, Quality, Direction, Transport, CandidateType, AudioRoute } from './stats';
export type { DeviceInfo, DeviceList, CameraFacing } from './devices';
export type { VideoHandle } from './render';
export { QencodeVideoElement, registerVideoElement } from './render';
export { SDK_VERSION } from './version';

import { registerVideoElement } from './render';
// Register <qencode-video> on import in browsers; a no-op elsewhere and when already defined.
registerVideoElement();
