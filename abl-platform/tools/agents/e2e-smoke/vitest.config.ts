import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.dirname(new URL(import.meta.url).pathname),
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
