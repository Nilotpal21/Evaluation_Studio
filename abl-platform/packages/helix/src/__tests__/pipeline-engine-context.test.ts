import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildPromptContextMock, notifyStageCompleteMock } = vi.hoisted(() => ({
  buildPromptContextMock: vi.fn(),
  notifyStageCompleteMock: vi.fn<() => Promise<void>>(),
}));

vi.mock('../pipeline/prompt-context.js', async () => {
  const actual = await vi.importActual<typeof import('../pipeline/prompt-context.js')>(
    '../pipeline/prompt-context.js',
  );

  return {
    ...actual,
    buildPromptContext: buildPromptContextMock,
  };
});

vi.mock('../intelligence/embedding-store.js', () => {
  class MockEmbeddingStore {
    notifyStageComplete = notifyStageCompleteMock;
    query = vi.fn().mockResolvedValue([]);
  }
  return { EmbeddingStore: MockEmbeddingStore };
});

import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import { SessionManager } from '../session/session-manager.js';
import type {
  HelixConfig,
  PipelineTemplate,
  ProgressEvent,
  ProgressReporter,
  WorkItem,
} from '../types.js';

describe('PipelineEngine prompt context refresh', () => {
  let workDir: string | null = null;

  beforeEach(() => {
    buildPromptContextMock.mockReset();
  });

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('persists refreshed prompt context before executing stages', async () => {
    workDir = await createWorkspace();
    const events: ProgressEvent[] = [];
    buildPromptContextMock.mockResolvedValue({
      builtAt: '2026-04-04T00:00:00.000Z',
      buildDurationMs: 18,
      instructionDocs: [
        {
          path: 'AGENTS.md',
          title: 'AGENTS.md',
          excerpt: 'CRITICAL: Follow repo rules first.',
        },
      ],
      codeMap: {
        scope: ['src'],
        totalSourceFiles: 1,
        totalTestFiles: 1,
        keyFiles: [
          {
            path: 'src/bug.test.ts',
            exports: [],
            dependents: [],
            isTestFile: true,
          },
        ],
        repoIndex: {
          cacheStatus: 'hit',
          scopedFileCount: 2,
          loadDurationMs: 7,
          diffHash: 'repo-diff-hash',
        },
      },
    });

    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createCheckpointPipeline());
    const engine = new PipelineEngine(config, createReporter(events));

    const result = await engine.run(session, createCheckpointPipeline());
    const persisted = await sessionManager.load(session.id);
    const contextSetupEvent = events.find(
      (event) => event.stage === 'Context Setup' && event.message.startsWith('Preloaded '),
    );

    expect(result.state).toBe('completed');
    expect(buildPromptContextMock).toHaveBeenCalledTimes(1);
    expect(result.promptContext).toMatchObject({
      buildDurationMs: 18,
      instructionDocs: [
        expect.objectContaining({
          path: 'AGENTS.md',
        }),
      ],
    });
    expect(persisted.promptContext).toMatchObject({
      codeMap: expect.objectContaining({
        totalTestFiles: 1,
      }),
    });
    expect(contextSetupEvent?.message).toContain('prompt context 18 ms');
    expect(contextSetupEvent?.message).toContain('repo-index cache hit for 2 files in 7 ms');
    expect(contextSetupEvent?.details).toMatchObject({
      instructionDocCount: 1,
      codeMapEntryCount: 1,
      promptContextBuildDurationMs: 18,
      repoIndexCacheStatus: 'hit',
      repoIndexScopedFileCount: 2,
      repoIndexLoadDurationMs: 7,
      repoIndexDiffHash: 'repo-diff-hash',
    });
  });

  it('continues the run when prompt context refresh fails', async () => {
    workDir = await createWorkspace();
    buildPromptContextMock.mockRejectedValueOnce(new Error('context blew up'));

    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createCheckpointPipeline());
    const engine = new PipelineEngine(config, createReporter());

    const result = await engine.run(session, createCheckpointPipeline());
    const persisted = await sessionManager.load(session.id);

    expect(result.state).toBe('completed');
    expect(result.promptContext).toBeUndefined();
    expect(persisted.promptContext).toBeUndefined();
    expect(result.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'Context Setup',
          message: expect.stringContaining('Prompt context refresh failed: context blew up'),
        }),
      ]),
    );
  });

  it('copies retrieval telemetry from prompt context onto retrieval-gated stage results', async () => {
    workDir = await createWorkspace();
    notifyStageCompleteMock.mockResolvedValue(undefined);
    buildPromptContextMock.mockResolvedValue({
      builtAt: '2026-05-02T00:00:00.000Z',
      instructionDocs: [],
      retrievalTelemetry: {
        queriedAt: '2026-05-02T00:00:01.000Z',
        topNReturned: 2,
        latencyMs: 11,
        fallback: false,
        embeddingSource: 'bge-m3',
        candidateCount: 2,
        includedCount: 2,
      },
    });

    const config = createConfigWithEmbeddings(workDir);
    const sessionManager = new SessionManager(config);
    const pipeline = createSkippedPlanGenerationPipeline();
    const session = await sessionManager.create(createWorkItem(), pipeline);
    const engine = new PipelineEngine(config, createReporter());

    const result = await engine.run(session, pipeline);

    expect(result.state).toBe('completed');
    expect(result.stageHistory[0]).toMatchObject({
      stageType: 'plan-generation',
      status: 'skipped',
      retrieval: {
        embeddingSource: 'bge-m3',
        fallback: false,
        topNReturned: 2,
      },
    });
  });
});

