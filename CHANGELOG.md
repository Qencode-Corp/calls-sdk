# Changelog

## 0.3.0 (unreleased)

`@qencode/calls`

- `devices.setCameraFacing('user' | 'environment')`: switch between the front and the rear
  camera on phones by direction; on desktops a camera whose label says which way it points
  is used, or `deviceUnavailable` is thrown.
- `devices.cameraId`, `devices.cameraFacing`, `devices.microphoneId` getters, and
  `DeviceInfo.facing` for cameras whose label gives the direction.
- A camera or microphone chosen before `connect()` or while the camera is off is applied when
  the track is next published, instead of being refused.
- Fix: a profile switch after `setCamera` restarted capture on the initial camera. The
  selection now lives in `devices` and every restart uses it.
- A chosen camera id is requested exactly. As a preference Chrome kept the camera it already
  had when the other one took a moment to wake, as a phone used as a webcam does.
- A camera that cannot be opened mid-call no longer leaves the call without video: the
  previous camera is reopened and `deviceUnavailable` is thrown. A remembered camera that is
  gone at `connect()` falls back to the default one instead of failing the call.

## 0.2.0 (2026-09-08)

`@qencode/calls`

- `videoSource` option and `setVideoSource()`: publish a custom `MediaStreamTrack` or a
  factory `(profile) => MediaStreamTrack` instead of the camera. A factory is called on every
  publish and republish and the SDK stops what it returned; a passed track is never stopped.
- `codec` and `simulcast` options and `setVideoEncoding({ codec, simulcast })`: H.264, VP8,
  VP9 or AV1, and a simulcast override per call.
- `jitterBufferTargetMs` option and `setJitterBufferTarget(ms)`, returning which receiver
  property took it; `jitterBufferTargetMs` and `jitterBufferSupport` getters. `setLatencyMode`
  clears the pin.
- `telemetryExtra` option: app fields on every telemetry row. `g2g_p50`, `g2g_p95` and
  `g2g_samples` are stored as columns, the rest under `extra`.
- Stats: `recv.processingMs`, `recv.absCaptureLatencyMs`, `send.targetKbps`; telemetry rows carry
  `processing_ms`, `abs_capture_ms` and `target_kbps` in `extra`.
- `videoCodec`, `simulcast` and `regionProbe` getters.
- `devices.setCamera` is refused with `unsupported` while a custom video source is published.
- A join the media server refuses with a bare websocket close is reported as `roomFull`
  when the server's validate endpoint still accepts the credential. Before, a third person
  on a two-person call saw `network`.
- `forceRelay` is documented.

## 0.1.0

Initial import: `Call`, credentials, profiles, latency modes, stats, telemetry, devices,
`<qencode-video>`, examples and CI.
