import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@agent-platform\/database\/clickhouse(?:\.js)?$/,
        replacement: resolve(__dirname, '../database/src/clickhouse.ts'),
      },
      {
        find: /^@agent-platform\/database\/models$/,
        replacement: resolve(__dirname, '../database/src/models/index.ts'),
      },
      {
        find: /^@agent-platform\/database$/,
        replacement: resolve(__dirname, '../database/src/index.ts'),
      },
      {
        find: /^@agent-platform\/shared-observability$/,
        replacement: resolve(__dirname, '../shared-observability/src/index.ts'),
      },
      {
        find: /^@agent-platform\/shared$/,
        replacement: resolve(__dirname, '../shared/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    exclude: ['dist/**', 'node_modules/**'],
  },
});
