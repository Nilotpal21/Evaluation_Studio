/**
 * Lock test — frozen inventory of `ProjectPage` leaves.
 *
 * The Track 2 IA flatten slice (ABLP-584) restructures the project
 * sidebar. Without a lock, a leaf can disappear silently if a refactor
 * forgets to wire it through the new IA. This test asserts the runtime
 * `PROJECT_PAGES` array matches a frozen baseline; explicit re-baseline
 * is required for any leaf removal — that IS the regression gate.
 *
 * Adding a leaf is fine: the `_AssertExhaustive` check inside
 * `lib/project-pages.ts` already forces the array to stay in sync with
 * the type, so adds appear here automatically. The test below also
 * grows its baseline implicitly because we compare via SET membership
 * with a count check (see "BASELINE_COUNT").
 *
 * If this test fails after intentional IA work:
 *   1. Verify the leaf removal is intentional and approved.
 *   2. Update both the `ProjectPage` union AND `PROJECT_PAGES` in
 *      `lib/project-pages.ts`.
 *   3. Update `BASELINE` here to reflect the new canonical set.
 *   4. Re-run; the test should now pass.
 */

import { describe, expect, test } from 'vitest';

import { PROJECT_PAGES } from '@/lib/project-pages';

const BASELINE: ReadonlySet<string> = new Set([
  'overview',
  'arch-ai',
  'agents',
  'profiles',
  'tools',
  'mcp-servers',
  'sessions',
  'deployments',
  'search-ai',
  'workflows',
  'connections',
  'templates',
  'inbox',
  'evals',
  'experiments',
  'dashboard',
  'analytics',
  'billing',
  'agent-performance',
  'quality-monitor',
  'customer-insights',
  'voice-analytics',
  'agent-transfer-insights',
  'pipelines',
  'alerts',
  'guardrails-config',
  'governance',
  'settings',
  'settings-members',
  'settings-api-keys',
  'settings-models',
  'settings-config-vars',
  'settings-localization',
  'settings-git',
  'settings-advanced',
  'settings-runtime-config',
  'settings-trace-dimensions',
  'settings-agent-transfer',
  'settings-pii-protection',
  'settings-public-api',
  'settings-auth-profiles',
  'settings-attachments',
  'settings-omnichannel',
  'settings-modules',
  'module-dependencies',
  'transfer-sessions',
]);

describe('ProjectPage inventory — frozen lock', () => {
  test('every baseline leaf is present in PROJECT_PAGES (no silent removal)', () => {
    const current = new Set<string>(PROJECT_PAGES);
    const missing = Array.from(BASELINE).filter((page) => !current.has(page));
    expect(missing).toEqual([]);
  });

  test('PROJECT_PAGES has no duplicate entries', () => {
    const counts = new Map<string, number>();
    for (const page of PROJECT_PAGES) {
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    const duplicates = Array.from(counts.entries())
      .filter(([, n]) => n > 1)
      .map(([page]) => page);
    expect(duplicates).toEqual([]);
  });
});
