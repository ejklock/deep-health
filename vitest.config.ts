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
      exclude: [
        'src/types/**',
        // Pure type/interface files — no executable runtime code; v8 would always show 0%
        'src/core/types/common.ts',
        'src/core/types/locale.ts',
        'src/core/types/report.ts',
        'src/core/types/sonarqube.ts',
        'src/core/types/update.ts',
        'src/modules/ecosystem/types.ts',
        'src/modules/scanner/types.ts',
        'src/infrastructure/storage/provider.ts',
        'src/infrastructure/provisioner/types.ts',
        'src/reporting/i18n/raw-locale.ts',
        'src/reporting/i18n/types.ts',
      ],
      thresholds: {
        statements: 100,
        functions: 100,
        lines: 100,
        branches: 88,
      },
    },
    // Named projects for targeted runs: pnpm test:unit, pnpm test:integration, pnpm test:smoke
    // NOTE: vitest 2.x inline-project mode does NOT support `--project <name>` CLI filtering
    // when projects are defined inline (not in a workspace file).
    // Use path-based invocation instead: `vitest run tests/<dir>` (see package.json scripts).
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
          include: ['tests/smoke/**/*.test.ts'],
          globals: true,
          // Smoke tests perform real Docker operations (container pull + start).
          // Per-test timeouts are declared inline with { timeout: N } but we
          // also raise the suite-level hook timeout so beforeAll skip probes
          // (docker info) don't time out on slow daemons.
          hookTimeout: 30_000,
          testTimeout: 120_000,
          // Run smoke tests sequentially to avoid port conflicts between provisioners.
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
  },
});
