import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/shared/__tests__/**/*.test.ts', 'src/matches/__tests__/**/*.test.ts'],
    setupFiles: ['src/shared/__tests__/setup.ts'],
    testTimeout: 10_000,
  },
});
