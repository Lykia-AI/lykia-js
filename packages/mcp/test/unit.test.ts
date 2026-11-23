import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnippet, writeSnippet } from '../src/clients.js';
import { canonicalResource, loadSettings, resolveConfigDir } from '../src/config.js';
import { FsAccessError, FsGuard } from '../src/local/fs-guard.js';
import { sniff } from '../src/local/mime.js';
import { FileHandleStore, LocalToolError } from '../src/local/tools.js';
import { redact, registerSecret } from '../src/log.js';
import { loadSession, saveSession, sessionPath, withSessionLock, type Session } from '../src/session.js';
import { VERSION } from '../src/version.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lykia-unit-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('redact', () => {
  it('removes keys, bearer tokens, OAuth fields and registered secrets', () => {
    registerSecret('super-secret-token-value');
    const out = redact(
      'key lyk-v1-abcdef0123456789 Authorization: Bearer abc.def-ghi "access_token":"zzz" refresh_token=yyy ?code=ccc&state=s super-secret-token-value "code": 404',
    );
    expect(out).not.toMatch(/abcdef0123456789|abc\.def|zzz|yyy|ccc|super-secret/);
    expect(out).toContain('"code": 404');
  });
});

describe('config', () => {
  it('resolves the config dir from LYKIA_CONFIG_DIR, then XDG_CONFIG_HOME', () => {
    const saved = { ...process.env };
    try {
      process.env['LYKIA_CONFIG_DIR'] = join(root, 'cfg');
      expect(resolveConfigDir()).toBe(join(root, 'cfg'));
      delete process.env['LYKIA_CONFIG_DIR'];
      process.env['XDG_CONFIG_HOME'] = join(root, 'xdg');
      expect(resolveConfigDir()).toBe(join(root, 'xdg', 'lykia'));
    } finally {
      process.env = saved;
    }
  });

  it('builds the download allow-list and canonical resource', () => {
    const saved = { ...process.env };
    try {
      process.env['LYKIA_MCP_URL'] = 'https://mcp.example.test/mcp';
      process.env['LYKIA_MCP_DOWNLOAD_HOSTS'] = 'cdn.example.test';
      const s = loadSettings();
      expect(s.downloadHosts).toEqual(expect.arrayContaining(['api.getlykia.com', '*.getlykia.com', 'mcp.example.test', 'cdn.example.test']));
      expect(s.oauthClientMetadataUrl).toBe('https://getlykia.com/oauth/clients/lykia-mcp.json');
      process.env['LYKIA_OAUTH_CLIENT_METADATA_URL'] = 'none';
      expect(loadSettings().oauthClientMetadataUrl).toBeUndefined();
    } finally {
      process.env = saved;
    }
    expect(canonicalResource('https://API.getlykia.com/mcp/#frag')).toBe('https://api.getlykia.com/mcp');
  });
});

describe('mime sniffing', () => {
  it('recognises images and audio by content', () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe('image/png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp');
    expect(sniff(Buffer.from('RIFF\0\0\0\0WAVEfmt '))?.mime).toBe('audio/wav');
    expect(sniff(Buffer.from('ID3\x04\0'))?.mime).toBe('audio/mpeg');
    expect(sniff(Buffer.from('\0\0\0\x20ftypM4A \0'))?.mime).toBe('audio/mp4');
    expect(sniff(Buffer.from('#!/bin/sh\n'))).toBeUndefined();
  });
});

describe('FsGuard', () => {
  it('confines reads and writes to allowed roots, resolving symlinks', async () => {
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(work, 'a.png'), 'x');
    writeFileSync(join(outside, 'secret.png'), 'x');
    symlinkSync(join(outside, 'secret.png'), join(work, 'link.png'));
    symlinkSync(outside, join(work, 'dirlink'));
    const guard = new FsGuard({ cwd: work, allowDirs: [] });
    expect(await guard.resolveReadable('a.png')).toMatch(/a\.png$/);
    await expect(guard.resolveReadable('../outside/secret.png')).rejects.toBeInstanceOf(FsAccessError);
    await expect(guard.resolveReadable('link.png')).rejects.toThrow(/outside the allowed/);
    await expect(guard.resolveWritable('dirlink/x.png')).rejects.toThrow(/outside the allowed/);
    await expect(guard.resolveWritable('link.png')).rejects.toThrow(/symbolic link/);
    expect((await guard.resolveWritable('new/deep/out.png')).exists).toBe(false);
    const allowed = new FsGuard({ cwd: work, allowDirs: [outside] });
    expect(await allowed.resolveReadable(join(outside, 'secret.png'))).toMatch(/secret\.png$/);
  });

  it('does not use the filesystem root or the home directory as an implicit root', async () => {
    expect(new FsGuard({ cwd: '/', allowDirs: [] }).cwdExcluded).toBe(true);
    expect(new FsGuard({ cwd: homedir(), allowDirs: [] }).cwdExcluded).toBe(true);
    await expect(new FsGuard({ cwd: '/', allowDirs: [] }).resolveReadable('/etc/hosts')).rejects.toThrow(/No directory is allowed/);
  });
});

