import { describe, expect, it } from 'vitest';

import {
  buildSlicePrompt,
  buildStagePrompt,
  estimateDeepScanEfficiencyBudget,
  estimatePlanningEfficiencyBudget,
  estimateRootCauseEfficiencyBudget,
  estimateSliceEfficiencyBudget,
} from '../pipeline/stage-runner.js';
import type { Finding, Session, Slice, SliceChecklist, StageDefinition } from '../types.js';

describe('stage-runner', () => {
  it('includes exact finding ids in plan-generation prompts', () => {
    const session = createSession([
      {
        id: 'finding-auth',
        title: 'Missing auth guard',
        description: 'Project route skips auth middleware',
        files: ['apps/runtime/src/websocket/auth.ts'],
      },
      {
        id: 'finding-validation',
        title: 'Request body validation is missing',
        description: 'Malformed JSON becomes a 500 instead of a 400',
        files: ['packages/helix/src/validation/body.ts'],
      },
    ]);
    session.promptContext = {
      builtAt: '2026-04-05T00:00:00.000Z',
      instructionDocs: [],
      codeMap: {
        scope: ['apps/runtime/src/websocket', 'packages/helix/src'],
        totalSourceFiles: 4,
        totalTestFiles: 2,
        keyFiles: [
          {
            path: 'apps/runtime/src/websocket/auth.ts',
            exports: ['requireSocketAuth'],
            dependents: ['apps/runtime/src/websocket/bootstrap.ts'],
            isTestFile: false,
          },
          {
            path: 'packages/helix/src/validation/body.ts',
            exports: ['parseRequestBody'],
            dependents: ['packages/helix/src/server.ts', 'packages/helix/src/worker.ts'],
            isTestFile: false,
          },
        ],
      },
    };
    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(
      stage,
      session,
      `QUALITY GATE FAILED:
Plan omitted required finding IDs.

PREVIOUS OUTPUT:
${'SLICE 1: Patch callers first\n- DESCRIPTION: giant rejected plan\n'.repeat(300)}`,
      2,
    );

    expect(prompt).toContain('ID: finding-auth');
    expect(prompt).toContain('ID: finding-validation');
    expect(prompt).toContain('## Complete Open Findings Registry');
    expect(prompt).toContain('## Planning Batches');
    expect(prompt).toContain('Use these deterministic planning batches as a starting outline.');
    expect(prompt).toContain('packages/helix/src — validation');
    expect(prompt).toContain('keep slices local unless a shared contract forces cross-batch work');
    expect(prompt).toContain('IDs:');
    expect(prompt).toContain('"id": "finding-auth"');
    expect(prompt).toContain('"id": "finding-validation"');
    expect(prompt).toContain('## Previous Iteration Output');
    expect(prompt).toContain('Plan omitted required finding IDs');
    expect(prompt).toContain('[retry output truncated]');
    expect(prompt).toContain('Do NOT search `.helix/sessions`');
    expect(prompt).toContain('Use the exact HELIX finding IDs shown in the registry above.');
    expect(prompt).toContain('Focused on one seam or contract at a time');
    expect(prompt).toContain('prefer shared abstractions, contract hardening, or path convergence');
    expect(prompt).toContain('What seam or contract this slice stabilizes');
    expect(prompt).toContain('## Planning Efficiency Budget');
    expect(prompt).toContain('## Planning Stop Policy');
    expect(prompt).toContain('Once the exploration budget is exhausted, stop broad discovery');
    expect(prompt).toContain('Do not re-read the same file or rerun the same lookup');
    expect(prompt).toContain('Each open finding ID must appear in exactly one slice');
    expect(prompt).toContain('"findings": ["existing-finding-id-1"]');
  });

  it('adds replay seam guidance for plan generation during historical replays', () => {
    const session = createSession([
      {
        id: 'finding-members',
        title: 'Project member routes duplicate repo logic',
        description: 'Route handlers inline membership persistence and audit logging',
        files: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
      },
    ]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['service-extraction', 'rbac', 'route-migration'],
      historicalFileHints: {
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts': [
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        ],
      },
    };

    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Replay Planning Guidance');
    expect(prompt).toContain('apps/studio/src/app/api/projects/[id]/members/route.ts');
    expect(prompt).toContain('Do not rerun `find`, `git ls-files`, `git show HEAD:<file>`');
    expect(prompt).toContain('Historical seam findings should anchor the earliest slice');
    expect(prompt).toContain('Non-listed consumers are out-of-bounds by default during planning');
    expect(prompt).toContain('runtime repos, or broad auth helpers');
    expect(prompt).toContain('After the exploration budget, treat workspace inventory commands');
  });

  it('starts broad replay planning in compact synthesis mode when seam findings are already sufficient', () => {
    const session = createSession([]);
    session.workItem.type = 'feature-audit';
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'apps/studio/src/services/audit-service.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
      ],
      tags: ['service-extraction', 'rbac', 'route-migration'],
      historicalFileHints: {
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts': [
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        ],
        'apps/studio/src/services/project-member-service.ts': [
          'apps/studio/src/app/api/projects/[id]/members/route.ts',
          'apps/studio/src/repos/project-repo.ts',
        ],
        'apps/studio/src/__tests__/project-member-service.test.ts': [
          'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        ],
      },
    };
    session.findings = [
      createFinding({
        id: 'finding-route',
        title: 'Historical replay target route is missing at the base commit',
        description:
          'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts does not exist yet at the replay base commit.',
        category: 'wiring-gap',
        severity: 'high',
        horizon: 'immediate',
        files: [
          'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        ],
      }),
      createFinding({
        id: 'finding-service',
        title: 'Historical replay target seam file is missing at the base commit',
        description:
          'apps/studio/src/services/project-member-service.ts does not exist yet at the replay base commit.',
        category: 'wiring-gap',
        severity: 'high',
        horizon: 'immediate',
        files: [
          'apps/studio/src/services/project-member-service.ts',
          'apps/studio/src/repos/project-repo.ts',
        ],
      }),
      createFinding({
        id: 'finding-test',
        title: 'Historical replay target test is missing at the base commit',
        description:
          'apps/studio/src/__tests__/project-member-service.test.ts does not exist yet at the replay base commit.',
        category: 'missing-test',
        severity: 'medium',
        horizon: 'next',
        files: [
          'apps/studio/src/__tests__/project-member-service.test.ts',
          'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        ],
      }),
    ];

    const budget = estimatePlanningEfficiencyBudget(session);
    expect(budget.disableToolUse).toBe(true);
    expect(budget.explorationTurns).toBe(0);
    expect(budget.hardTurnCap).toBe(budget.targetTurns);

    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);
    expect(prompt).toContain('## Compact Replay Planning Mode');
    expect(prompt).toContain('Tool use is disabled for this planning pass');
    expect(prompt).toContain('Keep only immediate and next-horizon work in this plan');
  });

  it('keeps broad replay recovery prompts compact during startup-hang synthesis retries', () => {
    const session = createSession([]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['service-extraction', 'rbac', 'route-migration'],
    };
    session.promptContext = {
      builtAt: '2026-04-15T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'apps/studio/AGENTS.md',
          title: 'Studio Instructions',
          excerpt: 'Read this before editing anything.',
        },
      ],
      codeMap: {
        scope: ['apps/studio/src', 'packages/database/src'],
        totalSourceFiles: 12,
        totalTestFiles: 2,
        keyFiles: [
          {
            path: 'apps/studio/src/repos/project-repo.ts',
            exports: ['findProjectMembers'],
            dependents: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
            isTestFile: false,
          },
        ],
      },
    };

    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Synthesize the replay seam findings',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'analysis-report' },
      prompt: [
        '## EVIDENCE-ONLY RECOVERY MODE',
        'Stage: Deep Scan',
        'Work item: Extract project member RBAC service and canonicalize member routes',
        'Replay tags: service-extraction, rbac, route-migration',
        'Synthesize the structured result only from the replay seam evidence already gathered in this run.',
        '',
        '## Historical Replay Seam',
        '- apps/studio/src/app/api/projects/[id]/members/route.ts',
        '- apps/studio/src/repos/project-repo.ts',
      ].join('\n'),
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## EVIDENCE-ONLY RECOVERY MODE');
    expect(prompt).toContain('## Historical Replay Seam');
    expect(prompt).not.toContain('## Replay Seam Guidance');
    expect(prompt).not.toContain('## Scope Discipline');
    expect(prompt).not.toContain('## Repository Instructions');
    expect(prompt).not.toContain('## Scoped Code Map');
  });

  it('keeps broad replay plan-generation recovery prompts compact during synthesis retries', () => {
    const session = createSession([]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['service-extraction', 'rbac', 'route-migration'],
    };
    session.promptContext = {
      builtAt: '2026-04-15T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'apps/studio/AGENTS.md',
          title: 'Studio Instructions',
          excerpt: 'Read this before editing anything.',
        },
      ],
      codeMap: {
        scope: ['apps/studio/src', 'packages/database/src'],
        totalSourceFiles: 12,
        totalTestFiles: 2,
        keyFiles: [
          {
            path: 'apps/studio/src/repos/project-repo.ts',
            exports: ['findProjectMembers'],
            dependents: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
            isTestFile: false,
          },
        ],
      },
    };

    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Synthesize the replay seam plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      prompt: [
        '## TOP PRIORITY RECOVERY MODE',
        'Stage: Plan Generation',
        'Work item: Extract project member RBAC service and canonicalize member routes',
        'Replay tags: service-extraction, rbac, route-migration',
        'Synthesize the structured result only from the replay seam evidence already gathered in this run.',
        '',
        '## Historical Replay Seam',
        '- apps/studio/src/app/api/projects/[id]/members/route.ts',
        '- apps/studio/src/repos/project-repo.ts',
      ].join('\n'),
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## TOP PRIORITY RECOVERY MODE');
    expect(prompt).toContain('## Historical Replay Seam');
    expect(prompt).not.toContain('## Replay Planning Guidance');
    expect(prompt).not.toContain('## Planning Stop Policy');
    expect(prompt).not.toContain('## Repository Instructions');
    expect(prompt).not.toContain('## Scoped Code Map');
  });

  it('limits plan generation to immediate and next findings while surfacing follow-up work', () => {
    const session = createSession([
      {
        id: 'finding-now',
        title: 'Extract the service seam now',
        description: 'Routes and repo must be split in this pass.',
        files: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
        severity: 'high',
        horizon: 'immediate',
      },
      {
        id: 'finding-next',
        title: 'Add follow-on regression for the new seam',
        description: 'The new service should get direct regression coverage next.',
        files: ['apps/studio/src/__tests__/project-member-service.test.ts'],
        severity: 'medium',
        horizon: 'next',
      },
      {
        id: 'finding-later',
        title: 'Clean up neighboring role helpers later',
        description: 'Valid follow-up, but not for this implementation pass.',
        files: ['packages/shared-auth/src/rbac/role-permissions.ts'],
        severity: 'low',
        horizon: 'near-term',
      },
    ]);

    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);
    const openRegistrySection =
      prompt
        .split('## Complete Open Findings Registry')[1]
        ?.split('## Follow-up Findings (Not For This Pass)')[0] ?? '';
    const followUpSection =
      prompt
        .split('## Follow-up Findings (Not For This Pass)')[1]
        ?.split('## Planning Batches')[0] ?? '';

    expect(openRegistrySection).toContain('"id": "finding-now"');
    expect(openRegistrySection).toContain('"id": "finding-next"');
    expect(openRegistrySection).not.toContain('"id": "finding-later"');
    expect(prompt).toContain('## Follow-up Findings (Not For This Pass)');
    expect(followUpSection).toContain('"id": "finding-later"');
    expect(prompt).toContain('Only findings in the open registry above are in scope for this plan');
    expect(prompt).toContain('Do NOT assign near-term or long-term follow-up findings');
  });

  it('pushes implementation prompts toward seam stabilization and future-proof fixes', () => {
    const session = createSession([
      {
        id: 'finding-dup',
        title: 'Duplicate validation branches',
        description: 'Two handlers patch the same invariant independently',
      },
    ]);
    const stage: StageDefinition = {
      name: 'Implementation',
      type: 'implementation',
      description: 'Implement the slice',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain(
      'Make the smallest change that completely stabilizes the seam or invariant',
    );
    expect(prompt).toContain(
      'Fix the shared seam or abstraction first when multiple consumers are affected',
    );
    expect(prompt).toContain('Do NOT trade long-term maintainability for a short local patch');
    expect(prompt).toContain('Treat dependents, exports, and regression coverage as part of done');
    expect(prompt).toContain(
      'Treat the preloaded package instructions in the slice packet as the default source of package guidance.',
    );
    expect(prompt).toContain(
      'Treat the slice issue brief appended below as authoritative for scope, contracts, required tests, and definition of done',
    );
    expect(prompt).toContain(
      'Treat the efficiency budget in the slice issue brief as real — use as few turns as possible while staying correct',
    );
    expect(prompt).toContain(
      'Batch related file reads in one turn when possible instead of reading one file at a time',
    );
    expect(prompt).toContain(
      'Do NOT reconstruct the assignment from raw `.helix/sessions`, `session.json`, or `progress.log` artifacts when the issue brief already captures it',
    );
    expect(prompt).toContain(
      'Treat the verification commands preloaded in the slice context packet as the authoritative minimal proof set',
    );
    expect(prompt).toContain(
      'Run the preloaded build/typecheck verification command before any test command',
    );
    expect(prompt).toContain(
      'Do NOT edit `AGENTS.md`, `CLAUDE.md`, `docs/sdlc-logs`, `next-env.d.ts`, or other generated/tool-owned files',
    );
    expect(prompt).toContain(
      'Once the declared build/typecheck, formatting, and required test commands pass, stop and hand control back to HELIX immediately',
    );
  });

  it('renders slice implementation prompts as issue-shaped packets', () => {
    const session = createSession([
      {
        id: 'finding-shared-mapper',
        title: 'Shared mapper contract drift',
        description: 'Two consumers normalize the same payload differently.',
        files: ['packages/helix/src/shared/mapper.ts'],
      },
      {
        id: 'finding-runtime-consumer',
        title: 'Runtime consumer still bypasses the shared mapper',
        description: 'The runtime path still constructs the payload inline.',
        files: ['packages/helix/src/runtime-consumer.ts'],
      },
    ]);
    const foundationSlice = createSlice(0, {
      title: 'Stabilize shared mapper seam',
      description: 'Harden the shared mapper before updating consumers.',
      findings: ['finding-shared-mapper'],
    });
    const targetSlice = createSlice(1, {
      title: 'Move runtime consumer onto shared mapper',
      description: 'Update the runtime consumer to reuse the stabilized shared mapper.',
      findings: ['finding-runtime-consumer'],
      dependencies: [0],
      manifest: {
        entryConditions: [
          {
            id: 'entry-foundation',
            type: 'slice-committed',
            description: 'Foundation mapper seam is already committed',
            reference: '1',
            met: true,
          },
        ],
        fileContracts: [
          {
            path: 'packages/helix/src/runtime-consumer.ts',
            action: 'modify',
            reason: 'Route runtime payload assembly through the shared mapper',
            dependents: ['packages/helix/src/runtime-entry.ts'],
          },
          {
            path: 'packages/helix/src/shared/mapper.ts',
            action: 'modify',
            reason: 'Add the final runtime mapping hook',
            expectedExports: ['mapRuntimePayload'],
            dependents: ['packages/helix/src/runtime-consumer.ts'],
          },
        ],
        exportContracts: [
          {
            sourceFile: 'packages/helix/src/shared/mapper.ts',
            exportName: 'mapRuntimePayload',
            consumers: ['packages/helix/src/runtime-consumer.ts'],
            isNew: false,
          },
        ],
        completeness: {
          summary:
            'Manifest completeness preflight flagged 1 consumer/barrel touchpoint and 1 test coverage gap.',
          hints: [
            {
              path: 'packages/helix/src/runtime-entry.ts',
              kind: 'consumer',
              suggestedAction: 'review',
              reason:
                'runtime-entry.ts imports the shared seam; promote it into direct scope if the runtime wiring changes.',
            },
            {
              path: 'packages/helix/src/runtime-entry.test.ts',
              kind: 'test',
              suggestedAction: 'promote-test',
              reason: 'runtime-entry.test.ts is affected but not explicitly locked yet.',
            },
          ],
        },
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'packages/helix/src/runtime-consumer.test.ts',
            description: 'Runtime consumer uses the shared mapper',
            status: 'passing',
            coversFindings: ['finding-runtime-consumer'],
            isNew: false,
          },
        ],
        regressionSuite: ['packages/helix/src/shared/mapper.test.ts'],
        locked: false,
      },
      impactAnalysis: {
        directFiles: [
          'packages/helix/src/runtime-consumer.ts',
          'packages/helix/src/shared/mapper.ts',
        ],
        dependentFiles: ['packages/helix/src/runtime-entry.ts'],
        affectedTests: [
          'packages/helix/src/runtime-consumer.test.ts',
          'packages/helix/src/shared/mapper.test.ts',
        ],
        riskLevel: 'medium',
        notes: 'The runtime path must stay aligned with the shared mapper contract.',
      },
      legacyPaths: [
        {
          path: 'packages/helix/src/runtime-inline-mapper.ts',
          reason: 'Can be removed after the runtime consumer converges on the shared mapper',
          removableAfter: 1,
          status: 'identified',
        },
      ],
    });
    const cleanupSlice = createSlice(2, {
      title: 'Remove legacy inline mapper',
      description: 'Delete the superseded inline runtime mapper after callers converge.',
      findings: [],
      dependencies: [1],
    });
    session.slices = [foundationSlice, targetSlice, cleanupSlice];
    session.totalSlices = session.slices.length;

    const checklist: SliceChecklist = {
      items: [
        {
          id: 'criterion-typecheck',
          label: 'Scoped typecheck passes',
          category: 'verification',
          status: 'pending',
        },
        {
          id: 'criterion-tests',
          label: 'Required runtime regression stays green',
          category: 'test-lock',
          status: 'pending',
          detail: 'runtime-consumer.test.ts and shared/mapper.test.ts',
        },
      ],
    };
    const stage: StageDefinition = {
      name: 'Implementation',
      type: 'implementation',
      description: 'Implement the slice',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildSlicePrompt(stage, session, targetSlice, checklist, '', 1);

    expect(prompt).toContain('## SLICE ISSUE BRIEF');
    expect(prompt).toContain('- Slice: 2/3 — Move runtime consumer onto shared mapper');
    expect(prompt).toContain('- Work item type: feature-audit');
    expect(prompt).toContain('- Finding IDs: finding-runtime-consumer');
    expect(prompt).toContain('- Depends on: Slice 1');
    expect(prompt).toContain('- Unlocks: Slice 3');
    expect(prompt).toContain(
      '- Source of truth: this issue brief is authoritative for scope, contracts, tests, and definition of done',
    );
    expect(prompt).toContain('### Efficiency Budget');
    expect(prompt).toContain('- Target total turns:');
    expect(prompt).toContain('- Exploration budget:');
    expect(prompt).toContain('Complexity drivers: 2 direct file contract(s), 1 dependent file(s)');
    expect(prompt).toContain('### Implementation Contract');
    expect(prompt).toContain('#### Expected Direct Edits');
    expect(prompt).toContain('packages/helix/src/runtime-consumer.ts');
    expect(prompt).toContain('#### Manifest Completeness Preflight');
    expect(prompt).toContain('runtime-entry.test.ts');
    expect(prompt).toContain('#### Export and Consumer Wiring');
    expect(prompt).toContain('### Proof and Regression Coverage');
    expect(prompt).toContain('#### Regression Suite That Must Stay Green');
    expect(prompt).toContain('packages/helix/src/shared/mapper.test.ts');
    expect(prompt).toContain('### Impact Watchlist');
    expect(prompt).toContain('packages/helix/src/runtime-entry.ts');
    expect(prompt).toContain('### Definition of Done');
    expect(prompt).toContain('### Legacy Cleanup Already Identified');
    expect(prompt).toContain('### Execution Notes');
    expect(prompt).toContain('Use this issue brief as the source of truth for the slice.');
    expect(prompt).toContain('Do not search `.helix/sessions`, `session.json`, or `progress.log`');
    expect(prompt).toContain(
      'Treat the preloaded Verification Commands above as the authoritative minimal proof set.',
    );
    expect(prompt).toContain(
      'Do not edit `AGENTS.md`, `CLAUDE.md`, `docs/sdlc-logs`, `next-env.d.ts`, or other generated/tool-owned files',
    );
    expect(prompt).toContain(
      'Once the build/typecheck, formatting, and required test commands are green, stop and hand control back immediately',
    );
    expect(prompt).toContain('Use the efficiency budget above to avoid wandering');
  });

  it('appends a prebuilt slice context packet into implementation prompts', () => {
    const session = createSession([
      {
        id: 'finding-context-packet',
        title: 'Context packet coverage',
        description: 'Ensure packet sections are preserved in the final prompt.',
      },
    ]);
    const slice = createSlice(0, {
      title: 'Use prebuilt packet',
      description: 'Inject the prebuilt slice context packet into the prompt.',
      findings: ['finding-context-packet'],
    });
    session.slices = [slice];
    session.totalSlices = 1;
    const checklist: SliceChecklist = {
      items: [],
    };
    const stage: StageDefinition = {
      name: 'Implementation',
      type: 'implementation',
      description: 'Implement the slice',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildSlicePrompt(
      stage,
      session,
      slice,
      checklist,
      '',
      1,
      [
        '## SLICE CONTEXT PACKET',
        '### Direct Files (full source)',
        '```ts',
        'export const x = 1;',
        '```',
      ].join('\n'),
    );

    expect(prompt).toContain('## SLICE CONTEXT PACKET');
    expect(prompt).toContain('### Direct Files (full source)');
    expect(prompt).toContain('export const x = 1;');
    expect(prompt.indexOf('## SLICE CONTEXT PACKET')).toBeLessThan(
      prompt.indexOf('### Execution Notes'),
    );
  });

  it('promotes required test repair context to the top-priority recovery section', () => {
    const session = createSession([]);
    const slice = createSlice(0);
    session.slices = [slice];
    session.totalSlices = 1;
    const checklist: SliceChecklist = {
      items: [],
    };
    const stage: StageDefinition = {
      name: 'Implementation',
      type: 'implementation',
      description: 'Implement the slice',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildSlicePrompt(
      stage,
      session,
      slice,
      checklist,
      [
        'REQUIRED TEST REPAIR REQUIRED',
        'Fix the failing API-route regression from the current diff.',
        '',
        '## Required Test Failure Evidence',
        'Error: Failed to resolve import "@agent-platform/shared/validation"',
      ].join('\n'),
      2,
    );

    expect(prompt).toContain('## TOP PRIORITY RECOVERY MODE');
    expect(prompt).toContain('REQUIRED TEST REPAIR REQUIRED');
    expect(prompt).toContain('Failed to resolve import "@agent-platform/shared/validation"');
  });

  it('adds replay-specific implementation startup guardrails for historical slices', () => {
    const session = createSession([
      {
        id: 'finding-replay-slice',
        title: 'Historical replay slice should stay on the seam',
        description:
          'Codex should start from the slice packet instead of rediscovering package docs.',
      },
    ]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/repos/project-member-repo.ts',
      ],
      avoidPaths: ['apps/studio/src/lib/project-access.ts'],
      historicalFileHints: {
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts': [
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        ],
        'apps/studio/src/repos/project-member-repo.ts': ['apps/studio/src/repos/project-repo.ts'],
      },
      tags: ['service-extraction', 'rbac', 'project-members'],
    };
    const slice = createSlice(0, {
      title: 'Extract project-member repository',
      description: 'Create the dedicated repository seam for project members.',
      findings: ['finding-replay-slice'],
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
            action: 'create',
            reason: 'Canonical replay target route',
            expectedExports: ['GET', 'PATCH', 'DELETE'],
            dependents: [],
          },
          {
            path: 'apps/studio/src/repos/project-member-repo.ts',
            action: 'create',
            reason: 'Extract dedicated member repository',
            expectedExports: ['findProjectMember'],
            dependents: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
          },
        ],
        exportContracts: [],
        completeness: {
          summary: 'Manifest complete',
          hints: [],
        },
      },
    });
    session.slices = [slice];
    session.totalSlices = 1;
    const checklist: SliceChecklist = { items: [] };
    const stage: StageDefinition = {
      name: 'Implementation',
      type: 'implementation',
      description: 'Implement the slice',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildSlicePrompt(stage, session, slice, checklist, '', 1);

    expect(prompt).toContain('### Replay Startup Guardrails');
    expect(prompt).toContain('Do not start by reading `AGENTS.md`, `agents.md`, `CLAUDE.md`');
    expect(prompt).toContain('Future target files may be missing at the replay base commit');
    expect(prompt).toContain('apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts');
    expect(prompt).toContain('apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts');
    expect(prompt).toContain('Historical seam substitutes are already known');
    expect(prompt).toContain('apps/studio/src/repos/project-repo.ts');
    expect(prompt).toContain('Replay-specific out-of-bounds paths for this slice');
    expect(prompt).toContain('apps/studio/src/lib/project-access.ts');
    expect(prompt).toContain(
      'begin writing the replacement immediately instead of searching for more consumers',
    );
  });

  it('carries forward approved slices and hides deferred findings in plan-generation retries', () => {
    const session = createSession([
      {
        id: 'finding-foundation',
        title: 'Shared seam needs stabilization',
        description: 'The shared parser boundary is brittle.',
        files: ['packages/helix/src/parser.ts'],
      },
      {
        id: 'finding-callers',
        title: 'Consumers patch around the seam',
        description: 'Downstream callers reimplement fallback logic.',
        files: ['packages/helix/src/caller.ts'],
      },
      {
        id: 'finding-cleanup',
        title: 'Legacy helper duplication',
        description: 'A duplicate helper can move to backlog.',
        files: ['packages/helix/src/legacy-helper.ts'],
      },
    ]);
    session.planReviewState = {
      summary: 'Keep slice 1, revise slice 2, backlog the legacy helper cleanup.',
      approvedSlices: [
        {
          sliceNumber: 1,
          slice: {
            title: 'Stabilize parser seam',
            description: 'Fix the shared parser boundary first.',
            findings: ['finding-foundation'],
            files: ['packages/helix/src/parser.ts'],
            tests: ['packages/helix/src/parser.test.ts'],
            dependencies: [],
            legacyPaths: [],
          },
        },
      ],
      slicesToRevise: [
        {
          sliceNumber: 2,
          title: 'Update parser callers',
          rationale: 'Add stronger caller-path regression coverage before approval.',
          requiredTestAmendments: [
            'packages/helix/src/caller.test.ts - prove the shared seam is used',
          ],
        },
      ],
      deferredFindings: [
        {
          findingId: 'finding-cleanup',
          reason: 'Safe to backlog after the parser seam lands.',
        },
      ],
      blockingFindings: [
        {
          disposition: 'blocking',
          severity: 'high',
          category: 'missing-test',
          title: 'Caller slice needs stronger regression coverage',
          description: 'Add the caller-path regression before approval.',
          files: ['packages/helix/src/caller.test.ts'],
        },
      ],
      advisoryFindings: [],
      carriedForwardAt: '2026-04-05T00:00:00.000Z',
    };
    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(
      stage,
      session,
      `QUALITY GATE FAILED:
Revise slice 2 only.

PREVIOUS OUTPUT:
${'stale slice body that should not be reread\n'.repeat(120)}`,
      2,
    );
    const openRegistrySection =
      prompt
        .split('## Complete Open Findings Registry')[1]
        ?.split('## Follow-up Findings (Not For This Pass)')[0] ?? '';

    expect(prompt).toContain('## Carry-Forward From Prior Review');
    expect(prompt).toContain('## Targeted Plan Revision Mode');
    expect(prompt).toContain('Approved slices to keep stable: 1');
    expect(prompt).toContain('Slices that actually need revision: 2');
    expect(prompt).toContain('Slice 1: Stabilize parser seam');
    expect(prompt).toContain('Slices that still need revision before the plan can pass');
    expect(prompt).toContain('finding-cleanup');
    expect(prompt).toContain('1 immediate/next to plan now');
    expect(prompt).toContain('1 proposed for backlog');
    expect(openRegistrySection).not.toContain('"id": "finding-foundation"');
    expect(openRegistrySection).not.toContain('"id": "finding-cleanup"');
    expect(openRegistrySection).toContain('"id": "finding-callers"');
    expect(prompt).toContain('still output the FULL plan, including the unchanged approved slices');
    expect(prompt).toContain(
      '[prior rejected plan body omitted; use Carry-Forward From Prior Review above as the authoritative prior plan state]',
    );
    expect(prompt).not.toContain('stale slice body that should not be reread');
  });

  it('renders approved carry-forward slices beyond the previous eight-slice cap', () => {
    const session = createSession([
      {
        id: 'finding-remaining',
        title: 'One slice still needs revision',
        description: 'Keep the approved slices intact.',
        files: ['packages/helix/src/revision.ts'],
      },
    ]);
    session.planReviewState = {
      summary: 'Preserve the approved plan and revise only the final slice.',
      approvedSlices: Array.from({ length: 11 }, (_, index) => ({
        sliceNumber: index + 1,
        slice: {
          title: `Approved slice ${index + 1}`,
          description: `Carry forward approved slice ${index + 1} without reconstructing it from session artifacts.`,
          findings: [`finding-approved-${index + 1}`],
          files: [`packages/helix/src/slice-${index + 1}.ts`],
          tests: [`packages/helix/src/slice-${index + 1}.test.ts`],
          dependencies: index === 0 ? [] : [index],
          legacyPaths: [],
        },
      })),
      slicesToRevise: [
        {
          sliceNumber: 12,
          title: 'Revised slice',
          rationale: 'Strengthen the last regression only.',
          requiredTestAmendments: ['packages/helix/src/revision.test.ts - cover final path'],
        },
      ],
      deferredFindings: [],
      blockingFindings: [],
      advisoryFindings: [],
      carriedForwardAt: '2026-04-05T00:00:00.000Z',
    };
    const stage: StageDefinition = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Create a sliced implementation plan',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'slice-plan' },
      canLoop: true,
      maxLoopIterations: 3,
    };

    const prompt = buildStagePrompt(
      stage,
      session,
      'QUALITY GATE FAILED:\nRevise slice 12 only.',
      2,
    );

    expect(prompt).toContain('## Targeted Plan Revision Mode');
    expect(prompt).toContain('Approved slices to keep stable: 1, 2, 3');
    expect(prompt).toContain('Slices that actually need revision: 12');
    expect(prompt).toContain('Slice 1: Approved slice 1');
    expect(prompt).toContain('Slice 8: Approved slice 8');
    expect(prompt).toContain('Slice 11: Approved slice 11');
    expect(prompt).toContain('Keep each finding ID attached to a single owning slice');
  });

  it('renders deferred bulk review queue details into bulk-review prompts', () => {
    const session = createSession([
      {
        id: 'finding-queue',
        title: 'Shared seam risk',
        description: 'Queued for deferred review',
      },
    ]);
    const queuedSlice: Slice = {
      index: 0,
      title: 'Stabilize parser seam',
      description: 'Auto-committed low-risk parser cleanup',
      status: 'committed',
      findings: ['finding-queue'],
      dependencies: [],
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'packages/helix/src/parser.ts',
            action: 'modify',
            reason: 'Stabilize parser seam',
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'packages/helix/src/parser.test.ts',
            description: 'Parser regression',
            status: 'passing',
            coversFindings: ['finding-queue'],
            isNew: false,
          },
        ],
        regressionSuite: [],
        locked: true,
      },
      impactAnalysis: {
        directFiles: ['packages/helix/src/parser.ts'],
        dependentFiles: [],
        affectedTests: ['packages/helix/src/parser.test.ts'],
        riskLevel: 'low',
        notes: 'Small parser seam cleanup.',
      },
      legacyPaths: [],
      exitCriteria: [],
      commit: {
        sha: '1234567890abcdef',
        message: '[ABLP-200] fix(helix): Stabilize parser seam',
        jiraKey: 'ABLP-200',
        sliceIndex: 0,
        files: ['packages/helix/src/parser.ts'],
        timestamp: '2026-04-01T00:00:00.000Z',
      },
      autonomy: {
        disposition: 'deferred-bulk-review',
        riskLevel: 'low',
        riskScore: 2,
        reasons: ['Manifest impact risk is low (1 direct file(s), 0 dependent file(s))'],
        confidenceLevel: 'medium',
        confidenceScore: 6,
        confidenceReasons: [
          '1 required regression test(s) are declared for this slice',
          'Required tests are passing and the slice can engage the test lock',
        ],
        matchedTrustProfiles: [],
        bulkReviewStatus: 'queued',
        assessedAt: '2026-04-01T00:00:00.000Z',
      },
    };
    session.slices = [queuedSlice];
    session.totalSlices = 1;
    session.commits = [queuedSlice.commit!];

    const stage: StageDefinition = {
      name: 'Deferred Bulk Review',
      type: 'bulk-review',
      description: 'Review auto-committed slices together',
      model: { primary: { engine: 'claude-code' } },
      outputSchema: { id: 'analysis-report', strict: true },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('Deferred Review Queue');
    expect(prompt).toContain('Slice 1: Stabilize parser seam');
    expect(prompt).toContain('Confidence: medium');
    expect(prompt).toContain('1234567 [ABLP-200] fix(helix): Stabilize parser seam');
    expect(prompt).toContain('Why it was auto-committed');
  });

  it('adds hard-boundary guidance for narrow file-scoped deep scans', () => {
    const session = createSession(
      [],
      [
        'apps/studio/src/lib/arch-ai/processors/process-message.ts',
        'apps/admin/src/app/api/health/route.ts',
      ],
    );
    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Deep read of the feature codebase',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Scope Discipline');
    expect(prompt).toContain('This is a narrow file-scoped audit.');
    expect(prompt).toContain('Do NOT read whole packages, unrelated dashboard pages');
    expect(prompt).toContain('Treat the declared scope as the default audit boundary');
  });

  it('adds seam-focused stop policy guidance for root cause analysis', () => {
    const session = createSession(
      [],
      ['apps/studio/src/components/auth/UserMenu.tsx', 'packages/i18n/locales/en/studio.json'],
    );
    const stage: StageDefinition = {
      name: 'Root Cause Analysis',
      type: 'root-cause',
      description: 'Trace from symptom to root cause',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Root Cause Efficiency Budget');
    expect(prompt).toContain('## Root Cause Stop Policy');
    expect(prompt).toContain(
      'Do not read `AGENTS.md`, `agents.md`, journals, `~/.claude` tool-result files',
    );
    expect(prompt).toContain('Stay inside the confirmed seam unless a read file directly points');
  });

  it('adds a scoped efficiency budget and stop policy for reproduce stages', () => {
    const session = createSession(
      [],
      ['apps/studio/src/components/auth/UserMenu.tsx', 'packages/i18n/locales/en/studio.json'],
    );
    const stage: StageDefinition = {
      name: 'Reproduce',
      type: 'reproduce',
      description: 'Write a failing reproduction artifact',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'reproduction-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Reproduce Efficiency Budget');
    expect(prompt).toContain('## Reproduce Stop Policy');
    expect(prompt).toContain('Do not edit `AGENTS.md`, `agents.md`, `CLAUDE.md`, journals');
    expect(prompt).toContain('Target total turns');
  });

  it('renders adaptive code-map context for large deep scans', () => {
    const session = createSession([], ['packages/helix/src']);
    session.promptContext = {
      builtAt: '2026-04-05T00:00:00.000Z',
      instructionDocs: [],
      codeMap: {
        scope: ['packages/helix/src'],
        totalSourceFiles: 220,
        totalTestFiles: 14,
        keyFiles: [
          {
            path: 'packages/helix/src/pipeline/stage-runner.ts',
            exports: ['buildStagePrompt'],
            dependents: ['packages/helix/src/pipeline/pipeline-engine.ts'],
            isTestFile: false,
            lineCount: 210,
          },
        ],
        allFiles: [
          ...Array.from(
            { length: 150 },
            (_, index) => `packages/helix/src/pipeline/file-${index + 1}.ts`,
          ),
          ...Array.from(
            { length: 70 },
            (_, index) => `packages/helix/src/models/file-${index + 1}.ts`,
          ),
        ],
      },
    };

    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Deep read of the feature codebase',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('### Directory Summary');
    expect(prompt).toContain('Complete file tree omitted for prompt size (234 scoped files).');
    expect(prompt).not.toContain('### Complete File Tree');
    expect(prompt).not.toContain('packages/helix/src/models/file-70.ts');
  });

  it('raises shell exploration floors for broader replay bug-fix tasks', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.workItem.type = 'bug-fix';
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        'apps/studio/src/__tests__/project-member-service.test.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-member-repo.ts',
        'apps/studio/src/repos/project-repo.ts',
        'apps/studio/src/services/project-member-service.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['rbac', 'service-extraction'],
    };

    const budget = estimateRootCauseEfficiencyBudget(session);

    expect(budget.shellWarnFloor).toBeGreaterThanOrEqual(12);
    expect(budget.shellAbortFloor).toBeGreaterThanOrEqual(18);
  });

  it('applies a replay-aware efficiency budget to broader deep scans', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.workItem.type = 'feature-audit';
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        'apps/studio/src/__tests__/project-member-service.test.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-member-repo.ts',
        'apps/studio/src/repos/project-repo.ts',
        'apps/studio/src/services/project-member-service.ts',
        'apps/studio/src/services/audit-service.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
      ],
      historicalFileHints: {
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts': [
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
          'apps/studio/src/app/api/projects/[id]/members/route.ts',
        ],
        'apps/studio/src/services/project-member-service.ts': [
          'apps/studio/src/repos/project-repo.ts',
          'apps/studio/src/services/audit-service.ts',
        ],
      },
      tags: ['rbac', 'service-extraction'],
    };

    const budget = estimateDeepScanEfficiencyBudget(session);

    expect(budget.targetTurns).toBeGreaterThanOrEqual(12);
    expect(budget.explorationTurns).toBeLessThan(budget.targetTurns);
    expect(budget.shellWarnFloor).toBeGreaterThanOrEqual(12);
    expect(budget.shellAbortFloor).toBeGreaterThanOrEqual(20);
    expect(budget.zeroTurnShellAbortFloor).toBe(11);
    expect(budget.zeroTurnElapsedAbortMs).toBe(30_000);
    expect(budget.shellAbortFloor).toBeGreaterThan(budget.targetTurns ?? 0);
    expect(budget.abortExploratoryToolUseAfterTargetTurns).toBe(true);
    expect(budget.abortScopedShellInspectionAfterLimit).toBe(true);
    expect(budget.abortScopedToolInspectionAfterLimit).toBe(true);
    expect(budget.scopedShellInspectionCountLimit).toBeGreaterThanOrEqual(8);
    expect(budget.scopedToolInspectionCountLimit).toBe(2);
    expect(budget.forbiddenShellPatterns).toEqual(
      expect.arrayContaining([
        '^ls(?:\\s|$)',
        '^find(?:\\s|$)',
        '^fd(?:\\s|$)',
        '^rg\\s+--files\\b',
      ]),
    );
  });

  it('applies a replay-aware efficiency budget to broader planning stages', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.workItem.type = 'feature-audit';
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        'apps/studio/src/__tests__/project-member-service.test.ts',
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-member-repo.ts',
        'apps/studio/src/repos/project-repo.ts',
        'apps/studio/src/services/project-member-service.ts',
        'apps/studio/src/services/audit-service.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
      ],
      tags: ['rbac', 'service-extraction'],
    };

    const budget = estimatePlanningEfficiencyBudget(session);

    expect(budget.abortExploratoryToolUseAfterTargetTurns).toBe(true);
    expect(budget.scopedShellInspectionCountLimit).toBeGreaterThanOrEqual(3);
    expect(budget.forbiddenShellPatterns).toEqual(
      expect.arrayContaining([
        '^ls(?:\\s|$)',
        '^find(?:\\s|$)',
        '^fd(?:\\s|$)',
        '^git\\s+ls-files\\b',
        '^rg\\s+--files\\b',
      ]),
    );
  });

  it('adds replay seam guidance for deep scans with historical changed files', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.workspaceContext = {
      mode: 'git-worktree',
      sourceWorkDir: '/Users/prasannaarikala/projects/agent-platform',
      worktreeDir:
        '/Users/prasannaarikala/projects/agent-platform-replay-ablp-327-project-member-rbac-service-working',
    };
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/services/project-member-service.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      historicalFileHints: {
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts': [
          'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        ],
        'apps/studio/src/services/project-member-service.ts': [
          'apps/studio/src/repos/project-repo.ts',
        ],
      },
      avoidPaths: ['apps/studio/src/components/settings/ProjectMembersTab.tsx'],
      tags: ['rbac', 'service-extraction'],
    };
    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Deep read of the feature codebase',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Replay Seam Guidance');
    expect(prompt).toContain('### Historical Replay Substitutions');
    expect(prompt).toContain(
      'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts -> apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
    );
    expect(prompt).toContain(
      'Some historical target files may not exist yet at the replay base commit.',
    );
    expect(prompt).toContain(
      'When a missing future target has an explicit historical substitution above, prefer those substitute files',
    );
    expect(prompt).toContain(
      'do not re-check that absence with `rg`, `grep`, or any other pattern search',
    );
    expect(prompt).toContain(
      'Do not treat a missing historical target file as a reason to fan out into unrelated runtime, UI, or workspace flows.',
    );
    expect(prompt).toContain(
      'Do not inspect settings pages, workspace-member routes, shared auth packages, or UI consumers',
    );
    expect(prompt).toContain(
      'do not use directory inventory commands such as `ls`, `find`, `fd`, or `rg --files`',
    );
    expect(prompt).toContain(
      'Current replay execution workspace: /Users/prasannaarikala/projects/agent-platform-replay-ablp-327-project-member-rbac-service-working.',
    );
    expect(prompt).toContain(
      'If you encounter source-checkout paths, treat them as reference-only and continue in the replay worktree.',
    );
    expect(prompt).toContain('apps/studio/src/services/project-member-service.ts');
    expect(prompt).toContain('Replay-specific out-of-bounds paths for this historical seam');
    expect(prompt).toContain('apps/studio/src/components/settings/ProjectMembersTab.tsx');
  });

  it('tightens replay implementation budgets around direct slice contracts', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/repos/project-member-repo.ts',
        'apps/studio/src/services/project-member-service.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      avoidPaths: [
        'apps/studio/src/lib/project-access.ts',
        'apps/studio/src/services/project-service.ts',
      ],
      tags: ['rbac', 'service-extraction'],
    };

    const slice = createSlice(0, {
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'apps/studio/src/repos/project-member-repo.ts',
            action: 'create',
            reason: 'Extract tenant-scoped project-member repo',
            dependents: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
          },
          {
            path: 'apps/studio/src/repos/project-repo.ts',
            action: 'modify',
            reason: 'Retain compatibility exports',
            dependents: [],
          },
          {
            path: 'packages/database/src/models/project-member.model.ts',
            action: 'modify',
            reason: 'Align tenant-aware membership schema usage',
            dependents: [],
          },
          {
            path: 'packages/database/src/models/role-definition.model.ts',
            action: 'modify',
            reason: 'Preserve custom-role validation contract',
            dependents: [],
          },
          {
            path: 'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
            action: 'modify',
            reason: 'Keep route proof green',
            dependents: [],
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
            description: 'Project member behavior stays green',
            status: 'pending',
            coversFindings: [],
            isNew: false,
          },
        ],
        regressionSuite: [],
        locked: false,
      },
      impactAnalysis: {
        directFiles: [
          'apps/studio/src/repos/project-member-repo.ts',
          'apps/studio/src/repos/project-repo.ts',
        ],
        dependentFiles: ['apps/studio/src/app/api/projects/[id]/members/route.ts'],
        affectedTests: ['apps/studio/src/__tests__/api-routes/api-project-members.test.ts'],
        riskLevel: 'medium',
        notes: 'Historical replay of the project-member extraction seam.',
      },
    });

    const budget = estimateSliceEfficiencyBudget(slice, session);

    expect(budget.explorationTurns).toBeLessThanOrEqual(3);
    expect(budget.abortExploratoryToolUseAfterTargetTurns).toBe(true);
    expect(budget.allowScopedShellInspection).toBe(true);
    expect(budget.shellWarnFloor).toBeGreaterThanOrEqual(8);
    expect(budget.shellAbortFloor).toBeGreaterThanOrEqual(12);
    expect(budget.scopedShellInspectionCountLimit).toBeGreaterThanOrEqual(10);
    expect(budget.forbiddenShellPatterns).toEqual(
      expect.arrayContaining([
        '^ls(?:\\s|$)',
        '^find(?:\\s|$)',
        '^fd(?:\\s|$)',
        '^git\\s+ls-files\\b',
        '^rg\\s+--files\\b',
        'apps/studio/src/lib/project-access\\.ts',
        'apps/studio/src/services/project-service\\.ts',
      ]),
    );
  });

  it('adds replay stabilization targets for tagged broader deep scans', () => {
    const session = createSession([]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-repo.ts',
      ],
      tags: ['service-extraction', 'rbac', 'route-migration', 'model-contract'],
    };
    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Audit replay seam',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('bias findings toward these stabilization targets');
    expect(prompt).toContain('dedicated service/repository seam');
    expect(prompt).toContain('custom-role validation');
    expect(prompt).toContain('userId -> memberId');
    expect(prompt).toContain('database model and repository contract');
    expect(prompt).toContain(
      'treat the following stabilization targets as sufficient stopping points',
    );
  });

  it('adds a replay stop policy for deep scans with historical changed files', () => {
    const session = createSession([], ['apps/studio', 'packages/database']);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/studio/src/services/project-member-service.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['rbac', 'service-extraction'],
    };
    const stage: StageDefinition = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Deep read of the feature codebase',
      model: { primary: { engine: 'codex-cli' } },
      outputSchema: { id: 'analysis-report' },
      canLoop: false,
      maxLoopIterations: 1,
    };

    const prompt = buildStagePrompt(stage, session, '', 1);

    expect(prompt).toContain('## Deep Scan Replay Stop Policy');
    expect(prompt).toContain('the primary route or handler seam');
    expect(prompt).toContain('Do not sample unrelated tests just because they mention');
    expect(prompt).toContain(
      'Generic wrappers such as `route-handler`, `api-response`, and similar framework helpers are confirmation-only in replay mode.',
    );
  });
});

