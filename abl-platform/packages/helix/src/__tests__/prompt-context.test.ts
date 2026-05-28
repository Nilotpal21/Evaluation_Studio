import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPromptContext } from '../pipeline/prompt-context.js';
import { renderPromptContext } from '../pipeline/prompt-context.js';
import { buildStagePrompt } from '../pipeline/stage-runner.js';
import { createBgeM3Client } from '../intelligence/bge-m3-client.js';
import {
  buildEmbeddingShardPaths,
  HELIX_EMBEDDING_MODEL_KEY,
} from '../intelligence/embedding-config.js';
import { EmbeddingStore } from '../intelligence/embedding-store.js';
import { appendEmbeddingRecord } from '../intelligence/shard-writer.js';
import type { EmbeddingRecord, HelixConfig, Session, StageDefinition } from '../types.js';

describe('prompt-context', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('builds instruction, feature-spec, prior-run, and code-map context from the workspace', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-'));

    await writeWorkspaceFile(
      tempDir,
      'AGENTS.md',
      [
        '# AGENTS.md',
        '',
        'CRITICAL: Follow repo rules first.',
        '',
        '## Core Invariants',
        '- Root invariant',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'CLAUDE.md',
      ['# CLAUDE.md', '', '## Key Rules', '- Root claude rule'].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/agents.md',
      [
        '# agents.md',
        '',
        'Agents MUST read this file before modifying code in this package.',
        '',
        '## 2026-04-04 - Prompt Context',
        '',
        '**Learning**: Package-specific guidance matters.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/pipeline/stage-runner.ts',
      "export function buildStagePrompt(): string { return 'ok'; }\n",
    );
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/pipeline/pipeline-engine.ts',
      [
        "import { buildStagePrompt } from './stage-runner.js';",
        '',
        'export function runPipeline(): string {',
        '  return buildStagePrompt();',
        '}',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/__tests__/stage-runner.test.ts',
      [
        "import { buildStagePrompt } from '../pipeline/stage-runner.js';",
        '',
        'export const smoke = buildStagePrompt;',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/features/helix-context.md',
      [
        '---',
        'doc-type: feature-spec',
        '---',
        '',
        '# HELIX Context',
        '',
        '## Summary',
        'Improve prompt context loading.',
        '',
        '## Architecture',
        'Use preloaded docs plus a scoped code map.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/testing/helix-context.md',
      [
        '# HELIX Context Test Spec',
        '',
        '## Acceptance',
        '- Covers positive and negative prompt-context loading paths.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/specs/helix-context.hld.md',
      [
        '# HELIX Context HLD',
        '',
        '## Architecture',
        '- Prompt context must preload planning docs when available.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/plans/helix-context.lld.md',
      [
        '# HELIX Context LLD',
        '',
        '## Implementation Plan',
        '- Inject planning docs into implementation and regression prompts.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/sdlc-logs/helix-context/findings.md',
      ['# Findings', '', '- [HIGH] Old finding carried from a previous audit'].join('\n'),
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/sdlc-logs/helix-context/decisions.md',
      ['# Decisions', '', '### Use code map', '- Answer: yes'].join('\n'),
    );

    const session = createSession({
      title: 'HELIX Context',
      scope: ['packages/helix/src'],
      featureSpec: 'docs/features/helix-context.md',
      testSpec: 'docs/testing/helix-context.md',
      hldSpec: 'docs/specs/helix-context.hld.md',
      lldPlan: 'docs/plans/helix-context.lld.md',
    });
    const context = await buildPromptContext(session, createConfig(tempDir));
    const rendered = renderPromptContext('implementation', context);

    expect(context.buildDurationMs).toEqual(expect.any(Number));
    expect(context.buildDurationMs).toBeGreaterThanOrEqual(0);
    expect(context.instructionDocs.map((doc) => doc.path)).toEqual(
      expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', 'packages/helix/agents.md']),
    );
    expect(context.featureSpecDoc?.excerpt).toContain('## Summary');
    expect(context.testSpecDoc?.excerpt).toContain('## Acceptance');
    expect(context.hldSpecDoc?.excerpt).toContain('## Architecture');
    expect(context.lldPlanDoc?.excerpt).toContain('## Implementation Plan');
    expect(context.priorFindingsDoc?.excerpt).toContain('Old finding');
    expect(context.priorDecisionsDoc?.excerpt).toContain('Use code map');
    expect(context.codeMap?.keyFiles.map((file) => file.path)).toContain(
      'packages/helix/src/pipeline/stage-runner.ts',
    );
    expect(
      context.codeMap?.keyFiles.find(
        (file) => file.path === 'packages/helix/src/pipeline/stage-runner.ts',
      )?.dependents,
    ).toContain('packages/helix/src/pipeline/pipeline-engine.ts');
    expect(context.codeMap?.repoIndex).toMatchObject({
      cacheStatus: 'miss',
      scopedFileCount: 3,
    });
    expect(context.codeMap?.repoIndex?.loadDurationMs).toEqual(expect.any(Number));
    expect(context.codeMap?.repoIndex?.loadDurationMs).toBeGreaterThanOrEqual(0);
    expect(rendered).toContain('## Test Spec Excerpt');
    expect(rendered).toContain('## HLD Excerpt');
    expect(rendered).toContain('## LLD / Implementation Plan Excerpt');
  });

  it('records repo-index cache telemetry across repeated prompt-context builds', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-'));

    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/pipeline/stage-runner.ts',
      "export function buildStagePrompt(): string { return 'ok'; }\n",
    );
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/pipeline/pipeline-engine.ts',
      [
        "import { buildStagePrompt } from './stage-runner.js';",
        '',
        'export function runPipeline(): string {',
        '  return buildStagePrompt();',
        '}',
      ].join('\n'),
    );

    const session = createSession({
      title: 'HELIX Context',
      scope: ['packages/helix/src'],
    });
    const config = createConfig(tempDir);

    const firstContext = await buildPromptContext(session, config);
    const secondContext = await buildPromptContext(session, config);

    expect(firstContext.codeMap?.repoIndex).toMatchObject({
      cacheStatus: 'miss',
      scopedFileCount: 2,
    });
    expect(secondContext.codeMap?.repoIndex).toMatchObject({
      cacheStatus: 'hit',
      scopedFileCount: 2,
      diffHash: firstContext.codeMap?.repoIndex?.diffHash,
    });
  });

  it('loads prior context from same-project embedding shards through a real HTTP embedding endpoint', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-embeddings-'));
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/index.ts',
      'export const helix = true;\n',
    );

    const bge = await startBgeM3Fake();
    try {
      const basePath = join(tempDir, '.helix', 'cache', 'embeddings', HELIX_EMBEDDING_MODEL_KEY);
      const sameProjectShard = buildEmbeddingShardPaths({ basePath, sessionId: 'prior-same' });
      const otherProjectShard = buildEmbeddingShardPaths({ basePath, sessionId: 'prior-other' });

      await appendEmbeddingRecord(
        makeEmbeddingRecord('finding-same', 'finding', 'ABLP-778', 'prior-same', [1, 0, 0]),
        sameProjectShard,
      );
      await appendEmbeddingRecord(
        makeEmbeddingRecord('decision-same', 'decision', 'ABLP-778', 'prior-same', [0.95, 0.05, 0]),
        sameProjectShard,
      );
      await appendEmbeddingRecord(
        makeEmbeddingRecord('finding-other', 'finding', 'ABLP-999', 'prior-other', [1, 0, 0]),
        otherProjectShard,
      );

      const provider = {
        kind: 'bge-m3-local' as const,
        enabled: true,
        modelId: 'bge-m3',
        modelKey: HELIX_EMBEDDING_MODEL_KEY,
        dimensions: 3,
        baseUrl: bge.baseUrl,
        timeoutMs: 5_000,
        maxBatchSize: 8,
        requestBudget: 4,
        shardBasePath: basePath,
        shardLayout: 'per-session' as const,
      };
      const store = new EmbeddingStore(
        provider,
        createBgeM3Client({
          baseUrl: bge.baseUrl,
          timeoutMs: 5_000,
          maxBatchSize: 8,
        }),
      );
      const session = createSession({
        title: 'HELIX embeddings retrieval',
        description: 'Use prior auth findings',
        scope: ['packages/helix/src'],
        jiraKey: 'ABLP-778',
      });

      const context = await buildPromptContext(session, createConfig(tempDir), store);

      expect(context.priorFindingsDoc?.path).toBe('embedding://findings');
      expect(context.priorFindingsDoc?.excerpt).toContain('finding-same');
      expect(context.priorFindingsDoc?.excerpt).not.toContain('finding-other');
      expect(context.priorDecisionsDoc?.excerpt).toContain('decision-same');
      expect(context.retrievalTelemetry).toMatchObject({
        fallback: false,
        embeddingSource: 'bge-m3',
        topNReturned: 2,
        candidateCount: 2,
        includedCount: 2,
      });
      expect(bge.embedRequestCount()).toBe(2);
    } finally {
      await bge.close();
    }
  });

  it('falls back to slug prior docs when embedding retrieval throws', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-embeddings-fallback-'));
    const session = createSession({
      title: 'HELIX Embeddings Fallback',
      scope: ['packages/helix/src'],
      jiraKey: 'ABLP-778',
    });
    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/index.ts',
      'export const helix = true;\n',
    );
    await writeWorkspaceFile(
      tempDir,
      'docs/sdlc-logs/helix-embeddings-fallback/findings.md',
      '# Findings\n\n- Legacy slug finding still available\n',
    );

    const throwingStore = {
      query: async () => {
        throw new Error('embedding endpoint exploded');
      },
    } as unknown as EmbeddingStore;

    const context = await buildPromptContext(session, createConfig(tempDir), throwingStore);

    expect(context.priorFindingsDoc?.excerpt).toContain('Legacy slug finding');
    expect(context.retrievalTelemetry).toMatchObject({
      fallback: true,
      embeddingSource: 'fallback-slug',
      topNReturned: 0,
    });
  });

  it('drops oversized persisted file trees while retaining directory summaries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-'));

    for (let index = 0; index < 180; index += 1) {
      await writeWorkspaceFile(
        tempDir,
        `packages/helix/src/pipeline/file-${index + 1}.ts`,
        `export const pipeline${index + 1} = ${index + 1};\n`,
      );
    }

    for (let index = 0; index < 90; index += 1) {
      await writeWorkspaceFile(
        tempDir,
        `packages/helix/src/models/file-${index + 1}.ts`,
        `export const model${index + 1} = ${index + 1};\n`,
      );
    }

    const session = createSession({
      title: 'HELIX Context',
      scope: ['packages/helix/src'],
    });
    const context = await buildPromptContext(session, createConfig(tempDir));
    const rendered = renderPromptContext('deep-scan', context);

    expect(context.codeMap?.totalSourceFiles).toBe(270);
    expect(context.codeMap?.allFiles).toBeUndefined();
    expect(context.codeMap?.directorySummary?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: 'packages/helix/src/pipeline',
          fileCount: 180,
        }),
        expect.objectContaining({
          directory: 'packages/helix/src/models',
          fileCount: 90,
        }),
      ]),
    );
    expect(rendered).toContain('### Directory Summary');
    expect(rendered).toContain('packages/helix/src/pipeline (180 files)');
    expect(rendered).toContain('Complete file tree omitted for prompt size (270 scoped files).');
    expect(rendered).not.toContain('packages/helix/src/pipeline/file-180.ts');
  });

  it('rebases absolute source feature-spec paths into the detached worktree context', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-'));
    const sourceDir = join(tempDir, 'source');
    const worktreeDir = join(tempDir, 'worktree');

    await writeWorkspaceFile(
      sourceDir,
      'docs/features/helix-context.md',
      [
        '# Source Spec',
        '',
        '## Summary',
        'This should not be loaded from the source checkout.',
      ].join('\n'),
    );
    await writeWorkspaceFile(
      worktreeDir,
      'docs/features/helix-context.md',
      ['# Worktree Spec', '', '## Summary', 'This must be loaded from the detached worktree.'].join(
        '\n',
      ),
    );

    const session = createSession({
      title: 'HELIX Context',
      scope: ['packages/helix/src'],
      featureSpec: join(sourceDir, 'docs/features/helix-context.md'),
    });
    const config = createConfig(worktreeDir);
    config.workspaceContext = {
      mode: 'git-worktree',
      sourceWorkDir: sourceDir,
      worktreeDir,
    };

    const context = await buildPromptContext(session, config);

    expect(context.featureSpecDoc).toMatchObject({
      path: 'docs/features/helix-context.md',
    });
    expect(context.featureSpecDoc?.excerpt).toContain(
      'This must be loaded from the detached worktree.',
    );
    expect(context.featureSpecDoc?.excerpt).not.toContain(
      'This should not be loaded from the source checkout.',
    );
  });

  it('injects preloaded context blocks into deep-scan prompts', () => {
    const session = createSession({ title: 'HELIX Context', scope: ['packages/helix/src'] });
    session.promptContext = {
      builtAt: '2026-04-04T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'AGENTS.md',
          title: 'AGENTS.md',
          excerpt: 'CRITICAL: Follow repo rules first.',
        },
      ],
      featureSpecDoc: {
        path: 'docs/features/helix-context.md',
        title: 'Feature Spec',
        excerpt: '## Summary\nImprove prompt context loading.',
      },
      priorFindingsDoc: {
        path: 'docs/sdlc-logs/helix-context/findings.md',
        title: 'Prior Findings',
        excerpt: '- [HIGH] Old finding',
      },
      priorDecisionsDoc: {
        path: 'docs/sdlc-logs/helix-context/decisions.md',
        title: 'Prior Decisions',
        excerpt: '### Use code map\n- Answer: yes',
      },
      codeMap: {
        scope: ['packages/helix/src'],
        totalSourceFiles: 2,
        totalTestFiles: 1,
        keyFiles: [
          {
            path: 'packages/helix/src/pipeline/stage-runner.ts',
            exports: ['buildStagePrompt'],
            exportSignatures: {
              buildStagePrompt:
                'function buildStagePrompt(stage: StageDefinition, session: Session): string',
            },
            dependents: ['packages/helix/src/pipeline/pipeline-engine.ts'],
            isTestFile: false,
          },
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

    expect(prompt).toContain('## Repository Instructions');
    expect(prompt).toContain('## Feature Spec Excerpt');
    expect(prompt).toContain('## Prior HELIX Findings');
    expect(prompt).toContain('## Prior HELIX Decisions');
    expect(prompt).toContain('## Scoped Code Map');
    expect(prompt).toContain('packages/helix/src/pipeline/stage-runner.ts');
    expect(prompt).toContain(
      'function buildStagePrompt(stage: StageDefinition, session: Session): string',
    );
  });

  it('filters prompt-context sections by stage type', () => {
    const rendered = renderPromptContext('implementation', {
      builtAt: '2026-04-04T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'AGENTS.md',
          title: 'AGENTS.md',
          excerpt: 'CRITICAL: Follow repo rules first.',
        },
      ],
      featureSpecDoc: {
        path: 'docs/features/helix-context.md',
        title: 'Feature Spec',
        excerpt: '## Summary\nImprove prompt context loading.',
      },
      priorFindingsDoc: {
        path: 'docs/sdlc-logs/helix-context/findings.md',
        title: 'Prior Findings',
        excerpt: '- [HIGH] Old finding',
      },
      priorDecisionsDoc: {
        path: 'docs/sdlc-logs/helix-context/decisions.md',
        title: 'Prior Decisions',
        excerpt: '### Use code map\n- Answer: yes',
      },
      codeMap: {
        scope: ['packages/helix/src'],
        totalSourceFiles: 2,
        totalTestFiles: 1,
        keyFiles: [
          {
            path: 'packages/helix/src/pipeline/stage-runner.ts',
            exports: ['buildStagePrompt'],
            dependents: ['packages/helix/src/pipeline/pipeline-engine.ts'],
            isTestFile: false,
          },
        ],
      },
    });

    expect(rendered).toContain('## Repository Instructions');
    expect(rendered).toContain('## Feature Spec Excerpt');
    expect(rendered).toContain('## Scoped Code Map');
    expect(rendered).not.toContain('## Prior HELIX Findings');
    expect(rendered).not.toContain('## Prior HELIX Decisions');
  });

  it('renders a compact planning context without the full file tree', () => {
    const repeatedRule = Array.from(
      { length: 80 },
      (_, index) => `- Planning rule ${index + 1}`,
    ).join('\n');
    const rendered = renderPromptContext('plan-generation', {
      builtAt: '2026-04-04T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'AGENTS.md',
          title: 'AGENTS.md',
          excerpt: `## Core Invariants\n${repeatedRule}`,
        },
        {
          path: 'packages/web-sdk/agents.md',
          title: 'packages/web-sdk/agents.md',
          excerpt: `## 2026-04-04 — Learnings\n${repeatedRule}`,
        },
      ],
      codeMap: {
        scope: ['packages/web-sdk/src'],
        totalSourceFiles: 24,
        totalTestFiles: 8,
        keyFiles: Array.from({ length: 20 }, (_, index) => ({
          path: `packages/web-sdk/src/file-${index + 1}.ts`,
          exports: [`export${index + 1}`],
          dependents: [`packages/web-sdk/src/consumer-${index + 1}.ts`],
          isTestFile: false,
        })),
        allFiles: Array.from(
          { length: 50 },
          (_, index) => `packages/web-sdk/src/all-${index + 1}.ts`,
        ),
      },
    });

    expect(rendered).toContain('## Repository Instructions');
    expect(rendered).toContain('Planning rule 59');
    expect(rendered).not.toContain('Planning rule 80');
    expect(rendered).toContain('## Scoped Code Map');
    expect(rendered).toContain('complete file tree is omitted for plan generation');
    expect(rendered).toContain('### High-Signal Files (top dependents/exports)');
    expect(rendered).not.toContain('### Complete File Tree');
    expect(rendered).not.toContain('packages/web-sdk/src/all-50.ts');
    expect(rendered).not.toContain('packages/web-sdk/src/file-20.ts');
  });

  it('omits the full file tree for large deep-scan scopes while keeping directory context', () => {
    const rendered = renderPromptContext('deep-scan', {
      builtAt: '2026-04-04T00:00:00.000Z',
      instructionDocs: [],
      codeMap: {
        scope: ['packages/helix/src'],
        totalSourceFiles: 220,
        totalTestFiles: 12,
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
    });

    expect(rendered).toContain('## Scoped Code Map');
    expect(rendered).toContain('### Directory Summary');
    expect(rendered).toContain('packages/helix/src/pipeline (150 files)');
    expect(rendered).toContain('Complete file tree omitted for prompt size (232 scoped files).');
    expect(rendered).not.toContain('### Complete File Tree');
    expect(rendered).not.toContain('packages/helix/src/models/file-70.ts');
  });

  it('enriches high-signal code-map files with semantic export signatures', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-context-'));

    await writeWorkspaceFile(
      tempDir,
      'packages/helix/src/pipeline/stage-runner.ts',
      [
        'export function buildStagePrompt(stage: string, iteration = 1): string {',
        '  return `${stage}:${iteration}`;',
        '}',
        '',
        'export const renderStage = (name: string): string => name.toUpperCase();',
      ].join('\n'),
    );

    const session = createSession({
      title: 'HELIX Context',
      scope: ['packages/helix/src'],
    });
    const context = await buildPromptContext(session, createConfig(tempDir));
    const rendered = renderPromptContext('deep-scan', context);

    expect(
      context.codeMap?.keyFiles.find(
        (file) => file.path === 'packages/helix/src/pipeline/stage-runner.ts',
      )?.exportSignatures,
    ).toMatchObject({
      buildStagePrompt: 'function buildStagePrompt(stage: string, iteration = 1): string',
      renderStage: 'const renderStage(name: string): string',
    });
    expect(rendered).toContain('function buildStagePrompt(stage: string, iteration = 1): string');
    expect(rendered).toContain('const renderStage(name: string): string');
  });
});

