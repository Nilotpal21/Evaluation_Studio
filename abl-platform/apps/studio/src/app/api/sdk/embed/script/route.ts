import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';

export const runtime = 'nodejs';

const log = createLogger('sdk-embed-script');

let cachedBundle: string | null = null;
let cachedBundlePath: string | null = null;

function resolveBundlePathCandidates(): string[] {
  const configuredPath = process.env.SDK_EMBED_BUNDLE_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return [configuredPath];
  }

  return [
    // Local Studio app cwd (apps/studio)
    resolve(process.cwd(), '../../packages/web-sdk/dist/agent-sdk.umd.js'),
    // Monorepo root / standalone root cwd
    resolve(process.cwd(), 'packages/web-sdk/dist/agent-sdk.umd.js'),
  ];
}

async function loadSdkBundle(): Promise<{ path: string; source: string }> {
  if (cachedBundle && cachedBundlePath) {
    return { path: cachedBundlePath, source: cachedBundle };
  }

  const candidates = resolveBundlePathCandidates();
  let lastError: string | null = null;

  for (const bundlePath of candidates) {
    try {
      const source = await readFile(bundlePath, 'utf8');
      cachedBundlePath = bundlePath;
      cachedBundle = source;
      return { path: bundlePath, source };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError ?? 'Unable to locate SDK bundle');
}

export async function GET() {
  try {
    const { source } = await loadSdkBundle();
    return new NextResponse(source, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  } catch (error) {
    log.error('Failed to load SDK UMD bundle for embed route', {
      error: error instanceof Error ? error.message : String(error),
      bundlePath: cachedBundlePath ?? resolveBundlePathCandidates()[0],
    });
    return NextResponse.json({ error: 'SDK bundle unavailable' }, { status: 500 });
  }
}
