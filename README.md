# lykia-js

JavaScript packages for [Lykia](https://getlykia.com). **One Key. Every AI.**

| Package | |
|---|---|
| [`@lykia/sdk`](packages/sdk) | Dependency-free TypeScript client for the Lykia `/v1` API (chat with streaming, embeddings, models, credits, images, video, speech). Also a single-file build for vendoring and a fake server for tests. |
| [`@lykia/mcp`](packages/mcp) | stdio bridge to Lykia's remote MCP server (`npx -y @lykia/mcp`), with OAuth login and local file tools. |

```sh
npm install          # dev dependencies
npm run build        # both packages
npm run check        # lint + typecheck + build + tests + npm pack file check
```

Single-file artifacts: see [ARTIFACTS.md](ARTIFACTS.md). Releasing: see [PUBLISHING.md](PUBLISHING.md).

Tests run only against local fakes (a fake `/v1` server, a fake OAuth authorization server and a fake remote MCP
server, on ephemeral `127.0.0.1` ports); they never contact a real Lykia host or touch real user configuration.

**Conformance (opt-in).** `npm run conformance` runs both packages against a real Lykia gateway when
`LYKIA_CONFORMANCE_URL` (the `/v1` base) and `LYKIA_CONFORMANCE_KEY` are set, and skips otherwise. It spends a little
money: use a staging or local gateway. `scripts/conformance/backend-env.mjs` starts a local gateway from a backend
checkout (`LYKIA_BACKEND_DIR`) with its fake providers and a throwaway database on ports 7821–7826 / 27221, provisions a
project with presets and a key, and writes `env.json` to `LYKIA_CONFORMANCE_WORK`; `curl -X POST :7826/stop` stops it.
Build first (`npm run build`): the MCP suite runs the built `lykia-mcp`.

## Türkçe

Lykia için JavaScript paketleri: `@lykia/sdk` (`/v1` istemcisi) ve `@lykia/mcp` (MCP istemcileri için köprü).
Geliştirme: `npm install`, `npm run check`. Yayın adımları `PUBLISHING.md` dosyasındadır.
