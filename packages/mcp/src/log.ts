/**
 * Human-facing output. stdout carries the MCP protocol when the bridge runs, so every message goes to stderr,
 * and every message passes through {@link redact} so tokens and keys never reach a terminal or a client log.
 */

const secrets = new Set<string>();

/** Registers a value (token, key) that must never be printed. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/lyk-(?:mgmt-)?v1-[A-Za-z0-9]{8,}/g, 'lyk-v1-[redacted]'],
  [/\b(Bearer|DPoP)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [redacted]'],
  [/("?(?:access_token|refresh_token|id_token|client_secret|code_verifier)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]'],
  [/([?&](?:code|token|access_token|refresh_token)=)[^&#\s"]+/gi, '$1[redacted]'],
];

export function redact(input: string): string {
  let out = input;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('[redacted]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack && process.env['LYKIA_MCP_DEBUG'] ? a.stack : `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

let sink: (line: string) => void = (line) => {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
};

/** Test hook: capture log output. */
export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

export const log = {
  /** Plain message for the user (stderr). */
  info(...args: unknown[]): void {
    sink(redact(format(args)));
  },
  warn(...args: unknown[]): void {
    sink(redact(`[lykia] warning: ${format(args)}`));
  },
  error(...args: unknown[]): void {
    sink(redact(`[lykia] error: ${format(args)}`));
  },
  debug(...args: unknown[]): void {
    if (process.env['LYKIA_MCP_DEBUG']) sink(redact(`[lykia:debug] ${format(args)}`));
  },
};

/** Console-compatible logger for the MCP SDK (`sdkLogger` / `logger` options); never writes to stdout. */
export const sdkLogger = {
  debug: (...args: unknown[]) => log.debug(...args),
  warn: (...args: unknown[]) => log.debug('[mcp-sdk]', ...args),
};
