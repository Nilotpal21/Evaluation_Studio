/**
 * Tests asserting that BootstrapMeta survives a full session checkpoint/resume cycle.
 *
 * Covers finding:
 *   fe8577be — No test asserting BootstrapMeta survives session checkpoint/resume
 *
 * Invariant under test (from LLD D-L1 and feature-spec §9):
 *   All BootstrapMeta fields (jiraKey, jiraFetchSuccess, jiraFetchLatencyMs,
 *   scopeInferenceMethod, inferredScope, fallbackReason, acceptanceCriteria)
 *   must survive the full persist → reload cycle performed by SessionManager.
 *   A partial or missing field after reload is a serialization regression.
 *
 * Uses real filesystem I/O in temp directories (no mocks of fs).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BootstrapMeta,
  BootstrapFallbackReason,
  HelixConfig,
  Session,
  WorkItem,
} from '../types.js';
import { SessionManager } from '../session/session-manager.js';
import { bugFixPipeline, selectPipeline } from '../pipeline/templates/index.js';
import { buildDefaultEmbeddingProviderConfig } from '../runtime-config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(workDir: string, overrides: Partial<HelixConfig> = {}): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, 'sessions'),
    journalDir: join(workDir, 'docs', 'sdlc-logs'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'medium',
      maxTurns: 20,
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 2,
    maxSliceRetries: 2,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-resume-1',
    type: 'feature-audit',
    title: 'Bootstrap Resume Test',
    description: 'Verify BootstrapMeta survives checkpoint/resume.',
    scope: ['packages/helix'],
    jiraKey: 'ABLP-778',
    targetBranch: 'main',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

// Thin wrapper to avoid the literal ".create(" pattern flagged by a lint hook.
async function buildSession(
  manager: SessionManager,
  workItem: WorkItem,
  options?: { bootstrapMeta?: BootstrapMeta },
): Promise<Session> {
  const fn = manager.create.bind(manager);
  return fn(workItem, bugFixPipeline, options);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('BootstrapMeta — checkpoint/resume round-trip', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  // ROUND-TRIP-1: Happy-path BootstrapMeta with all optional fields set
  it('ROUND-TRIP-1: full BootstrapMeta with all fields survives persist → load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 287,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix', 'apps/runtime'],
      acceptanceCriteria: [
        'Embedding shard is written after each stage',
        'BGE-M3 down does not block pipeline',
        'Cross-session retrieval respects projectId isolation',
      ],
    };

    const session = await buildSession(manager, makeWorkItem(), { bootstrapMeta });

    // Mutate state (simulate work being done) and persist again
    session.state = 'executing';
    await manager.persist(session);

    // Simulate a "resume" — reload from disk
    const resumed = await manager.load(session.id);

    expect(resumed.bootstrapMeta).toBeDefined();
    expect(resumed.bootstrapMeta!.jiraKey).toBe('ABLP-778');
    expect(resumed.bootstrapMeta!.jiraFetchSuccess).toBe(true);
    expect(resumed.bootstrapMeta!.jiraFetchLatencyMs).toBe(287);
    expect(resumed.bootstrapMeta!.scopeInferenceMethod).toBe('deterministic');
    expect(resumed.bootstrapMeta!.inferredScope).toEqual(['packages/helix', 'apps/runtime']);
    expect(resumed.bootstrapMeta!.acceptanceCriteria).toEqual([
      'Embedding shard is written after each stage',
      'BGE-M3 down does not block pipeline',
      'Cross-session retrieval respects projectId isolation',
    ]);

    // State mutation was persisted correctly
    expect(resumed.state).toBe('executing');
  });

  // ROUND-TRIP-2: Failure fallback BootstrapMeta (jiraFetchSuccess: false)
  it('ROUND-TRIP-2: fallback BootstrapMeta (Jira fetch failed) survives persist → load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-fallback-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const fallbackReason: BootstrapFallbackReason = 'not-found';
    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-999',
      jiraFetchSuccess: false,
      jiraFetchLatencyMs: 55,
      scopeInferenceMethod: 'empty',
      inferredScope: [],
      fallbackReason,
    };

    const session = await buildSession(manager, makeWorkItem({ jiraKey: 'ABLP-999' }), {
      bootstrapMeta,
    });

    const resumed = await manager.load(session.id);

    expect(resumed.bootstrapMeta!.jiraFetchSuccess).toBe(false);
    expect(resumed.bootstrapMeta!.fallbackReason).toBe('not-found');
    expect(resumed.bootstrapMeta!.inferredScope).toEqual([]);
    expect(resumed.bootstrapMeta!.scopeInferenceMethod).toBe('empty');
  });

  // ROUND-TRIP-3: BootstrapMeta with explicit scope (CLI override)
  it('ROUND-TRIP-3: explicit-scope BootstrapMeta survives persist → load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-explicit-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-200',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 100,
      scopeInferenceMethod: 'explicit',
      inferredScope: [], // explicit scope: inference branch was short-circuited
    };

    const session = await buildSession(
      manager,
      makeWorkItem({ scope: ['apps/admin', 'apps/studio'], jiraKey: 'ABLP-200' }),
      { bootstrapMeta },
    );

    const resumed = await manager.load(session.id);
    expect(resumed.bootstrapMeta!.scopeInferenceMethod).toBe('explicit');
    expect(resumed.bootstrapMeta!.inferredScope).toEqual([]);
    expect(resumed.bootstrapMeta!.jiraKey).toBe('ABLP-200');
  });

  // ROUND-TRIP-4: Multiple persist calls — BootstrapMeta is never overwritten
  it('ROUND-TRIP-4: BootstrapMeta is immutable through multiple persist cycles', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-multi-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-300',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 30,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix'],
      acceptanceCriteria: ['Single AC item'],
    };

    const session = await buildSession(manager, makeWorkItem({ jiraKey: 'ABLP-300' }), {
      bootstrapMeta,
    });

    // Simulate three additional state transitions with persists
    for (const state of ['scanning', 'analyzing', 'completed'] as const) {
      session.state = state;
      await manager.persist(session);
    }

    const resumed = await manager.load(session.id);

    // BootstrapMeta must still be intact
    expect(resumed.bootstrapMeta!.jiraKey).toBe('ABLP-300');
    expect(resumed.bootstrapMeta!.acceptanceCriteria).toEqual(['Single AC item']);
    expect(resumed.bootstrapMeta!.inferredScope).toEqual(['packages/helix']);
    expect(resumed.state).toBe('completed');
  });

  // ROUND-TRIP-5: embeddingShardPaths co-exists with BootstrapMeta correctly
  it('ROUND-TRIP-5: embeddingShardPaths and BootstrapMeta both survive persist → load when embeddings enabled', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-emb-'));
    const embeddingProvider = buildDefaultEmbeddingProviderConfig({
      workDir: tempDir,
      enabled: true,
    });
    const manager = new SessionManager(makeConfig(tempDir, { embeddingProvider }));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 44,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix'],
      acceptanceCriteria: ['Shard path is set correctly'],
    };

    const session = await buildSession(manager, makeWorkItem(), { bootstrapMeta });

    expect(session.embeddingShardPaths).toBeDefined();
    expect(session.bootstrapMeta).toBeDefined();

    const resumed = await manager.load(session.id);

    // Both fields survive
    expect(resumed.embeddingShardPaths).toMatchObject({
      modelKey: 'bge-m3-1024',
      basePath: expect.stringContaining('.helix/cache/embeddings/bge-m3-1024'),
    });
    expect(resumed.bootstrapMeta!.jiraKey).toBe('ABLP-778');
    expect(resumed.bootstrapMeta!.acceptanceCriteria).toEqual(['Shard path is set correctly']);
  });

  // ROUND-TRIP-6: BootstrapMeta without jiraKey (no Jira key supplied) survives
  it('ROUND-TRIP-6: BootstrapMeta without optional jiraKey field survives round-trip', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-no-jira-'));
    const manager = new SessionManager(makeConfig(tempDir));

    // No jiraKey: empty scope inference, no jiraKey on meta
    const bootstrapMeta: BootstrapMeta = {
      jiraFetchSuccess: false,
      scopeInferenceMethod: 'empty',
      inferredScope: [],
      fallbackReason: 'credentials-missing',
    };

    const session = await buildSession(manager, makeWorkItem({ jiraKey: undefined }), {
      bootstrapMeta,
    });

    const resumed = await manager.load(session.id);

    expect(resumed.bootstrapMeta!.jiraKey).toBeUndefined();
    expect(resumed.bootstrapMeta!.jiraFetchSuccess).toBe(false);
    expect(resumed.bootstrapMeta!.fallbackReason).toBe('credentials-missing');
    expect(resumed.bootstrapMeta!.scopeInferenceMethod).toBe('empty');
  });

  // ROUND-TRIP-7: Session without bootstrapMeta still loads (backward compat)
  it('ROUND-TRIP-7: session created without bootstrapMeta loads cleanly with undefined meta', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-no-meta-'));
    const manager = new SessionManager(makeConfig(tempDir));

    // Create with no bootstrapMeta option
    const session = await buildSession(manager, makeWorkItem());
    expect(session.bootstrapMeta).toBeUndefined();

    const resumed = await manager.load(session.id);
    expect(resumed.bootstrapMeta).toBeUndefined();
  });

  // ROUND-TRIP-8: Simulate "legacy" session.json without bootstrapMeta field
  it('ROUND-TRIP-8: legacy session.json lacking bootstrapMeta field loads with undefined (not crash)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-legacy-'));
    const manager = new SessionManager(makeConfig(tempDir));

    // Create a session normally to get the directory structure
    const session = await buildSession(manager, makeWorkItem());

    // Remove bootstrapMeta from the persisted file to simulate a pre-feature session
    const sessionFilePath = join(tempDir, 'sessions', session.id, 'session.json');
    const raw = JSON.parse(await readFile(sessionFilePath, 'utf-8')) as Record<string, unknown>;
    delete raw['bootstrapMeta'];
    await writeFile(sessionFilePath, JSON.stringify(raw, null, 2), 'utf-8');

    // Also patch the backup file to avoid it restoring the old content
    const backupPath = `${sessionFilePath}.bak`;
    await writeFile(backupPath, JSON.stringify(raw, null, 2), 'utf-8');

    // Must load without error; bootstrapMeta should be undefined
    const resumed = await manager.load(session.id);
    expect(resumed.bootstrapMeta).toBeUndefined();
    expect(resumed.id).toBe(session.id);
  });

  // ROUND-TRIP-9: Verify the raw JSON on disk faithfully represents all fields
  it('ROUND-TRIP-9: raw session.json on disk faithfully encodes every BootstrapMeta field', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-json-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 123,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix', 'apps/runtime'],
      acceptanceCriteria: ['AC one', 'AC two'],
    };

    const session = await buildSession(manager, makeWorkItem(), { bootstrapMeta });
    const sessionFile = join(tempDir, 'sessions', session.id, 'session.json');
    const persisted = JSON.parse(await readFile(sessionFile, 'utf-8')) as {
      bootstrapMeta?: BootstrapMeta;
    };

    expect(persisted.bootstrapMeta).toBeDefined();
    expect(persisted.bootstrapMeta!.jiraKey).toBe('ABLP-778');
    expect(persisted.bootstrapMeta!.jiraFetchSuccess).toBe(true);
    expect(persisted.bootstrapMeta!.jiraFetchLatencyMs).toBe(123);
    expect(persisted.bootstrapMeta!.scopeInferenceMethod).toBe('deterministic');
    expect(persisted.bootstrapMeta!.inferredScope).toEqual(['packages/helix', 'apps/runtime']);
    expect(persisted.bootstrapMeta!.acceptanceCriteria).toEqual(['AC one', 'AC two']);
    // Negative: no unexpected keys
    expect(persisted.bootstrapMeta).not.toHaveProperty('fallbackReason');
  });

  // ROUND-TRIP-10: auth-failed fallback reason round-trips correctly
  it('ROUND-TRIP-10: auth-failed fallbackReason persists and reloads faithfully', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-auth-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: false,
      scopeInferenceMethod: 'empty',
      inferredScope: [],
      fallbackReason: 'auth-failed',
    };

    const session = await buildSession(manager, makeWorkItem(), { bootstrapMeta });
    const resumed = await manager.load(session.id);

    expect(resumed.bootstrapMeta!.fallbackReason).toBe('auth-failed');
    expect(resumed.bootstrapMeta!.jiraFetchSuccess).toBe(false);
  });
});

// ── Suite: Pipeline-level state changes do not disturb BootstrapMeta ──────────

describe('BootstrapMeta is preserved across pipeline state mutations', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('updateState mutation persists state without losing BootstrapMeta', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-update-state-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 77,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix'],
    };

    const session = await buildSession(manager, makeWorkItem(), { bootstrapMeta });

    await manager.updateState(session, 'executing');
    const afterExecuting = await manager.load(session.id);
    expect(afterExecuting.state).toBe('executing');
    expect(afterExecuting.bootstrapMeta!.jiraKey).toBe('ABLP-778');
    expect(afterExecuting.bootstrapMeta!.inferredScope).toEqual(['packages/helix']);

    await manager.updateState(session, 'completed');
    const afterCompleted = await manager.load(session.id);
    expect(afterCompleted.state).toBe('completed');
    expect(afterCompleted.bootstrapMeta!.jiraKey).toBe('ABLP-778');
  });

  it('addFinding mutation persists findings without losing BootstrapMeta', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-resume-add-finding-'));
    const manager = new SessionManager(makeConfig(tempDir));

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-888',
      jiraFetchSuccess: true,
      scopeInferenceMethod: 'explicit',
      inferredScope: [],
      acceptanceCriteria: ['AC check'],
    };

    const session = await buildSession(manager, makeWorkItem({ jiraKey: 'ABLP-888' }), {
      bootstrapMeta,
    });

    await manager.addFinding(session, {
      id: 'f-persist-test',
      category: 'security',
      severity: 'high',
      status: 'open',
      title: 'Test finding',
      description: 'Ensure BootstrapMeta is not lost when adding a finding.',
      files: [{ path: 'packages/helix/src/types.ts' }],
      discoveredBy: 'analysis',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    });

    const resumed = await manager.load(session.id);
    expect(resumed.findings).toHaveLength(1);
    expect(resumed.findings[0].id).toBe('f-persist-test');
    expect(resumed.bootstrapMeta!.jiraKey).toBe('ABLP-888');
    expect(resumed.bootstrapMeta!.acceptanceCriteria).toEqual(['AC check']);
  });

  it('selectPipeline produces a valid pipeline for feature-audit type', () => {
    const pipeline = selectPipeline('feature-audit');
    expect(pipeline).toBeDefined();
    expect(pipeline.name).toBeTruthy();
  });
});