async function writeWorkspaceFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = join(rootDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf-8');
}

function createConfig(workDir: string): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, '.helix', 'sessions'),
    journalDir: join(workDir, 'docs', 'sdlc-logs'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'extra-high',
      maxTurns: 20,
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 4,
    maxSliceRetries: 3,
    autoCommit: false,
    autoApprove: false,
    budgetLimitUsd: 100,
    verbose: false,
  };
}

function createSession({
  title,
  description = 'Test session',
  scope,
  jiraKey,
  featureSpec,
  testSpec,
  hldSpec,
  lldPlan,
}: {
  title: string;
  description?: string;
  scope: string[];
  jiraKey?: string;
  featureSpec?: string;
  testSpec?: string;
  hldSpec?: string;
  lldPlan?: string;
}): Session {
  const timestamp = '2026-04-04T00:00:00.000Z';

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title,
      description,
      scope,
      jiraKey,
      featureSpec,
      testSpec,
      hldSpec,
      lldPlan,
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
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    ...(jiraKey
      ? {
          bootstrapMeta: {
            jiraKey,
            jiraFetchSuccess: true,
            scopeInferenceMethod: 'deterministic',
            inferredScope: scope,
          },
        }
      : {}),
  };
}

function makeEmbeddingRecord(
  id: string,
  kind: EmbeddingRecord['kind'],
  projectId: string,
  sessionId: string,
  vector: number[],
): EmbeddingRecord {
  return {
    id,
    kind,
    contentHash: `hash-${id}`,
    model: 'bge-m3',
    dimensions: 3,
    vector,
    metadata: {
      severity: kind === 'finding' ? 'high' : undefined,
      category: kind === 'finding' ? 'security' : undefined,
      classification: kind === 'decision' ? 'DECIDED' : undefined,
      files: kind === 'finding' ? ['packages/helix/src/index.ts'] : [],
      featureSlug: `feature-${id}`,
      sessionId,
      projectId,
      createdAt: '2026-05-01T00:00:00.000Z',
    },
  };
}

async function startBgeM3Fake(): Promise<{
  baseUrl: string;
  embedRequestCount: () => number;
  close: () => Promise<void>;
}> {
  let embedRequests = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/embed') {
      embedRequests += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { texts?: string[] };
      const texts = body.texts ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          embeddings: texts.map(() => [1, 0, 0]),
          model: 'bge-m3',
          dimensions: 3,
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolveServer) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolveServer());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    embedRequestCount: () => embedRequests,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
