import { readFileSync } from 'node:fs';
import { defineConfig, type UserConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const banner = (what: string, usage: string) =>
  [
    '/*!',
    ` * ${what} (@lykia/sdk ${pkg.version}): single-file CommonJS build for vendoring without npm.`,
    ' * GENERATED FILE: do not edit. Built from packages/sdk/src by tsdown; regenerate with `npm run build`.',
    ' * No dependencies (Node.js built-ins and globals only); Node.js >= 18. License: ISC. https://getlykia.com',
    ` * Usage: ${usage}`,
    ' */',
  ].join('\n');

const vendored = (entry: string, out: string, what: string, usage: string, tsconfig = 'tsconfig.json'): UserConfig => ({
  entry: { [out]: entry },
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  // Type declarations next to the file (`<name>.d.cts`), so a vendored copy is typed too.
  dts: { tsconfig },
  sourcemap: false,
  clean: false,
  fixedExtension: true,
  outputOptions: { banner: banner(what, usage), exports: 'named' },
});

export default defineConfig([
  {
    // npm build of the client: ESM + CJS with type declarations; no Node built-ins (browsers / edge runtimes).
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2022',
    dts: true,
    sourcemap: false,
    clean: true,
    fixedExtension: true,
  },
  {
    // @lykia/sdk/testing: the fake server (Node only).
    entry: { testing: 'src/testing/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node18',
    dts: { tsconfig: 'tsconfig.testing.json' },
    sourcemap: false,
    clean: false,
    fixedExtension: true,
  },
  vendored('src/index.ts', 'lykia-client', 'Lykia API client', 'const { Lykia, LykiaError } = require("./lykia-client.cjs");'),
  vendored(
    'src/testing/index.ts',
    'lykia-fake-server',
    'Fake Lykia API server for tests',
    'const { createFakeLykia } = require("./lykia-fake-server.cjs"); const fake = await createFakeLykia();',
    'tsconfig.testing.json',
  ),
]);
