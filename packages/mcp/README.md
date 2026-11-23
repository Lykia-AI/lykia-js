# @lykia/mcp

Use [Lykia](https://getlykia.com) from any MCP client: generate images, video, speech and text with one Lykia
account. **One Key. Every AI.**

Lykia runs a remote MCP server at `https://api.getlykia.com/mcp`. Clients that can add a remote server need nothing
from npm (see [Remote connector](#remote-connector-no-npm)). `@lykia/mcp` is a small stdio bridge for clients that
only start local servers: it connects to the remote server and re-exposes its tools, workflows (prompts) and
resources, and adds two local tools for files on your computer.

## Remote connector (no npm)

| Client | How |
|---|---|
| Claude Desktop | Settings → Connectors → Add custom connector → URL `https://api.getlykia.com/mcp` |
| Claude Code | `claude mcp add --transport http lykia https://api.getlykia.com/mcp`, then `/mcp` to sign in |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "lykia": { "url": "https://api.getlykia.com/mcp" } } }` |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "lykia": { "type": "http", "url": "https://api.getlykia.com/mcp" } } }` |

The client opens a browser window: sign in to Lykia, pick the company and the project whose credits and budget the
connection uses, and approve. `npx @lykia/mcp config <client> --remote` prints these snippets.

## Install the stdio bridge

1. Sign in once (or set an API key, below):

   ```sh
   npx @lykia/mcp login
   ```

2. Add the server to your client. `npx @lykia/mcp config <client>` prints the snippet; add `--write` to merge it into
   the client's config file (the previous file is backed up first; nothing is written without `--write`).

**Claude Desktop** (`claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`):

```json
{ "mcpServers": { "lykia": { "command": "npx", "args": ["-y", "@lykia/mcp"] } } }
```

**Claude Code**: `claude mcp add lykia -- npx -y @lykia/mcp`, or `.mcp.json` in the project:

```json
{ "mcpServers": { "lykia": { "type": "stdio", "command": "npx", "args": ["-y", "@lykia/mcp"] } } }
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` with `--project`):

```json
{ "mcpServers": { "lykia": { "command": "npx", "args": ["-y", "@lykia/mcp"] } } }
```

**VS Code** (`.vscode/mcp.json`):

```json
{ "servers": { "lykia": { "type": "stdio", "command": "npx", "args": ["-y", "@lykia/mcp"] } } }
```

To let the local tools use folders other than the client's working directory, add `"--allow-dir", "/path/to/folder"`
to `args` (repeatable).

## Authentication

Order: `LYKIA_API_KEY` (a project key, `lyk-v1-…`, sent as `Authorization: Bearer`) → the stored login session →
otherwise the bridge exits with a message telling you to run `npx @lykia/mcp login` or set `LYKIA_API_KEY`.

`login` uses OAuth 2.1: discovery of the server's protected-resource metadata and its authorization server,
a Client ID Metadata Document (or dynamic registration when the server offers only that), authorization code with
PKCE (S256), a loopback redirect on `127.0.0.1` with a random port, `state` and issuer (`iss`) checks, and a resource
indicator. Tokens are refreshed automatically (refresh tokens rotate); if a refresh is refused, the session is
removed and the bridge tells you to log in again.

| Command | |
|---|---|
| `npx @lykia/mcp login [--no-browser]` | sign in; prints the URL when no browser can be opened |
| `npx @lykia/mcp logout` | revokes the tokens at Lykia and deletes the session |
| `npx @lykia/mcp whoami [--json]` | company, project, limits and scopes of the credential in use |
| `npx @lykia/mcp doctor [--json]` | Node version, credentials, file permissions, server reachability, MCP connection, tool count |
| `npx @lykia/mcp config <claude-desktop\|claude-code\|cursor\|vscode> [--remote] [--write] [--path f]` | client config |

## Tools

The tool list comes from the Lykia server; the bridge forwards whatever the server lists, including progress updates
(e.g. while waiting for a video), cancellation, errors and list changes. Today the server offers 15 tools:

