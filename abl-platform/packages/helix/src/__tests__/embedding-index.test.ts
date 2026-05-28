/**
 * Tests for the embedding index subsystem:
 *   - Cross-session embedding retrieval (EmbeddingStore.query)
 *   - Index-rebuild path (rebuildEmbeddingIndex from helix-indexer.ts)
 *   - BGE-M3 endpoint-unavailable graceful degradation
 *
 * Covers the findings:
 *   dc67af71 — No test for cross-session embedding retrieval or index-rebuild
 *
 * All tests use real filesystem I/O in temp directories but mock the HTTP
 * embedding client so no live BGE-M3 service is required.
 */

import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EmbeddingRecord,
  HelixEmbeddingProviderConfig,
  Session,
  StageDefinition,
} from '../types.js';
import { EmbeddingStore } from '../intelligence/embedding-store.js';
import { rebuildEmbeddingIndex } from '../intelligence/helix-indexer.js';
import { appendEmbeddingRecord, writeConsolidatedShardFile } from '../intelligence/shard-writer.js';
import {
  buildEmbeddingShardPaths,
  HELIX_EMBEDDING_MODEL_KEY,
} from '../intelligence/embedding-config.js';
import type { BgeM3Client, EmbedResponse } from '../intelligence/bge-m3-client.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProvider(
  basePath: string,
  overrides: Partial<HelixEmbeddingProviderConfig> = {},
): HelixEmbeddingProviderConfig {
  return {
    kind: 'bge-m3-local',
    enabled: true,
    modelId: 'bge-m3',
    modelKey: HELIX_EMBEDDING_MODEL_KEY,
    dimensions: 3,
    baseUrl: 'http://localhost:8000',
    timeoutMs: 5_000,
    maxBatchSize: 32,
    requestBudget: 100,
    shardBasePath: basePath,
    shardLayout: 'per-session',
    ...overrides,
  };
}

