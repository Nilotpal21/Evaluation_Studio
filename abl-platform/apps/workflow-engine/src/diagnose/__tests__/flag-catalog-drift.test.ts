import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { WORKFLOW_ENGINE_FLAGS } from '../flag-catalog.js';

/**
 * Drift guard: every `process.env.WORKFLOW_*` identifier read by the
 * workflow-engine source tree must appear in the flag catalog, so the
 * `/diagnose` response never goes stale when a new flag is added. A
 * failing assertion here points to the exact file + identifier that
 * needs a catalog entry.
 *
 * We intentionally scan only `WORKFLOW_*` prefixed env reads — that's
 * the family the catalog is responsible for. Infrastructure vars like
 * `MONGODB_URL` or `JWT_SECRET` are out of scope.
 */

const SRC_ROOT = join(__dirname, '../../');
const WORKFLOW_ENV_RE = /process\.env\.(WORKFLOW_[A-Z0-9_]+)/g;

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

describe('WORKFLOW_ENGINE_FLAGS drift guard', () => {
  test('every process.env.WORKFLOW_* referenced in source is listed in the catalog', () => {
    const catalogNames = new Set(WORKFLOW_ENGINE_FLAGS.map((f) => f.name));
    const missing = new Map<string, string[]>();

    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(WORKFLOW_ENV_RE)) {
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
      'New WORKFLOW_* env vars must be added to WORKFLOW_ENGINE_FLAGS',
    ).toEqual({});
  });
});
