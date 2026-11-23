#!/usr/bin/env node
/**
 * Verifies what `npm pack` would publish for each package: only the intended files (built dist output, README,
 * LICENSE, package.json), no tests or fixtures, no source maps, no secrets-looking strings.
 * Run after `npm run build`. Nothing is published.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = {
  '@lykia/sdk': {
    dir: 'packages/sdk',
    required: ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.mts', 'dist/index.d.cts', 'dist/testing.mjs', 'dist/testing.cjs', 'dist/lykia-client.cjs', 'dist/lykia-fake-server.cjs', 'dist/lykia-client.d.cts', 'dist/lykia-fake-server.d.cts'],
  },
  '@lykia/mcp': {
    dir: 'packages/mcp',
    required: ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.mts', 'dist/index.d.cts'],
  },
};
const ALLOWED = /^(package\.json|README\.md|LICENSE|dist\/[\w.-]+\.(mjs|cjs|d\.mts|d\.cts))$/;
const SECRET = /lyk-(mgmt-)?v1-[a-f0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}/;

let failed = false;
for (const [name, spec] of Object.entries(PACKAGES)) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', name], { cwd: ROOT, encoding: 'utf8' });
  const [info] = JSON.parse(out);
  const files = info.files.map((f) => f.path).sort();
  const problems = [];
  for (const f of files) if (!ALLOWED.test(f)) problems.push(`unexpected file: ${f}`);
  for (const r of spec.required) if (!files.includes(r)) problems.push(`missing file: ${r}`);
  for (const f of files) {
    const text = readFileSync(join(ROOT, spec.dir, f), 'utf8');
    if (/sourceMappingURL/.test(text)) problems.push(`source map reference in ${f}`);
    if (SECRET.test(text)) problems.push(`secret-looking string in ${f}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, spec.dir, 'package.json'), 'utf8'));
  if (pkg.scripts?.postinstall || pkg.scripts?.preinstall || pkg.scripts?.install) problems.push('install scripts are not allowed');
  if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access must be public');
  const total = info.files.reduce((n, f) => n + f.size, 0);
  console.log(`${name}@${info.version}: ${files.length} files, ${(total / 1024).toFixed(1)} kB unpacked`);
  for (const f of info.files) console.log(`  ${String(f.size).padStart(8)}  ${f.path}`);
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(`  ✗ ${p}`);
  } else {
    console.log('  ✓ only intended files');
  }
}
process.exit(failed ? 1 : 0);
