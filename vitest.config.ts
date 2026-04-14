import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';

const sharedAlias = {
  '@core': resolve(__dirname, 'src/core'),
  '@modules': resolve(__dirname, 'src/modules'),
  '@infra': resolve(__dirname, 'src/infrastructure'),
  '@orchestration': resolve(__dirname, 'src/orchestration'),
  '@reporting': resolve(__dirname, 'src/reporting'),
  '@app': resolve(__dirname, 'src/app'),
};

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: sharedAlias,
  },
  test: {
    globals: true,
    // Default run: all tests (preserves existing `pnpm test` behavior)
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
    },
    // Named projects for targeted runs: pnpm test:unit, pnpm test:integration, pnpm test:smoke
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          globals: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globals: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'smoke',
          // Smoke tests are a placeholder — no files yet.
          include: ['tests/smoke/**/*.test.ts'],
          globals: true,
        },
      },
    ],
  },
});
