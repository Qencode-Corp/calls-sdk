# Manual smoke page

Drives the public API through the UMD bundle with a pasted credential, no backend needed.
Useful for the first end-to-end run against any Qencode Calls region.

```
npm run build
# serve sdk/web over HTTPS or localhost, open examples/smoke/index.html
# or copy dist/qencode-calls.umd.js next to index.html and host both on any HTTPS origin
```

URL parameters: `cred=<base64 credential JSON>` prefills the credential; `adaptive=0` sets
`adaptiveStream: false`, which you want when both participants are tabs of one browser
(a background tab's hidden video pauses the track otherwise). `window.__call` and
`window.__events` are exposed for inspection from the console.
