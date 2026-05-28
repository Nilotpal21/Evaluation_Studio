import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import withBundleAnalyzer from '@next/bundle-analyzer';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Monorepo: set tracing root so standalone output resolves workspace deps
  outputFileTracingRoot: resolve(__dirname, '../../'),

  // Server-only packages — loaded natively, not bundled.
  //
  // Only packages with native addons or that must NOT be bundled go here.
  // Pure-TS workspace packages (config, shared, etc.) are intentionally
  // excluded: tsconfig path overrides already point Turbopack at compiled
  // dist/ files, so Turbopack bundles them directly without issue.
  //
  // @agent-platform/database stays external because:
  //  - It imports mongoose (native addon, must not be bundled)
  //  - Auto-connect logic should run once in Node.js, not per SSR render
  //
  // @abl/compiler stays external because:
  //  - ESM-only package; webpack's static export analysis fails to trace
  //    re-exports through pnpm symlinks inside @abl/compiler dist files
  //  - Next.js 16+ correctly uses import() for ESM externals (no require() issue)
  serverExternalPackages: [
    '@agent-platform/database',
    'mongoose',
    'mongodb',
    'bcryptjs',
    '@abl/compiler',
  ],

  // Security headers (replaces nginx configuration-snippet)
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(isProd
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=31536000; includeSubDomains; preload',
                },
              ]
            : []),
        ],
      },
    ];
  },

  // React Compiler (auto-memoization, replaces manual useMemo/useCallback)
  reactCompiler: true,
};

const withAnalyzer = withBundleAnalyzer({ enabled: process.env.ANALYZE === 'true' });
export default withAnalyzer(nextConfig);
