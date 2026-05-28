import { defineConfig } from 'vitest/config';
import path from 'path';
import { studioCoverageConfig } from './vitest.coverage';

export default defineConfig({
  root: __dirname,
  test: {
    coverage: studioCoverageConfig,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'server-only': path.resolve(__dirname, 'src/__tests__/server-only.stub.ts'),
      '@agent-platform/web-sdk/react': path.resolve(
        __dirname,
        '../../packages/web-sdk/src/react/index.ts',
      ),
      '@agent-platform/web-sdk': path.resolve(__dirname, '../../packages/web-sdk/src/index.ts'),
    },
  },
});
