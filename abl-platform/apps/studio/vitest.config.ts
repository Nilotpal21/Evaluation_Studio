import { defineConfig } from 'vitest/config';
import path from 'path';
import { studioCoverageConfig } from './vitest.coverage';

export default defineConfig({
  root: __dirname,
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'e2e/**',
      'src/**/*.repro.test.ts',
      'src/**/*.repro.test.tsx',
    ],
    environment: 'happy-dom',
    environmentOptions: {
      // Use a non-connectable URL so happy-dom does not attempt real TCP
      // connections to localhost:3000 during env initialization/teardown.
      url: 'http://localhost/',
    },
    setupFiles: ['./src/__tests__/setup.tsx'],
    globalSetup: ['./vitest-force-exit.ts'],
    css: false,
    pool: 'forks',
    // Dynamic imports in beforeEach hooks can exceed the default 10s under
    // concurrent load (full monorepo test suite). Increase to 30s.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: studioCoverageConfig,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: [
      // Optional native peer deps used by @agent-platform/auth-enterprise
      // through try/catch dynamic imports. Vite's static analyzer cannot
      // see the try/catch, so it fails to resolve the bare specifiers in
      // environments where the optional modules are not installed. Alias
      // each one to an empty stub so tests that transitively import
      // auth-enterprise can load. Production behavior is unaffected.
      {
        find: /^kerberos$/,
        replacement: path.resolve(__dirname, './src/__tests__/_stubs/optional-peer-dep.ts'),
      },
      {
        find: /^@node-saml\/node-saml$/,
        replacement: path.resolve(__dirname, './src/__tests__/_stubs/optional-peer-dep.ts'),
      },
      {
        find: /^@abl\/compiler$/,
        replacement: path.resolve(__dirname, '../../packages/compiler/src/index.ts'),
      },
      {
        find: /^@abl\/compiler\/platform$/,
        replacement: path.resolve(__dirname, '../../packages/compiler/src/platform/logger.ts'),
      },
      {
        find: /^@abl\/compiler\/platform\/(.*)\.js$/,
        replacement: path.resolve(__dirname, '../../packages/compiler/src/platform/$1.ts'),
      },
      {
        find: /^@abl\/compiler\/platform\/(.*)$/,
        replacement: path.resolve(__dirname, '../../packages/compiler/src/platform/$1'),
      },
      {
        find: '@agent-platform/openapi/nextjs',
        replacement: path.resolve(__dirname, '../../packages/openapi/src/nextjs/index.ts'),
      },
      {
        find: '@agent-platform/openapi/express',
        replacement: path.resolve(__dirname, '../../packages/openapi/src/express/index.ts'),
      },
      {
        find: '@agent-platform/shared/errors',
        replacement: path.resolve(__dirname, '../../packages/shared/src/errors.ts'),
      },
      {
        find: '@agent-platform/shared/encryption',
        replacement: path.resolve(__dirname, '../../packages/shared/src/encryption/index.ts'),
      },
      {
        find: '@agent-platform/shared/validation',
        replacement: path.resolve(__dirname, '../../packages/shared/src/validation/index.ts'),
      },
      {
        find: /^@agent-platform\/openapi$/,
        replacement: path.resolve(__dirname, '../../packages/openapi/src/index.ts'),
      },
      {
        find: '@agent-platform/shared/rbac',
        replacement: path.resolve(__dirname, '../../packages/shared/src/rbac/index.ts'),
      },
      {
        find: '@agent-platform/shared/services/mcp-registry',
        replacement: path.resolve(
          __dirname,
          '../../packages/shared/src/services/mcp-server-registry.ts',
        ),
      },
      {
        find: /^@agent-platform\/shared\/repos$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/repos/index.ts'),
      },
      {
        find: /^@agent-platform\/shared\/security$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/security/index.ts'),
      },
      {
        find: /^@agent-platform\/shared$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
      {
        find: /^@agent-platform\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/$1'),
      },
      {
        find: '@agent-platform/web-sdk/react',
        replacement: path.resolve(__dirname, '../../packages/web-sdk/src/react/index.ts'),
      },
      {
        find: '@agent-platform/web-sdk',
        replacement: path.resolve(__dirname, '../../packages/web-sdk/src/index.ts'),
      },
      {
        find: '@agent-platform/pipeline-engine/client',
        replacement: path.resolve(__dirname, '../../packages/pipeline-engine/src/client.ts'),
      },
      {
        find: '@agent-platform/pipeline-engine/schemas',
        replacement: path.resolve(__dirname, '../../packages/pipeline-engine/src/schemas/index.ts'),
      },
      {
        find: '@agent-platform/pipeline-engine/contracts',
        replacement: path.resolve(
          __dirname,
          '../../packages/pipeline-engine/src/pipeline/contracts/index.ts',
        ),
      },
      {
        find: '@agent-platform/pipeline-engine/node-references',
        replacement: path.resolve(
          __dirname,
          '../../packages/pipeline-engine/src/pipeline/node-references.ts',
        ),
      },
      {
        find: '@agent-platform/pipeline-engine/validation',
        replacement: path.resolve(
          __dirname,
          '../../packages/pipeline-engine/src/pipeline/validation.ts',
        ),
      },
      {
        find: '@agent-platform/pipeline-engine/templates',
        replacement: path.resolve(
          __dirname,
          '../../packages/pipeline-engine/src/pipeline/template-registry.ts',
        ),
      },
      {
        find: '@agent-platform/pipeline-engine',
        replacement: path.resolve(__dirname, '../../packages/pipeline-engine/src/index.ts'),
      },
      {
        find: /^@agent-platform\/connectors\/auth$/,
        replacement: path.resolve(__dirname, '../../packages/connectors/src/auth/index.ts'),
      },
      {
        find: /^@agent-platform\/connectors\/catalog$/,
        replacement: path.resolve(
          __dirname,
          '../../packages/connectors/src/catalog/extract-entry.ts',
        ),
      },
      {
        find: /^@agent-platform\/connectors$/,
        replacement: path.resolve(__dirname, '../../packages/connectors/src/index.ts'),
      },
      {
        find: /^@agent-platform\/database\/models$/,
        replacement: path.resolve(__dirname, '../../packages/database/src/models/index.ts'),
      },
      {
        find: /^@agent-platform\/shared-observability$/,
        replacement: path.resolve(__dirname, '../../packages/shared-observability/src/index.ts'),
      },
      {
        find: /^@agent-platform\/shared-kernel\/security\/safe-fetch$/,
        replacement: path.resolve(
          __dirname,
          '../../packages/shared-kernel/src/security/safe-fetch.ts',
        ),
      },
      {
        find: /^@agent-platform\/shared-kernel\/security$/,
        replacement: path.resolve(__dirname, '../../packages/shared-kernel/src/security/index.ts'),
      },
      {
        find: /^@agent-platform\/shared-kernel$/,
        replacement: path.resolve(__dirname, '../../packages/shared-kernel/src/index.ts'),
      },
      {
        find: /^@agent-platform\/shared-auth\/rbac$/,
        replacement: path.resolve(__dirname, '../../packages/shared-auth/src/rbac/index.ts'),
      },
      {
        find: /^@agent-platform\/connectors\/catalog\/json$/,
        replacement: path.resolve(
          __dirname,
          '../../packages/connectors/src/generated/connector-catalog.json',
        ),
      },
      {
        find: /^@\//,
        replacement: `${path.resolve(__dirname, 'src')}/`,
      },
    ],
  },
});
