# @qencode/calls

Low-latency 1:1 audio and video calls inside your own UI. The SDK takes a short-lived
participant credential minted by **your backend**, connects, renders media into views you
place, and reports call quality. It ships no screens and no theme. Version 0.2.0, pre-release,
on npm as [`@qencode/calls`](https://www.npmjs.com/package/@qencode/calls).

## Quickstart

### 1. Your backend mints a credential

Never put a Qencode API key in a browser. Your server calls the Qencode calls API and hands
the token response to the page unchanged:

```
POST /v1/access_token/{api_key}          -> { access_token }              (project JWT, 24 h)
POST /v1/calls                           -> { call: { id, ... } }         Authorization: Bearer <access_token>
POST /v1/calls/{id}/tokens               -> { token, url, regions, identity, room_name, expires_at }
     body { "identity": "alice", "name": "Alice", "role": "A", "ttl": 600 }
```

Return that last object to the browser (optionally add `call_id` and `api_base`). See
`examples/backend-node/server.js` for a complete 60-line version.

### 2. The page joins

```html
<script type="module">
  import { Call } from 'https://unpkg.com/@qencode/calls/dist/qencode-calls.esm.bundle.js';

  const cred = await fetch('/api/calls/join?as=alice').then(r => r.json());
  const call = Call.create(cred, { videoProfile: 'p540_60' });

  call.on('remoteVideo', track => { document.querySelector('#remote').track = track; });
  call.on('stateChanged', (state, reason) => console.log(state, reason ?? ''));
  call.on('credentialExpiring', async () => {
    call.updateCredential(await fetch('/api/calls/refresh').then(r => r.json()));
  });

  await call.connect();
  document.querySelector('#self').track = call.localVideo;
</script>

<qencode-video id="remote"></qencode-video>
<qencode-video id="self" mirror></qencode-video>
```

`npm install @qencode/calls` gives the same API as an ES module with TypeScript types.

## Builds and size

| File | Use | Size, gzipped |
|---|---|---|
| `dist/qencode-calls.esm.js` | `import` through a bundler; the engine (`livekit-client`) is a dependency your bundler resolves and dedupes | ~11 KB |
| `dist/qencode-calls.esm.bundle.js` | `<script type="module">` with no bundler; engine included | ~154 KB |
| `dist/qencode-calls.umd.js` | classic `<script>`; exposes `window.QencodeCalls`; engine included | ~154 KB |

The SDK itself is about 11 KB gzipped. The self-contained builds are dominated by the engine,
which is about 145 KB gzipped on its own.

## Call

| Member | Meaning |
|---|---|
| `Call.create(credential, options)` | Builds a call. No network yet. |
| `connect()` | Probes regions when the credential lists several, connects, publishes camera and microphone per options. Rejects with a `CallError`. |
| `leave()` | Unpublishes, disconnects, releases devices. Idempotent. |
| `state` | `idle`, `connecting`, `connected`, `reconnecting`, `ended`; `endReason` says why it ended. |
| `localVideo`, `remoteVideo`, `remoteAudio` | Track handles with `attach(element)` and `detach()`. Remote audio is played by the SDK; the handle is for metering or custom output. |
| `setMicrophoneEnabled(bool)`, `setCameraEnabled(bool)` | Mute keeps the track published, so unmute is instant. |
| `setVideoProfile(name)` | Switches tier mid-call. Simulcast changes republish; other changes restart capture in place. |
| `setLatencyMode('lowest' \| 'smooth')` | Jitter buffer target, degradation preference and audio framing in one switch. Clears a `setJitterBufferTarget` pin. |
| `setJitterBufferTarget(ms)` | Pins the receiver's jitter buffer target regardless of the mode. Returns which property took it: `jitterBufferTarget`, `playoutDelayHint`, or `unsupported` (Firefox). |
| `setVideoEncoding({ codec, simulcast })` | Switches codec or simulcast mid-call; the video track is republished. |
| `setVideoSource(source \| null)` | Replaces the published video with a custom track or factory, or returns to the camera. See below. |
| `devices` | `list()`, `setCamera(id)`, `setMicrophone(id)`, `setSpeaker(id)`, `onChange(handler)`, `canSelectSpeaker`. |
| `sendMessage(payload, reliable = true)` | Up to 15 KB, 30 per second, to the peer. Strings and JSON objects arrive as sent, `Uint8Array` as bytes. |
| `stats` | Latest quality snapshot, refreshed every second. |
| `peer` | Identity, display name and mute state of the other human, or `null`. |
| `videoCodec`, `simulcast`, `jitterBufferTargetMs`, `jitterBufferSupport`, `regionProbe` | What is in force: codec, simulcast, jitter target in ms, which receiver property took it, and the probe results by region name (`null` when no probe ran). |
| `updateCredential(credential)` | Fresh token for the same call and identity, used by the next reconnect. |
| `on(event, handler)` returns an unsubscribe function; `off`, `once`. |

### Options

`adaptiveStream` (default `true`) lets the engine match what is sent and received to how the
video is displayed: a phone rendering a desktop's 720p pulls the 540p layer, and a hidden or
background video element pauses that track on the server until it is visible again. Two tabs
on one machine therefore show a black remote picture in whichever tab is in the background.
Set it to `false` to always send and receive the full profile, which is what a measurement
bench wants and what a customer UI rarely does.

| Option | Default | Notes |
|---|---|---|
| `audio`, `video` | `true` | Publish on connect. |
| `videoProfile` | `p540_60` | See profiles. |
| `latencyMode` | `lowest` | See latency modes. |
| `region` | auto | Pin a region name from the credential. |
| `telemetry` | `true` | Post quality stats to Qencode every 5 s. |
| `autoReconnect` | `true` | Resume for up to 60 s after a network change, then end with reason `network`. |
| `endOnPeerLeft` | `true` | 1:1 semantics: the call ends when the peer leaves. |
| `cameraId`, `microphoneId` | system default | Initial devices. |
| `apiBase` | `https://api.qencode.com` | Telemetry target; `credential.api_base` also works. |
| `logLevel` | `warn` | Never logs media or credentials. |
| `videoSource` | camera | A `MediaStreamTrack` or a factory `(profile) => MediaStreamTrack`; see custom video source. |
| `codec` | `h264` | `h264`, `vp8`, `vp9`, `av1`. The engine falls back to VP8 when a peer cannot decode the choice. |
| `simulcast` | per profile | Force simulcast layers on or off. |
| `jitterBufferTargetMs` | per latency mode | Pin the receiver's jitter buffer target; `0` asks for the browser's floor. |
| `telemetryExtra` | none | `(direction) => fields` appended to every telemetry row; see telemetry. |
| `forceRelay` | `false` | Connect through TURN only, to measure the relay path. |

### Custom video source

Pass `videoSource` to publish something other than the raw camera: a canvas with an overlay or a
timestamp, a processed camera track (virtual background, filters), or a screen.

```ts
const call = Call.create(cred, {
  videoSource: (profile) => {                 // called on every publish and republish
    canvas.width = profile.width; canvas.height = profile.height;
    return canvas.captureStream(profile.fps).getVideoTracks()[0];
  },
});
```

A factory is called with the profile so it can size its output, and is called again on
`setVideoProfile`, `setVideoEncoding` and `setVideoSource`; the SDK stops the track it returned
when it is replaced or the call ends. A `MediaStreamTrack` passed directly is published as is,
gets new encoding parameters on a profile switch, and is never stopped by the SDK. Encoding
caps, codec, simulcast and mute work the same either way. `devices.setCamera` is refused while a
custom source is published: switch cameras in the code that produces the track.

### Events

| Event | Payload |
|---|---|
| `stateChanged` | `(state, endReason \| null)` |
| `peerJoined`, `peerLeft` | `(peer)` |
| `remoteVideo`, `remoteAudio` | `(track \| null)`; fires again after a reconnect with the replacement track |
| `peerMuted` | `('audio' \| 'video', muted)` |
| `stats` | `(snapshot)` once per second |
| `qualityChanged` | `('good' \| 'fair' \| 'poor', 'recv' \| 'send')`, with hysteresis |
| `message` | `(payload, reliable)` |
| `credentialExpiring` | `(expiresAt)` two minutes before expiry, and on reconnect if already expired |
| `devicesChanged` | `(list)` |
| `moderation` | reserved; no-op until the moderation agent ships |
| `error` | `(CallError)` non-fatal errors; fatal ones end the call |

### Errors

`CallError` has `code`, `message`, `retryable` and `cause`. Codes: `credentialInvalid`,
`credentialExpired`, `roomFull`, `roomClosed`, `permissionDenied`, `deviceUnavailable`,
`network`, `unsupported`, `internal`.

A media server refuses a third participant by closing the websocket without a reason a
browser can read. `connect()` then asks the server's validate endpoint whether the credential
is still accepted; if it is, the rejection was capacity and the error is `roomFull`, otherwise
it stays `network`. That is one extra request, on that failure path only.

## Profiles

| Profile | Resolution | fps | Cap |
|---|---|---|---|
| `audioOnly` | none | | 48 kbps |
| `p360_30` | 640×360 | 30 | 450 kbps |
| `p540_30` | 960×540 | 30 | 800 kbps |
| `p540_60` (default) | 960×540 | 60 | 1.2 Mbps |
| `p720_30` | 1280×720 | 30 | 1.2 Mbps |
| `p720_60` | 1280×720 | 60 | 1.8 Mbps |
| `p1080_30` | 1920×1080 | 30 | 2.2 Mbps |

Hardware H.264 everywhere it exists, VP8 as the fallback. Simulcast is on at 720p and above.
The captured frame is cover-fitted to the profile's aspect ratio, never stretched.

## Latency modes

`lowest` (default) asks the browser for its minimum jitter buffer, drops resolution before
frame rate under pressure, and uses 10 ms audio frames where the platform allows. `smooth`
lets the buffer grow to 150 ms and drops frame rate before resolution. Switch mid-call.

## Stats

Every second, `call.stats` and the `stats` event carry:

| Field | Source |
|---|---|
| `recv.rttMs`, `send.rttMs` | selected ICE candidate pair, round trip to the media node |
| `recv.jitterBufferMs` | Δ`jitterBufferDelay` / Δ`jitterBufferEmittedCount` |
| `recv.decodeMs`, `send.encodeMs` | Δ`totalDecodeTime` / Δ`framesDecoded`, Δ`totalEncodeTime` / Δ`framesEncoded` |
| `recv.fps`, `width`, `height`, `kbps`, `codec` | inbound-rtp; `send.*` from outbound-rtp |
| `recv.lossPct`, `jitterMs`, `freezes`, `freezeMs` | inbound-rtp deltas |
| `recv.processingMs` | Δ`totalProcessingDelay` / Δ`framesDecoded`, receive to render |
| `recv.absCaptureLatencyMs` | sender capture to now through the abs-capture-time extension; Chromium, and only when the media node forwards it. A cross-check for the estimate. |
| `send.lossPct` | remote-inbound-rtp `fractionLost` |
| `send.targetKbps` | the encoder's current bitrate target |
| `recv.transport`, `candidateType` | `udp`, `tcp`, `relay-udp`, `relay-tcp`; `host`, `srflx`, `prflx`, `relay` |
| `peerRttMs` | the peer's own RTT, exchanged over the data channel |
| `estimatedLatencyMs` | `rtt/2 + peerRtt/2 + jitterBuffer + decode + one frame interval`. An estimate; it excludes capture and display. |
| `quality.recv`, `quality.send` | `good`, `fair`, `poor` |
| `region`, `nodeId`, `serverVersion`, `joinMs` | where the call landed and how long connect took |

## Telemetry and privacy

With `telemetry: true` and a credential that carries `call_id`, the SDK posts the last
snapshots every 5 s to `POST {apiBase}/v1/calls/{call_id}/stats` using the participant token.
The rows are the fields above plus SDK version, platform and user agent. Nothing identifying the
user is sent, media never is, and a failed post is dropped silently. Manual credentials without a
`call_id` post nothing.

`telemetryExtra` adds your own fields to every row. It is called once per row with `'recv'` or
`'send'`. Three keys are stored as columns because the API knows them: `g2g_p50`, `g2g_p95` and
`g2g_samples`, an app's own measured glass-to-glass latency in ms over its window, as the Qencode
bench posts. Every other key lands in the row's `extra` object next to the SDK's keys, which win
on a name clash.

```ts
Call.create(cred, { telemetryExtra: (direction) => ({ session: mySessionId, screen: direction === 'recv' ? 'room' : undefined }) });
```

## Browser support

Chromium 110+, Safari 16.4+, Firefox 115+. A secure context is required. Device labels are
empty until the first permission grant. Firefox has no `jitterBufferTarget`, so `lowest` mode
runs with the browser's default buffer there and `stats` still reports the size. Speaker
selection needs `setSinkId`, which Safari lacks; `devices.canSelectSpeaker` says so.

## Running the example

```bash
cd examples/backend-node && npm install
QENCODE_API_KEY=<your project API key> npm start   # API_BASE defaults to https://api.qencode.com
# open http://localhost:8787/ in two tabs or on two devices, join as alice and bob
```

The backend creates one call, mints a credential per identity, and serves `examples/vanilla`.

## Development

```bash
npm install
npm test          # vitest, jsdom, engine mocked
npm run build     # typecheck, ESM + UMD bundles, declarations in dist/
```
