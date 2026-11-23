import { defineConfig } from 'tsdown';

// The MCP SDK packages stay runtime dependencies; they are not bundled.
export default defineConfig([
  {
    // Programmatic API: ESM + CJS with type declarations.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node20',
    dts: true,
    sourcemap: false,
    clean: true,
    fixedExtension: true,
  },
  {
    // The `lykia-mcp` binary (ESM only; keeps its #! line).
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: false,
    clean: false,
    fixedExtension: true,
  },
]);
