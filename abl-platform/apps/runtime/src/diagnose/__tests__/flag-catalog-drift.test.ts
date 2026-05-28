import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RUNTIME_FLAGS } from '../flag-catalog.js';

/**
 * Drift guard: every `process.env.(WORKFLOW_*|FEATURE_*)` identifier
 * read by the runtime source tree must appear in the flag catalog so
 * the `/diagnose` response never goes stale when a new flag is added.
 * A failing assertion here points to the exact file + identifier that
 * needs a catalog entry.
 *
 * We intentionally scan only `WORKFLOW_*` and `FEATURE_*` prefixed env
 * reads — those are the families the runtime catalog is responsible
 * for. Infrastructure vars (MONGODB_URL, JWT_SECRET, etc.) are out of
 * scope, as are third-party library env vars.
 */

const SRC_ROOT = join(__dirname, '../../');
const FLAG_ENV_RE = /process\.env\.(WORKFLOW_[A-Z0-9_]+|FEATURE_[A-Z0-9_]+)/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('RUNTIME_FLAGS drift guard', () => {
  test('every process.env.(WORKFLOW_*|FEATURE_*) referenced in source is in the catalog', () => {
    const catalogNames = new Set(RUNTIME_FLAGS.map((f) => f.name));
    const missing = new Map<string, string[]>();

    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(FLAG_ENV_RE)) {
        const name = match[1];
        if (!catalogNames.has(name)) {
          const refs = missing.get(name) ?? [];
          refs.push(relative(SRC_ROOT, file));
          missing.set(name, refs);
        }
      }
    }

    expect(
      Object.fromEntries(missing),
      'New WORKFLOW_*/FEATURE_* env vars must be added to RUNTIME_FLAGS',
    ).toEqual({});
  });
});
