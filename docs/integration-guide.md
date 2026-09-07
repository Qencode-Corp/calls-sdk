# Integration guide

Three parties take part in every call. Your **backend** holds the Qencode API key and decides
when a call starts. Your **app** holds only a short-lived participant credential. **Qencode**
runs the media.

```
app ──(start call with Bob)──▶ backend ──POST /v1/calls──────────▶ Qencode API
                                       ──POST /v1/calls/{id}/tokens──▶ Qencode API
app ◀──(credential, unchanged)── backend
app ──connect(credential)────────────────────────────────────────▶ nearest media region
```

## 1. Backend: create a call and mint credentials

Any HTTP client works; the [API reference](api.md) has the request and response shapes.
`web/examples/backend-node/server.js` is a complete 80-line example. The pattern:

1. Get a project JWT once a day from `POST /v1/access_token/{api_key}`.
2. `POST /v1/calls` when two users should talk. Keep the call id with your own session.
3. `POST /v1/calls/{id}/tokens` once per participant, with your user id as `identity`.
4. Return that response to the app as is.

Never ship the API key or the project JWT to an app.

## 2. Web app: join

```ts
import { Call } from '@qencode/calls';

const cred = await fetch('/api/calls/join').then((r) => r.json());   // from your backend
const call = Call.create(cred, { videoProfile: 'p540_60' });

call.on('remoteVideo', (track) => track?.attach(document.getElementById('remote')));
call.on('stateChanged', (state, reason) => console.log(state, reason));
call.on('credentialExpiring', async () => {
  call.updateCredential(await fetch('/api/calls/refresh').then((r) => r.json()));
});

await call.connect();
call.localVideo?.attach(document.getElementById('self'));
```

`<qencode-video id="remote">` and `<qencode-video id="self" mirror>` are the simplest targets;
plain `<video>` elements work too. Full options, events, profiles, latency modes, stats and
error codes are in [web/README.md](../web/README.md).

## 3. iOS and Android

Same concepts, events and error codes. The Swift Package lives in
[calls-sdk-swift](https://github.com/Qencode-Corp/calls-sdk-swift); the Android library ships
from this repository. Both are in development and release together with the web package.

## Choosing a profile and a latency mode

| Want | Set |
|---|---|
| Lowest latency on phones and laptops (default) | `videoProfile: 'p540_60'`, `latencyMode: 'lowest'` |
| Desktop windows, larger picture | `p720_30` or `p720_60` |
| Weak networks, data saver | `p360_30` |
| Voice only, camera never opened | `audioOnly` |
| Smooth playback over lowest delay (lessons, interviews) | `latencyMode: 'smooth'` |

## Telemetry

With `telemetry: true` (default) the SDK posts quality samples every 5 s with the participant
credential, so support can see what your users saw. It sends numbers, SDK and OS versions and
a device model; never media, contact details or the credential. Set `telemetry: false` to
send nothing.