| Tool | What it does |
|---|---|
| `models_list` | search the catalog (text, `output_modality`, `input_modality`, `supports`, `max_price`, `free_only`, sort) |
| `model_get` | one model: prices, limits, parameters, media capabilities and `provider_options` allow-list |
| `cost_estimate` | the maximum cost of a chat request before running it |
| `chat` | a chat completion (`prompt` or `messages`, `system`, `max_tokens`, `max_cost_usd`) |
| `credits_get` | balance, reserved and available credits |
| `usage_summary` | requests, errors, tokens and USD between two dates, by model, day or key |
| `generation_get` | the record of one request (cost, tokens, latency, provider attempts) |
| `workflows_list`, `workflow_get` | the ready-made workflows (also offered as prompts, below) |
| `image_generate` | generate or edit images (`images` accepts `file_input` handles); returns signed links |
| `video_generate` | start a video job (`image` / `last_frame` / `reference_images` accept handles) |
| `video_status`, `video_wait` | poll a job, or wait for it with progress updates (up to 300 s per call; call again to keep waiting) |
| `speech_generate` | text to speech with a preset voice or one of the project's clones; returns a signed link |
| `voices_list` | voices of a speech model |

Tools that spend credits accept `max_cost_usd` and refuse to run above it. Result links are signed and last about an
hour; a stored video is kept for 7 days. Save what you want to keep with `output_save`.

**Ready-made commands.** The server's workflows appear in your client as prompts (slash commands in most clients):
`product-ad`, `ad-variants`, `ad-resize`, `ad-localize`, `logo-concepts`, `social-pack`, `storyboard`, `product-video`,
`ugc-video`, `explainer-video`, `voiceover`, `model-compare`, `cost-report`. Each one guides the assistant through
the tool calls (with a cost estimate first) for that job.

Two tools run locally:

- **`file_input`**: reads an image (PNG, JPEG, WebP, GIF) or audio file (MP3, WAV, OGG, FLAC, M4A, WebM), checks its
  type from its content and its size (10 MB default), and returns a short handle (`lykia-file:…`). Use the handle as
  the file value in a Lykia tool call (e.g. `images: ["lykia-file:…"]`); the bridge sends the file as a
  `data:<mime>;base64,…` URI. `inline: true` returns the data URI itself for small files.
- **`output_save`**: downloads a result to a file. It accepts `data:` URIs, `https` links on Lykia hosts
  (`api.getlykia.com`, `*.getlykia.com`, plus `LYKIA_MCP_DOWNLOAD_HOSTS`), and the exact links Lykia's own tools
  returned in this session (the `url` fields of their structured results, e.g. a signed storage link), so it cannot be
  used to fetch arbitrary URLs. Links that appear only in free text, such as a chat answer, are not trusted. Existing
  files are kept unless `overwrite: true`.

Both are limited to the working directory, the `--allow-dir` folders and the client's MCP roots, after resolving
symbolic links. When the client starts the bridge from the filesystem root or your home directory, that directory is
not used: pass `--allow-dir`.

Typical flow: `file_input` (`product.png`) → `image_generate` with `images: ["lykia-file:…"]` → `output_save` with
the returned link → `video_generate` from that image → `video_wait` → `output_save`.

## Environment variables

| Variable | Default | |
|---|---|---|
| `LYKIA_API_KEY` | | project API key; takes precedence over the login session |
| `LYKIA_MCP_URL` | `https://api.getlykia.com/mcp` | remote MCP endpoint |
| `LYKIA_BASE_URL` | `https://api.getlykia.com/v1` | API base used by `whoami` / `doctor` |
| `LYKIA_CONFIG_DIR` | `$XDG_CONFIG_HOME/lykia`, or `~/Library/Application Support/lykia` (macOS), `%APPDATA%\lykia` (Windows), `~/.config/lykia` | session storage |
| `LYKIA_MCP_ALLOW_DIRS` | | extra folders for the local tools (path-list separated) |
| `LYKIA_MCP_DOWNLOAD_HOSTS` | | extra hosts for `output_save` (comma separated, `*.example.com` allowed) |
| `LYKIA_MCP_MAX_FILE_MB` / `LYKIA_MCP_MAX_DOWNLOAD_MB` | 10 / 500 | size limits |
| `LYKIA_MCP_TIMEOUT_MS` | 900000 | upper bound for one forwarded call (progress keeps it alive) |
| `LYKIA_NO_BROWSER` | | do not open a browser during `login` |
| `LYKIA_OAUTH_CLIENT_ID` | | use a pre-registered OAuth client |
| `LYKIA_OAUTH_CLIENT_METADATA_URL` | `https://getlykia.com/oauth/clients/lykia-mcp.json` | client ID metadata document; `none` disables it |
| `LYKIA_MCP_DEBUG` | | verbose logs on stderr |

## Security notes

- stdout carries only MCP messages; every human message goes to stderr. Tokens and keys are redacted from all output.
- The session file is written with mode `0600` in a `0700` directory. On a shared computer prefer short sessions and
  `logout` when done. Do not put `LYKIA_API_KEY` in config files that you commit or share.
