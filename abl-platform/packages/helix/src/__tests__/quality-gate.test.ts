import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildExplicitScopedTestCmd,
  buildScopedTypecheckCmd,
  buildScopedTestCmd,
  buildSliceVerificationCommandPacket,
  buildTestLockCommand,
  runQualityGate,
} from '../pipeline/quality-gate.js';
import type { Session } from '../types.js';

describe('quality-gate', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('passes the modified-test gate when a scoped test file changes', async () => {
    tempDir = await createGitRepo();
    await writeFile(join(tempDir, 'src', 'parser.test.ts'), 'expect(true).toBe(false);\n', 'utf-8');

    const result = await runQualityGate(
      {
        name: 'Bug Reproduced',
        checks: [{ name: 'Scoped failing test artifact exists', type: 'modified-test' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Reproduce',
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Scoped failing test artifact exists',
        passed: true,
      }),
    ]);
  });

  it('fails the modified-test gate when scoped test files stay unchanged', async () => {
    tempDir = await createGitRepo();
    await writeFile(
      join(tempDir, 'src', 'parser.ts'),
      "export const parser = 'changed';\n",
      'utf-8',
    );

    const result = await runQualityGate(
      {
        name: 'Bug Reproduced',
        checks: [{ name: 'Scoped failing test artifact exists', type: 'modified-test' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Reproduce',
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('No modified scoped test files found');
  });

  it('passes the analysis-report-clear gate when the stage output has no findings or decisions', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Security Audit Clearance',
        checks: [{ name: 'No blocking security findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.ts']),
      'Security Audit',
      {
        stageOutput: JSON.stringify({
          summary: 'No blocking issues remain.',
          findings: [],
          decisions: [],
        }),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'No blocking security findings remain',
        passed: true,
        output: expect.stringContaining('Analysis report is clear'),
      }),
    ]);
  });

  it('fails the analysis-report-clear gate when the stage output still contains blocking findings', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'UX Design Audit Clearance',
        checks: [{ name: 'No blocking UX findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.ts']),
      'UX Design Audit',
      {
        stageOutput: JSON.stringify({
          summary: 'One blocking issue remains.',
          findings: [
            {
              severity: 'medium',
              category: 'bug',
              title: 'Primary action is still hidden',
              description: 'The create-workspace action remains undiscoverable.',
              files: ['src/parser.ts'],
            },
          ],
          decisions: [],
        }),
      },
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Primary action is still hidden');
  });

  it('passes scenario-evidence when a Jira UI ticket has mapped Studio evidence artifacts', async () => {
    tempDir = await createGitRepo();
    const artifactDir = join(
      tempDir,
      '.codex-artifacts',
      'studio-video-evidence',
      'run-1',
      'screenshots',
    );
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, 'ablp-321-scenario.png'), 'png', 'utf-8');

    const session = createSession(['apps/studio/src/app/page.tsx']);
    session.workItem.jiraKey = 'ABLP-321';
    session.workItem.title = 'Studio scenario evidence';
    session.workItem.description = 'UI Studio scenario requires screenshot proof';

    const result = await runQualityGate(
      {
        name: 'Jira Evidence',
        checks: [{ name: 'Scenario-mapped Jira evidence exists', type: 'scenario-evidence' }],
        passThreshold: 1,
        failAction: 'stop',
      },
      tempDir,
      session,
      'Regression',
      {
        stageOutput: [
          'Jira scenario: ABLP-321 Studio scenario evidence',
          'Root cause: Studio action state was not visible.',
          'Fix commit: abc1234 [ABLP-321] fix(studio): expose action state',
          'Exact evidence artifact: .codex-artifacts/studio-video-evidence/run-1/screenshots/ablp-321-scenario.png',
          'Verification command: pnpm studio:video:evidence -- --scenario ablp-321-action-state',
          'Residual risk: none beyond existing fixture coverage.',
        ].join('\n'),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.output).toContain('Scenario-mapped Jira evidence verified');
  });

  it('blocks scenario-evidence when a Jira API ticket lacks response header and body artifacts', async () => {
    tempDir = await createGitRepo();
    const session = createSession(['apps/runtime/src/routes/messages.ts']);
    session.workItem.jiraKey = 'ABLP-322';
    session.workItem.title = 'Runtime API response evidence';
    session.workItem.description = 'API ticket requires actual response artifacts';

    const result = await runQualityGate(
      {
        name: 'Jira Evidence',
        checks: [{ name: 'Scenario-mapped Jira evidence exists', type: 'scenario-evidence' }],
        passThreshold: 1,
        failAction: 'stop',
      },
      tempDir,
      session,
      'Regression',
      {
        stageOutput: [
          'Jira scenario: ABLP-322 Runtime API response evidence',
          'Root cause: Runtime route dropped a header.',
          'Fix commit: abc1234 [ABLP-322] fix(runtime): keep header',
          'Exact evidence artifact: .codex-artifacts/helix-evidence/ABLP-322/response.json',
          'Verification command: curl -i http://localhost:3112/api/messages',
          'Residual risk: none known.',
        ].join('\n'),
      },
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('BLOCKED: Jira scenario-specific evidence is incomplete');
    expect(result.feedback).toContain('response plus header/body artifacts');
  });

  it('passes replay-target-coverage when every historical seam file is present in the replay diff', async () => {
    tempDir = await createGitRepo();
    const baseHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tempDir,
      encoding: 'utf8',
    }).trim();
    await writeFile(
      join(tempDir, 'src', 'parser.ts'),
      "export const parser = 'changed';\n",
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'src', 'parser.test.ts'),
      "it('covers parser', () => expect(true).toBe(true));\n",
      'utf-8',
    );

    const session = createSession(['src/parser.ts', 'src/parser.test.ts']);
    session.replayContext = {
      changedFiles: ['src/parser.ts', 'src/parser.test.ts'],
    };
    session.workspaceContext = {
      mode: 'git-worktree',
      worktreeDir: tempDir,
      baseHeadSha,
    };

    const result = await runQualityGate(
      {
        name: 'Replay Coverage',
        checks: [{ name: 'Replay target seam coverage', type: 'replay-target-coverage' }],
        passThreshold: 1,
        failAction: 'stop',
      },
      tempDir,
      session,
      'Regression',
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.output).toContain('Replay target seam coverage passed');
  });

  it('fails replay-target-coverage when a historical seam file is missing from the replay diff', async () => {
    tempDir = await createGitRepo();
    const baseHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tempDir,
      encoding: 'utf8',
    }).trim();
    await writeFile(
      join(tempDir, 'src', 'parser.ts'),
      "export const parser = 'changed';\n",
      'utf-8',
    );

    const session = createSession(['src/parser.ts']);
    session.replayContext = {
      changedFiles: ['src/parser.ts', 'src/parser.test.ts'],
    };
    session.workspaceContext = {
      mode: 'git-worktree',
      worktreeDir: tempDir,
      baseHeadSha,
    };

    const result = await runQualityGate(
      {
        name: 'Replay Coverage',
        checks: [{ name: 'Replay target seam coverage', type: 'replay-target-coverage' }],
        passThreshold: 1,
        failAction: 'stop',
      },
      tempDir,
      session,
      'Regression',
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Missing historical target files: src/parser.test.ts');
  });

  it('prefers modified scoped test files over package-wide test scripts', async () => {
    tempDir = await createGitRepo();
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__'), { recursive: true });
    await writeFile(
      join(tempDir, 'apps', 'studio', 'package.json'),
      JSON.stringify(
        {
          name: '@agent-platform/studio',
          scripts: {
            test: 'vitest run',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'apps', 'studio', 'src', '__tests__', 'user-menu.test.tsx'),
      "it('shows create workspace', () => expect(true).toBe(true));\n",
      'utf-8',
    );

    const command = await buildScopedTestCmd(tempDir, createSession(['apps/studio']), [
      'apps/studio',
    ]);

    expect(command).toContain(
      'pnpm --filter ./apps/studio exec vitest run "src/__tests__/user-menu.test.tsx"',
    );
    expect(command).not.toContain('run test');
  });

  it('uses the node vitest config for API-route scoped proof commands when available', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-node-vitest-'));
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__', 'api-routes'), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
      'utf-8',
    );
    await writeFile(join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
    await writeFile(
      join(tempDir, 'apps', 'studio', 'package.json'),
      JSON.stringify(
        {
          name: '@agent-platform/studio',
          private: true,
          scripts: {
            test: 'vitest run',
            'test:api-routes':
              'vitest run --config vitest.node.config.ts src/__tests__/api-routes/',
          },
          devDependencies: {
            vitest: '^4.0.0',
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'apps', 'studio', 'vitest.node.config.ts'),
      'export default {};\n',
      'utf-8',
    );

    const command = await buildExplicitScopedTestCmd(tempDir, [
      'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
    ]);

    expect(command).toContain(
      'pnpm --filter ./apps/studio exec vitest run --config vitest.node.config.ts "src/__tests__/api-routes/api-project-members.test.ts"',
    );
  });

  it('uses the node vitest config for e2e scoped proof commands when available', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-node-e2e-'));
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__'), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
      'utf-8',
    );
    await writeFile(join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
    await writeFile(
      join(tempDir, 'apps', 'studio', 'package.json'),
      JSON.stringify(
        {
          name: '@agent-platform/studio',
          private: true,
          scripts: {
            test: 'vitest run',
          },
          devDependencies: {
            vitest: '^4.0.0',
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'apps', 'studio', 'vitest.node.config.ts'),
      'export default {};\n',
      'utf-8',
    );

    const command = await buildExplicitScopedTestCmd(tempDir, [
      'apps/studio/src/project-members-api.e2e.test.ts',
    ]);

    expect(command).toContain(
      'pnpm --filter ./apps/studio exec vitest run --config vitest.node.config.ts "src/project-members-api.e2e.test.ts"',
    );
  });

  it('splits mixed test-lock batches by Vitest config and drops helper files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-test-lock-'));
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__', 'api-routes'), {
      recursive: true,
    });
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__', 'search-ai'), {
      recursive: true,
    });
    await mkdir(join(tempDir, 'apps', 'studio', 'src', '__tests__', 'helpers'), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
      'utf-8',
    );
    await writeFile(join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
    await writeFile(
      join(tempDir, 'apps', 'studio', 'package.json'),
      JSON.stringify(
        {
          name: '@agent-platform/studio',
          private: true,
          scripts: {
            test: 'vitest run',
          },
          devDependencies: {
            vitest: '^4.0.0',
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'apps', 'studio', 'vitest.node.config.ts'),
      'export default {};\n',
      'utf-8',
    );

    const command = await buildTestLockCommand(tempDir, [
      'apps/studio/src/__tests__/api-routes/api-project-members.test.ts',
      'apps/studio/src/__tests__/search-ai/index-not-ready-guard.test.tsx',
      'apps/studio/src/__tests__/helpers/studio-api-harness.ts',
    ]);

    expect(command).toContain(
      'pnpm --filter ./apps/studio exec vitest run --config vitest.node.config.ts "src/__tests__/api-routes/api-project-members.test.ts"',
    );
    expect(command).toContain(
      'pnpm --filter ./apps/studio exec vitest run "src/__tests__/search-ai/index-not-ready-guard.test.tsx"',
    );
    expect(command).not.toContain('studio-api-harness.ts');
  });

  it('fails a model-review gate when the reviewer returns blocking findings', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Plan Quality',
        checks: [
          {
            name: 'Plan is seam-aware',
            type: 'model-review',
            prompt: 'Block plans that patch consumers before foundations.',
          },
        ],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Plan Generation',
      {
        stageOutput: 'SLICE 1: Patch callers first',
        runModelReview: async ({ prompt, outputSchema }) => {
          expect(prompt).toContain('Block plans that patch consumers before foundations.');
          expect(prompt).toContain('SLICE 1: Patch callers first');
          expect(outputSchema).toEqual({ id: 'analysis-report', strict: true });
          return {
            output: JSON.stringify({
              summary: 'The plan patches consumers before stabilizing the shared parser seam.',
              findings: [
                {
                  severity: 'high',
                  category: 'inconsistency',
                  title: 'Foundations come after consumers',
                  description:
                    'The plan should harden the parser contract before updating callers.',
                  files: ['src/parser.ts'],
                },
              ],
              decisions: [],
            }),
            model: 'opus',
            engine: 'claude-code',
            turnsUsed: 1,
            durationMs: 1,
          };
        },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Foundations come after consumers');
  });

  it('passes a model-review gate when the reviewer approves the output', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Implementation Quality',
        checks: [
          {
            name: 'Fix is durable',
            type: 'model-review',
          },
        ],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Implement Fix',
      {
        stageOutput: 'Implemented the parser seam fix and updated regression coverage.',
        runModelReview: async () => ({
          output: JSON.stringify({
            summary: 'The implementation is durable and fully wired.',
            findings: [],
            decisions: [],
          }),
          model: 'opus',
          engine: 'claude-code',
          turnsUsed: 1,
          durationMs: 1,
        }),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('All checks passed');
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Fix is durable',
        passed: true,
      }),
    ]);
  });

  it('promotes structured analysis-review output even when the reviewer also reports a timeout', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Implementation Quality',
        checks: [
          {
            name: 'Fix is durable',
            type: 'model-review',
          },
        ],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Implement Fix',
      {
        stageOutput: 'Implemented the parser seam fix and updated regression coverage.',
        runModelReview: async () => ({
          output: JSON.stringify({
            summary: 'The implementation is durable and fully wired.',
            findings: [],
            decisions: [],
          }),
          model: 'opus',
          engine: 'claude-code',
          turnsUsed: 3,
          durationMs: 9_000,
          error: 'Claude stalled after 9s of inactivity',
          timedOut: true,
          timeoutMs: 9_000,
        }),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.feedback).toBe('All checks passed');
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Fix is durable',
        passed: true,
        timedOut: false,
        modelReview: expect.objectContaining({
          schemaId: 'analysis-report',
          approved: true,
          findings: [],
        }),
      }),
    ]);
  });

  it('passes the full open findings snapshot and timeout budget into model-review checks', async () => {
    tempDir = await createGitRepo();

    const session = createSession(['src/parser.test.ts']);
    session.findings = Array.from({ length: 25 }, (_, index) => ({
      id: `finding-${index + 1}`,
      category: 'bug' as const,
      severity: 'high' as const,
      status: 'open' as const,
      title: `Finding ${index + 1}`,
      description: `Description ${index + 1}`,
      files: [{ path: `src/file-${index + 1}.ts` }],
      discoveredBy: 'Deep Scan',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }));

    const result = await runQualityGate(
      {
        name: 'Plan Quality',
        checks: [{ name: 'Plan is complete', type: 'model-review' }],
        passThreshold: 1,
        failAction: 'loop',
        timeoutMs: 45_000,
      },
      tempDir,
      session,
      'Plan Generation',
      {
        stageOutput: 'SLICE 1: Stabilize parser seam',
        timeoutMs: 45_000,
        runModelReview: async ({ prompt, timeoutMs }) => {
          expect(prompt).toContain('25 open finding(s)');
          expect(prompt).toContain('finding-25');
          expect(timeoutMs).toBe(45_000);
          return {
            output: JSON.stringify({
              summary: 'Approved',
              findings: [],
              decisions: [],
            }),
            model: 'opus',
            engine: 'claude-code',
            turnsUsed: 1,
            durationMs: 1,
          };
        },
      },
    );

    expect(result.passed).toBe(true);
    expect(result.timeoutMs).toBe(45_000);
  });

  it('captures partial plan approval details from plan-review quality gates', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Plan Quality',
        checks: [
          {
            name: 'Plan is seam-aware and future-proof',
            type: 'model-review',
            prompt: 'Review each slice and preserve sound slices.',
            reviewOutputSchema: { id: 'plan-review', strict: true },
          },
        ],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Plan Generation',
      {
        stageOutput: JSON.stringify({
          summary: 'Two-slice plan',
          slices: [
            {
              title: 'Stabilize parser seam',
              description: 'Fix foundation first',
              findings: ['finding-foundation'],
              files: ['src/parser.ts'],
              tests: ['src/parser.test.ts'],
              dependencies: [],
              legacyPaths: [],
            },
            {
              title: 'Update callers',
              description: 'Wire consumers afterward',
              findings: ['finding-callers'],
              files: ['src/caller.ts'],
              tests: ['src/caller.test.ts'],
              dependencies: [1],
              legacyPaths: [],
            },
          ],
        }),
        runModelReview: async ({ prompt, outputSchema }) => {
          expect(prompt).toContain('Review each slice and preserve sound slices.');
          expect(outputSchema).toEqual({ id: 'plan-review', strict: true });
          return {
            output: JSON.stringify({
              summary: 'Keep slice 1, revise slice 2',
              findings: [
                {
                  disposition: 'blocking',
                  severity: 'high',
                  category: 'missing-test',
                  title: 'Slice 2 needs stronger regression coverage',
                  description:
                    'Add the integration test that proves the caller path uses the seam.',
                  files: ['src/caller.test.ts'],
                },
                {
                  disposition: 'advisory',
                  severity: 'low',
                  category: 'redundancy',
                  title: 'Legacy helper cleanup can wait',
                  description: 'Move the duplicate helper to backlog later.',
                  files: ['src/legacy-helper.ts'],
                },
              ],
              sliceAssessments: [
                {
                  sliceNumber: 1,
                  verdict: 'approved',
                  rationale: 'Foundation slice is correct.',
                  requiredTestAmendments: [],
                },
                {
                  sliceNumber: 2,
                  verdict: 'revise',
                  rationale: 'Strengthen regression coverage before approval.',
                  requiredTestAmendments: [
                    'src/caller.test.ts - prove the stabilized seam is used',
                  ],
                },
              ],
              deferredFindings: [
                {
                  findingId: 'finding-cleanup',
                  reason: 'Safe to backlog after the main fix lands.',
                },
              ],
              decisions: [],
            }),
            model: 'opus',
            engine: 'claude-code',
            turnsUsed: 1,
            durationMs: 1,
          };
        },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Approved slices: 1');
    expect(result.feedback).toContain('Slice 2');
    expect(result.feedback).toContain('finding-cleanup');
    expect(result.checks[0]?.modelReview).toEqual(
      expect.objectContaining({
        schemaId: 'plan-review',
        approved: false,
        deferredFindings: [expect.objectContaining({ findingId: 'finding-cleanup' })],
        sliceAssessments: [
          expect.objectContaining({ sliceNumber: 1, verdict: 'approved' }),
          expect.objectContaining({ sliceNumber: 2, verdict: 'revise' }),
        ],
      }),
    );
  });

  it('records timeout metadata when a model-review gate times out', async () => {
    tempDir = await createGitRepo();

    const result = await runQualityGate(
      {
        name: 'Plan Quality',
        checks: [{ name: 'Plan is complete', type: 'model-review' }],
        passThreshold: 1,
        failAction: 'loop',
        timeoutMs: 12_000,
      },
      tempDir,
      createSession(['src/parser.test.ts']),
      'Plan Generation',
      {
        stageOutput: 'SLICE 1: Stabilize parser seam',
        timeoutMs: 12_000,
        runModelReview: async () => ({
          output: '(partial review output)',
          model: 'opus',
          engine: 'claude-code',
          turnsUsed: 2,
          durationMs: 12_000,
          error: 'Claude timed out after 12s',
          timedOut: true,
          timeoutMs: 12_000,
        }),
      },
    );

    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Plan is complete',
        passed: false,
        timedOut: true,
        timeoutMs: 12_000,
      }),
    ]);
    expect(result.feedback).toContain('Claude timed out after 12s');
  });

  it('scopes test gates to explicit test files in the work item scope', async () => {
    tempDir = await createWorkspaceTestRepo();

    const result = await runQualityGate(
      {
        name: 'Fix Quality',
        checks: [{ name: 'Previously failing test now passes', type: 'test' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      createSession(['apps/demo/src/feature.test.ts']),
      'Implement Fix',
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Previously failing test now passes',
        passed: true,
        output: expect.stringContaining('src/feature.test.ts'),
      }),
    ]);
  });

  it('scopes typecheck gates to the provided slice files instead of the whole work-item package', async () => {
    tempDir = await createScopedVerificationRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          output: expect.stringContaining('"src/feature.ts"'),
        }),
      ]);
      expect(result.checks[0]?.output).not.toContain('"src/unrelated.ts"');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('includes recursively imported local helpers in synthetic scoped typecheck projects', async () => {
    tempDir = await createRecursiveScopedTypecheckRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.test.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          output: expect.stringContaining('"src/helpers/test-harness.ts"'),
        }),
      ]);
      expect(result.checks[0]?.output).toContain('"src/setup-mongo.ts"');
      expect(result.checks[0]?.output).not.toContain('"src/unrelated.ts"');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('falls back to package typecheck context when scoped tsconfig files trigger synthetic workspace errors', async () => {
    tempDir = await createScopedTypecheckFallbackRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          output: expect.stringContaining('ignored out-of-scope diagnostics'),
        }),
      ]);
      expect(result.checks[0]?.output).not.toContain('apps/demo/src/unrelated.ts');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('uses package builds for composite scoped typecheck packages instead of synthetic tsc projects', async () => {
    tempDir = await createCompositeScopedTypecheckRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          command: 'pnpm --filter ./apps/demo build',
          output: expect.stringContaining('--filter ./apps/demo build'),
        }),
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('avoids heavyweight app builds for composite scoped typecheck packages', async () => {
    tempDir = await createCompositeScopedTypecheckRepo({
      buildScript: 'pnpm run ensure:web-sdk && next build',
      expectPackageBuild: false,
    });
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          command: expect.stringContaining('pnpm --filter ./apps/demo exec tsc --noEmit -p'),
        }),
      ]);
      expect(result.checks[0]?.command).not.toContain('--filter ./apps/demo build');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('uses package-relative scoped typecheck config paths in verification commands', async () => {
    tempDir = await createScopedVerificationRepo();
    const command = await buildScopedTypecheckCmd(tempDir, createSession(['apps/demo']), [
      'apps/demo/src/feature.ts',
    ]);

    expect(command).toContain(`tsc --noEmit -p ".helix-typecheck-session-1-`);
    expect(command).not.toContain(tempDir);
    expect(command).not.toContain(`apps/demo/.helix-typecheck-session-1-`);
  });

  it('ignores malformed scoped package entries that do not resolve to a workspace package', async () => {
    tempDir = await createScopedVerificationRepo();
    const command = await buildScopedTypecheckCmd(tempDir, createSession(['apps/demo']), [
      'apps/demo/src/feature.ts',
      'packages/core or packages/shared-kernel error module',
    ]);

    expect(command).toContain('pnpm --filter ./apps/demo exec tsc --noEmit -p');
    expect(command).not.toContain('packages/core or packages');
  });

  it('refreshes scoped typecheck proof after a transient TS6053 deleted-file failure', async () => {
    tempDir = await createScopedTypecheckRefreshRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'TypeScript compiles', type: 'typecheck' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'TypeScript compiles',
          passed: true,
          output: expect.stringContaining('Scoped typecheck refresh passed via'),
        }),
      ]);
      expect(result.checks[0]?.output).not.toContain('unexpected package-wide typecheck fallback');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('scopes lint gates to explicit slice files instead of sibling edits in the same directory', async () => {
    tempDir = await createScopedVerificationRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'Changed files are formatted', type: 'lint' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo']),
        'Implement Fix',
        {
          scopeEntries: ['apps/demo/src/feature.ts'],
        },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'Changed files are formatted',
          passed: true,
          output: expect.stringContaining('apps/demo/src/feature.ts'),
        }),
      ]);
      expect(result.checks[0]?.output).not.toContain('apps/demo/src/unrelated.ts');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('falls back to focused vitest reruns when a shared scoped test file has unrelated failures', async () => {
    tempDir = await createFocusedFallbackRepo();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const result = await runQualityGate(
        {
          name: 'Fix Quality',
          checks: [{ name: 'Previously failing test now passes', type: 'test' }],
          passThreshold: 1,
          failAction: 'loop',
        },
        tempDir,
        createSession(['apps/demo/src/feature.test.ts']),
        'Implement Fix',
      );

      expect(result.passed).toBe(true);
      expect(result.feedback).toBe('All checks passed');
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: 'Previously failing test now passes',
          passed: true,
          output: expect.stringContaining('Focused regression fallback passed via'),
        }),
      ]);
      expect(result.checks[0]?.output).toContain(
        'should override LLM-supplied projectId with the authenticated project context',
      );
      expect(result.checks[0]?.output).toContain(
        'should not solicit projectId for query_session_traces in a project-scoped chat',
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('treats replay test failures from untouched import-resolution files as non-blocking baseline noise', async () => {
    tempDir = await createWorkspaceTestRepo();
    await mkdir(join(tempDir, 'apps', 'demo', 'src', 'lib'), { recursive: true });
    await writeFile(
      join(tempDir, 'apps', 'demo', 'src', 'lib', 'route-handler.ts'),
      "export const handler = 'baseline';\n",
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'fail-replay-test.js'),
      [
        'console.error(\'Error: Failed to resolve import "@agent-platform/shared/validation" from "src/lib/route-handler.ts". Does the file exist?\');',
        "console.error('  Plugin: vite:import-analysis');",
        `console.error('  File: ${join(tempDir, 'apps', 'demo', 'src', 'lib', 'route-handler.ts')}:37:27');`,
        'process.exit(1);',
      ].join('\n'),
      'utf-8',
    );

    const session = createSession(['apps/demo/src/feature.test.ts']);
    session.replayContext = {
      changedFiles: [
        'apps/demo/src/app/api/projects/[id]/members/route.ts',
        'apps/demo/src/repos/project-repo.ts',
      ],
      tags: ['studio', 'rbac', 'service-extraction'],
    };

    const result = await runQualityGate(
      {
        name: 'Fix Quality',
        checks: [{ name: 'Required tests', type: 'test', command: 'node fail-replay-test.js' }],
        passThreshold: 1,
        failAction: 'loop',
      },
      tempDir,
      session,
      'Implement Fix',
      {
        scopeEntries: ['apps/demo/src/feature.test.ts'],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Required tests',
        passed: true,
        output: expect.stringContaining('Replay verification baseline allowance'),
      }),
    ]);
    expect(result.checks[0]?.output).toContain('apps/demo/src/lib/route-handler.ts');
  });

  it('drops deleted explicit proof targets from slice verification packets', async () => {
    tempDir = await createWorkspaceTestRepo();
    await mkdir(
      join(
        tempDir,
        'apps',
        'demo',
        'src',
        'app',
        'api',
        'projects',
        '[id]',
        'members',
        '[memberId]',
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        tempDir,
        'apps',
        'demo',
        'src',
        'app',
        'api',
        'projects',
        '[id]',
        'members',
        '[memberId]',
        'route.ts',
      ),
      'export const memberRoute = true;\n',
      'utf-8',
    );
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'seed explicit proof targets'], { cwd: tempDir });

    await rm(
      join(
        tempDir,
        'apps',
        'demo',
        'src',
        'app',
        'api',
        'projects',
        '[id]',
        'members',
        '[userId]',
        'route.ts',
      ),
      { force: true },
    );
    await writeFile(
      join(
        tempDir,
        'apps',
        'demo',
        'src',
        'app',
        'api',
        'projects',
        '[id]',
        'members',
        '[memberId]',
        'route.ts',
      ),
      'export const memberRoute = false;\n',
      'utf-8',
    );

    const packet = await buildSliceVerificationCommandPacket(tempDir, createSession([]), {
      typecheckScopeEntries: ['apps/demo/src/app/api/projects/[id]/members/[memberId]/route.ts'],
      formatScopeEntries: [
        'apps/demo/src/app/api/projects/[id]/members/[memberId]/route.ts',
        'apps/demo/src/app/api/projects/[id]/members/[userId]/route.ts',
      ],
      requiredTestFiles: ['apps/demo/src/feature.test.ts', 'apps/demo/src/deleted-feature.test.ts'],
    });

    expect(packet.formatCommand).toContain('[memberId]/route.ts');
    expect(packet.formatCommand).not.toContain('[userId]/route.ts');
    expect(packet.requiredTestCommand).toContain('src/feature.test.ts');
    expect(packet.requiredTestCommand).not.toContain('deleted-feature.test.ts');
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'parser.ts'), "export const parser = 'ok';\n", 'utf-8');
  await writeFile(join(dir, 'src', 'parser.test.ts'), 'expect(true).toBe(true);\n', 'utf-8');

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

