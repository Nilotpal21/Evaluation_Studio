import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import createNextIntlPlugin from 'next-intl/plugin';
import withBundleAnalyzer from '@next/bundle-analyzer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Docker (produces .next/standalone with self-contained server.js)
  output: 'standalone',

  env: {
    // Empty in production (ingress routes by path). Set in .env.local for local dev.
    NEXT_PUBLIC_SEARCH_AI_URL: process.env.NEXT_PUBLIC_SEARCH_AI_URL ?? '',
    NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL: process.env.NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL ?? '',
  },

  // Transpile workspace packages (client-safe only; database is server-external)
  transpilePackages: [
    '@agent-platform/shared',
    '@agent-platform/shared-kernel',
    '@agent-platform/i18n',
    '@agent-platform/config',
    '@agent-platform/web-sdk',
    '@abl/core',
    '@abl/language-service',
  ],

  // Server-only packages — loaded natively, not webpack-bundled.
  // @agent-platform/database MUST be here so its models share the same
  // Mongoose instance as MongoConnectionManager (avoids buffering timeouts).
  // Monorepo: set tracing root to the monorepo root so standalone output can
  // resolve all workspace dependencies (prevents ENOENT on .nft.json files)
  outputFileTracingRoot: resolve(__dirname, '../../'),
  outputFileTracingIncludes: {
    '/api/sdk/embed/script': ['../../packages/web-sdk/dist/agent-sdk.umd.js'],
    '/docs': ['./content/**/*', './docs.config.json'],
    '/api/abl/docs': ['../../apps/docs-internal/content/**/*'],
    '/api/academy/[...path]': ['../../packages/academy/content/**/*'],
  },

  serverExternalPackages: [
    '@agent-platform/database',
    '@aws-sdk/client-lambda',
    '@agent-platform/messaging',
    '@agent-platform/messaging/kafka',
    '@agent-platform/notifications',
    '@agent-platform/notifications/email',
    '@agent-platform/notifications/slack',
    '@agent-platform/academy',
    '@agent-platform/pipeline-engine',
    '@agent-platform/project-io',
    '@agent-platform/arch-ai',
    '@agent-platform/connectors',
    '@agent-platform/shared-auth-profile',
    '@abl/compiler',
    'js-yaml',
    'mongoose',
    'mongodb',
    'bcryptjs',
    'jsonwebtoken',
    'google-auth-library',
    'otpauth',
    'qrcode',
    'gray-matter',
    // Optional enterprise auth dependencies loaded via dynamic import in
    // auth-enterprise. Keep them external so Turbopack does not hard-resolve
    // them during Studio server bundle build.
    '@agent-platform/auth-enterprise',
    'bullmq',
    'kerberos',
    '@node-saml/node-saml',
  ],

  // All API proxying (Runtime, SearchAI, SearchAI-Runtime) is handled by
  // middleware (src/proxy.ts) which reads service URLs from process.env at
  // request time. next.config.mjs rewrites are serialized at build time in
  // Docker standalone builds and bake localhost fallbacks permanently.

  // Allow image domains if needed
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'lh3.googleusercontent.com' }],
  },

  // Headers for CSP - allow Swagger UI from unpkg.com
  async headers() {
    return [
      {
        source: '/api/openapi',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:;",
          },
        ],
      },
    ];
  },

  // Prevent webpack from resolving optional runtime-only packages that may not exist
  webpack: (config, { isServer, dev }) => {
    if (dev) {
      config.watchOptions = {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '**/dist/**',
          '**/build/**',
          '**/e2e/**',
          '**/__tests__/**',
          '**/public/monaco-editor/**',
        ],
        // Batch file change events to avoid excessive recompilation
        aggregateTimeout: 500,
      };
    }
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push(
        '@agent-platform/messaging',
        '@agent-platform/messaging/kafka',
        '@agent-platform/notifications',
        '@agent-platform/notifications/email',
        '@agent-platform/notifications/slack',
        // Function external to catch dynamic imports of subpaths through compiled dist files
        // (pnpm workspace symlinks bypass serverExternalPackages matching)
        // Note: pipeline-engine is NOT included here — it's ESM-only ("type": "module")
        // and forcing commonjs externals breaks subpath resolution (ERR_PACKAGE_PATH_NOT_EXPORTED).
        // It relies on serverExternalPackages for correct ESM externalization.
        ({ request }, callback) => {
          if (
            request &&
            (/^@agent-platform\/database(\/|$)/.test(request) ||
              /^@agent-platform\/messaging(\/|$)/.test(request) ||
              /^@agent-platform\/notifications(\/|$)/.test(request))
          ) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      );
    } else {
      // Mirror Turbopack resolveAlias for webpack — prevent Node.js-only modules
      // from being bundled into client chunks (avoids crypto-browserify / CSP issues)
      const emptyModule = resolve(__dirname, 'src/lib/empty-module.ts');
      const emptyCrypto = resolve(__dirname, 'src/lib/empty-crypto.ts');
      config.resolve = config.resolve || {};
      config.resolve.alias = {
        ...config.resolve.alias,
        fs: emptyModule,
        path: emptyModule,
        crypto: emptyCrypto,
        'node:crypto': emptyCrypto,
      };
      // Handle "node:" URI scheme for pre-compiled dist files that import node:crypto etc.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: emptyCrypto,
        fs: false,
        path: false,
        stream: false,
        util: false,
      };
      // NormalModuleReplacementPlugin to catch node: scheme imports in dist files
      const require_ = createRequire(import.meta.url);
      const { webpack: wp } = require_('next/dist/compiled/webpack/webpack.js');
      config.plugins.push(
        new wp.NormalModuleReplacementPlugin(/^node:crypto$/, emptyCrypto),
        new wp.NormalModuleReplacementPlugin(/^node:fs$/, emptyModule),
        new wp.NormalModuleReplacementPlugin(/^node:path$/, emptyModule),
      );
    }
    // Resolve workspace subpath exports that Webpack can't follow through pnpm symlinks
    config.resolve.alias = {
      ...config.resolve.alias,
      '@agent-platform/web-sdk/react': resolve(
        __dirname,
        '../../packages/web-sdk/dist/react/index.js',
      ),
    };
    // Resolve .ts/.tsx imports with .js extensions (ESM convention in web-sdk)
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },

  // React Compiler (auto-memoization, replaces manual useMemo/useCallback)
  // Disable in dev when LIGHT_DEV=1 to reduce CPU/memory overhead
  reactCompiler: process.env.LIGHT_DEV === '1' ? false : true,

  // Turbopack config (replaces webpack customizations for dev server)
  // TODO: When adding multi-language support, add resolveAlias entries per locale
  // (Turbopack doesn't support wildcard aliases like webpack's @i18n-locales/*).
  turbopack: {
    resolveAlias: {
      // Prevent bundling Node.js-only modules for browser — avoids crypto-browserify
      // and vm-browserify polyfills that violate CSP (eval) in production
      fs: { browser: './src/lib/empty-module.ts' },
      path: { browser: './src/lib/empty-module.ts' },
      crypto: { browser: './src/lib/empty-crypto.ts' },
      'node:crypto': { browser: './src/lib/empty-crypto.ts' },
      // Workspace subpath exports (pnpm symlinks + Turbopack)
      '@agent-platform/web-sdk/react': '../../packages/web-sdk/dist/react/index.js',
      // i18n locale JSON files
      '@i18n-locales/en/studio.json': '../../packages/i18n/locales/en/studio.json',
      '@i18n-locales/en/platform.json': '../../packages/i18n/locales/en/platform.json',
      '@i18n-locales/en/academy.json': '../../packages/i18n/locales/en/academy.json',
    },
  },
};

const withAnalyzer = withBundleAnalyzer({ enabled: process.env.ANALYZE === 'true' });
export default withAnalyzer(withNextIntl(nextConfig));
