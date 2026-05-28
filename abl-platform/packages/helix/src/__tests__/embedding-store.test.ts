/**
 * Tests for EmbeddingStore (src/intelligence/embedding-store.ts)
 *
 * Core invariants verified:
 *
 * ISOLATION INVARIANT:
 *   query() MUST filter by projectId — records from a different project are
 *   never returned regardless of cosine score.
 *
 * GRACEFUL DEGRADATION:
 *   When the embedding client returns null (endpoint unreachable), embed
 *   operations skip silently without throwing.
 *
 * CROSS-PROJECT ISOLATION:
 *   A session from project B cannot retrieve findings produced by project A.
 *
 * SHARD WRITER DELEGATION:
 *   EmbeddingStore delegates JSONL I/O to shard-writer helpers (confirmed
 *   via mocking).
 *
 * Tests use in-memory fixtures — no real filesystem, no real network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Decision,
  EmbeddingRecord,
  Finding,
  HelixEmbeddingProviderConfig,
  Session,
  StageDefinition,
} from '../types.js';
import { EmbeddingStore } from '../intelligence/embedding-store.js';
import type { BgeM3Client, EmbedResponse } from '../intelligence/bge-m3-client.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock shard-writer so we never hit the filesystem
vi.mock('../intelligence/shard-writer.js', () => ({
  appendEmbeddingRecord: vi.fn().mockResolvedValue('/tmp/fake.jsonl'),
  readEmbeddingShardFile: vi.fn().mockResolvedValue([]),
  writeConsolidatedShardFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:fs/promises readdir used by EmbeddingStore.loadScopedRecords
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeProvider(
  overrides: Partial<HelixEmbeddingProviderConfig> = {},
): HelixEmbeddingProviderConfig {
  return {
    kind: 'bge-m3-local',
    enabled: true,
    modelId: 'bge-m3',
    modelKey: 'bge-m3-1024',
    dimensions: 1024,
    baseUrl: 'http://localhost:8000',
    timeoutMs: 5_000,
    maxBatchSize: 32,
    requestBudget: 100,
    shardBasePath: '/tmp/helix-test/embeddings',
    shardLayout: 'per-session',
    ...overrides,
  };
}

function makeClient(overrides: Partial<BgeM3Client> = {}): BgeM3Client {
  return {
    embedBatch: vi.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      model: 'bge-m3',
      dimensions: 3,
    } satisfies EmbedResponse),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeFinding(id = 'f-1', overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    category: 'security',
    severity: 'high',
    status: 'open',
    title: 'SQL injection in auth route',
    description: 'Unsanitized user input passed to query.',
    files: [{ path: 'apps/runtime/src/auth.ts', lines: [42, 55] }],
    discoveredBy: 'holistic-audit',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function makeDecision(id = 'd-1', overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    question: 'Should we use optimistic locking for this resource?',
    context: 'Concurrent writes could cause data loss.',
    classification: 'DECIDED',
    answer: 'Yes, use optimistic locking with version fields.',
    oracleVotes: [],
    stage: 'planning',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-abc',
    workItem: {
      id: 'wi-1',
      type: 'feature-audit',
      title: 'Auth security hardening',
      description: 'Harden the auth module.',
      scope: ['apps/runtime'],
      jiraKey: 'PROJ-42',
      targetBranch: 'main',
      createdAt: '2026-05-01T00:00:00Z',
    },
    bootstrapMeta: {
      jiraKey: 'PROJ-42',
      jiraFetchSuccess: true,
      scopeInferenceMethod: 'jira-scope-labels',
      inferredScope: ['apps/runtime'],
    },
    pipelineName: 'holistic-audit',
    pipelineVersion: '1.0.0',
    state: 'running',
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
    ...overrides,
  };
}

function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: 'analysis',
    type: 'analysis',
    prompt: 'Analyse the codebase.',
    exitCriteria: [],
    entryConditions: [],
    ...overrides,
  } as unknown as StageDefinition;
}

function makeEmbeddingRecord(
  overrides: {
    id?: string;
    kind?: EmbeddingRecord['kind'];
    projectId?: string;
    vector?: number[];
  } = {},
): EmbeddingRecord {
  return {
    id: overrides.id ?? 'rec-1',
    kind: overrides.kind ?? 'finding',
    contentHash: 'abc123',
    model: 'bge-m3',
    dimensions: 3,
    vector: overrides.vector ?? [0.1, 0.2, 0.3],
    metadata: {
      featureSlug: 'auth-security-hardening',
      sessionId: 'sess-other',
      projectId: overrides.projectId ?? 'PROJ-42',
      files: [],
      createdAt: '2026-05-01T00:00:00Z',
    },
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('EmbeddingStore', () => {
  let shardWriter: typeof import('../intelligence/shard-writer.js');
  let fsPromises: typeof import('node:fs/promises');

  beforeEach(async () => {
    vi.clearAllMocks();
    shardWriter = await import('../intelligence/shard-writer.js');
    fsPromises = await import('node:fs/promises');
  });

  // ── Disabled provider ──────────────────────────────────────────────────────

  describe('when provider.enabled = false', () => {
    it('notifyStageComplete does nothing', async () => {
      const store = new EmbeddingStore(makeProvider({ enabled: false }), makeClient());
      const session = makeSession({ findings: [makeFinding()] });
      await store.notifyStageComplete(session, makeStage());
      expect(shardWriter.appendEmbeddingRecord).not.toHaveBeenCalled();
    });

    it('query returns empty array', async () => {
      const store = new EmbeddingStore(makeProvider({ enabled: false }), makeClient());
      const results = await store.query('any text', { projectId: 'PROJ-42' });
      expect(results).toEqual([]);
    });
  });

  // ── notifyStageComplete ────────────────────────────────────────────────────

  describe('notifyStageComplete', () => {
    it('embeds findings and writes shard records', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({ findings: [makeFinding('f-1')] });

      await store.notifyStageComplete(session, makeStage());

      expect(client.embedBatch).toHaveBeenCalledOnce();
      expect(shardWriter.appendEmbeddingRecord).toHaveBeenCalledOnce();

      const writtenRecord = (shardWriter.appendEmbeddingRecord as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EmbeddingRecord;
      expect(writtenRecord.id).toBe('f-1');
      expect(writtenRecord.kind).toBe('finding');
      expect(writtenRecord.metadata.projectId).toBe('PROJ-42');
    });

    it('embeds decisions and includes correct kind', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0.4, 0.5, 0.6]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({ decisions: [makeDecision('d-1')] });

      await store.notifyStageComplete(session, makeStage());

      expect(client.embedBatch).toHaveBeenCalledOnce();
      const writtenRecord = (shardWriter.appendEmbeddingRecord as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EmbeddingRecord;
      expect(writtenRecord.kind).toBe('decision');
      expect(writtenRecord.id).toBe('d-1');
    });

    it('skips gracefully when embed client returns null (endpoint unreachable)', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue(null),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({ findings: [makeFinding()] });

      // Must not throw
      await expect(store.notifyStageComplete(session, makeStage())).resolves.toBeUndefined();
      expect(shardWriter.appendEmbeddingRecord).not.toHaveBeenCalled();
    });

    it('does nothing when session has no findings or decisions', async () => {
      const client = makeClient();
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({ findings: [], decisions: [] });

      await store.notifyStageComplete(session, makeStage());

      expect(client.embedBatch).not.toHaveBeenCalled();
      expect(shardWriter.appendEmbeddingRecord).not.toHaveBeenCalled();
    });

    it('stores projectId from bootstrapMeta.jiraKey', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({
        findings: [makeFinding()],
        bootstrapMeta: {
          jiraKey: 'ABLP-999',
          jiraFetchSuccess: true,
          scopeInferenceMethod: 'jira-scope-labels',
          inferredScope: [],
        },
      });

      await store.notifyStageComplete(session, makeStage());

      const writtenRecord = (shardWriter.appendEmbeddingRecord as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EmbeddingRecord;
      expect(writtenRecord.metadata.projectId).toBe('ABLP-999');
    });

    it('falls back to workItem.title slug when no jiraKey in bootstrapMeta', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const session = makeSession({
        findings: [makeFinding()],
        bootstrapMeta: undefined,
      });
      session.workItem.jiraKey = undefined;

      await store.notifyStageComplete(session, makeStage());

      const writtenRecord = (shardWriter.appendEmbeddingRecord as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EmbeddingRecord;
      // slug from 'Auth security hardening'
      expect(writtenRecord.metadata.projectId).toMatch(/auth-security-hardening/);
    });
  });

  // ── query — ISOLATION INVARIANT ────────────────────────────────────────────

  describe('query — isolation invariant', () => {
    it('returns empty array for empty query text', async () => {
      const store = new EmbeddingStore(makeProvider(), makeClient());
      const results = await store.query('', { projectId: 'PROJ-42' });
      expect(results).toEqual([]);
    });

    it('returns empty array when embed client returns null', async () => {
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue(null),
      });
      const store = new EmbeddingStore(makeProvider(), client);
      const results = await store.query('find auth issues', { projectId: 'PROJ-42' });
      expect(results).toEqual([]);
    });

    it('ISOLATION: never returns records from a different projectId', async () => {
      // Shard contains a record from project PROJ-OTHER
      const foreignRecord = makeEmbeddingRecord({
        projectId: 'PROJ-OTHER',
        vector: [0.1, 0.2, 0.3],
      });

      vi.mocked(fsPromises.readdir).mockResolvedValue(['sess-other.jsonl'] as unknown as Awaited<
        ReturnType<typeof fsPromises.readdir>
      >);
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue([foreignRecord]);

      // Query vector matches perfectly (same direction)
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0.1, 0.2, 0.3]], // identical to foreignRecord.vector
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      // Scope requests PROJ-42 — foreignRecord has PROJ-OTHER → must be excluded
      const results = await store.query('auth injection', { projectId: 'PROJ-42' });

      expect(results).toEqual([]);
    });

    it('ISOLATION: returns records that match the requested projectId', async () => {
      const ownRecord = makeEmbeddingRecord({ projectId: 'PROJ-42', vector: [1, 0, 0] });
      const foreignRecord = makeEmbeddingRecord({
        id: 'rec-foreign',
        projectId: 'PROJ-OTHER',
        vector: [1, 0, 0],
      });

      vi.mocked(fsPromises.readdir).mockResolvedValue(['sess.jsonl'] as unknown as Awaited<
        ReturnType<typeof fsPromises.readdir>
      >);
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue([ownRecord, foreignRecord]);

      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[1, 0, 0]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      // Restrict to 'finding' kind so only the findings shard dir is scanned
      // (prevents duplication from both findings/ and decisions/ dirs)
      const results = await store.query(
        'find issues',
        { projectId: 'PROJ-42' },
        { kind: 'finding' },
      );

      expect(results).toHaveLength(1);
      expect(results[0].record.id).toBe('rec-1'); // ownRecord
    });

    it('filters by sessionId when scope.sessionId provided', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([
        'sess-A.jsonl',
        'sess-B.jsonl',
      ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);

      const recordA = makeEmbeddingRecord({ id: 'rec-a', projectId: 'PROJ-42', vector: [1, 0, 0] });
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue([recordA]);

      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[1, 0, 0]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      const results = await store.query('text', {
        projectId: 'PROJ-42',
        sessionId: 'sess-A',
      });

      // readdir gives two files but only sess-A.jsonl is read
      expect(shardWriter.readEmbeddingShardFile).toHaveBeenCalledTimes(2); // findings + decisions dirs
    });

    it('respects minScore threshold', async () => {
      // vector [1,0,0] vs query [0,1,0] → cosine = 0 → below any positive threshold
      const lowScoreRecord = makeEmbeddingRecord({ projectId: 'PROJ-42', vector: [1, 0, 0] });

      vi.mocked(fsPromises.readdir).mockResolvedValue(['sess.jsonl'] as unknown as Awaited<
        ReturnType<typeof fsPromises.readdir>
      >);
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue([lowScoreRecord]);

      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[0, 1, 0]], // orthogonal → cosine similarity = 0
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      const results = await store.query('text', { projectId: 'PROJ-42' }, { minScore: 0.5 });
      expect(results).toEqual([]);
    });

    it('ranks results by cosine similarity descending', async () => {
      const highScore = makeEmbeddingRecord({
        id: 'high',
        projectId: 'PROJ-42',
        vector: [1, 0, 0],
      });
      const lowScore = makeEmbeddingRecord({
        id: 'low',
        projectId: 'PROJ-42',
        vector: [0.5, 0.5, 0],
      });

      vi.mocked(fsPromises.readdir).mockResolvedValue(['sess.jsonl'] as unknown as Awaited<
        ReturnType<typeof fsPromises.readdir>
      >);
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue([lowScore, highScore]);

      // query vector aligned with highScore → cosine 1.0 for high, ~0.7 for low
      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[1, 0, 0]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      // Restrict to 'finding' kind to scan only one shard dir (avoids duplication)
      const results = await store.query(
        'text',
        { projectId: 'PROJ-42' },
        { minScore: 0.0, kind: 'finding' },
      );
      expect(results[0].record.id).toBe('high');
      expect(results[0].score).toBeCloseTo(1.0, 5);
      expect(results[1].record.id).toBe('low');
    });

    it('respects topN limit', async () => {
      const records = [1, 2, 3, 4, 5].map((i) =>
        makeEmbeddingRecord({ id: `rec-${i}`, projectId: 'PROJ-42', vector: [i / 5, 0, 0] }),
      );

      vi.mocked(fsPromises.readdir).mockResolvedValue(['sess.jsonl'] as unknown as Awaited<
        ReturnType<typeof fsPromises.readdir>
      >);
      vi.mocked(shardWriter.readEmbeddingShardFile).mockResolvedValue(records);

      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[1, 0, 0]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      const results = await store.query('text', { projectId: 'PROJ-42' }, { topN: 3, minScore: 0 });
      expect(results).toHaveLength(3);
    });
  });

  // ── ENOENT handling ────────────────────────────────────────────────────────

  describe('when shard directory does not exist', () => {
    it('returns empty array without throwing', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readdir).mockRejectedValue(err);

      const client = makeClient({
        embedBatch: vi.fn().mockResolvedValue({
          embeddings: [[1, 0, 0]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      });
      const store = new EmbeddingStore(makeProvider(), client);

      const results = await store.query('text', { projectId: 'PROJ-42' });
      expect(results).toEqual([]);
    });
  });
});
