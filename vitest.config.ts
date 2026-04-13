import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@modules': resolve(__dirname, 'src/modules'),
      '@infra': resolve(__dirname, 'src/infrastructure'),
      '@orchestration': resolve(__dirname, 'src/orchestration'),
      '@reporting': resolve(__dirname, 'src/reporting'),
      '@app': resolve(__dirname, 'src/app'),
    },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
    },
  },
});
