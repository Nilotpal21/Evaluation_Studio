import { describe, expect, it } from 'vitest';

import { buildPlanningBatches, formatPlanningBatches } from '../pipeline/planning-batches.js';
import type { Finding, Session } from '../types.js';

describe('planning-batches', () => {
  it('elevates cross-scope foundation findings ahead of local package batches', () => {
    const session = createSession([
      createFinding('finding-cross', 'critical', 'security', [
        'packages/web-sdk/src/widget/sanitize.ts',
        'apps/runtime/src/websocket/widget-bootstrap.ts',
      ]),
      createFinding('finding-runtime', 'high', 'bug', ['apps/runtime/src/websocket/auth.ts']),
      createFinding('finding-studio', 'medium', 'missing-test', [
        'apps/studio/src/app/api/sdk/routes.ts',
      ]),
    ]);

    const batches = buildPlanningBatches(session);
    const rendered = formatPlanningBatches(session);

    expect(batches[0]?.title).toContain('Cross-scope foundation');
    expect(batches[0]?.findingIds).toContain('finding-cross');
    expect(rendered).toContain('Cross-scope foundation');
    expect(rendered).toContain('IDs: finding-cross');
    expect(rendered).toContain('apps/runtime/src/websocket/auth.ts');
  });

  it('splits an oversized root group into seam-local planning batches', () => {
    const session = createSession([
      createFinding('finding-auth-1', 'high', 'bug', ['packages/web-sdk/src/auth/guard.ts']),
      createFinding('finding-auth-2', 'high', 'bug', ['packages/web-sdk/src/auth/session.ts']),
      createFinding('finding-auth-3', 'medium', 'missing-test', [
        'packages/web-sdk/src/auth/session.ts',
      ]),
      createFinding('finding-auth-4', 'medium', 'inconsistency', [
        'packages/web-sdk/src/auth/guard.ts',
      ]),
      createFinding('finding-auth-5', 'low', 'bug', ['packages/web-sdk/src/auth/token.ts']),
      createFinding('finding-widget-1', 'critical', 'security', [
        'packages/web-sdk/src/widgets/render.ts',
      ]),
      createFinding('finding-widget-2', 'high', 'security', [
        'packages/web-sdk/src/widgets/sanitize.ts',
      ]),
      createFinding('finding-widget-3', 'high', 'bug', ['packages/web-sdk/src/widgets/events.ts']),
      createFinding('finding-widget-4', 'medium', 'missing-test', [
        'packages/web-sdk/src/widgets/render.ts',
      ]),
      createFinding('finding-widget-5', 'medium', 'inconsistency', [
        'packages/web-sdk/src/widgets/render.ts',
      ]),
    ]);

    const batches = buildPlanningBatches(session);

    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches.some((batch) => batch.title.includes('packages/web-sdk/src'))).toBe(true);
    expect(
      batches.some((batch) => batch.title.includes('auth') || batch.title.includes('widgets')),
    ).toBe(true);
  });
});

function createSession(findings: Finding[]): Session {
  const timestamp = '2026-04-05T00:00:00.000Z';
  return {
    id: 'planning-batches-session',
    workItem: {
      id: 'work-item-1',
      type: 'feature-audit',
      title: 'Planning batches',
      description: 'Test deterministic planning batches',
      scope: ['packages/web-sdk/src', 'apps/runtime/src/websocket', 'apps/studio/src/app/api/sdk'],
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: 'Holistic Feature Audit',
    pipelineVersion: 'Holistic Feature Audit@test',
    promptContext: {
      builtAt: timestamp,
      instructionDocs: [],
      codeMap: {
        scope: [
          'packages/web-sdk/src',
          'apps/runtime/src/websocket',
          'apps/studio/src/app/api/sdk',
        ],
        totalSourceFiles: 10,
        totalTestFiles: 3,
        keyFiles: [
          {
            path: 'packages/web-sdk/src/widgets/render.ts',
            exports: ['renderWidget'],
            dependents: ['apps/runtime/src/websocket/widget-bootstrap.ts'],
            isTestFile: false,
          },
          {
            path: 'packages/web-sdk/src/auth/guard.ts',
            exports: ['requireAuth'],
            dependents: ['packages/web-sdk/src/auth/session.ts'],
            isTestFile: false,
          },
          {
            path: 'apps/runtime/src/websocket/auth.ts',
            exports: ['attachAuth'],
            dependents: ['apps/runtime/src/websocket/server.ts'],
            isTestFile: false,
          },
        ],
      },
    },
    state: 'planning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings,
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

function createFinding(
  id: string,
  severity: Finding['severity'],
  category: Finding['category'],
  files: string[],
): Finding {
  const timestamp = '2026-04-05T00:00:00.000Z';
  return {
    id,
    category,
    severity,
    status: 'open',
    title: `${id} title`,
    description: `${id} description`,
    files: files.map((path) => ({ path })),
    discoveredBy: 'Deep Scan',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
