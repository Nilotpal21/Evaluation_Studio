/**
 * Frozen runtime inventory of every ProjectPage.
 *
 * Mirrors the ProjectPage type union in `navigation-store.ts` so lock
 * tests can iterate the canonical leaf set and catch accidental drops
 * during IA refactors. The exhaustiveness check below fails the build
 * if a ProjectPage is added to the type but not to this array.
 *
 * When ADDING a new ProjectPage:
 *   1. Add it to the ProjectPage union in `store/navigation-store.ts`.
 *   2. Add it to this array — order does not matter.
 *   3. Update `__tests__/lock/project-page-inventory.test.ts` if the
 *      baseline asserts a specific count or set membership.
 *
 * When REMOVING a ProjectPage:
 *   1. Remove from the union and from this array.
 *   2. Re-baseline the lock test EXPLICITLY — this is the regression
 *      gate. If you cannot articulate why a leaf is being removed, do
 *      not remove it.
 */

import type { ProjectPage } from '../store/navigation-store';

export const PROJECT_PAGES = [
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
  'external-agents',
  'prompt-library',
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
  'feedback',
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
  'settings-data-retention',
  'settings-trace-dimensions',
  'settings-agent-transfer',
  'settings-agent-assist',
  'settings-pii-protection',
  'settings-public-api',
  'settings-auth-profiles',
  'settings-attachments',
  'settings-omnichannel',
  'settings-modules',
  'module-dependencies',
  'transfer-sessions',
] as const satisfies readonly ProjectPage[];

export type ProjectPageId = (typeof PROJECT_PAGES)[number];

// Type-level exhaustiveness: fails compilation if any ProjectPage value is
// missing from the runtime PROJECT_PAGES array. If a new page is added to
// the union without being added here, this assertion stops being `true`.
type _AssertExhaustive = Exclude<ProjectPage, ProjectPageId> extends never ? true : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;