describe('PipelineEngine onStageCompleted — embedding hook and error envelope', () => {
  let workDir: string | null = null;

  beforeEach(() => {
    buildPromptContextMock.mockReset();
    notifyStageCompleteMock.mockReset();
  });

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('fires the embedding hook after stage completion when embeddingProvider is enabled', async () => {
    // Verifies that onStageCompleted() calls EmbeddingStore.notifyStageComplete
    // for the checkpoint stage (1st push site via the skip/user-approval path).
    workDir = await createWorkspace();
    notifyStageCompleteMock.mockResolvedValue(undefined);
    buildPromptContextMock.mockResolvedValue(undefined);

    const config = createConfigWithEmbeddings(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createCheckpointPipeline());
    const engine = new PipelineEngine(config, createReporter());

    const result = await engine.run(session, createCheckpointPipeline());

    expect(result.state).toBe('completed');
    // The user-checkpoint stage completes via the autoApprove path → push site 2 (main path)
    expect(notifyStageCompleteMock).toHaveBeenCalledTimes(1);
    expect(notifyStageCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({ name: 'Approval' }),
    );
  });

  it('journals a structured error entry and does not block the pipeline when the embedding hook throws', async () => {
    // Verifies error envelope invariant (D-L10): an embedding failure routes
    // through journal type:'error' and never stalls or fails the pipeline.
    workDir = await createWorkspace();
    notifyStageCompleteMock.mockRejectedValue(new Error('BGE-M3 endpoint timeout'));
    buildPromptContextMock.mockResolvedValue(undefined);

    const config = createConfigWithEmbeddings(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createCheckpointPipeline());
    const engine = new PipelineEngine(config, createReporter());

    const result = await engine.run(session, createCheckpointPipeline());

    // Pipeline must complete even when the embedding hook throws
    expect(result.state).toBe('completed');

    // Journal must contain a structured error entry for the embedding failure
    expect(result.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Embedding hook failed (non-blocking)'),
          details: expect.objectContaining({ embeddingError: true }),
        }),
      ]),
    );
  });

  it('contentHash is computed lazily inside the embedding hook (D-L8) — notifyStageComplete receives the session after findings are present', async () => {
    // Verifies D-L8: contentHash is computed inside the embedding hook, not at
    // persistFindings time. The session passed to notifyStageComplete must
    // already contain the findings so the hook can hash their content.
    workDir = await createWorkspace();
    let capturedSessionFindings: unknown[] = [];
    notifyStageCompleteMock.mockImplementation(async (session) => {
      capturedSessionFindings = [...(session.findings ?? [])];
    });
    buildPromptContextMock.mockResolvedValue(undefined);

    const config = createConfigWithEmbeddings(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createCheckpointPipeline());

    // Seed a finding onto the session before running — simulates findings
    // from a prior stage being present when the hook fires.
    await sessionManager.addFinding(session, {
      id: 'finding-d-l8-test',
      severity: 'medium',
      category: 'architecture',
      title: 'Lazy contentHash test finding',
      description: 'Verifies D-L8: finding present in session when hook fires.',
      files: [{ path: 'src/bug.test.ts', startLine: 1, endLine: 1 }],
      horizon: 'immediate',
      createdAt: new Date().toISOString(),
      stage: 'Approval',
    });

    const engine = new PipelineEngine(config, createReporter());
    const result = await engine.run(session, createCheckpointPipeline());

    expect(result.state).toBe('completed');
    // The hook received the session with findings already present
    expect(capturedSessionFindings).toHaveLength(1);
    expect(capturedSessionFindings[0]).toMatchObject({ id: 'finding-d-l8-test' });
  });
});