function makeClient(overrides: Partial<BgeM3Client> = {}): BgeM3Client {
  return {
    embedBatch: vi.fn().mockResolvedValue({
      embeddings: [[0.9, 0.1, 0.0]],
      model: 'bge-m3',
      dimensions: 3,
    } satisfies EmbedResponse),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeSession(id: string, projectId = 'PROJ-1'): Session {
  return {
    id,
    workItem: {
      id: 'wi-1',
      type: 'feature-audit',
      title: 'Auth security hardening',
      description: 'Harden the auth module.',
      scope: ['apps/runtime'],
      jiraKey: projectId,
      targetBranch: 'main',
      createdAt: '2026-05-01T00:00:00Z',
    },
    bootstrapMeta: {
      jiraKey: projectId,
      jiraFetchSuccess: true,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['apps/runtime'],
    },
    pipelineName: 'holistic-audit',
    pipelineVersion: '1.0.0',
    state: 'running',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 1,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function makeStage(name = 'analysis'): StageDefinition {
  return {
    name,
    type: 'analysis',
    prompt: 'Analyse the codebase.',
    exitCriteria: [],
    entryConditions: [],
  } as unknown as StageDefinition;
}

function makeEmbeddingRecord(
  id: string,
  projectId: string,
  sessionId: string,
  kind: EmbeddingRecord['kind'] = 'finding',
  vector: number[] = [0.9, 0.1, 0.0],
): EmbeddingRecord {
  return {
    id,
    kind,
    contentHash: `hash-${id}`,
    model: 'bge-m3',
    dimensions: 3,
    vector,
    metadata: {
      featureSlug: 'auth-security-hardening',
      sessionId,
      projectId,
      files: ['apps/runtime/src/auth.ts'],
      createdAt: '2026-05-01T00:00:00Z',
    },
  };
}

// ── Suite: EmbeddingStore cross-session retrieval ─────────────────────────────

describe('EmbeddingStore — cross-session retrieval', () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-emb-idx-'));
    basePath = join(tempDir, 'embeddings');
    await mkdir(basePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('retrieves findings from multiple sessions in the same project', async () => {
    // Write two records from different sessions but same project into separate shards
    const shardA = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-A' });
    const shardB = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-B' });

    const recA = makeEmbeddingRecord('f-1', 'PROJ-1', 'sess-A', 'finding', [0.9, 0.1, 0.0]);
    const recB = makeEmbeddingRecord('f-2', 'PROJ-1', 'sess-B', 'finding', [0.8, 0.2, 0.0]);

    await appendEmbeddingRecord(recA, shardA);
    await appendEmbeddingRecord(recB, shardB);

    const provider = makeProvider(basePath);
    // The client returns a query vector similar to our stored vectors
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.9, 0.1, 0.0]],
        model: 'bge-m3',
        dimensions: 3,
      }),
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('SQL injection in auth route', {
      projectId: 'PROJ-1',
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map((r) => r.record.id);
    expect(ids).toContain('f-1');
    expect(ids).toContain('f-2');
  });

  it('ISOLATION: does NOT return records from a different project', async () => {
    // Write records for two different projects
    const shardA = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-proj1' });
    const shardB = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-proj2' });

    const recProj1 = makeEmbeddingRecord('f-proj1', 'PROJ-1', 'sess-proj1');
    const recProj2 = makeEmbeddingRecord('f-proj2', 'PROJ-2', 'sess-proj2');

    await appendEmbeddingRecord(recProj1, shardA);
    await appendEmbeddingRecord(recProj2, shardB);

    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.9, 0.1, 0.0]],
        model: 'bge-m3',
        dimensions: 3,
      }),
    });
    const store = new EmbeddingStore(provider, client);

    // Query scoped to PROJ-1 only
    const results = await store.query('auth security', { projectId: 'PROJ-1' });

    const ids = results.map((r) => r.record.id);
    expect(ids).toContain('f-proj1');
    expect(ids).not.toContain('f-proj2');
  });

  it('session-scoped query restricts to a single session shard', async () => {
    const shardA = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-A' });
    const shardB = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-B' });

    await appendEmbeddingRecord(makeEmbeddingRecord('f-A', 'PROJ-1', 'sess-A'), shardA);
    await appendEmbeddingRecord(makeEmbeddingRecord('f-B', 'PROJ-1', 'sess-B'), shardB);

    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.9, 0.1, 0.0]],
        model: 'bge-m3',
        dimensions: 3,
      }),
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('auth', {
      projectId: 'PROJ-1',
      sessionId: 'sess-A',
    });

    const ids = results.map((r) => r.record.id);
    expect(ids).toContain('f-A');
    expect(ids).not.toContain('f-B');
  });

  it('returns empty array when provider is disabled', async () => {
    const provider = makeProvider(basePath, { enabled: false });
    const client = makeClient();
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('anything', { projectId: 'PROJ-1' });
    expect(results).toEqual([]);
    expect(client.embedBatch).not.toHaveBeenCalled();
  });

  it('returns empty array when query text is blank', async () => {
    const provider = makeProvider(basePath);
    const client = makeClient();
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('   ', { projectId: 'PROJ-1' });
    expect(results).toEqual([]);
    expect(client.embedBatch).not.toHaveBeenCalled();
  });

  it('returns empty array when there are no shards matching the project', async () => {
    // No shard files written — empty basePath
    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.9, 0.1, 0.0]],
        model: 'bge-m3',
        dimensions: 3,
      }),
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('SQL injection', { projectId: 'PROJ-1' });
    expect(results).toEqual([]);
  });

  it('respects topN limit', async () => {
    // Write 5 records
    for (let i = 0; i < 5; i++) {
      const shard = buildEmbeddingShardPaths({ basePath, sessionId: `sess-${i}` });
      await appendEmbeddingRecord(
        makeEmbeddingRecord(`f-${i}`, 'PROJ-1', `sess-${i}`, 'finding', [0.9, 0.1, 0.0]),
        shard,
      );
    }

    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.9, 0.1, 0.0]],
        model: 'bge-m3',
        dimensions: 3,
      }),
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('auth', { projectId: 'PROJ-1' }, { topN: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ── Suite: BGE-M3 endpoint unavailable — graceful degradation ─────────────────

describe('EmbeddingStore — BGE-M3 endpoint unavailable graceful degradation', () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-emb-degrade-'));
    basePath = join(tempDir, 'embeddings');
    await mkdir(basePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('notifyStageComplete does NOT throw when embedBatch returns null (endpoint down)', async () => {
    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue(null), // endpoint unreachable
    });
    const store = new EmbeddingStore(provider, client);

    const session = makeSession('sess-degrade');
    session.findings = [
      {
        id: 'f-degrade',
        category: 'security',
        severity: 'high',
        status: 'open',
        title: 'SQL injection in auth',
        description: 'User input unsanitized.',
        files: [{ path: 'apps/runtime/src/auth.ts', lines: [42] }],
        discoveredBy: 'analysis',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ];

    // Must not throw — graceful degradation
    await expect(
      store.notifyStageComplete(session, makeStage('analysis')),
    ).resolves.toBeUndefined();
  });

  it('query returns empty array when embedBatch returns null (endpoint down)', async () => {
    // Populate a real shard so there is something to retrieve
    const shard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-ok' });
    await appendEmbeddingRecord(makeEmbeddingRecord('f-ok', 'PROJ-1', 'sess-ok'), shard);

    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockResolvedValue(null), // cannot embed query
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('auth', { projectId: 'PROJ-1' });
    expect(results).toEqual([]);
  });

  it('notifyStageComplete does NOT throw when embedBatch rejects (network error)', async () => {
    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const store = new EmbeddingStore(provider, client);

    const session = makeSession('sess-net-err');
    session.findings = [
      {
        id: 'f-net',
        category: 'bug',
        severity: 'medium',
        status: 'open',
        title: 'Race condition',
        description: 'Concurrency issue.',
        files: [{ path: 'apps/runtime/src/session.ts' }],
        discoveredBy: 'analysis',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ];

    await expect(store.notifyStageComplete(session, makeStage())).resolves.toBeUndefined();
  });

  it('query returns empty array when embedBatch rejects (network error)', async () => {
    const shard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-query-reject' });
    await appendEmbeddingRecord(
      makeEmbeddingRecord('f-query-reject', 'PROJ-1', 'sess-query-reject'),
      shard,
    );

    const provider = makeProvider(basePath);
    const client = makeClient({
      embedBatch: vi.fn().mockRejectedValue(new Error('socket hang up')),
    });
    const store = new EmbeddingStore(provider, client);

    const results = await store.query('auth', { projectId: 'PROJ-1' });
    expect(results).toEqual([]);
  });

  it('skips embedding when stage has no new findings or decisions', async () => {
    const provider = makeProvider(basePath);
    const embedBatchSpy = vi.fn().mockResolvedValue(null);
    const client = makeClient({ embedBatch: embedBatchSpy });
    const store = new EmbeddingStore(provider, client);

    const session = makeSession('sess-empty-stage');
    // No findings or decisions on the session

    await store.notifyStageComplete(session, makeStage());
    expect(embedBatchSpy).not.toHaveBeenCalled();
  });
});

// ── Suite: Index-rebuild path ─────────────────────────────────────────────────

describe('rebuildEmbeddingIndex', () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-rebuild-'));
    basePath = join(tempDir, 'embeddings');
    await mkdir(basePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeRebuildProvider(
    overrides: Partial<HelixEmbeddingProviderConfig> = {},
  ): HelixEmbeddingProviderConfig {
    return makeProvider(basePath, overrides);
  }

  it('returns zero counts when there are no shard files', async () => {
    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider);

    expect(result.filesScanned).toBe(0);
    expect(result.findingsWritten).toBe(0);
    expect(result.decisionsWritten).toBe(0);
    expect(result.rowsSkipped).toBe(0);
    expect(result.dryRun).toBe(false);
    expect(result.manifest).toBeDefined();
  });

  it('consolidates multiple session shards into a flat findings.jsonl', async () => {
    const shardA = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-A' });
    const shardB = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-B' });

    await appendEmbeddingRecord(makeEmbeddingRecord('f-1', 'PROJ-1', 'sess-A'), shardA);
    await appendEmbeddingRecord(makeEmbeddingRecord('f-2', 'PROJ-1', 'sess-B'), shardB);

    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider);

    expect(result.filesScanned).toBe(2);
    expect(result.findingsWritten).toBe(2);
    expect(result.decisionsWritten).toBe(0);
    expect(result.dryRun).toBe(false);

    // Verify consolidated file was written
    const consolidatedPath = join(basePath, 'findings.jsonl');
    const raw = await readFile(consolidatedPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const ids = lines.map((l) => (JSON.parse(l) as EmbeddingRecord).id);
    expect(ids).toContain('f-1');
    expect(ids).toContain('f-2');
  });

  it('consolidates decision shards alongside findings', async () => {
    const shard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-C' });

    await appendEmbeddingRecord(makeEmbeddingRecord('f-C', 'PROJ-1', 'sess-C', 'finding'), shard);
    await appendEmbeddingRecord(makeEmbeddingRecord('d-C', 'PROJ-1', 'sess-C', 'decision'), shard);

    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider);

    expect(result.findingsWritten).toBe(1);
    expect(result.decisionsWritten).toBe(1);
    expect(result.filesScanned).toBe(2); // one findings shard + one decisions shard
  });

  it('dry-run mode scans shards but writes nothing', async () => {
    const shard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-dry' });
    await appendEmbeddingRecord(makeEmbeddingRecord('f-dry', 'PROJ-1', 'sess-dry'), shard);

    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.filesScanned).toBe(1);
    expect(result.findingsWritten).toBe(0); // nothing written in dry-run
    expect(result.decisionsWritten).toBe(0);

    // Consolidated file should NOT exist
    const consolidatedPath = join(basePath, 'findings.jsonl');
    await expect(readFile(consolidatedPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns immediately when provider is disabled', async () => {
    const provider = makeRebuildProvider({ enabled: false });
    const result = await rebuildEmbeddingIndex(provider);

    expect(result.dryRun).toBe(false);
    expect(result.filesScanned).toBe(0);
    expect(result.findingsWritten).toBe(0);
    expect(result.manifest).toBeUndefined();
  });

  it('manifest contains model info and a generated timestamp', async () => {
    const provider = makeRebuildProvider();
    const before = new Date().toISOString();
    const result = await rebuildEmbeddingIndex(provider);
    const after = new Date().toISOString();

    expect(result.manifest).toBeDefined();
    expect(result.manifest!.model).toBe('bge-m3');
    expect(result.manifest!.version).toBe(1);
    expect(result.manifest!.generatedAt >= before).toBe(true);
    expect(result.manifest!.generatedAt <= after).toBe(true);
  });

  it('handles shard files with corrupt (non-JSON) lines gracefully', async () => {
    // Write one valid shard and one file that contains malformed JSONL lines.
    // readEmbeddingShardFile skips bad lines rather than throwing, so the
    // indexer still scans the file and the valid shard record is written.
    // rowsSkipped is only incremented when the WHOLE file throws (e.g. unreadable).
    const validShard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-valid' });
    await appendEmbeddingRecord(makeEmbeddingRecord('f-valid', 'PROJ-1', 'sess-valid'), validShard);

    // Write a file with a mix of valid and corrupt lines directly into the findings dir
    const findingsDir = join(basePath, 'findings');
    const corruptRecord = makeEmbeddingRecord('f-corrupt', 'PROJ-1', 'sess-corrupt');
    const { writeFile: fsWriteFile } = await import('node:fs/promises');
    await fsWriteFile(
      join(findingsDir, 'mixed.jsonl'),
      `not-valid-json\n${JSON.stringify(corruptRecord)}\n`,
      'utf-8',
    );

    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider);

    // Both shard files are scanned
    expect(result.filesScanned).toBe(2);
    // The valid record from sess-valid + the valid record from mixed.jsonl = 2
    expect(result.findingsWritten).toBe(2);
    // rowsSkipped reflects file-level errors (whole file unreadable), not line-level
    // malformed lines are silently discarded by readEmbeddingShardFile
    expect(result.rowsSkipped).toBe(0);
  });

  it('increments rowsSkipped when a shard file cannot be read at all', async () => {
    // Create the findings directory with one valid shard
    const validShard = buildEmbeddingShardPaths({ basePath, sessionId: 'sess-ok' });
    await appendEmbeddingRecord(makeEmbeddingRecord('f-ok', 'PROJ-1', 'sess-ok'), validShard);

    // Create a directory entry that has the right name but cannot be read as a file
    // by making it a directory itself
    const findingsDir = join(basePath, 'findings');
    const { mkdir: fsMkdir } = await import('node:fs/promises');
    // Create a subdirectory named *.jsonl — readEmbeddingShardFile will get EISDIR and throw
    await fsMkdir(join(findingsDir, 'unreadable.jsonl'), { recursive: true });

    const provider = makeRebuildProvider();
    const result = await rebuildEmbeddingIndex(provider);

    // Both *.jsonl entries are scanned (valid file + directory)
    expect(result.filesScanned).toBe(2);
    // The directory entry causes rowsSkipped to increment
    expect(result.rowsSkipped).toBeGreaterThanOrEqual(1);
    // Valid record still written
    expect(result.findingsWritten).toBe(1);
  });

  it('writes a consolidated shard file that writeConsolidatedShardFile produces valid JSONL', async () => {
    const records = [
      makeEmbeddingRecord('r-1', 'PROJ-1', 'sess-1'),
      makeEmbeddingRecord('r-2', 'PROJ-1', 'sess-1'),
    ];

    const consolidatedPath = join(basePath, 'findings.jsonl');
    await writeConsolidatedShardFile(consolidatedPath, records);

    const raw = await readFile(consolidatedPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsed = lines.map((l) => JSON.parse(l) as EmbeddingRecord);
    expect(parsed[0].id).toBe('r-1');
    expect(parsed[1].id).toBe('r-2');
  });
});
