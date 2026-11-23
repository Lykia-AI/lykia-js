import { homedir, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export const DEFAULT_MCP_URL = 'https://api.getlykia.com/mcp';
export const DEFAULT_BASE_URL = 'https://api.getlykia.com/v1';
/**
 * Client ID Metadata Document of the bridge (the OAuth `client_id`). Used when the authorization server advertises
 * `client_id_metadata_document_supported`; otherwise the bridge falls back to dynamic client registration.
 */
export const DEFAULT_CLIENT_METADATA_URL = 'https://getlykia.com/oauth/clients/lykia-mcp.json';

export interface Settings {
  /** Remote MCP endpoint (Streamable HTTP). */
  mcpUrl: string;
  /** `/v1` base URL. */
  baseUrl: string;
  /** API key from `LYKIA_API_KEY` (takes precedence over a stored OAuth session). */
  apiKey: string | undefined;
  /** Directory holding the OAuth session (0700). */
  configDir: string;
  /** Extra directories the local file tools may use. */
  allowDirs: string[];
  /** Host allow-list for `output_save` downloads (exact hosts or `*.domain`). */
  downloadHosts: string[];
  /** `file_input` size limit in bytes. */
  maxFileBytes: number;
  /** `output_save` size limit in bytes. */
  maxDownloadBytes: number;
  /** Upper bound for one forwarded request (ms); progress notifications reset the idle timer. */
  requestTimeoutMs: number;
  /** Do not try to open a browser during `login`. */
  noBrowser: boolean;
  /** Pre-registered OAuth client id (skips dynamic registration). */
  oauthClientId: string | undefined;
  /** HTTPS URL of the Client ID Metadata Document (preferred when the AS supports it); `none` in the env disables it. */
  oauthClientMetadataUrl: string | undefined;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function intEnv(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `$LYKIA_CONFIG_DIR` → `$XDG_CONFIG_HOME/lykia` → platform default. */
export function resolveConfigDir(): string {
  const explicit = env('LYKIA_CONFIG_DIR');
  if (explicit) return resolve(explicit);
  const xdg = env('XDG_CONFIG_HOME');
  if (xdg) return join(resolve(xdg), 'lykia');
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(env('APPDATA') ?? join(home, 'AppData', 'Roaming'), 'lykia');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'lykia');
    default:
      return join(home, '.config', 'lykia');
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function loadSettings(overrides: { allowDirs?: string[]; noBrowser?: boolean } = {}): Settings {
  const mcpUrl = env('LYKIA_MCP_URL') ?? DEFAULT_MCP_URL;
  const baseUrl = (env('LYKIA_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const envDirs = (env('LYKIA_MCP_ALLOW_DIRS') ?? '').split(delimiter).filter(Boolean);
  const hosts = new Set<string>(['api.getlykia.com', '*.getlykia.com']);
  for (const u of [mcpUrl, baseUrl]) {
    const h = hostOf(u);
    if (h) hosts.add(h);
  }
  for (const h of (env('LYKIA_MCP_DOWNLOAD_HOSTS') ?? '').split(',')) {
    if (h.trim()) hosts.add(h.trim().toLowerCase());
  }
  const settings: Omit<Settings, 'apiKey'> = {
    mcpUrl,
    baseUrl,
    configDir: resolveConfigDir(),
    allowDirs: [...envDirs, ...(overrides.allowDirs ?? [])].map((d) => resolve(d)),
    downloadHosts: [...hosts],
    maxFileBytes: intEnv('LYKIA_MCP_MAX_FILE_MB', 10) * 1024 * 1024,
    maxDownloadBytes: intEnv('LYKIA_MCP_MAX_DOWNLOAD_MB', 500) * 1024 * 1024,
    requestTimeoutMs: intEnv('LYKIA_MCP_TIMEOUT_MS', 15 * 60 * 1000),
    noBrowser: overrides.noBrowser ?? Boolean(env('LYKIA_NO_BROWSER')),
    oauthClientId: env('LYKIA_OAUTH_CLIENT_ID'),
    oauthClientMetadataUrl: ((v) => (v === 'none' ? undefined : (v ?? DEFAULT_CLIENT_METADATA_URL)))(env('LYKIA_OAUTH_CLIENT_METADATA_URL')),
  };
  return withSecretApiKey(settings, env('LYKIA_API_KEY'));
}

/**
 * Attaches the API key as a non-enumerable getter: `JSON.stringify`, `console.log` and spreading the settings (or any
 * object holding them, such as the bridge) never reveal it.
 */
export function withSecretApiKey(settings: Omit<Settings, 'apiKey'>, apiKey: string | undefined): Settings {
  Object.defineProperty(settings, 'apiKey', { get: () => apiKey, enumerable: false, configurable: false });
  return settings as Settings;
}

/** The canonical resource identifier for the MCP server (RFC 8707): no fragment, no trailing slash. */
export function canonicalResource(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  u.hash = '';
  u.search = '';
  const s = u.toString();
  return s.endsWith('/') && u.pathname !== '/' ? s.slice(0, -1) : s.replace(/\/$/, '');
}