function createConfigWithEmbeddings(workDir: string): HelixConfig {
  return {
    ...createConfig(workDir),
    embeddingProvider: {
      kind: 'bge-m3-local',
      enabled: true,
      modelId: 'bge-m3',
      modelKey: 'bge-m3-1024',
      dimensions: 1024,
      baseUrl: 'http://localhost:8000',
      timeoutMs: 5_000,
      maxBatchSize: 32,
      requestBudget: 100,
      shardBasePath: join(workDir, '.helix', 'embeddings'),
      shardLayout: 'per-session',
    },
  };
}

function createCheckpointPipeline(): PipelineTemplate {
  return {
    name: 'Checkpoint Pipeline',
    description: 'Minimal pipeline for prompt-context tests',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Approval',
        type: 'user-checkpoint',
        description: 'Approve the run before continuing',
        model: {
          primary: {
            engine: 'claude-code',
            model: 'opus',
          },
        },
        canLoop: false,
        maxLoopIterations: 1,
        checkpoint: 'user-approval',
      },
    ],
  };
}

function createSkippedPlanGenerationPipeline(): PipelineTemplate {
  return {
    name: 'Plan Generation Pipeline',
    description: 'Minimal retrieval telemetry pipeline',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Plan Generation',
        type: 'plan-generation',
        description: 'Skipped plan generation when no actionable findings exist',
        prompt: 'Plan the work.',
        model: {
          primary: {
            engine: 'claude-code',
            model: 'opus',
          },
        },
        canLoop: false,
        maxLoopIterations: 1,
      },
    ],
  };
}

function createConfig(workDir: string): HelixConfig {
  return {
    workDir,
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
  };
}

function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'work-item-1',
    type: 'feature-audit',
    title: 'Prompt Context Engine Test',
    description: 'Ensure prompt context refreshes cleanly',
    scope: ['src/bug.test.ts'],
    targetBranch: 'current',
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function createReporter(events: ProgressEvent[] = []): ProgressReporter {
  return {
    emit(event): void {
      events.push(event);
    },
    async onQuestion(): Promise<string> {
      return 'Proceed';
    },
    async onCheckpoint(): Promise<boolean> {
      return true;
    },
  };
}

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-pipeline-engine-context-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'src', 'bug.test.ts'),
    "import { it, expect } from 'vitest';\n\nit('baseline', () => {\n  expect(true).toBe(true);\n});\n",
    'utf-8',
  );
  return dir;
}