describe('FileHandleStore', () => {
  it('expands handles at any depth and rejects unknown ones', () => {
    const store = new FileHandleStore();
    const h = store.add({ name: 'a.png', mime: 'image/png', bytes: 3, data: Buffer.from('abc') });
    expect(h).toMatch(/^lykia-file:[a-f0-9]{24}$/);
    expect(store.expand({ images: [h], nested: { image: h }, text: 'keep' })).toEqual({
      images: ['data:image/png;base64,YWJj'],
      nested: { image: 'data:image/png;base64,YWJj' },
      text: 'keep',
    });
    expect(() => store.expand({ image: 'lykia-file:' + '0'.repeat(24) })).toThrow(LocalToolError);
  });
});

describe('session storage', () => {
  const session = (mcpUrl: string): Session => ({
    version: 1,
    mcpUrl,
    resource: mcpUrl,
    issuer: 'https://as.test',
    authorizationServerUrl: 'https://as.test',
    tokenEndpoint: 'https://as.test/token',
    authorizationServerMetadata: {},
    client: { client_id: 'c1' },
    tokens: { access_token: 'at-1234567890', token_type: 'Bearer' },
    createdAt: 'x',
    updatedAt: 'x',
  });

  it('writes 0600 files in a 0700 directory and reads them back', async () => {
    const dir = join(root, 'sess');
    await saveSession(dir, session('https://a.test/mcp'));
    const path = sessionPath(dir, 'https://a.test/mcp');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'sessions')).mode & 0o777).toBe(0o700);
    }
    expect((await loadSession(dir, 'https://a.test/mcp'))?.tokens.access_token).toBe('at-1234567890');
    expect(await loadSession(dir, 'https://other.test/mcp')).toBeUndefined();
    expect(readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('serialises work under the session lock', async () => {
    const dir = join(root, 'lock');
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withSessionLock(dir, 'https://a.test/mcp', async () => {
          order.push(`start${n}`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`end${n}`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.replace('start', '')).toBe(order[i + 1]!.replace('end', ''));
  });
});

describe('client config snippets', () => {
  const base = { mcpUrl: 'https://api.getlykia.com/mcp', name: 'lykia', allowDirs: [] as string[], project: false, cwd: '/tmp/lykia-not-used' };

  it('builds stdio and remote snippets', () => {
    expect(buildSnippet({ ...base, client: 'claude-desktop', remote: false }).json).toEqual({ mcpServers: { lykia: { command: 'npx', args: ['-y', '@lykia/mcp'] } } });
    expect(buildSnippet({ ...base, client: 'vscode', remote: true }).json).toEqual({ servers: { lykia: { type: 'http', url: 'https://api.getlykia.com/mcp' } } });
    expect(buildSnippet({ ...base, client: 'cursor', remote: true }).json).toEqual({ mcpServers: { lykia: { url: 'https://api.getlykia.com/mcp' } } });
    expect(buildSnippet({ ...base, client: 'claude-code', remote: false, allowDirs: ['/data'] }).json).toEqual({
      mcpServers: { lykia: { type: 'stdio', command: 'npx', args: ['-y', '@lykia/mcp', '--allow-dir', '/data'] } },
    });
    expect(buildSnippet({ ...base, client: 'claude-desktop', remote: true }).json).toBeUndefined();
    const custom = buildSnippet({ ...base, mcpUrl: 'https://staging.test/mcp', client: 'cursor', remote: false });
    expect(JSON.stringify(custom.json)).toContain('LYKIA_MCP_URL');
    expect(JSON.stringify(custom.json)).not.toContain('LYKIA_API_KEY');
  });

  it('merges into an existing file after a backup and refuses non-JSON files', async () => {
    const file = join(root, 'claude_desktop_config.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    const snip = buildSnippet({ ...base, client: 'claude-desktop', remote: false });
    const r = await writeSnippet(snip, file);
    expect(r.replaced).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' }, lykia: { command: 'npx', args: ['-y', '@lykia/mcp'] } } });
    expect(JSON.parse(readFileSync(r.backup!, 'utf8')).mcpServers.lykia).toBeUndefined();
    expect((await writeSnippet(snip, file)).replaced).toBe(true);

    const jsonc = join(root, 'mcp.json');
    writeFileSync(jsonc, '{ // comment\n "servers": {} }');
    await expect(writeSnippet(buildSnippet({ ...base, client: 'vscode', remote: false }), jsonc)).rejects.toThrow(/not plain JSON/);
    expect(readFileSync(jsonc, 'utf8')).toContain('// comment');
  });
});
