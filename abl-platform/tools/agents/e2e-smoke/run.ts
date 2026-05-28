/**
 * Bootstrap entry point for the E2E smoke test executor.
 *
 * Resolves MONGODB_URL from apps/runtime/.env before importing anything,
 * since @agent-platform/database auto-connects on import and defaults to
 * hostname "mongo" (Docker) which fails outside Docker.
 *
 * Usage:
 *   npx tsx tools/agents/e2e-smoke/run.ts [--studio-url ...] [--runtime-url ...]
 *
 * Must be run from within Claude Code (the Agent SDK spawns a Claude Code subprocess).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.MONGODB_URL) {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  try {
    const envContent = readFileSync(resolve(thisDir, '../../../apps/runtime/.env'), 'utf-8');
    const match = envContent.match(/^MONGODB_URL=(.+)$/m);
    if (match) process.env.MONGODB_URL = match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    console.error(
      'ERROR: MONGODB_URL not set and could not read apps/runtime/.env. ' +
        'Set MONGODB_URL or ensure apps/runtime/.env exists.',
    );
    process.exit(1);
  }
}

// Now safe to import — database package will use the MONGODB_URL we just set
await import('./executor.js');