- The bridge sends credentials only to the configured Lykia server. `output_save` sends them only to the Lykia API
  origin, never to storage hosts or redirect targets.
- Every tool call is billed to the project you chose; Lykia tools that spend credits accept `max_cost_usd`.
- No telemetry.

## Troubleshooting

- **"No Lykia credentials found"**: run `npx @lykia/mcp login` or set `LYKIA_API_KEY` in the server's `env`.
- **"session expired or was revoked"**: run `npx @lykia/mcp login` again (the app may have been disconnected under
  Settings → Connected apps).
- **Only `file_input` and `output_save` are listed**: the Lykia server could not be reached; run `npx @lykia/mcp doctor`.
  The bridge keeps retrying and announces the remote tools when it reconnects.
- **"outside the allowed directories"**: start the bridge with `--allow-dir <folder>`.
- **`npx` not found (Windows)**: use `"command": "cmd", "args": ["/c", "npx", "-y", "@lykia/mcp"]`.
- Logs: run with `LYKIA_MCP_DEBUG=1`; your client shows the server's stderr in its MCP log.

## Server contract (for implementers)

The bridge expects: protected resource metadata at `/.well-known/oauth-protected-resource/mcp`, authorization server
metadata (RFC 8414) with `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported`
and either `client_id_metadata_document_supported: true` or a `registration_endpoint`; refresh-token rotation;
`revocation_endpoint` (RFC 7009); media tools whose structured results carry result links under `url` keys;
`GET /v1/key` returning `company`, `project`, `label`, limits and (OAuth) `scopes` for
both API keys and access tokens. The client ID metadata document served at
`https://getlykia.com/oauth/clients/lykia-mcp.json` should read:

```json
{
  "client_id": "https://getlykia.com/oauth/clients/lykia-mcp.json",
  "client_name": "Lykia MCP bridge (@lykia/mcp)",
  "client_uri": "https://getlykia.com",
  "redirect_uris": ["http://127.0.0.1/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "native"
}
```

with the loopback port allowed to vary (RFC 8252 §7.3). Built against MCP specification 2026-07-28 and the MCP
TypeScript SDK v2 (`@modelcontextprotocol/client` / `server` 2.4); 2025-era clients and servers are served too.

---

## Türkçe

**@lykia/mcp**, yalnız yerel (stdio) sunucu başlatabilen MCP istemcileri için Lykia köprüsüdür; uzak sunucuya
(`https://api.getlykia.com/mcp`) bağlanır ve oradaki araçları, iş akışlarını ve kaynakları aynen sunar. Uzak sunucu
ekleyebilen istemcide npm gerekmez: adresi bağlayıcı olarak ekleyin, tarayıcıda giriş yapıp şirketi ve projeyi seçin.

Kurulum: `npx @lykia/mcp login` ile bir kez giriş yapın (ya da `LYKIA_API_KEY` ortam değişkenine proje anahtarını
koyun), sonra `npx @lykia/mcp config claude-desktop` (ya da `claude-code`, `cursor`, `vscode`) çıktısını istemcinin
ayar dosyasına ekleyin; `--write` dosyayı yedekleyip birleştirir. `whoami` hangi şirket ve projeye bağlı olduğunuzu,
`doctor` bağlantı durumunu gösterir, `logout` oturumu iptal edip siler.

Uzak sunucunun 15 aracı (`models_list`, `model_get`, `cost_estimate`, `chat`, `credits_get`, `usage_summary`,
`generation_get`, `workflows_list`, `workflow_get`, `image_generate`, `video_generate`, `video_status`, `video_wait`,
`speech_generate`, `voices_list`) ve hazır komutlar (`product-ad`, `ad-variants`, `ad-resize`, `ad-localize`,
`logo-concepts`, `social-pack`, `storyboard`, `product-video`, `ugc-video`, `explainer-video`, `voiceover`,
`model-compare`, `cost-report`) olduğu gibi sunulur.

Yerel araçlar: `file_input` bilgisayarınızdaki görsel ya da ses dosyasını Lykia araçlarına girdi yapar;
`output_save` sonucu diske indirir (Lykia araçlarının bu oturumda döndürdüğü imzalı bağlantılar dahil). İkisi de yalnız çalışma dizini, `--allow-dir` ile verilen klasörler ve istemcinin
kök dizinleriyle sınırlıdır; `output_save` yalnız Lykia adreslerinden ve Lykia araçlarının döndürdüğü bağlantılardan indirir ve var olan dosyanın üzerine
`overwrite: true` olmadan yazmaz. Oturum dosyası 0600 izinle saklanır; anahtar ve jetonlar hiçbir çıktıda görünmez.
