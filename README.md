# Qencode Calls SDK

Client libraries for Qencode Calls: real-time 1:1 audio and video calls that you render in
your own interface. Your backend creates a call and mints a per-participant credential
through the Qencode API; the SDK takes that credential, connects to the nearest region,
publishes camera and microphone, renders the remote stream, and reports call quality.

| Package | Platform | Status |
|---|---|---|
| [`@qencode/calls`](web/) | Web, TypeScript, evergreen browsers | [0.2.0 on npm](https://www.npmjs.com/package/@qencode/calls), pre-release |
| `com.qencode:calls` | Android, Kotlin, API 24+ | in development |
| [`QencodeCalls`](https://github.com/Qencode-Corp/calls-sdk-swift) | iOS 15+, Swift Package | in development, separate repository |
| `@qencode/calls-server`, `qencode-calls` (PyPI) | Node and Python helpers for the token step | in development |

Start with the [integration guide](docs/integration-guide.md), then the
[API reference](docs/api.md) for the six server-side calls your backend makes.

## Layout

```
web/        @qencode/calls: source, tests, builds, examples
docs/       integration guide and API reference
android/    (planned) com.qencode:calls
server/     (planned) Node and Python helpers
```

## Principles

- **Custom UI first.** The SDK renders video into a view you place. No screens, no theme.
- **No API keys in apps.** Apps hold only a short-lived participant credential minted by your backend.
- **Same vocabulary everywhere.** One set of objects, events and error codes across web, iOS and Android.
- **Lowest latency by default.** Hardware H.264, 540p at 60 fps, region selection by probe.

## License

Apache 2.0. See [LICENSE](LICENSE).
