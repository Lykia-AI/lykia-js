/**
 * Credentials for the remote MCP connection. Order: `LYKIA_API_KEY` → stored OAuth session → error.
 */
import type { AuthProvider } from '@modelcontextprotocol/client';
import type { Settings } from './config.js';
import { AuthRejectedError, LOGIN_HINT, LoginRequiredError } from './errors.js';
import { registerSecret } from './log.js';
import { refreshSession } from './oauth.js';
import { loadSession, type Session } from './session.js';

export type AuthSource = { kind: 'api-key' } | { kind: 'oauth'; session: Session };

/** Decides which credentials to use, without network access. */
export async function resolveAuthSource(settings: Settings): Promise<AuthSource> {
  if (settings.apiKey) {
    registerSecret(settings.apiKey);
    return { kind: 'api-key' };
  }
  const session = await loadSession(settings.configDir, settings.mcpUrl);
  if (session) return { kind: 'oauth', session };
  throw new LoginRequiredError('No Lykia credentials found.');
}

/** Static API key: a 401 is final (keys are not refreshable). */
export function apiKeyAuthProvider(apiKey: string): AuthProvider {
  registerSecret(apiKey);
  return {
    token: async () => apiKey,
    onUnauthorized: async () => {
      throw new AuthRejectedError(
        'Lykia rejected the API key in LYKIA_API_KEY (401: missing, invalid, disabled, archived or expired key). ' +
          'Check the key in the Lykia dashboard, or unset LYKIA_API_KEY to use `npx @lykia/mcp login`.',
      );
    },
  };
}

const EXPIRY_SKEW_MS = 60_000;

/**
 * OAuth session provider for the bridge. Reads the session file on every request so rotations made by
 * another process are picked up, refreshes shortly before expiry, and on a 401 refreshes once (the
 * transport then retries once and surfaces a second 401). Never starts a browser flow: a bridge runs
 * inside an MCP client, so it tells the user to run `login` instead.
 */
export function sessionAuthProvider(settings: Settings): AuthProvider {
  let lastToken: string | undefined;
  return {
    token: async () => {
      let session = await loadSession(settings.configDir, settings.mcpUrl);
      if (!session) throw new LoginRequiredError('You are signed out of Lykia (no stored session).');
      if (session.tokens.expires_at && session.tokens.expires_at - EXPIRY_SKEW_MS < Date.now() && session.tokens.refresh_token) {
        session = await refreshSession(settings, session.tokens.access_token);
      }
      lastToken = session.tokens.access_token;
      return lastToken;
    },
    onUnauthorized: async () => {
      try {
        await refreshSession(settings, lastToken);
      } catch (err) {
        if (err instanceof LoginRequiredError) throw err;
        throw new AuthRejectedError(`Lykia rejected the session token and refreshing failed: ${(err as Error).message}. ${LOGIN_HINT}`);
      }
    },
  };
}

export function authProviderFor(settings: Settings, source: AuthSource): AuthProvider {
  return source.kind === 'api-key' && settings.apiKey ? apiKeyAuthProvider(settings.apiKey) : sessionAuthProvider(settings);
}
