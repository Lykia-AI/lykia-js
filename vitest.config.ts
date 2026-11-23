import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests start real local HTTP servers on ephemeral ports and child processes; keep files isolated.
    pool: 'forks',
    env: {
      // Never let a test touch the real user config directory or a real Lykia host.
      LYKIA_CONFIG_DIR: '/nonexistent-lykia-config-dir-set-per-test',
      LYKIA_MCP_URL: 'http://127.0.0.1:9/mcp',
      LYKIA_BASE_URL: 'http://127.0.0.1:9/v1',
      LYKIA_API_KEY: '',
      LYKIA_NO_BROWSER: '1',
    },
  },
});
