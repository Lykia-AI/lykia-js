#!/usr/bin/env node
/**
 * `lykia-mcp`: stdio bridge to the Lykia MCP server, plus login/logout/whoami/doctor/config.
 */
import { cmdConfig, cmdDoctor, cmdLogin, cmdLogout, cmdServe, cmdWhoami } from './commands.js';
import { loadSettings } from './config.js';
import { CliError } from './errors.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const HELP = `lykia-mcp ${VERSION}: Lykia for MCP clients (One Key. Every AI.)

Usage:
  npx -y @lykia/mcp [--allow-dir <dir>]...   run the stdio bridge (what MCP clients start)
  npx @lykia/mcp login [--no-browser]        sign in with your browser (OAuth)
  npx @lykia/mcp logout                      revoke and delete the stored session
  npx @lykia/mcp whoami [--json]             show the company and project in use
  npx @lykia/mcp doctor [--json]             check connectivity, credentials and the server
  npx @lykia/mcp config <client> [--remote] [--write] [--path <file>] [--name <name>] [--project]
                                             print (or merge) MCP client config; client is one of
                                             claude-desktop, claude-code, cursor, vscode

Environment:
  LYKIA_API_KEY            project API key (lyk-v1-…); used instead of a login session
  LYKIA_MCP_URL            remote MCP endpoint (default https://api.getlykia.com/mcp)
  LYKIA_BASE_URL           API base for whoami (default https://api.getlykia.com/v1)
  LYKIA_CONFIG_DIR         where the login session is stored
  LYKIA_MCP_ALLOW_DIRS     extra directories for file_input / output_save (path-list separated)
  LYKIA_MCP_DOWNLOAD_HOSTS extra hosts output_save may download from (comma separated)
  LYKIA_MCP_DEBUG=1        verbose logs on stderr
`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
  allowDirs: string[];
}

const VALUE_FLAGS = new Set(['--allow-dir', '--path', '--name', '--scope']);

function parse(argv: string[]): Parsed {
  const out: Parsed = { command: undefined, positional: [], flags: new Map(), allowDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      let value: string | true = true;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined) throw new CliError(`${name} needs a value`);
        value = next;
        i++;
      }
      if (name === '--allow-dir') out.allowDirs.push(String(value));
      else out.flags.set(name, value);
    } else if (a === '-h') out.flags.set('--help', true);
    else if (a === '-v') out.flags.set('--version', true);
    else if (out.command === undefined) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

async function main(): Promise<void> {
  const p = parse(process.argv.slice(2));
  if (p.flags.has('--help') || p.command === 'help') {
    process.stderr.write(HELP);
    return;
  }
  if (p.flags.has('--version')) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  const settings = loadSettings({ allowDirs: p.allowDirs, ...(p.flags.has('--no-browser') ? { noBrowser: true } : {}) });
  const json = p.flags.has('--json');
  switch (p.command) {
    case undefined:
    case 'serve':
    case 'start':
      return cmdServe(settings);
    case 'login': {
      const scope = p.flags.get('--scope');
      return cmdLogin(settings, typeof scope === 'string' ? { scope } : {});
    }
    case 'logout':
      return cmdLogout(settings);
    case 'whoami':
      return cmdWhoami(settings, { json });
    case 'doctor':
      return cmdDoctor(settings, { json });
    case 'config': {
      const path = p.flags.get('--path');
      const name = p.flags.get('--name');
      return cmdConfig(settings, {
        client: p.positional[0],
        remote: p.flags.has('--remote'),
        write: p.flags.has('--write'),
        ...(typeof path === 'string' ? { path } : {}),
        name: typeof name === 'string' ? name : 'lykia',
        project: p.flags.has('--project'),
        allowDirs: p.allowDirs,
      });
    }
    default:
      throw new CliError(`Unknown command "${p.command}". Run with --help.`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    if (err.message) log.info(err.message);
    process.exit(err.exitCode);
  }
  log.error((err as Error)?.message ?? String(err));
  process.exit(1);
});