function createSession(
  findings: Array<
    Pick<Finding, 'id' | 'title' | 'description'> & {
      files?: string[];
      severity?: Finding['severity'];
      horizon?: Finding['horizon'];
    }
  >,
  scope: string[] = ['packages/helix'],
): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title: 'HELIX stage runner tests',
      description: 'Test session',
      scope,
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
      status: 'open',
      horizon: finding.horizon,
      files: (finding.files ?? []).map((path) => ({ path })),
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

function createFinding(
  overrides: Partial<Session['findings'][number]> = {},
): Session['findings'][number] {
  const timestamp = '2026-04-01T00:00:00.000Z';
  const normalizedFiles = Array.isArray(overrides.files)
    ? overrides.files.map((file) =>
        typeof file === 'string' ? { path: file } : { path: file.path },
      )
    : undefined;
  return {
    id: 'finding-default',
    category: 'inconsistency',
    severity: 'high',
    status: 'open',
    title: 'Default finding',
    description: 'Default description',
    files: [{ path: 'src/feature.ts' }],
    discoveredBy: 'Deep Scan',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
    ...(normalizedFiles ? { files: normalizedFiles } : {}),
  };
}

function createSlice(index: number, overrides: Partial<Slice> = {}): Slice {
  return {
    index,
    title: overrides.title ?? `Slice ${index + 1}`,
    description: overrides.description ?? `Default description for slice ${index + 1}`,
    status: overrides.status ?? 'pending',
    findings: overrides.findings ?? [],
    dependencies: overrides.dependencies ?? [],
    manifest: overrides.manifest ?? {
      entryConditions: [],
      fileContracts: [],
      exportContracts: [],
    },
    testLock: overrides.testLock ?? {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: overrides.impactAnalysis ?? {
      directFiles: [],
      dependentFiles: [],
      affectedTests: [],
      riskLevel: 'low',
      notes: '',
    },
    legacyPaths: overrides.legacyPaths ?? [],
    exitCriteria: overrides.exitCriteria ?? [],
    commit: overrides.commit,
    review: overrides.review,
    autonomy: overrides.autonomy,
    implementationCheckpoint: overrides.implementationCheckpoint,
    verificationCheckpoint: overrides.verificationCheckpoint,
  };
}
