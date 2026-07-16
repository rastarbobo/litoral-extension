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
    coverage: {
      provider: 'v8',
      // ROADMAP Phase 2.1 acceptance requires 100% branch coverage on rate
      // limiting (the scheduling orchestrator + circuit breaker). Other files
      // (index.ts poll loop, storage) are out of scope for 2.1 — covered
      // separately in extension-poll-storage.test.ts and integration tests.
      include: ['src/background/scheduling-orchestrator.ts', 'src/background/circuit-breaker.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'],
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      // 100% on the orchestrator's branches is the locked-in Phase 2.1 target.
      // We assert this gate so regressions in rate-limit logic fail CI.
      thresholds: {
        branches: 100,
        lines: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
  resolve: {
    alias: {
      '@extension/shared': resolve(__dirname, '../packages/shared/lib/utils/extension-types.ts'),
      '@extension/storage': resolve(__dirname, '../packages/storage/lib/index.ts'),
    },
  },
});
