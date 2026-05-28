import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelRouter } from '../models/model-router.js';
import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import { SessionManager } from '../session/session-manager.js';
import type {
  ExecutorResult,
  HelixConfig,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  PipelineTemplate,
  ProgressEvent,
  ProgressReporter,
  Session,
  Slice,
  StageDefinition,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkItem,
} from '../types.js';

describe('implementation continuity', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('promotes a bounded implementation diff into proof/commit when exploration stops after edits', async () => {
    tempDir = await createWorkspace();
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${join(tempDir, 'bin')}:${originalPath}`;

    try {
      const config = createConfig(tempDir, tempDir, { maxSliceRetries: 1 });
      const engine = new PipelineEngine(config, createReporter());
      const session = createSlicedSession();
      session.pipelineName = 'Implementation Continuity';
      session.pipelineVersion = 'Implementation Continuity@123456789abc';
      session.workItem.scope = ['apps/demo'];

      session.slices[0] = {
        ...session.slices[0]!,
        manifest: {
          entryConditions: [],
          fileContracts: [
            {
              path: 'apps/demo/src/feature.ts',
              action: 'modify',
              reason: 'Current slice file',
            },
          ],
          exportContracts: [],
        },
        testLock: {
          requiredTests: [
            {
              testFile: 'apps/demo/src/feature.test.ts',
              description: 'Feature regression',
              status: 'passing',
              coversFindings: ['finding-seam'],
              isNew: false,
            },
          ],
          regressionSuite: [],
          locked: false,
        },
        impactAnalysis: {
          directFiles: ['apps/demo/src/feature.ts'],
          dependentFiles: [],
          affectedTests: [],
          riskLevel: 'low',
          notes: 'Scoped to the current slice file only.',
        },
        exitCriteria: [
          {
            id: 'typecheck',
            type: 'typecheck',
            description: 'TypeScript compiles for the current slice',
            passed: false,
          },
        ],
      };
      session.slices = [session.slices[0]!];
      session.totalSlices = 1;

      let implementationCalls = 0;
      registerExecutor(
        engine,
        createExecutor('codex-cli', async (_prompt, spec) => {
          implementationCalls += 1;
          await writeFile(
            join(tempDir!, 'apps', 'demo', 'src', 'feature.ts'),
            'export const feature: "fixed" = "fixed";\n',
            'utf-8',
          );
          return {
            output: JSON.stringify({
              summary: 'Made the bounded edit before the exploration cap landed.',
              findings: [],
              decisions: [],
            }),
            model: spec.model ?? 'gpt-5.5',
            engine: spec.engine,
            turnsUsed: 3,
            durationMs: 100,
            error:
              "Codex issued 12 exploratory shell commands, exceeding HELIX's shell exploration budget. Stop this shell-heavy trajectory and continue from the evidence already gathered.",
          };
        }),
      );

      const commitManager = (
        engine as unknown as {
          commitManager: {
            performSliceCommit: (
              session: Session,
              slice: Slice,
              sliceIndex: number,
            ) => Promise<unknown>;
          };
        }
      ).commitManager;
      commitManager.performSliceCommit = async (_session, slice, sliceIndex) => ({
        sha: 'continuity1',
        message: `[ABLP-999] fix(core): ${slice.title}`,
        jiraKey: 'ABLP-999',
        sliceIndex,
        files: slice.manifest.fileContracts.map((contract) => contract.path),
        timestamp: '2026-04-01T00:00:00.000Z',
      });

      const result = await engine.run(session, {
        name: 'Implementation Continuity',
        description: 'Promote a bounded implementation diff into proof and commit',
        applicableTo: ['feature-audit'],
        stages: [createSliceImplementationStage()],
      });

      expect(result.state).toBe('completed');
      expect(implementationCalls).toBe(1);
      expect(result.slices[0]).toMatchObject({
        status: 'committed',
        commit: expect.objectContaining({ sha: 'continuity1' }),
      });
      expect(await readFile(join(tempDir, 'apps', 'demo', 'src', 'feature.ts'), 'utf-8')).toContain(
        '"fixed" = "fixed"',
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

function createConfig(
  workDir: string,
  invocationDir: string = workDir,
  overrides: Partial<HelixConfig> = {},
): HelixConfig {
  return {
    workDir,
    invocationDir,
    sessionDir: join(workDir, '.helix', 'sessions'),
    journalDir: join(workDir, '.helix', 'journal'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
    ...overrides,
  };
}

function createReporter(): ProgressReporter {
  return {
    emit(_event: ProgressEvent): void {},
    async onQuestion(): Promise<string> {
      return 'Use the scoped test file.';
    },
    async onCheckpoint(): Promise<boolean> {
      return true;
    },
  };
}

function createSlicedSession(): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';
  const slice: Slice = {
    index: 0,
    title: 'Stabilize shared seam',
    description: 'Move validation to the shared boundary before updating the consumer',
    status: 'pending',
    findings: ['finding-seam'],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'src/feature.ts',
          action: 'modify',
          reason: 'Shared seam under review',
          dependents: ['src/consumer.ts'],
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['src/feature.ts'],
      dependentFiles: ['src/consumer.ts'],
      affectedTests: [],
      riskLevel: 'medium',
      notes: 'One consumer still depends on the old branch structure.',
    },
    legacyPaths: [],
    exitCriteria: [],
  };

  return {
    id: 'session-sliced',
    workItem: {
      id: 'work-sliced',
      type: 'feature-audit',
      title: 'Slice architecture review',
      description: 'Ensure slice review blocks brittle seam fixes',
      scope: ['src/feature.ts'],
      targetBranch: 'current',
      jiraKey: 'ABLP-999',
      createdAt: timestamp,
    },
    pipelineName: 'Holistic Feature Audit',
    pipelineVersion: 'Holistic Feature Audit@123456789abc',
    state: 'executing',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 1,
    slices: [slice],
    findings: [
      {
        id: 'finding-seam',
        category: 'inconsistency',
        severity: 'high',
        status: 'open',
        title: 'Validation is patched in the consumer instead of the shared seam',
        description: 'The fix needs to move to the shared boundary.',
        files: [{ path: 'src/feature.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

function createExecutor(
  engine: ModelEngine,
  handler: (
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ) => Promise<ExecutorResult>,
): ModelExecutor {
  return {
    engine,
    execute: handler,
    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}

function registerExecutor(engine: PipelineEngine, executor: ModelExecutor): void {
  (engine as unknown as { modelRouter: ModelRouter }).modelRouter.registerExecutor(executor);
}

function createSliceImplementationStage(): StageDefinition {
  return {
    name: 'Implementation',
    type: 'implementation',
    description: 'Implement the bounded slice',
    model: {
      primary: { engine: 'codex-cli', model: 'gpt-5.5' },
    },
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    canLoop: true,
    maxLoopIterations: 1,
  };
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'helix-implementation-continuity-'));
  await mkdir(join(root, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'helix-implementation-continuity-root', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf-8');
  await writeFile(
    join(root, 'apps', 'demo', 'package.json'),
    JSON.stringify({ name: '@helix/demo', private: true }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(root, 'apps', 'demo', 'tsconfig.json'),
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
    join(root, 'apps', 'demo', 'src', 'feature.ts'),
    'export const feature: "fixed" = "broken";\n',
    'utf-8',
  );
  await writeFile(
    join(root, 'bin', 'pnpm'),
    [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const source = readFileSync(join(process.cwd(), 'apps', 'demo', 'src', 'feature.ts'), 'utf-8');",
      'if (!source.includes(\'"fixed" = "fixed"\')) {',
      '  console.error("apps/demo/src/feature.ts(1,14): error TS2322: Type \'\\"broken\\"\' is not assignable to type \'\\"fixed\\"\'.");',
      '  process.exit(1);',
      '}',
      "console.log('Typecheck passed');",
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(join(root, 'bin', 'pnpm'), 0o755);

  return root;
}
