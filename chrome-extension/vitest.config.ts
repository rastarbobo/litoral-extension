import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Aliases: the production code only imports TYPES from `@extension/shared`
// (see chrome-extension/src/background/*.ts). The shared package's source
// entry `lib/utils/index.ts` re-exports `init-app-with-shadow.ts`, which pulls
// `react-dom/client` and `document` — both unavailable under `node`
// environment. Redirect the alias at the pure-types file so Vitest never
// drags React/DOM into the node test runner. Value imports would fail under
// this alias, but none exist in the background service-worker code path.
//
// `@extension/storage`'s built `dist/index.mjs` re-exports `./lib/index.js`
// (an ESM-only specifier that resolves to .ts sources in this repo and so
// cannot be loaded directly). Point at the source `lib/index.ts` instead;
// Vitest's esbuild handles .ts natively.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/background/__tests__/**/*.test.ts'],
    setupFiles: ['src/background/__tests__/setup.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@extension/shared': resolve(__dirname, '../packages/shared/lib/utils/extension-types.ts'),
      '@extension/storage': resolve(__dirname, '../packages/storage/lib/index.ts'),
    },
  },
});
