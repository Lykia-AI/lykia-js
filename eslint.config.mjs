import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tgz', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        DOMException: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['packages/sdk/src/**/*.ts'],
    ignores: ['packages/sdk/src/testing/**'],
    rules: {
      // The SDK must stay free of Node built-ins so it runs in browsers and edge runtimes.
      'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'stream'] }],
    },
  },
  {
    files: ['packages/mcp/src/**/*.ts'],
    rules: {
      // stdout belongs to the MCP protocol: human output must go through the stderr logger.
      'no-console': 'error',
    },
  },
  {
    files: ['**/test/**/*.ts', 'scripts/**/*.mjs', '*.config.*'],
    rules: {
      'no-console': 'off',
    },
  },
);
