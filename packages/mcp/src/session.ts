/**
 * OAuth session storage: one JSON file per MCP server URL under the config dir.
 * Directory 0700, file 0600, atomic replace (write temp + rename). A lock file serialises refreshes across
 * processes: refresh tokens rotate on every use and reusing an old one revokes the grant, so two bridges
 * (e.g. two MCP clients) must never refresh at the same time with the same token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerSecret } from './log.js';

export interface StoredTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** Epoch ms. */
  expires_at?: number;
}

export interface Session {
  version: 1;
  mcpUrl: string;
  resource: string;
  issuer: string;
  authorizationServerUrl: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** Full AS metadata, kept for refresh requests (auth method selection). */
  authorizationServerMetadata: Record<string, unknown>;
  client: { client_id: string; client_secret?: string; token_endpoint_auth_method?: string; [k: string]: unknown };
  tokens: StoredTokens;
  createdAt: string;
  updatedAt: string;
}

export function sessionKey(mcpUrl: string): string {
  return createHash('sha256').update(mcpUrl).digest('hex').slice(0, 16);
}

export function sessionPath(configDir: string, mcpUrl: string): string {
  return join(configDir, 'sessions', `${sessionKey(mcpUrl)}.json`);
}

export async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const st = await stat(dir);
    if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
  }
}

/** Writes a file atomically with 0600 permissions. */
export async function writeSecureFile(path: string, content: string): Promise<void> {
  const dir = join(path, '..');
  await ensureSecureDir(dir);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function remember(session: Session): Session {
  registerSecret(session.tokens.access_token);
  registerSecret(session.tokens.refresh_token);
  registerSecret(session.client.client_secret);
  return session;
}

export async function loadSession(configDir: string, mcpUrl: string): Promise<Session | undefined> {
  const path = sessionPath(configDir, mcpUrl);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: Session;
  try {
    parsed = JSON.parse(raw) as Session;
  } catch {
    return undefined;
  }
  if (parsed.version !== 1 || parsed.mcpUrl !== mcpUrl || !parsed.tokens?.access_token) return undefined;
  return remember(parsed);
}

export async function saveSession(configDir: string, session: Session): Promise<void> {
  remember(session);
  await writeSecureFile(sessionPath(configDir, session.mcpUrl), `${JSON.stringify(session, null, 2)}\n`);
}

export async function deleteSession(configDir: string, mcpUrl: string): Promise<boolean> {
  try {
    await unlink(sessionPath(configDir, mcpUrl));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

/** Runs `fn` while holding an exclusive lock file next to the session. */
export async function withSessionLock<T>(configDir: string, mcpUrl: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${sessionPath(configDir, mcpUrl)}.lock`;
  await ensureSecureDir(join(lockPath, '..'));
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('Timed out waiting for the session lock', { cause: err });
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
