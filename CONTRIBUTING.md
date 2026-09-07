# Contributing

Issues and pull requests are welcome.

- **Bugs**: use the bug template; include SDK version, browser or OS version, and the
  `stats` snapshot or console output where it applies. Never paste credentials.
- **Changes**: open an issue first for anything that touches the public surface. The three
  SDKs share one vocabulary, so a new method or event lands on all platforms together.
- **Web package**: `cd web && npm ci && npm test && npm run build`. Tests run offline against
  a mocked engine; the manual smoke page in `web/examples/smoke` runs against a real region.
- **Style**: TypeScript strict, no engine types on the public surface, every error mapped to a
  documented code.

By contributing you agree that your contributions are licensed under Apache 2.0.