async function createWorkspaceTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-workspace-'));
  await mkdir(
    join(dir, 'apps', 'demo', 'src', 'app', 'api', 'projects', '[id]', 'members', '[userId]'),
    { recursive: true },
  );
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify(
      {
        name: '@quality-gate/demo',
        private: true,
        scripts: {
          test: 'node test-runner.js',
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'test-runner.js'),
    [
      'const args = process.argv.slice(2);',
      "console.log(args.join(' '));",
      "if (!args.includes('src/feature.test.ts')) {",
      "  console.error('missing explicit scoped test file');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.test.ts'),
    'export const feature = true;\n',
    'utf-8',
  );
  await writeFile(
    join(
      dir,
      'apps',
      'demo',
      'src',
      'app',
      'api',
      'projects',
      '[id]',
      'members',
      '[userId]',
      'route.ts',
    ),
    'export const userRoute = true;\n',
    'utf-8',
  );

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

async function createFocusedFallbackRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-fallback-'));
  await mkdir(join(dir, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify(
      {
        name: '@quality-gate/demo',
        private: true,
        scripts: {
          test: 'node test-runner.js',
          'test:full': 'vitest run',
        },
        devDependencies: {
          vitest: '^4.0.0',
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'test-runner.js'),
    "console.log('broad shared file test run');\nprocess.exit(1);\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.test.ts'),
    ["it('existing unrelated failure', () => {});", ''].join('\n'),
    'utf-8',
  );

  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "const rendered = args.join(' ');",
      "if (args.includes('exec') && args.includes('vitest') && args.includes('-t')) {",
      '  console.log(rendered);',
      '  process.exit(0);',
      '}',
      "if (args.includes('test')) {",
      "  console.error('primary scoped test failed');",
      '  process.exit(1);',
      '}',
      'console.error(`unexpected pnpm invocation: ${rendered}`);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.test.ts'),
    [
      "it('existing unrelated failure', () => {});",
      '',
      "it('should not solicit projectId for query_session_traces in a project-scoped chat', () => {});",
      "it('should override LLM-supplied projectId with the authenticated project context', () => {});",
      '',
    ].join('\n'),
    'utf-8',
  );

  return dir;
}

async function createScopedVerificationRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-scoped-'));
  await mkdir(join(dir, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify({ name: '@quality-gate/demo', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    'export const feature = true;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'unrelated.ts'),
    'export const unrelated = true;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const projectIndex = args.indexOf('-p');",
      "console.log(args.join(' '));",
      'if (projectIndex === -1 || !args[projectIndex + 1]) {',
      "  console.error('missing scoped project config');",
      '  process.exit(1);',
      '}',
      'const configPathArg = args[projectIndex + 1];',
      "const configPath = path.isAbsolute(configPathArg) ? configPathArg : path.join(process.cwd(), 'apps', 'demo', configPathArg);",
      "const config = readFileSync(configPath, 'utf-8');",
      "const scopeLine = config.split('\\n').find((line) => line.includes('src/'));",
      'if (scopeLine) {',
      '  console.log(scopeLine.trim());',
      '}',
      'console.log(config);',
      "if (!config.includes('src/feature.ts')) {",
      "  console.error('missing slice file in scoped typecheck');",
      '  process.exit(1);',
      '}',
      "if (config.includes('src/unrelated.ts')) {",
      "  console.error('included unrelated file in scoped typecheck');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'npx'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "const rendered = args.join(' ');",
      'console.log(rendered);',
      "if (!rendered.includes('apps/demo/src/feature.ts')) {",
      "  console.error('missing slice file in scoped lint');",
      '  process.exit(1);',
      '}',
      "if (rendered.includes('apps/demo/src/unrelated.ts')) {",
      "  console.error('included unrelated file in scoped lint');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);
  await chmod(join(dir, 'bin', 'npx'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    'export const feature = false;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'unrelated.ts'),
    'export const unrelated = false;\n',
    'utf-8',
  );

  return dir;
}

async function createScopedTypecheckFallbackRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-typecheck-fallback-'));
  await mkdir(join(dir, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify({ name: '@quality-gate/demo', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    'export const feature = true;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'unrelated.ts'),
    'export const unrelated = false;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const rendered = args.join(' ');",
      'console.log(rendered);',
      "if (args.includes('exec') && args.includes('tsc') && args.includes('-p')) {",
      "  const configPathArg = args[args.indexOf('-p') + 1];",
      "  const configPath = path.isAbsolute(configPathArg) ? configPathArg : path.join(process.cwd(), 'apps', 'demo', configPathArg);",
      "  const config = readFileSync(configPath, 'utf-8');",
      "  if (!config.includes('src/feature.ts')) {",
      "    console.error('missing scoped slice file');",
      '    process.exit(1);',
      '  }',
      "  if (config.includes('src/unrelated.ts')) {",
      "    console.error('included unrelated file in scoped typecheck');",
      '    process.exit(1);',
      '  }',
      "  console.error('../../packages/shared/src/outside.ts(1,1): error TS6307: File is not listed within the file list of project.');",
      '  process.exit(1);',
      '}',
      "if (args.includes('exec') && args.includes('tsc')) {",
      '  console.error(\'apps/demo/src/unrelated.ts(1,1): error TS2322: Type "false" is not assignable to type "true".\');',
      '  process.exit(1);',
      '}',
      'console.error(`unexpected pnpm invocation: ${rendered}`);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

async function createScopedTypecheckRefreshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-typecheck-refresh-'));
  await mkdir(join(dir, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify({ name: '@quality-gate/demo', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    'export const feature = true;\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const rendered = args.join(' ');",
      'console.log(rendered);',
      "if (args.includes('exec') && args.includes('tsc') && args.includes('-p')) {",
      "  const configPathArg = args[args.indexOf('-p') + 1];",
      "  const configPath = path.isAbsolute(configPathArg) ? configPathArg : path.join(process.cwd(), 'apps', 'demo', configPathArg);",
      "  const config = readFileSync(configPath, 'utf-8');",
      "  const markerPath = path.join(process.cwd(), 'apps', 'demo', '.ts6053-once');",
      '  if (!existsSync(markerPath)) {',
      "    writeFileSync(markerPath, '1');",
      "    const missingFile = path.join(process.cwd(), 'apps', 'demo', 'src', 'deleted.ts');",
      "    console.error(`error TS6053: File '${missingFile}' not found.`);",
      '    process.exit(1);',
      '  }',
      "  if (!config.includes('src/feature.ts')) {",
      "    console.error('missing scoped slice file');",
      '    process.exit(1);',
      '  }',
      "  if (config.includes('src/deleted.ts')) {",
      "    console.error('stale deleted file remained in scoped typecheck config');",
      '    process.exit(1);',
      '  }',
      '  process.exit(0);',
      '}',
      "if (args.includes('exec') && args.includes('tsc')) {",
      "  console.error('unexpected package-wide typecheck fallback');",
      '  process.exit(1);',
      '}',
      'console.error(`unexpected pnpm invocation: ${rendered}`);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

async function createRecursiveScopedTypecheckRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-recursive-typecheck-'));
  await mkdir(join(dir, 'apps', 'demo', 'src', 'helpers'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify({ name: '@quality-gate/demo', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.test.ts'),
    "import { setupHarness } from './helpers/test-harness';\nexport const run = () => setupHarness();\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'helpers', 'test-harness.ts'),
    "import { setupMongo } from '../setup-mongo';\nexport const setupHarness = () => setupMongo();\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'setup-mongo.ts'),
    "export const setupMongo = () => 'ok';\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'unrelated.ts'),
    "export const unrelated = 'ignore';\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const projectIndex = args.indexOf('-p');",
      "console.log(args.join(' '));",
      'if (projectIndex === -1 || !args[projectIndex + 1]) {',
      "  console.error('missing scoped project config');",
      '  process.exit(1);',
      '}',
      'const configPathArg = args[projectIndex + 1];',
      "const configPath = path.isAbsolute(configPathArg) ? configPathArg : path.join(process.cwd(), 'apps', 'demo', configPathArg);",
      "const config = readFileSync(configPath, 'utf-8');",
      'console.log(config);',
      "if (!config.includes('src/feature.test.ts')) {",
      "  console.error('missing test file in scoped typecheck');",
      '  process.exit(1);',
      '}',
      "if (!config.includes('src/helpers/test-harness.ts')) {",
      "  console.error('missing recursively imported helper');",
      '  process.exit(1);',
      '}',
      "if (!config.includes('src/setup-mongo.ts')) {",
      "  console.error('missing transitive setup helper');",
      '  process.exit(1);',
      '}',
      'if (!config.includes(\'"exclude"\') || !config.includes(\'".next"\')) {',
      "  console.error('missing generated-artifact excludes in scoped typecheck config');",
      '  process.exit(1);',
      '}',
      "if (config.includes('src/unrelated.ts')) {",
      "  console.error('included unrelated file in scoped typecheck');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

async function createCompositeScopedTypecheckRepo(options?: {
  buildScript?: string;
  expectPackageBuild?: boolean;
}): Promise<string> {
  const buildScript = options?.buildScript ?? 'tsc';
  const expectPackageBuild = options?.expectPackageBuild ?? true;
  const dir = await mkdtemp(join(tmpdir(), 'helix-quality-gate-composite-'));
  await mkdir(join(dir, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'lib', 'src'), { recursive: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'quality-gate-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'package.json'),
    JSON.stringify(
      {
        name: '@quality-gate/demo',
        private: true,
        scripts: {
          build: buildScript,
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@quality-gate/lib', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          rootDir: 'src',
          outDir: 'dist',
        },
        include: ['src/**/*.ts'],
        references: [{ path: '../../packages/lib' }],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    "export const feature = 'ok';\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'packages', 'lib', 'src', 'index.ts'),
    "export const helper = 'ok';\n",
    'utf-8',
  );
  await writeFile(
    join(dir, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "const rendered = args.join(' ');",
      `const expectPackageBuild = ${expectPackageBuild ? 'true' : 'false'};`,
      'console.log(rendered);',
      "if (rendered.includes('tsc --noEmit -p') && expectPackageBuild) {",
      "  console.error('unexpected synthetic typecheck config');",
      '  process.exit(1);',
      '}',
      "if (rendered.includes('--filter ./apps/demo build') && !expectPackageBuild) {",
      "  console.error('unexpected heavyweight package build');",
      '  process.exit(1);',
      '}',
      "if (expectPackageBuild && !rendered.includes('--filter ./apps/demo build')) {",
      "  console.error('missing package build fallback');",
      '  process.exit(1);',
      '}',
      "if (!expectPackageBuild && !rendered.includes('tsc --noEmit -p')) {",
      "  console.error('missing synthetic scoped typecheck config');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(dir, 'bin', 'pnpm'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  await writeFile(
    join(dir, 'apps', 'demo', 'src', 'feature.ts'),
    "export const feature = 'updated';\n",
    'utf-8',
  );

  return dir;
}

function createSession(scope: string[]): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'bug-fix',
      title: 'Quality gate test',
      description: 'Quality gate test',
      scope,
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: 'Bug Fix',
    pipelineVersion: 'Bug Fix@123456789abc',
    state: 'scanning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}
