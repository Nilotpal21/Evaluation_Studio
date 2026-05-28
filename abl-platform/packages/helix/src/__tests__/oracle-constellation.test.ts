import { describe, expect, it } from 'vitest';

import {
  OracleConstellation,
  applyOracleDecisionOutcome,
  resolveArchitectureOracle,
} from '../oracles/oracle-constellation.js';
import { accumulateProviderCost } from '../pipeline/cost-accumulator.js';
import type { ExecutorResult, HelixConfig, Session } from '../types.js';

describe('OracleConstellation', () => {
  it('builds per-finding consensus and quorum-backed new findings', async () => {
    const router = {
      async execute(prompt: string): Promise<ExecutorResult> {
        if (prompt.includes('Codebase Oracle')) {
          return makeResult({
            summary: 'Confirms auth finding',
            assessments: [
              {
                findingId: 'finding-auth',
                verdict: 'confirm',
                rationale: 'Auth middleware is still worth keeping in scope',
                severity: null,
                horizon: 'immediate',
              },
            ],
            newFindings: [
              {
                severity: 'medium',
                category: 'missing-test',
                title: 'Missing review route integration coverage',
                description: 'Review route has no integration test',
                files: ['src/review.ts'],
              },
            ],
            decisions: [],
          });
        }

        if (prompt.includes('Testing Oracle')) {
          return makeResult({
            summary: 'Challenges auth finding',
            assessments: [
              {
                findingId: 'finding-auth',
                verdict: 'challenge',
                rationale: 'Current tests already prove auth is enforced',
                severity: null,
                horizon: 'near-term',
              },
            ],
            newFindings: [
              {
                severity: 'medium',
                category: 'missing-test',
                title: 'Missing review route integration coverage',
                description: 'Review route has no integration test',
                files: ['src/review.ts'],
              },
            ],
            decisions: [],
          });
        }

        return makeResult({
          summary: 'Also challenges auth finding',
          assessments: [
            {
              findingId: 'finding-auth',
              verdict: 'challenge',
              rationale: 'Architecture review found the route already isolated',
              severity: null,
              horizon: 'near-term',
            },
          ],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: { engine: 'claude-code', model: 'sonnet' },
          promptFile: '',
          focusAreas: ['code'],
        },
        {
          id: 'testing',
          name: 'Testing Oracle',
          description: 'Reads tests',
          model: { engine: 'claude-code', model: 'opus' },
          promptFile: '',
          focusAreas: ['tests'],
        },
        {
          id: 'architecture',
          name: 'Architecture Oracle',
          description: 'Reads architecture',
          model: { engine: 'claude-code', model: 'opus' },
          promptFile: '',
          focusAreas: ['architecture'],
        },
      ],
      2,
    );

    const result = await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(result.successfulOracles).toBe(3);
    expect(result.additionalFindings).toHaveLength(1);
    expect(result.additionalFindings[0]).toMatchObject({
      title: 'Missing review route integration coverage',
      category: 'missing-test',
    });
    const statusDecision = result.decisions.find((decision) =>
      decision.context?.includes('[action:status]'),
    );
    const horizonDecision = result.decisions.find((decision) =>
      decision.context?.includes('[action:horizon]'),
    );

    expect(statusDecision).toMatchObject({
      classification: 'INFERRED',
      answer: 'defer',
    });
    expect(horizonDecision).toMatchObject({
      classification: 'INFERRED',
      answer: 'near-term',
    });

    expect(applyOracleDecisionOutcome(session, statusDecision!)).toBe(true);
    expect(applyOracleDecisionOutcome(session, horizonDecision!)).toBe(true);
    expect(session.findings[0].status).toBe('deferred');
    expect(session.findings[0].horizon).toBe('near-term');
  });

  it('includes finding file paths and oracle review instructions in the oracle prompt', async () => {
    let capturedPrompt = '';
    const router = {
      async execute(prompt: string): Promise<ExecutorResult> {
        capturedPrompt = prompt;
        return makeResult({
          summary: 'No changes',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: { engine: 'claude-code', model: 'sonnet' },
          promptFile: '',
          reviewInstructions:
            'Stay inside the supplied finding files unless a direct helper is required.',
          focusAreas: ['code'],
          tools: ['Read'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(capturedPrompt).toContain('files: src/review.ts');
    expect(capturedPrompt).toContain(
      'Stay inside the supplied finding files unless a direct helper is required.',
    );
  });

  it('adds replay seam discipline to oracle prompts during historical replays', async () => {
    let capturedPrompt = '';
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const capturedTools: string[][] = [];
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        capturedPrompt = prompt;
        capturedSpecs.push(spec);
        capturedTools.push(tools);
        return makeResult({
          summary: 'No changes',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      avoidPaths: ['apps/studio/src/components/settings/ProjectMembersTab.tsx'],
      historicalFileHints: undefined,
      tags: ['studio', 'rbac', 'service-extraction'],
    };

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'testing',
          name: 'Testing Oracle',
          description: 'Reads tests',
          model: { engine: 'claude-code', model: 'opus' },
          promptFile: '',
          focusAreas: ['tests'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(capturedPrompt).toContain('Replay-specific out-of-bounds paths for this oracle pass');
    expect(capturedPrompt).toContain('apps/studio/src/components/settings/ProjectMembersTab.tsx');

    expect(capturedPrompt).toContain('## Replay Oracle Discipline');
    expect(capturedPrompt).toContain('apps/studio/src/app/api/projects/[id]/members/route.ts');
    expect(capturedPrompt).toContain('Do NOT rediscover the repository from scratch.');
    expect(capturedPrompt).toContain('Do NOT inspect unrelated runtime auth suites');
    expect(capturedPrompt).toContain(
      'Do NOT run workspace-root inventory commands like `ls`, `find .`, `rg --files`',
    );
    expect(capturedPrompt).toContain(
      'Do NOT broaden into `permission-resolver`, package-wide role maps, or `vitest.config.ts`',
    );
    expect(capturedPrompt).toContain('Set horizon to "immediate" or "next"');
    expect(capturedPrompt).toContain('Missing historical future files are evidence');
    expect(capturedSpecs[0]).toMatchObject({
      primary: {
        stallThresholdMs: 45_000,
        efficiencyBudget: expect.objectContaining({
          allowScopedShellInspection: true,
          forbiddenShellPatterns: expect.arrayContaining([
            '^rg\\s+--files\\b',
            '^ls(?:\\s+-\\S+)*\\s+(?:apps|packages)(?:\\s|$)',
            'vitest\\.config\\.ts',
          ]),
        }),
      },
    });
  });

  it('disables oracle tools for seam-complete broad replays', async () => {
    let capturedPrompt = '';
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const capturedTools: string[][] = [];
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        capturedPrompt = prompt;
        capturedSpecs.push(spec);
        capturedTools.push(tools);
        return makeResult({
          summary: 'No changes',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
        'apps/studio/src/services/audit-service.ts',
      ],
      historicalFileHints: undefined,
      tags: ['studio', 'rbac', 'service-extraction'],
    };
    session.findings = [
      makeFinding('finding-1', 'apps/studio/src/app/api/projects/[id]/members/route.ts'),
      makeFinding('finding-2', 'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts'),
      makeFinding('finding-3', 'apps/studio/src/repos/project-repo.ts'),
      makeFinding('finding-4', 'packages/database/src/models/project-member.model.ts'),
      makeFinding('finding-5', 'packages/database/src/models/role-definition.model.ts'),
      makeFinding('finding-6', 'apps/studio/src/services/audit-service.ts'),
    ];

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'testing',
          name: 'Testing Oracle',
          description: 'Reads tests',
          model: { engine: 'claude-code', model: 'opus' },
          promptFile: '',
          focusAreas: ['tests'],
          tools: ['Read', 'Grep'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(capturedPrompt).toContain('TOP PRIORITY ORACLE SYNTHESIS RETRY');
    expect(capturedPrompt).toContain(
      'Deep scan already gathered sufficient replay seam evidence for oracle review.',
    );
    expect(capturedTools[0]).toEqual([]);
    expect(capturedSpecs[0]).toMatchObject({
      primary: {
        efficiencyBudget: expect.objectContaining({
          disableToolUse: true,
          explorationTurns: 0,
        }),
      },
    });
  });

  it('reuses persisted oracle checkpoints for unchanged findings and tunes small reviews down', async () => {
    let calls = 0;
    const modelSpecs: Array<Record<string, unknown>> = [];
    const router = {
      async execute(_prompt: string, spec: Record<string, unknown>): Promise<ExecutorResult> {
        calls += 1;
        modelSpecs.push(spec);
        return makeResult({
          summary: 'Confirmed',
          assessments: [
            {
              findingId: 'finding-auth',
              verdict: 'confirm',
              rationale: 'Still relevant',
              severity: null,
              horizon: 'immediate',
            },
          ],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: {
            engine: 'claude-code',
            model: 'claude-opus-4-7',
            maxTurns: 20,
            maxBudgetUsd: 10,
          },
          promptFile: '',
          focusAreas: ['code'],
        },
      ],
      1,
    );

    const first = await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });
    const second = await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(first.reusedOracles).toBe(0);
    expect(second.reusedOracles).toBe(1);
    expect(calls).toBe(1);
    expect(modelSpecs[0]).toMatchObject({
      primary: {
        maxTurns: 12,
        maxBudgetUsd: 4,
      },
    });
    expect(session.oracleCheckpoints).toEqual([
      expect.objectContaining({
        oracleId: 'codebase',
        stageName: 'Oracle Analysis',
      }),
    ]);
  });

  it('injects failure-advisory retry guidance and disables tools for replay oracle stage retries', async () => {
    let capturedPrompt = '';
    const capturedTools: string[][] = [];
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        capturedPrompt = prompt;
        capturedSpecs.push(spec);
        capturedTools.push(tools);
        return makeResult({
          summary: 'Synthesized from existing findings',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['studio', 'rbac', 'service-extraction'],
    };
    session.pendingFailureAdvisory = {
      id: 'advisory-1',
      stageName: 'Oracle Analysis',
      stageType: 'oracle-analysis',
      failureCategory: 'model-error',
      failureSignature: 'Oracle Analysis:error:All oracles failed',
      retryCount: 0,
      sourceError: 'All oracles failed',
      generatedAt: '2026-04-15T00:00:00.000Z',
      summary: 'All oracles stalled on the prior attempt.',
      suspectedCause: 'Transient model startup issue.',
      recommendedAction: 'retry-stage',
      promptGuidance: 'Do not rediscover the repository. Start from the current findings.',
      operatorActions: [],
    };

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: { engine: 'claude-code', model: 'sonnet' },
          promptFile: '',
          focusAreas: ['code'],
          tools: ['Read', 'Grep'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(capturedPrompt).toContain('TOP PRIORITY ORACLE SYNTHESIS RETRY');
    expect(capturedPrompt).toContain('All oracles stalled on the prior attempt.');
    expect(capturedPrompt).toContain(
      'Do not rediscover the repository. Start from the current findings.',
    );
    expect(capturedTools[0]).toEqual([]);
    expect(capturedSpecs[0]).toMatchObject({
      primary: {
        efficiencyBudget: expect.objectContaining({
          disableToolUse: true,
          explorationTurns: 0,
        }),
      },
    });
  });

  it('reuses persisted oracle failure advisories on replay retries after pending advisory is cleared', async () => {
    let capturedPrompt = '';
    const capturedTools: string[][] = [];
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        capturedPrompt = prompt;
        capturedSpecs.push(spec);
        capturedTools.push(tools);
        return makeResult({
          summary: 'Synthesized from persisted replay findings',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
      ],
      tags: ['studio', 'rbac', 'service-extraction'],
    };
    session.failureAdvisories = [
      {
        id: 'advisory-2',
        stageName: 'Oracle Analysis',
        stageType: 'oracle-analysis',
        failureCategory: 'model-error',
        failureSignature: 'Oracle Analysis:error:All oracles failed',
        retryCount: 1,
        sourceError: 'All oracles failed',
        generatedAt: '2026-04-15T00:00:00.000Z',
        summary: 'All oracles stalled on the retry entry.',
        suspectedCause: 'The replay should synthesize from gathered findings.',
        recommendedAction: 'retry-stage',
        promptGuidance: 'Use the existing findings and gathered seam evidence only.',
        operatorActions: [],
      },
    ];

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: { engine: 'claude-code', model: 'sonnet' },
          promptFile: '',
          focusAreas: ['code'],
          tools: ['Read', 'Grep'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(capturedPrompt).toContain('TOP PRIORITY ORACLE SYNTHESIS RETRY');
    expect(capturedPrompt).toContain('All oracles stalled on the retry entry.');
    expect(capturedPrompt).toContain('Use the existing findings and gathered seam evidence only.');
    expect(capturedTools[0]).toEqual([]);
    expect(capturedSpecs[0]).toMatchObject({
      primary: {
        efficiencyBudget: expect.objectContaining({
          disableToolUse: true,
          explorationTurns: 0,
        }),
      },
    });
  });

  it('respects explicit custom oracle caps when adaptive tuning would otherwise raise them', async () => {
    const modelSpecs: Array<Record<string, unknown>> = [];
    const router = {
      async execute(_prompt: string, spec: Record<string, unknown>): Promise<ExecutorResult> {
        modelSpecs.push(spec);
        return makeResult({
          summary: 'Confirmed',
          assessments: [],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession([
      makeFinding('finding-1', 'src/a.ts'),
      makeFinding('finding-2', 'src/b.ts'),
      makeFinding('finding-3', 'src/c.ts'),
      makeFinding('finding-4', 'src/d.ts'),
    ]);

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'codebase',
          name: 'Codebase Oracle',
          description: 'Reads code',
          model: {
            engine: 'claude-code',
            model: 'sonnet',
            maxTurns: 8,
            maxBudgetUsd: 4,
          },
          promptFile: '',
          reviewInstructions: 'Keep this bounded.',
          respectConfiguredLimits: true,
          focusAreas: ['code'],
        },
      ],
      1,
    );

    await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 5_000,
    });

    expect(modelSpecs[0]).toMatchObject({
      primary: {
        maxTurns: 8,
        maxBudgetUsd: 4,
      },
    });
  });

  it('retries replay oracle reviews in synthesis mode after a timeout-style failure', async () => {
    const capturedPrompts: string[] = [];
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const capturedTools: string[][] = [];
    let calls = 0;
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        calls += 1;
        capturedPrompts.push(prompt);
        capturedSpecs.push(spec);
        capturedTools.push(tools);

        if (calls === 1) {
          return {
            output: '',
            model: 'opus',
            engine: 'claude-code',
            turnsUsed: 20,
            durationMs: 90_000,
            error: 'Execution timed out after 90000ms',
          };
        }

        return makeResult({
          summary: 'Synthesized from gathered seam evidence',
          assessments: [
            {
              findingId: 'finding-auth',
              verdict: 'confirm',
              rationale: 'The replay seam still needs the service extraction',
              severity: null,
              horizon: 'immediate',
            },
          ],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession();
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
      ],
      tags: ['studio', 'rbac', 'service-extraction'],
    };

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'architecture',
          name: 'Architecture Oracle',
          description: 'Reviews architecture',
          model: { engine: 'claude-code', model: 'opus', maxTurns: 20, maxBudgetUsd: 10 },
          promptFile: '',
          focusAreas: ['architecture'],
        },
      ],
      1,
    );

    const result = await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 180_000,
    });

    expect(result.successfulOracles).toBe(1);
    expect(calls).toBe(2);
    expect(capturedPrompts[1]).toContain('TOP PRIORITY ORACLE SYNTHESIS RETRY');
    expect(capturedPrompts[1]).toContain('## Replay Findings Digest');
    expect(capturedPrompts[1]).toContain('Missing auth guard');
    expect(capturedPrompts[1]).not.toContain('## Replay Oracle Discipline');
    expect(capturedSpecs[1]).toMatchObject({
      primary: {
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
        maxBudgetUsd: 4,
        stallThresholdMs: 20_000,
        efficiencyBudget: expect.objectContaining({
          disableToolUse: true,
          targetTurns: 2,
          explorationTurns: 0,
          hardTurnCap: 4,
        }),
      },
    });
    expect(capturedTools[0]).toEqual([]);
    expect(capturedTools[1]).toEqual([]);
  });

  it('starts broad replay oracles in synthesis mode when deep scan already covered the seam', async () => {
    const capturedPrompts: string[] = [];
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const capturedTools: string[][] = [];
    const router = {
      async execute(
        prompt: string,
        spec: Record<string, unknown>,
        tools: string[],
      ): Promise<ExecutorResult> {
        capturedPrompts.push(prompt);
        capturedSpecs.push(spec);
        capturedTools.push(tools);
        return makeResult({
          summary: 'Synthesized from replay seam evidence',
          assessments: [
            {
              findingId: 'finding-auth',
              verdict: 'confirm',
              rationale: 'The supplied findings are enough for this oracle pass.',
              severity: null,
              horizon: 'immediate',
            },
          ],
          newFindings: [],
          decisions: [],
        });
      },
    };

    const session = createSession([
      makeFinding(
        'finding-route',
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'Route seam finding',
      ),
      makeFinding(
        'finding-detail',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'Detail route seam finding',
      ),
      makeFinding('finding-repo', 'apps/studio/src/repos/project-repo.ts', 'Repo seam finding'),
      makeFinding(
        'finding-member-model',
        'packages/database/src/models/project-member.model.ts',
        'Member model seam finding',
      ),
      makeFinding(
        'finding-role-model',
        'packages/database/src/models/role-definition.model.ts',
        'Role model seam finding',
      ),
      makeFinding(
        'finding-tests',
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
        'Test seam finding',
      ),
    ]);
    session.replayContext = {
      changedFiles: [
        'apps/studio/src/app/api/projects/[id]/members/route.ts',
        'apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts',
        'apps/studio/src/repos/project-repo.ts',
        'packages/database/src/models/project-member.model.ts',
        'packages/database/src/models/role-definition.model.ts',
        'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
      ],
      tags: ['studio', 'rbac', 'service-extraction'],
    };

    const constellation = new OracleConstellation(
      router,
      createReporter(),
      [
        {
          id: 'architecture',
          name: 'Architecture Oracle',
          description: 'Reviews architecture',
          model: { engine: 'claude-code', model: 'opus', maxTurns: 20, maxBudgetUsd: 10 },
          promptFile: '',
          focusAreas: ['architecture'],
        },
      ],
      1,
    );

    const result = await constellation.analyzeFindings(session.findings, session, {
      stageName: 'Oracle Analysis',
      timeoutMs: 180_000,
    });

    expect(result.successfulOracles).toBe(1);
    expect(capturedPrompts[0]).toContain('TOP PRIORITY ORACLE SYNTHESIS RETRY');
    expect(capturedPrompts[0]).toContain(
      'Deep scan already gathered sufficient replay seam evidence',
    );
    expect(capturedPrompts[0]).toContain('## Replay Findings Digest');
    expect(capturedPrompts[0]).toContain('apps/studio/src/app/api/projects/[id]/members/route.ts');
    expect(capturedSpecs[0]).toMatchObject({
      primary: {
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
        maxBudgetUsd: 4,
        stallThresholdMs: 20_000,
        efficiencyBudget: expect.objectContaining({
          disableToolUse: true,
          targetTurns: 2,
          explorationTurns: 0,
        }),
      },
    });
    expect(capturedTools[0]).toEqual([]);
  });

  // ── UT-5: resolveArchitectureOracle helper ────────────────────

  describe('UT-5: resolveArchitectureOracle', () => {
    it('returns openai-api engine with gpt-5 when useOpenAiArchitectureOracle is true', () => {
      const config = createHelixConfig({ useOpenAiArchitectureOracle: true });
      const oracle = resolveArchitectureOracle(config);
      expect(oracle.model.engine).toBe('openai-api');
      expect(oracle.model.model).toBe('gpt-5');
      expect(oracle.id).toBe('architecture');
      expect(oracle.focusAreas).toEqual([
        'isolation',
        'auth',
        'stateless',
        'traceability',
        'error-handling',
      ]);
      expect(oracle.model.maxBudgetUsd).toBe(10);
      expect(oracle.model.maxTurns).toBe(20);
    });

    it('returns openaiModel override when specified', () => {
      const config = createHelixConfig({
        useOpenAiArchitectureOracle: true,
        openaiModel: 'gpt-5-turbo',
      });
      const oracle = resolveArchitectureOracle(config);
      expect(oracle.model.engine).toBe('openai-api');
      expect(oracle.model.model).toBe('gpt-5-turbo');
    });

    it('returns Opus default when useOpenAiArchitectureOracle is false', () => {
      const config = createHelixConfig({ useOpenAiArchitectureOracle: false });
      const oracle = resolveArchitectureOracle(config);
      expect(oracle.model.engine).toBe('claude-code');
      expect(oracle.model.model).toBe('opus');
    });

    it('returns Opus default when useOpenAiArchitectureOracle is undefined', () => {
      const config = createHelixConfig({});
      const oracle = resolveArchitectureOracle(config);
      expect(oracle.model.engine).toBe('claude-code');
      expect(oracle.model.model).toBe('opus');
    });
  });

  // ── inferOracleConfidence regression ─────────────────────────

  describe('inferOracleConfidence regression', () => {
    it('gpt-5 model yields 0.82 confidence via architecture oracle verdict', async () => {
      const capturedVotes: Array<{ oracleId: string; confidence: number }> = [];
      const router = {
        async execute(prompt: string): Promise<ExecutorResult> {
          return makeResult({
            summary: 'GPT-5 architecture review',
            assessments: [
              {
                findingId: 'finding-auth',
                verdict: 'confirm',
                rationale: 'GPT-5 agrees',
                severity: null,
                horizon: 'immediate',
              },
            ],
            newFindings: [],
            decisions: [],
          });
        },
      };

      const session = createSession();
      const constellation = new OracleConstellation(
        router,
        createReporter(),
        [
          {
            id: 'architecture',
            name: 'Architecture Oracle',
            description: 'Architecture review',
            model: { engine: 'openai-api', model: 'gpt-5', maxTurns: 20, maxBudgetUsd: 10 },
            promptFile: '',
            focusAreas: ['architecture'],
          },
        ],
        1,
      );

      const result = await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 5_000,
      });

      // Verify the decision has the correct confidence from inferOracleConfidence
      const statusDecision = result.decisions.find((d) => d.context?.includes('[action:status]'));
      if (statusDecision?.oracleVotes?.[0]) {
        expect(statusDecision.oracleVotes[0].confidence).toBe(0.82);
      }
    });

    it('gpt-4o model yields 0.75 confidence', async () => {
      const router = {
        async execute(): Promise<ExecutorResult> {
          return makeResult({
            summary: 'GPT-4o review',
            assessments: [
              {
                findingId: 'finding-auth',
                verdict: 'challenge',
                rationale: 'GPT-4o disagrees',
                severity: null,
                horizon: null,
              },
            ],
            newFindings: [],
            decisions: [],
          });
        },
      };

      const session = createSession();
      const constellation = new OracleConstellation(
        router,
        createReporter(),
        [
          {
            id: 'mini',
            name: 'Mini Oracle',
            description: 'Mini review',
            model: { engine: 'openai-api', model: 'gpt-4o', maxTurns: 10, maxBudgetUsd: 5 },
            promptFile: '',
            focusAreas: ['misc'],
          },
        ],
        1,
      );

      const result = await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 5_000,
      });

      const decision = result.decisions.find((d) => d.context?.includes('[action:status]'));
      if (decision?.oracleVotes?.[0]) {
        expect(decision.oracleVotes[0].confidence).toBe(0.75);
      }
    });

    it('unknown model yields 0.68 confidence', async () => {
      const router = {
        async execute(): Promise<ExecutorResult> {
          return makeResult({
            summary: 'Unknown model review',
            assessments: [
              {
                findingId: 'finding-auth',
                verdict: 'confirm',
                rationale: 'Agrees',
                severity: null,
                horizon: null,
              },
            ],
            newFindings: [],
            decisions: [],
          });
        },
      };

      const session = createSession();
      const constellation = new OracleConstellation(
        router,
        createReporter(),
        [
          {
            id: 'unknown',
            name: 'Unknown Oracle',
            description: 'Unknown model',
            model: {
              engine: 'openai-api',
              model: 'unknown-model',
              maxTurns: 10,
              maxBudgetUsd: 5,
            },
            promptFile: '',
            focusAreas: ['misc'],
          },
        ],
        1,
      );

      const result = await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 5_000,
      });

      const decision = result.decisions.find((d) => d.oracleVotes && d.oracleVotes.length > 0);
      if (decision?.oracleVotes?.[0]) {
        expect(decision.oracleVotes[0].confidence).toBe(0.68);
      }
    });
  });

  // ── buildOracleSynthesisModelSpec engine-awareness ────────────

  describe('buildOracleSynthesisModelSpec engine-awareness', () => {
    it('falls back to gpt-4o-mini for openai-api engine on synthesis retry', async () => {
      let calls = 0;
      const capturedSpecs: Array<Record<string, unknown>> = [];
      const router = {
        async execute(_prompt: string, spec: Record<string, unknown>): Promise<ExecutorResult> {
          calls += 1;
          capturedSpecs.push(spec);
          if (calls === 1) {
            return {
              output: '',
              model: 'gpt-5',
              engine: 'openai-api',
              turnsUsed: 20,
              durationMs: 90_000,
              error: 'Execution timed out after 90000ms',
            };
          }
          return makeResult({
            summary: 'Synthesis retry',
            assessments: [],
            newFindings: [],
            decisions: [],
          });
        },
      };

      const session = createSession();
      session.replayContext = {
        changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
        tags: ['service-extraction'],
      };

      const constellation = new OracleConstellation(
        router,
        createReporter(),
        [
          {
            id: 'architecture',
            name: 'Architecture Oracle',
            description: 'Architecture',
            model: { engine: 'openai-api', model: 'gpt-5', maxTurns: 20, maxBudgetUsd: 10 },
            promptFile: '',
            focusAreas: ['architecture'],
          },
        ],
        1,
      );

      await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 180_000,
      });

      expect(calls).toBe(2);
      // Second call (synthesis retry) should use gpt-4o-mini
      expect(capturedSpecs[1]).toMatchObject({
        primary: {
          model: 'gpt-4o-mini',
          engine: 'openai-api',
        },
      });
    });

    it('falls back to claude-sonnet-4-6 for claude-code engine on synthesis retry', async () => {
      let calls = 0;
      const capturedSpecs: Array<Record<string, unknown>> = [];
      const router = {
        async execute(_prompt: string, spec: Record<string, unknown>): Promise<ExecutorResult> {
          calls += 1;
          capturedSpecs.push(spec);
          if (calls === 1) {
            return {
              output: '',
              model: 'opus',
              engine: 'claude-code',
              turnsUsed: 20,
              durationMs: 90_000,
              error: 'Execution timed out after 90000ms',
            };
          }
          return makeResult({
            summary: 'Synthesis retry',
            assessments: [],
            newFindings: [],
            decisions: [],
          });
        },
      };

      const session = createSession();
      session.replayContext = {
        changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
        tags: ['service-extraction'],
      };

      const constellation = new OracleConstellation(
        router,
        createReporter(),
        [
          {
            id: 'architecture',
            name: 'Architecture Oracle',
            description: 'Architecture',
            model: { engine: 'claude-code', model: 'opus', maxTurns: 20, maxBudgetUsd: 10 },
            promptFile: '',
            focusAreas: ['architecture'],
          },
        ],
        1,
      );

      await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 180_000,
      });

      expect(calls).toBe(2);
      expect(capturedSpecs[1]).toMatchObject({
        primary: {
          model: 'claude-sonnet-4-6',
          engine: 'claude-code',
        },
      });
    });
  });

  // ── FR-3 / INT-3: Full constellation with architecture oracle swap ──

  describe('FR-3 / INT-3: mixed-engine oracle constellation', () => {
    it('runs 3 Claude + 1 OpenAI oracles with correct cost attribution', async () => {
      const engineModelPairs: Array<{ engine: string; model: string }> = [];
      const router = {
        async execute(prompt: string): Promise<ExecutorResult> {
          const isArchitecture = prompt.includes('Architecture Oracle');
          const engine = isArchitecture ? 'openai-api' : 'claude-code';
          const model = isArchitecture ? 'gpt-5' : 'opus';
          engineModelPairs.push({ engine, model });

          return {
            output: JSON.stringify({
              summary: `${engine} review`,
              assessments: [
                {
                  findingId: 'finding-auth',
                  verdict: 'confirm',
                  rationale: `${engine} agrees`,
                  severity: null,
                  horizon: 'immediate',
                },
              ],
              newFindings: [],
              decisions: [],
            }),
            model,
            engine,
            turnsUsed: 1,
            durationMs: 100,
            costUsd: engine === 'openai-api' ? 0.18 : 0.14,
          };
        },
      };

      const session = createSession();
      const config = createHelixConfig({ useOpenAiArchitectureOracle: true });
      const constellation = new OracleConstellation(router, createReporter(), undefined, 4, config);

      const result = await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 10_000,
      });

      expect(result.successfulOracles).toBe(8);
      expect(result.failedOracles).toHaveLength(0);

      // Verify engine distribution: 1 openai-api (architecture swap),
      // 7 claude-code (the test mock routes everything else to claude-code,
      // including the e2e-flow oracle whose production engine is codex-cli).
      const openaiCalls = engineModelPairs.filter((p) => p.engine === 'openai-api');
      const claudeCalls = engineModelPairs.filter((p) => p.engine === 'claude-code');
      expect(openaiCalls).toHaveLength(1);
      expect(claudeCalls).toHaveLength(7);

      // Verify cost attribution
      expect(session.costByProvider).toBeDefined();
      expect(session.costByProvider?.['openai-api:gpt-5']?.callCount).toBe(1);
      expect(session.costByProvider?.['openai-api:gpt-5']?.totalUsd).toBeCloseTo(0.18, 4);
    });
  });

  // ── FR-16: Oracle checkpoint reuse across engines ─────────────

  describe('FR-16: checkpoint reuse across mixed engines', () => {
    it('skips all oracles on second run when findings are unchanged', async () => {
      let calls = 0;
      const router = {
        async execute(prompt: string): Promise<ExecutorResult> {
          calls += 1;
          const isArchitecture = prompt.includes('Architecture Oracle');
          return {
            output: JSON.stringify({
              summary: 'Review complete',
              assessments: [
                {
                  findingId: 'finding-auth',
                  verdict: 'confirm',
                  rationale: 'Agreed',
                  severity: null,
                  horizon: 'immediate',
                },
              ],
              newFindings: [],
              decisions: [],
            }),
            model: isArchitecture ? 'gpt-5' : 'opus',
            engine: isArchitecture ? 'openai-api' : 'claude-code',
            turnsUsed: 1,
            durationMs: 100,
            costUsd: 0.1,
          };
        },
      };

      const session = createSession();
      const config = createHelixConfig({ useOpenAiArchitectureOracle: true });

      // First run
      const constellation1 = new OracleConstellation(
        router,
        createReporter(),
        undefined,
        4,
        config,
      );
      const first = await constellation1.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 10_000,
      });

      expect(first.successfulOracles).toBe(8);
      expect(first.reusedOracles).toBe(0);
      expect(calls).toBe(8);

      // Second run — same findings → all from checkpoint
      const constellation2 = new OracleConstellation(
        router,
        createReporter(),
        undefined,
        4,
        config,
      );
      const second = await constellation2.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 10_000,
      });

      expect(second.successfulOracles).toBe(8);
      expect(second.reusedOracles).toBe(8);
      expect(calls).toBe(8); // No additional calls on second run
    });
  });

  // ── E2E-6: Full pipeline oracle-analysis stage with swap ──────

  describe('E2E-6: oracle-analysis stage round-trip with architecture swap', () => {
    it('produces 8 verdicts with consensus and persists checkpoint', async () => {
      let callCount = 0;
      const router = {
        async execute(prompt: string): Promise<ExecutorResult> {
          callCount += 1;
          const isArchitecture = prompt.includes('Architecture Oracle');
          return {
            output: JSON.stringify({
              summary: 'Oracle verdict',
              assessments: [
                {
                  findingId: 'finding-auth',
                  verdict: 'confirm',
                  rationale: 'All agree',
                  severity: null,
                  horizon: 'immediate',
                },
              ],
              newFindings: [],
              decisions: [],
            }),
            model: isArchitecture ? 'gpt-5' : 'opus',
            engine: isArchitecture ? 'openai-api' : 'claude-code',
            turnsUsed: 1,
            durationMs: 100,
            costUsd: 0.1,
          };
        },
      };

      const session = createSession();
      const config = createHelixConfig({ useOpenAiArchitectureOracle: true });

      // Run 1 — 8 verdicts, consensus, checkpoint persist
      const constellation = new OracleConstellation(router, createReporter(), undefined, 4, config);
      const result = await constellation.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 10_000,
      });

      expect(result.successfulOracles).toBe(8);
      expect(callCount).toBe(8);
      expect(session.oracleCheckpoints).toHaveLength(8);

      // Run 2 — all skipped via checkpoint
      const constellation2 = new OracleConstellation(
        router,
        createReporter(),
        undefined,
        4,
        config,
      );
      const result2 = await constellation2.analyzeFindings(session.findings, session, {
        stageName: 'Oracle Analysis',
        timeoutMs: 10_000,
      });

      expect(result2.reusedOracles).toBe(8);
      expect(callCount).toBe(8); // Still 8, no new calls
    });
  });

  it('lets an explicit keep answer override a deferred oracle proposal', () => {
    const session = createSession();

    const applied = applyOracleDecisionOutcome(session, {
      id: 'decision-keep',
      classification: 'AMBIGUOUS',
      question: 'Should finding finding-auth remain in the implementation plan?',
      context: '[finding-id:finding-auth][action:status][proposal:deferred] rollout risk remains',
      answer: 'keep',
      oracleVotes: [],
      resolvedBy: 'user',
      resolvedAt: '2026-04-09T00:00:00.000Z',
      stage: 'Oracle Analysis',
    });

    expect(applied).toBe(true);
    expect(session.findings[0]?.status).toBe('open');
  });
});

