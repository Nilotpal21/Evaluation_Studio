import { describe, expect, it } from 'vitest';

import {
  applySliceAssignments,
  normalizeBroadReplayPlanFindingOwnership,
  parseAnalysisOutput,
  parseImpactAnalysisOutput,
  parseOracleReviewOutput,
  parsePlanCWithDivergenceOutput,
  parseReproductionOutput,
  parseSlicePlanOutput,
  parseStructuredStageOutput,
  parseStructuredStageOutputResult,
  validateSlicePlan,
} from '../pipeline/stage-output-parsers.js';
import { StructuredOutputParseError } from '../models/executor-errors.js';
import type { Finding, Session } from '../types.js';

describe('stage-output-parsers', () => {
  it('parses structured analysis JSON into findings and decisions', () => {
    const output = JSON.stringify({
      summary: 'Found one bug and one decision',
      findings: [
        {
          severity: 'high',
          category: 'bug',
          title: 'Missing auth guard',
          description: 'Project route skips auth middleware',
          files: ['apps/runtime/src/routes/project.ts'],
        },
      ],
      decisions: [
        {
          classification: 'DECIDED',
          question: 'Should the route use requireProjectPermission?',
          context: null,
          answer: 'Yes',
        },
      ],
    });

    const parsed = parseAnalysisOutput(output, 'Deep Scan');

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      severity: 'high',
      category: 'bug',
      title: 'Missing auth guard',
      discoveredBy: 'Deep Scan',
      files: [{ path: 'apps/runtime/src/routes/project.ts' }],
    });
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0]).toMatchObject({
      classification: 'DECIDED',
      question: 'Should the route use requireProjectPermission?',
      answer: 'Yes',
    });
  });

  it('falls back to markdown-wrapped FINDING and DECISION lines', () => {
    const output = [
      '**FINDING: [high] [bug] Wrapped markdown finding still parses**',
      '',
      '**DECISION: [AMBIGUOUS] Which route should own the fallback?**',
    ].join('\n');

    const parsed = parseAnalysisOutput(output, 'Oracle Analysis');

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      severity: 'high',
      category: 'bug',
      title: 'Wrapped markdown finding still parses',
    });
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      question: 'Which route should own the fallback?',
    });
  });

  it('parses structured slice plans without mutating findings until assignments are applied', () => {
    const session = createSession([
      {
        id: 'finding-auth',
        title: 'Missing auth guard',
        description: 'Project route skips auth middleware',
      },
    ]);

    const output = JSON.stringify({
      summary: 'One slice fixes auth',
      slices: [
        {
          title: 'Add auth guard',
          description: 'Wire auth into the project route',
          findings: ['finding-auth'],
          files: ['apps/runtime/src/routes/project.ts'],
          tests: ['apps/runtime/src/__tests__/project-auth.test.ts'],
          dependencies: [],
          legacyPaths: [
            {
              path: 'apps/runtime/src/routes/legacy-project.ts',
              reason: 'Superseded by guarded project route',
            },
          ],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session);

    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({
      title: 'Add auth guard',
      findings: ['finding-auth'],
      dependencies: [],
    });
    expect(slices[0].testLock.requiredTests).toHaveLength(1);
    expect(slices[0].exitCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'architecture-reviewed',
          type: 'architecture-reviewed',
        }),
      ]),
    );
    expect(slices[0].legacyPaths).toEqual([
      expect.objectContaining({
        path: 'apps/runtime/src/routes/legacy-project.ts',
        reason: 'Superseded by guarded project route',
      }),
    ]);
    expect(validation).toEqual({ ok: true });
    expect(session.findings[0]).toMatchObject({ status: 'open' });
    expect(session.findings[0]).not.toHaveProperty('assignedSlice');

    applySliceAssignments(slices, session);

    expect(session.findings[0]).toMatchObject({
      assignedSlice: 0,
      status: 'planned',
    });
  });

  it('parses structured slice-plan JSON even when brace-heavy narration appears before the object', () => {
    const session = createSession([
      {
        id: 'finding-rbac',
        title: 'RBAC seam needs a compatibility plan',
        description:
          'Planner must preserve the flat contract while introducing scoped permissions.',
      },
    ]);

    const output = [
      'QUALITY GATE FAILED:',
      'FAILED: Plan is seam-aware and future-proof',
      '',
      'PREVIOUS OUTPUT:',
      'Now I have the full picture. The exploration confirms {ownerId} and {tenantId: {$in}} are legacy query shapes.',
      'The backward-compatible path introduces ScopedPermission {resourceType, operation, resourceId} in parallel.',
      '',
      JSON.stringify({
        summary: 'One slice preserves the compatibility seam.',
        slices: [
          {
            title: 'Preserve the compatibility seam',
            description: 'Keep the old contract while adding the scoped path.',
            findings: ['finding-rbac'],
            files: ['packages/shared-auth/src/rbac/permission-resolver.ts'],
            tests: ['packages/shared-auth/src/__tests__/permission-resolver.test.ts'],
            dependencies: [],
            legacyPaths: [],
          },
        ],
      }),
    ].join('\n');

    const parsed = parseStructuredStageOutputResult(output, 'slice-plan');
    const slices = parseSlicePlanOutput(output, session);

    expect(parsed.error).toBeNull();
    expect(parsed.data).toMatchObject({
      summary: 'One slice preserves the compatibility seam.',
      slices: [expect.objectContaining({ title: 'Preserve the compatibility seam' })],
    });
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({
      title: 'Preserve the compatibility seam',
      findings: ['finding-rbac'],
    });
  });

  it('parses structured slice-plan JSON when harmless top-level metadata is present', () => {
    const session = createSession([
      {
        id: 'finding-member-repo',
        title: 'Extract the member repo seam',
        description: 'Move member CRUD logic into a dedicated repo/service layer.',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Four slices cover the full member RBAC extraction.',
      wiringChecklist: [
        'Wire the new repo into the service layer.',
        'Backfill the canonical member route.',
      ],
      slices: [
        {
          title: 'Extract the repo seam',
          description: 'Create a dedicated project member repo.',
          findings: ['finding-member-repo'],
          files: ['apps/studio/src/repos/project-member-repo.ts'],
          tests: ['apps/studio/src/__tests__/project-member-repo.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    });

    const parsed = parseStructuredStageOutputResult(output, 'slice-plan');
    const slices = parseSlicePlanOutput(output, session);

    expect(parsed.error).toBeNull();
    expect(parsed.data).toMatchObject({
      summary: 'Four slices cover the full member RBAC extraction.',
      slices: [expect.objectContaining({ title: 'Extract the repo seam' })],
    });
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({
      title: 'Extract the repo seam',
      findings: ['finding-member-repo'],
    });
  });

  it('parses structured plan review JSON with slice verdicts and backlog deferrals', () => {
    const output = JSON.stringify({
      summary: 'Keep slice 1, revise slice 2, defer one low-value cleanup',
      findings: [
        {
          disposition: 'blocking',
          severity: 'high',
          category: 'missing-test',
          title: 'Slice 2 needs stronger regression coverage',
          description: 'The second slice lacks the integration test that proves the seam.',
          files: ['apps/runtime/src/__tests__/project-auth.test.ts'],
        },
        {
          disposition: 'advisory',
          severity: 'low',
          category: 'redundancy',
          title: 'Legacy cleanup can wait',
          description: 'The duplicate helper can move to backlog.',
          files: ['apps/runtime/src/routes/legacy-project.ts'],
        },
      ],
      sliceAssessments: [
        {
          sliceNumber: 1,
          verdict: 'approved',
          rationale: 'The foundation slice is dependency-ordered and well covered.',
          requiredTestAmendments: [],
        },
        {
          sliceNumber: 2,
          verdict: 'revise',
          rationale: 'Add the missing integration test before this slice can pass.',
          requiredTestAmendments: [
            'apps/runtime/src/__tests__/project-auth.test.ts - prove the shared auth seam',
          ],
        },
      ],
      deferredFindings: [
        {
          findingId: 'finding-cleanup',
          reason: 'Safe to backlog after the shared seam lands.',
        },
      ],
      decisions: [],
    });

    const parsed = parseStructuredStageOutput(output, 'plan-review');

    expect(parsed).toMatchObject({
      summary: 'Keep slice 1, revise slice 2, defer one low-value cleanup',
      sliceAssessments: [
        expect.objectContaining({ sliceNumber: 1, verdict: 'approved' }),
        expect.objectContaining({ sliceNumber: 2, verdict: 'revise' }),
      ],
      deferredFindings: [
        expect.objectContaining({
          findingId: 'finding-cleanup',
        }),
      ],
    });
    expect(parsed?.findings).toEqual([
      expect.objectContaining({ disposition: 'blocking', category: 'missing-test' }),
      expect.objectContaining({ disposition: 'advisory', category: 'redundancy' }),
    ]);
  });

  it('rejects slices that exceed MAX_FILE_CONTRACTS_PER_SLICE', () => {
    const session = createSession([
      {
        id: 'finding-broad',
        title: 'Broad seam refactor',
        description: 'Refactor touches many files',
      },
    ]);

    const output = JSON.stringify({
      summary: 'One mega-slice',
      slices: [
        {
          title: 'Refactor everything',
          description: 'Single-shot refactor across many files',
          findings: ['finding-broad'],
          files: [
            'apps/runtime/src/routes/a.ts',
            'apps/runtime/src/routes/b.ts',
            'apps/runtime/src/routes/c.ts',
            'apps/runtime/src/routes/d.ts',
            'apps/runtime/src/routes/e.ts',
            'apps/runtime/src/routes/f.ts',
            'apps/runtime/src/routes/g.ts',
          ],
          tests: ['apps/runtime/src/__tests__/coverage.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session);

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toContain('cap is 6');
      expect(validation.reason).toContain('Split this slice');
    }
  });

  it('rejects slices whose impact score (direct + dependents weighted) exceeds the cap', () => {
    const session = createSession([
      {
        id: 'finding-impact',
        title: 'High-impact change',
        description: 'A change with many dependent files',
      },
    ]);

    // 5 direct + 25 dependent → score = 5 + ceil(25*0.3) = 5 + 8 = 13 > 12
    const output = JSON.stringify({
      summary: 'Single slice with broad ripple',
      slices: [
        {
          title: 'Touch a hub seam',
          description: 'Edits a core type that 25 modules import',
          findings: ['finding-impact'],
          files: [
            'apps/runtime/src/types/a.ts',
            'apps/runtime/src/types/b.ts',
            'apps/runtime/src/types/c.ts',
            'apps/runtime/src/types/d.ts',
            'apps/runtime/src/types/e.ts',
          ],
          tests: ['apps/runtime/src/__tests__/types.test.ts'],
          dependencies: [],
          legacyPaths: [],
          dependentFiles: Array.from(
            { length: 25 },
            (_, i) => `apps/runtime/src/consumers/consumer-${i}.ts`,
          ),
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    // Manually set dependentFiles since the parser may not propagate them in this fixture
    if (slices[0]) {
      slices[0].impactAnalysis.dependentFiles = Array.from(
        { length: 25 },
        (_, i) => `apps/runtime/src/consumers/consumer-${i}.ts`,
      );
    }
    const validation = validateSlicePlan(slices, session);

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toContain('impact score of 13');
      expect(validation.reason).toContain('cap is 12');
    }
  });

  it('rejects plans that omit required tests', () => {
    const session = createSession([
      {
        id: 'finding-test',
        title: 'Add regression coverage',
        description: 'No integration test covers this route',
      },
    ]);

    const output = [
      'SLICE 1: Wire route',
      '- FINDINGS: finding-test',
      '- FILES: apps/runtime/src/routes/project.ts',
      '- TESTS: none',
      '- DEPENDS: none',
      '- DESCRIPTION: Fix the route without declaring tests',
    ].join('\n');

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session);

    expect(validation).toEqual({
      ok: false,
      reason: 'Plan left 1 slices without required tests',
    });
  });

  it('allows explicitly deferred findings to remain unassigned when validating the final plan', () => {
    const session = createSession([
      {
        id: 'finding-core',
        title: 'Core fix',
        description: 'Must be planned now',
      },
      {
        id: 'finding-backlog',
        title: 'Optional cleanup',
        description: 'Safe to backlog later',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Plan only the core fix',
      slices: [
        {
          title: 'Fix the core seam',
          description: 'Stabilize the invariant first',
          findings: ['finding-core'],
          files: ['apps/runtime/src/routes/project.ts'],
          tests: ['apps/runtime/src/__tests__/project-auth.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session, {
      deferredFindingIds: new Set(['finding-backlog']),
    });

    expect(validation).toEqual({ ok: true });
  });

  it('rejects structured analysis JSON with invalid enum values instead of normalizing them', () => {
    const output = JSON.stringify({
      summary: 'Invalid severity should fail',
      findings: [
        {
          severity: 'severe',
          category: 'bug',
          title: 'Missing auth guard',
          description: 'Project route skips auth middleware',
          files: ['apps/runtime/src/routes/project.ts'],
        },
      ],
      decisions: [],
    });

    const parsed = parseStructuredStageOutputResult(output, 'analysis-report');

    expect(parsed.data).toBeNull();
    expect(parsed.error?.message).toContain('analysis-report JSON failed schema validation');
    expect(parsed.error?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('/findings/0/severity')]),
    );
  });

  it('parses workspace reconcile output and preserves ignore/block decisions', () => {
    const output = JSON.stringify({
      summary: 'Ignore scratch files, block substantive code drift.',
      assessments: [
        {
          file: 'tmp/debug.log',
          disposition: 'ignore',
          rationale: 'Transient debug output outside the slice.',
        },
        {
          file: 'src/unexpected.ts',
          disposition: 'block',
          rationale: 'Substantive source file outside the declared slice.',
        },
      ],
    });

    const parsed = parseStructuredStageOutputResult(output, 'workspace-reconcile');

    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual({
      summary: 'Ignore scratch files, block substantive code drift.',
      assessments: [
        {
          file: 'tmp/debug.log',
          disposition: 'ignore',
          rationale: 'Transient debug output outside the slice.',
        },
        {
          file: 'src/unexpected.ts',
          disposition: 'block',
          rationale: 'Substantive source file outside the declared slice.',
        },
      ],
    });
  });

  it('parses failure advisory output and preserves retry guidance', () => {
    const output = JSON.stringify({
      summary: 'Plan generation timed out while still exploring.',
      suspectedCause: 'The stage kept re-reading files instead of converging on the slice plan.',
      recommendedAction: 'synthesize-stage',
      budgetRecommendation: null,
      promptGuidance:
        'Reuse the current findings. Stop re-reading already inspected files and emit the final slice plan JSON directly.',
      operatorActions: [
        'Review the current plan-generation output before retrying if the same timeout repeats.',
      ],
    });

    const parsed = parseStructuredStageOutputResult(output, 'failure-advisory');

    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual({
      summary: 'Plan generation timed out while still exploring.',
      suspectedCause: 'The stage kept re-reading files instead of converging on the slice plan.',
      recommendedAction: 'synthesize-stage',
      promptGuidance:
        'Reuse the current findings. Stop re-reading already inspected files and emit the final slice plan JSON directly.',
      operatorActions: [
        'Review the current plan-generation output before retrying if the same timeout repeats.',
      ],
      budgetRecommendation: null,
    });
  });

  it('parses failure advisory continuation actions beyond simple retry', () => {
    const output = JSON.stringify({
      summary: 'Oracle review is widening into medium-term findings.',
      suspectedCause:
        'The current pass already has enough evidence to finish the immediate seam work.',
      recommendedAction: 'continue-immediate-only',
      budgetRecommendation: null,
      promptGuidance:
        'Finish only the immediate and next findings now. Defer near-term and long-term follow-up into a later pass.',
      operatorActions: [
        'Schedule a later follow-up audit for deferred findings if this retry succeeds.',
      ],
    });

    const parsed = parseStructuredStageOutputResult(output, 'failure-advisory');

    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual({
      summary: 'Oracle review is widening into medium-term findings.',
      suspectedCause:
        'The current pass already has enough evidence to finish the immediate seam work.',
      recommendedAction: 'continue-immediate-only',
      promptGuidance:
        'Finish only the immediate and next findings now. Defer near-term and long-term follow-up into a later pass.',
      operatorActions: [
        'Schedule a later follow-up audit for deferred findings if this retry succeeds.',
      ],
      budgetRecommendation: null,
    });
  });

  it('rejects plans that assign the same finding to multiple slices', () => {
    const session = createSession([
      {
        id: 'finding-auth',
        title: 'Missing auth guard',
        description: 'Project route skips auth middleware',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Duplicate assignment should fail',
      slices: [
        {
          title: 'Add auth guard',
          description: 'Wire auth into the project route',
          findings: ['finding-auth'],
          files: ['apps/runtime/src/routes/project.ts'],
          tests: ['apps/runtime/src/__tests__/project-auth.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
        {
          title: 'Revisit auth guard',
          description: 'Incorrectly assigns the same finding twice',
          findings: ['finding-auth'],
          files: ['apps/runtime/src/routes/project-review.ts'],
          tests: ['apps/runtime/src/__tests__/project-review.test.ts'],
          dependencies: [1],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session);

    expect(validation).toEqual({
      ok: false,
      reason: 'Plan assigned finding finding-auth to multiple slices (1 and 2)',
    });
    expect(session.findings[0]).toMatchObject({ status: 'open' });
    expect(session.findings[0]).not.toHaveProperty('assignedSlice');
  });

  it('allows dependent continuation slices without findings for broad replay cleanup plans', () => {
    const session = createSession([
      {
        id: 'finding-service',
        title: 'Service extraction incomplete',
        description: 'Route handlers still own business logic.',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Keep the cleanup slice as a dependency-only continuation',
      slices: [
        {
          title: 'Service extraction',
          description: 'Move the shared logic into the service layer',
          findings: ['finding-service'],
          files: ['apps/studio/src/services/project-member-service.ts'],
          tests: ['apps/studio/src/__tests__/project-member-service.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
        {
          title: 'Route handler thinning',
          description: 'Mechanical cleanup once service extraction lands',
          findings: [],
          files: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
          tests: ['apps/studio/src/__tests__/api-routes/api-project-members.test.ts'],
          dependencies: [1],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session, {
      allowDependentContinuationSlicesWithoutFindings: true,
    });

    expect(validation).toEqual({ ok: true });
  });

  it('normalizes duplicate broad replay finding ownership onto the earliest slice', () => {
    const session = createSession([
      {
        id: 'finding-service',
        title: 'Service extraction incomplete',
        description: 'Route handlers still own business logic.',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Duplicate seam-wide finding ownership',
      slices: [
        {
          title: 'Service extraction',
          description: 'Move the shared logic into the service layer',
          findings: ['finding-service'],
          files: ['apps/studio/src/services/project-member-service.ts'],
          tests: ['apps/studio/src/__tests__/project-member-service.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
        {
          title: 'Route handler thinning',
          description: 'Mechanical cleanup once service extraction lands',
          findings: ['finding-service'],
          files: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
          tests: ['apps/studio/src/__tests__/api-routes/api-project-members.test.ts'],
          dependencies: [1],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const normalized = normalizeBroadReplayPlanFindingOwnership(slices);

    expect(normalized.changed).toBe(true);
    expect(normalized.removedAssignments).toBe(1);
    expect(normalized.slices[0]?.findings).toEqual(['finding-service']);
    expect(normalized.slices[1]?.findings).toEqual([]);
  });

  it('matches slugified or shortened finding references back to session finding ids', () => {
    const session = createSession([
      {
        id: 'a9fc9fd5',
        title: 'PII pattern write routes are guarded only by `project:read`',
        description: 'Read access can mutate PII configuration.',
      },
      {
        id: 'a7e11564',
        title: 'New built-in overrides are sent through the edit path',
        description: 'First-time override creation incorrectly issues PUT.',
      },
      {
        id: '40463cb9',
        title: 'Proxy routes bypass request validation and malformed JSON becomes a generic 500',
        description: 'Bad payloads are only caught downstream.',
      },
    ]);

    const output = JSON.stringify({
      summary: 'Map PII findings into slices',
      slices: [
        {
          title: 'Harden PII route permissions',
          description: 'Lock down write access and validate proxy requests',
          findings: [
            'pii-pattern-write-routes-guarded-only-by-project-read',
            'proxy-routes-bypass-request-validation',
          ],
          files: [
            'apps/studio/src/app/api/projects/[id]/pii-patterns/route.ts',
            'apps/studio/src/app/api/projects/[id]/pii-patterns/test/route.ts',
          ],
          tests: [
            'apps/studio/src/app/api/projects/[id]/pii-patterns/__tests__/pii-routes.test.ts',
          ],
          dependencies: [],
          legacyPaths: [],
        },
        {
          title: 'Fix built-in override creation',
          description: 'Route first-time built-in overrides through create mode',
          findings: ['new-builtin-overrides-sent-through-edit-path'],
          files: ['apps/studio/src/components/settings/PIIPatternFormDialog.tsx'],
          tests: ['apps/studio/src/components/settings/__tests__/PIIPatternFormDialog.test.tsx'],
          dependencies: [1],
          legacyPaths: [],
        },
      ],
    });

    const slices = parseSlicePlanOutput(output, session);
    const validation = validateSlicePlan(slices, session);

    expect(slices).toHaveLength(2);
    expect(slices[0].findings).toEqual(['a9fc9fd5', '40463cb9']);
    expect(slices[1].findings).toEqual(['a7e11564']);
    expect(validation).toEqual({ ok: true });
    for (const finding of session.findings) {
      expect(finding).toMatchObject({ status: 'open' });
      expect(finding).not.toHaveProperty('assignedSlice');
    }

    applySliceAssignments(slices, session);

    expect(session.findings).toEqual([
      expect.objectContaining({ id: 'a9fc9fd5', assignedSlice: 0, status: 'planned' }),
      expect.objectContaining({ id: 'a7e11564', assignedSlice: 1, status: 'planned' }),
      expect.objectContaining({ id: '40463cb9', assignedSlice: 0, status: 'planned' }),
    ]);
  });

  it('parses structured impact analysis JSON', () => {
    const output = JSON.stringify({
      dependentFiles: ['apps/runtime/src/routes/project-review.ts'],
      affectedTests: ['apps/runtime/src/__tests__/project-auth.test.ts'],
      riskLevel: 'high',
      notes: 'Auth middleware ordering affects all project routes',
    });

    const parsed = parseImpactAnalysisOutput(output, ['apps/runtime/src/routes/project.ts']);

    expect(parsed).toEqual({
      directFiles: ['apps/runtime/src/routes/project.ts'],
      dependentFiles: ['apps/runtime/src/routes/project-review.ts'],
      affectedTests: ['apps/runtime/src/__tests__/project-auth.test.ts'],
      riskLevel: 'high',
      notes: 'Auth middleware ordering affects all project routes',
    });
  });

  it('parses structured oracle review JSON', () => {
    const output = JSON.stringify({
      summary: 'Two findings reviewed',
      assessments: [
        {
          findingId: 'finding-auth',
          verdict: 'challenge',
          rationale: 'Route already uses unified auth middleware',
          severity: null,
          horizon: 'near-term',
        },
      ],
      newFindings: [
        {
          severity: 'medium',
          category: 'missing-test',
          title: 'No integration test covers review route',
          description: 'Route lacks integration coverage',
          files: ['apps/runtime/src/routes/project-review.ts'],
        },
      ],
      decisions: [
        {
          classification: 'AMBIGUOUS',
          question: 'Should the auth finding remain?',
          context: null,
          answer: null,
        },
      ],
    });

    const parsed = parseOracleReviewOutput(output);

    expect(parsed.assessments).toEqual([
      expect.objectContaining({
        findingId: 'finding-auth',
        verdict: 'challenge',
        rationale: 'Route already uses unified auth middleware',
        severity: null,
        horizon: 'near-term',
      }),
    ]);
    expect(parsed.newFindings).toEqual([
      expect.objectContaining({
        title: 'No integration test covers review route',
        category: 'missing-test',
      }),
    ]);
    expect(parsed.decisions).toEqual([
      expect.objectContaining({
        classification: 'AMBIGUOUS',
        question: 'Should the auth finding remain?',
        context: null,
        answer: null,
      }),
    ]);
  });

  it('parses structured reproduction output and exposes the declared test file', () => {
    const output = JSON.stringify({
      summary: 'Bug reproduced via regression test',
      testFile: 'packages/helix/src/__tests__/stage-output-parsers.test.ts',
      reproductionSteps: ['Run pnpm build --filter=@agent-platform/helix', 'Run the targeted test'],
      findings: [
        {
          severity: 'high',
          category: 'bug',
          title: 'Invalid dependencies survive validation',
          description: 'Out-of-range dependency indexes pass plan validation',
          files: ['packages/helix/src/pipeline/stage-output-parsers.ts'],
        },
      ],
      decisions: [],
    });

    const parsed = parseReproductionOutput(output, 'Reproduce');

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      testFile: 'packages/helix/src/__tests__/stage-output-parsers.test.ts',
      reproductionSteps: ['Run pnpm build --filter=@agent-platform/helix', 'Run the targeted test'],
    });
    expect(parsed?.findings).toEqual([
      expect.objectContaining({
        title: 'Invalid dependencies survive validation',
        discoveredBy: 'Reproduce',
      }),
    ]);
  });
});

// ─── parsePlanCWithDivergenceOutput (2.C.5) ──────────────────

describe('parsePlanCWithDivergenceOutput', () => {
  it('returns plan + divergenceNotes from valid JSON', () => {
    const input = JSON.stringify({
      summary: 'Convergent plan.',
      slices: [
        {
          title: 'Fix shared seam',
          description: 'Move validation to shared boundary',
          findings: ['finding-001'],
          files: ['src/shared/validation.ts'],
          tests: ['src/shared/validation.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
      divergenceNotes: 'Plan A prefers extract-first; Plan B prefers inline.',
    });

    const result = parsePlanCWithDivergenceOutput(input);
    expect(result.plan).toBeDefined();
    expect(result.plan.length).toBeGreaterThan(0);
    expect(result.divergenceNotes).toBe('Plan A prefers extract-first; Plan B prefers inline.');

    // Plan body should not contain divergenceNotes
    const planBody = JSON.parse(result.plan) as Record<string, unknown>;
    expect(planBody['summary']).toBe('Convergent plan.');
    expect(planBody['divergenceNotes']).toBeUndefined();
  });

  it('returns plan without divergenceNotes when field is absent (optional)', () => {
    const input = JSON.stringify({
      summary: 'Plan without notes.',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    });

    const result = parsePlanCWithDivergenceOutput(input);
    expect(result.plan).toBeDefined();
    expect(result.divergenceNotes).toBeUndefined();
  });

  it('returns plan without divergenceNotes when field is empty string', () => {
    const input = JSON.stringify({
      summary: 'Plan with empty notes.',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
      divergenceNotes: '',
    });

    const result = parsePlanCWithDivergenceOutput(input);
    expect(result.divergenceNotes).toBeUndefined();
  });

  it('throws StructuredOutputParseError on malformed JSON', () => {
    expect(() => parsePlanCWithDivergenceOutput('NOT JSON')).toThrow(StructuredOutputParseError);
    try {
      parsePlanCWithDivergenceOutput('NOT JSON');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(StructuredOutputParseError);
      const err = e as InstanceType<typeof StructuredOutputParseError>;
      expect(err.schemaId).toBe('plan-c-with-divergence');
      expect(err.message).toContain('JSON.parse failed');
    }
  });

  it('throws StructuredOutputParseError when summary is empty (schema violation)', () => {
    const input = JSON.stringify({
      summary: '',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    });

    expect(() => parsePlanCWithDivergenceOutput(input)).toThrow(StructuredOutputParseError);
    try {
      parsePlanCWithDivergenceOutput(input);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(StructuredOutputParseError);
      const err = e as InstanceType<typeof StructuredOutputParseError>;
      expect(err.schemaId).toBe('plan-c-with-divergence');
      expect(err.message).toContain('AJV validation failed');
    }
  });

  it('throws StructuredOutputParseError with strict flag on extra properties', () => {
    const input = JSON.stringify({
      summary: 'Valid summary.',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
      divergenceNotes: 'Some notes.',
      extraField: 'should fail with strict',
    });

    expect(() => parsePlanCWithDivergenceOutput(input, true)).toThrow(StructuredOutputParseError);
  });
});

function createSession(
  findings: Array<
    Pick<Finding, 'id' | 'title' | 'description'> &
      Partial<Pick<Finding, 'severity' | 'horizon' | 'status'>>
  >,
): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title: 'HELIX parser tests',
      description: 'Test session',
      scope: ['packages/helix'],
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: 'test',
    pipelineVersion: 'test@123456789abc',
    state: 'planning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: findings.map((finding) => ({
      ...finding,
      category: 'bug',
      severity: finding.severity ?? 'high',
      status: finding.status ?? 'open',
      files: [],
      horizon: finding.horizon,
      discoveredBy: 'Deep Scan',
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}
