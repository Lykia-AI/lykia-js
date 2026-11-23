/**
 * MCP client configuration snippets (`lykia-mcp config <client>`), and the opt-in `--write` that merges the
 * snippet into the client's config file after backing it up.
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_MCP_URL } from './config.js';

export const CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'vscode'] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface SnippetOptions {
  client: ClientName;
  /** Connect the client to the remote server URL directly instead of running the npm bridge. */
  remote: boolean;
  mcpUrl: string;
  name: string;
  allowDirs: string[];
  /** Cursor: write the project file instead of the user-wide one. */
  project: boolean;
  cwd: string;
}

export interface Snippet {
  /** JSON object to merge; `undefined` when the client takes no file (e.g. remote Claude Desktop). */
  json: Record<string, unknown> | undefined;
  /** The config file this snippet belongs in. */
  path: string | undefined;
  /** Top-level key holding the servers (`mcpServers` or `servers`). */
  rootKey: 'mcpServers' | 'servers';
  /** Extra human instructions. */
  notes: string[];
}

function claudeDesktopPath(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default:
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
  }
}

export function buildSnippet(o: SnippetOptions): Snippet {
  const args = ['-y', '@lykia/mcp'];
  for (const d of o.allowDirs) args.push('--allow-dir', d);
  const env: Record<string, string> = {};
  if (o.mcpUrl !== DEFAULT_MCP_URL) env['LYKIA_MCP_URL'] = o.mcpUrl;
  const stdio = { command: 'npx', args, ...(Object.keys(env).length ? { env } : {}) };
  const keyNote =
    'Authentication: run `npx @lykia/mcp login` once (browser sign-in), or add "env": { "LYKIA_API_KEY": "lyk-v1-…" } to this entry. ' +
    'Keep API keys out of shared or committed files.';

  switch (o.client) {
    case 'claude-desktop':
      if (o.remote) {
        return {
          json: undefined,
          path: undefined,
          rootKey: 'mcpServers',
          notes: [
            'Claude Desktop adds remote servers in the app, not in a file: Settings → Connectors → Add custom connector,',
            `name "Lykia", URL ${o.mcpUrl}. Sign in to Lykia in the browser window that opens and choose the company and project.`,
          ],
        };
      }
      return { json: { mcpServers: { [o.name]: stdio } }, path: claudeDesktopPath(), rootKey: 'mcpServers', notes: [keyNote, 'Restart Claude Desktop after changing the file.'] };
    case 'claude-code': {
      const path = resolve(o.cwd, '.mcp.json');
      if (o.remote) {
        return {
          json: { mcpServers: { [o.name]: { type: 'http', url: o.mcpUrl } } },
          path,
          rootKey: 'mcpServers',
          notes: [`Or run: claude mcp add --transport http ${o.name} ${o.mcpUrl}`, 'Then authenticate with /mcp inside Claude Code.'],
        };
      }
      return {
        json: { mcpServers: { [o.name]: { type: 'stdio', ...stdio } } },
        path,
        rootKey: 'mcpServers',
        notes: [`Or run: claude mcp add ${o.name} -- npx ${args.join(' ')}`, keyNote],
      };
    }
    case 'cursor': {
      const path = o.project ? resolve(o.cwd, '.cursor', 'mcp.json') : join(homedir(), '.cursor', 'mcp.json');
      return {
        json: { mcpServers: { [o.name]: o.remote ? { url: o.mcpUrl } : stdio } },
        path,
        rootKey: 'mcpServers',
        notes: o.remote ? ['Cursor asks you to sign in to Lykia the first time it connects.'] : [keyNote],
      };
    }
    case 'vscode': {
      const path = resolve(o.cwd, '.vscode', 'mcp.json');
      return {
        json: { servers: { [o.name]: o.remote ? { type: 'http', url: o.mcpUrl } : { type: 'stdio', ...stdio } } },
        path,
        rootKey: 'servers',
        notes: o.remote
          ? ['VS Code asks you to sign in to Lykia the first time it starts the server.']
          : [
              keyNote,
              'To be prompted for a key instead, add "inputs": [{ "type": "promptString", "id": "lykia-api-key", "description": "Lykia API key", "password": true }] ' +
                'and "env": { "LYKIA_API_KEY": "${input:lykia-api-key}" } to the server entry.',
            ],
      };
    }
  }
}

export interface WriteResult {
  path: string;
  backup: string | undefined;
  replaced: boolean;
}

/**
 * Merges the snippet's server entry into the config file. Existing content is kept; an existing entry with the
 * same name is replaced. The previous file is copied to `<file>.lykia-backup-<timestamp>` first. A file that is not
 * plain JSON (e.g. JSON with comments) is left untouched and an error is thrown.
 */
export async function writeSnippet(snippet: Snippet, pathOverride?: string): Promise<WriteResult> {
  const path = pathOverride ? resolve(pathOverride) : snippet.path;
  if (!path || !snippet.json) throw new Error('This client is configured in its app, not in a file; nothing to write.');
  let existing: Record<string, unknown> = {};
  let backup: string | undefined;
  let mode: number | undefined;
  try {
    const raw = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        existing = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`${path} is not plain JSON (comments?); not changing it. Add the snippet by hand.`);
      }
    }
    backup = `${path}.lykia-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(path, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = snippet.rootKey;
  const servers = (existing[key] && typeof existing[key] === 'object' ? existing[key] : {}) as Record<string, unknown>;
  const [name, entry] = Object.entries(snippet.json[key] as Record<string, unknown>)[0]!;
  const replaced = name in servers;
  const merged = { ...existing, [key]: { ...servers, [name]: entry } };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.lykia-tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: mode ?? 0o644 });
  await rename(tmp, path);
  return { path, backup, replaced };
}