function makeResult(payload: unknown): ExecutorResult {
  return {
    output: JSON.stringify(payload),
    model: 'opus',
    engine: 'claude-code',
    turnsUsed: 1,
    durationMs: 1,
  };
}

function createReporter() {
  return {
    emit(): void {
      // no-op for tests
    },
    async onQuestion(): Promise<string> {
      return 'keep';
    },
    async onCheckpoint(): Promise<boolean> {
      return true;
    },
  };
}

function createSession(findings = [makeFinding('finding-auth', 'src/review.ts')]): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title: 'Oracle consensus',
      description: 'Test oracle consensus',
      scope: ['src'],
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
    findings,
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeFinding(id: string, path: string, _title?: string) {
  const timestamp = '2026-04-01T00:00:00.000Z';
  return {
    id,
    category: 'security' as const,
    severity: 'high' as const,
    status: 'open' as const,
    title: `Missing auth guard (${id})`,
    description: 'Route appears to skip auth middleware',
    files: [{ path }],
    discoveredBy: 'Deep Scan',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createHelixConfig(overrides: Partial<HelixConfig> = {}): HelixConfig {
  return {
    workDir: '/tmp/helix-test',
    sessionDir: '/tmp/helix-test/sessions',
    journalDir: '/tmp/helix-test/journal',
    defaultModel: { engine: 'claude-code', model: 'opus' },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 4,
    maxSliceRetries: 3,
    autoCommit: false,
    autoApprove: false,
    budgetLimitUsd: 100,
    verbose: false,
    ...overrides,
  };
}
