import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEmbeddingShardPaths } from '../../intelligence/embedding-config.js';
import type { Decision, EmbeddingRecord, Finding } from '../../types.js';
import {
  appendEmbeddingRecord,
  buildDecisionEmbeddingText,
  buildFindingEmbeddingText,
  computeDecisionContentHash,
  computeEmbeddingContentHash,
  computeFindingContentHash,
  createLogger,
  dedupeEmbeddingRecords,
  EmbeddingShardStore,
  type EmbeddingShardAppendResult,
  type EmbeddingShardStoreOptions,
  type EmbeddingShardStoreLogger,
  readEmbeddingShardFile,
  type ShardWriterOptions,
  writeConsolidatedShardFile,
} from '../embedding-shard-store.js';

interface CapturedLogEntry {
  level: 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

describe('EmbeddingShardStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    const artifactRoot = join(process.cwd(), '.test-artifacts');
    await mkdir(artifactRoot, { recursive: true });
    tempDir = await mkdtemp(join(artifactRoot, 'embedding-shard-store-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates per-session finding and decision shards without writing flat files', async () => {
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const paths = buildEmbeddingShardPaths({ basePath, sessionId: 'session-a' });
    const storeOptions: EmbeddingShardStoreOptions = {};
    const store = new EmbeddingShardStore(storeOptions);
    const appendOptions: ShardWriterOptions = {};

    const appendResult: EmbeddingShardAppendResult = await store.appendRecord(
      makeRecord({ id: 'finding-a', kind: 'finding' }),
      paths,
    );
    await expect(
      appendEmbeddingRecord(
        makeRecord({ id: 'decision-a', kind: 'decision' }),
        paths,
        appendOptions,
      ),
    ).resolves.toBe(paths.decisionsShardPath);

    const findingLines = await readEmbeddingShardFile(paths.findingsShardPath);
    const decisionLines = await readEmbeddingShardFile(paths.decisionsShardPath);

    expect(appendResult).toMatchObject({ shardPath: paths.findingsShardPath, written: true });
    expect(findingLines).toHaveLength(1);
    expect(findingLines[0].id).toBe('finding-a');
    expect(decisionLines).toHaveLength(1);
    expect(decisionLines[0].id).toBe('decision-a');
    await expect(stat(join(basePath, 'findings.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(basePath, 'decisions.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('computes stable content hashes from canonical finding and decision text', () => {
    const finding = makeFinding({
      files: [
        { path: 'packages/helix/src/b.ts', lines: [10, 20] },
        { path: 'packages/helix/src/a.ts', lines: [1, 5] },
      ],
    });
    const sameFindingDifferentFileOrder = makeFinding({
      id: 'finding-hash-copy',
      files: [
        { path: 'packages/helix/src/a.ts', lines: [1, 5] },
        { path: 'packages/helix/src/b.ts', lines: [10, 20] },
      ],
    });
    const changedFinding = makeFinding({ description: 'Different finding description.' });
    const decision = makeDecision();

    const findingHash = computeFindingContentHash(finding);
    const expectedFindingHash = createHash('sha256')
      .update(buildFindingEmbeddingText(finding), 'utf-8')
      .digest('hex');
    const expectedDecisionHash = createHash('sha256')
      .update(buildDecisionEmbeddingText(decision), 'utf-8')
      .digest('hex');
    const logger = createLogger('helix.embedding-shard-store.test');

    expect(findingHash).toBe(expectedFindingHash);
    expect(findingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(computeFindingContentHash(sameFindingDifferentFileOrder)).toBe(findingHash);
    expect(computeFindingContentHash(changedFinding)).not.toBe(findingHash);
    expect(computeDecisionContentHash({ ...decision, id: 'decision-hash-copy' })).toBe(
      computeDecisionContentHash(decision),
    );
    expect(computeDecisionContentHash(decision)).toBe(expectedDecisionHash);
    expect(computeEmbeddingContentHash('same text')).toBe(computeEmbeddingContentHash('same text'));
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('dedupes duplicate contentHash writes within a session under concurrent appends', async () => {
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const paths = buildEmbeddingShardPaths({ basePath, sessionId: 'session-dedup' });
    const store = new EmbeddingShardStore();
    const recordA = makeRecord({ id: 'finding-duplicate-a', contentHash: 'same-content-hash' });
    const recordB = makeRecord({ id: 'finding-duplicate-b', contentHash: 'same-content-hash' });

    const results = await Promise.all([
      store.appendRecord(recordA, paths),
      store.appendRecord(recordB, paths),
    ]);

    const writtenResults = results.filter((result) => result.written);
    const duplicateResults = results.filter((result) => result.duplicateOf);
    const records = await readJsonl(paths.findingsShardPath);

    expect(writtenResults).toHaveLength(1);
    expect(duplicateResults).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0].contentHash).toBe('same-content-hash');
  });

  it('keeps session shards isolated even when two sessions share contentHash values', async () => {
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const pathsA = buildEmbeddingShardPaths({ basePath, sessionId: 'session-a' });
    const pathsB = buildEmbeddingShardPaths({ basePath, sessionId: 'session-b' });
    const store = new EmbeddingShardStore();

    await Promise.all([
      store.appendRecord(
        makeRecord({
          id: 'finding-session-a',
          sessionId: 'session-a',
          contentHash: 'shared-content-hash',
        }),
        pathsA,
      ),
      store.appendRecord(
        makeRecord({
          id: 'finding-session-b',
          sessionId: 'session-b',
          contentHash: 'shared-content-hash',
        }),
        pathsB,
      ),
    ]);

    const recordsA = await readJsonl(pathsA.findingsShardPath);
    const recordsB = await readJsonl(pathsB.findingsShardPath);

    expect(recordsA.map((record) => record.id)).toEqual(['finding-session-a']);
    expect(recordsB.map((record) => record.id)).toEqual(['finding-session-b']);
    expect(recordsA[0].metadata.sessionId).toBe('session-a');
    expect(recordsB[0].metadata.sessionId).toBe('session-b');
  });

  it('skips malformed prior lines and treats missing shard files as empty', async () => {
    const { logger, entries } = createCapturingLogger();
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const paths = buildEmbeddingShardPaths({ basePath, sessionId: 'session-malformed' });
    const store = new EmbeddingShardStore({ logger });
    const validRecord = makeRecord({ id: 'finding-valid' });

    await mkdir(dirname(paths.findingsShardPath), { recursive: true });
    await writeFile(
      paths.findingsShardPath,
      [
        'not-json',
        JSON.stringify({ id: 'missing-required-fields' }),
        JSON.stringify(validRecord),
      ].join('\n'),
      'utf-8',
    );

    const records = await store.readShardFile(paths.findingsShardPath);
    const missingRecords = await store.readShardFile(paths.decisionsShardPath);

    expect(records.map((record) => record.id)).toEqual(['finding-valid']);
    expect(missingRecords).toEqual([]);
    expect(entries.filter((entry) => entry.level === 'warn')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Skipping malformed embedding shard line',
          context: expect.objectContaining({ lineNumber: 1 }),
        }),
        expect.objectContaining({
          message: 'Skipping malformed embedding shard line',
          context: expect.objectContaining({ lineNumber: 2 }),
        }),
      ]),
    );
  });

  it('surfaces and logs append failures with shard context', async () => {
    const { logger, entries } = createCapturingLogger();
    const basePath = join(tempDir, 'not-a-directory');
    const paths = buildEmbeddingShardPaths({ basePath, sessionId: 'session-failure' });
    const store = new EmbeddingShardStore({ logger });

    await writeFile(basePath, 'blocks child directory creation', 'utf-8');

    await expect(store.appendRecord(makeRecord({ id: 'finding-failure' }), paths)).rejects.toThrow(
      /Embedding shard append failed/,
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: 'Embedding shard append failed',
          context: expect.objectContaining({
            recordId: 'finding-failure',
            kind: 'finding',
          }),
        }),
      ]),
    );
  });

  it('rejects records that reach the writer without a contentHash', async () => {
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const paths = buildEmbeddingShardPaths({ basePath, sessionId: 'session-missing-hash' });
    const store = new EmbeddingShardStore();

    await expect(
      store.appendRecord(makeRecord({ id: 'finding-missing-hash', contentHash: '' }), paths),
    ).rejects.toThrow(/missing contentHash/);
  });

  it('dedupes consolidated records by kind and contentHash', async () => {
    const { logger, entries } = createCapturingLogger();
    const basePath = join(tempDir, '.helix/cache/embeddings/bge-m3-1024');
    const consolidatedPath = join(basePath, 'findings.jsonl');
    const dedupedRecords = dedupeEmbeddingRecords(
      [
        makeRecord({
          id: 'finding-session-a',
          sessionId: 'session-a',
          contentHash: 'shared-content-hash',
        }),
        makeRecord({
          id: 'finding-session-b',
          sessionId: 'session-b',
          contentHash: 'shared-content-hash',
        }),
        makeRecord({
          id: 'finding-unique',
          sessionId: 'session-c',
          contentHash: 'unique-content-hash',
        }),
      ],
      logger,
    );

    await writeConsolidatedShardFile(consolidatedPath, dedupedRecords);

    const records = await readJsonl(consolidatedPath);

    expect(records.map((record) => record.id)).toEqual(['finding-session-a', 'finding-unique']);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: 'Skipping duplicate embedding record with matching contentHash',
          context: expect.objectContaining({
            keptRecordId: 'finding-session-a',
            skippedRecordId: 'finding-session-b',
          }),
        }),
      ]),
    );
  });

  it('uses fs/promises and avoids sync filesystem APIs', async () => {
    const sourcePath = fileURLToPath(new URL('../embedding-shard-store.ts', import.meta.url));
    const source = await readFile(sourcePath, 'utf-8');

    expect(source).toContain('node:fs/promises');
    expect(source).not.toMatch(/readFileSync|writeFileSync|appendFileSync|mkdirSync/);
  });
});

async function readJsonl(filePath: string): Promise<EmbeddingRecord[]> {
  const raw = await readFile(filePath, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EmbeddingRecord);
}

function createCapturingLogger(): {
  entries: CapturedLogEntry[];
  logger: EmbeddingShardStoreLogger;
} {
  const entries: CapturedLogEntry[] = [];
  return {
    entries,
    logger: {
      warn: (message, context) => entries.push({ level: 'warn', message, context }),
      error: (message, context) => entries.push({ level: 'error', message, context }),
    },
  };
}

function makeRecord(
  params: {
    id?: string;
    kind?: EmbeddingRecord['kind'];
    sessionId?: string;
    projectId?: string;
    contentHash?: string;
  } = {},
): EmbeddingRecord {
  const kind = params.kind ?? 'finding';
  const id = params.id ?? `${kind}-1`;
  const sessionId = params.sessionId ?? 'session-a';
  return {
    id,
    kind,
    contentHash: params.contentHash ?? `hash-${id}`,
    model: 'bge-m3',
    dimensions: 3,
    vector: [0.1, 0.2, 0.3],
    metadata: {
      severity: kind === 'finding' ? 'high' : undefined,
      category: kind === 'finding' ? 'security' : undefined,
      classification: kind === 'decision' ? 'DECIDED' : undefined,
      files: kind === 'finding' ? ['packages/helix/src/pipeline/pipeline-engine.ts'] : [],
      featureSlug: 'helix-work-item-bootstrap',
      sessionId,
      projectId: params.projectId ?? 'ABLP-778',
      createdAt: '2026-05-04T00:00:00.000Z',
    },
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding-hash',
    category: 'wiring-gap',
    severity: 'high',
    status: 'open',
    title: 'Shard writer missing',
    description: 'Per-session embedding shard writes are not implemented.',
    files: [{ path: 'packages/helix/src/pipeline/pipeline-engine.ts', lines: [1, 2] }],
    suggestedFix: 'Add an async per-session JSONL writer.',
    discoveredBy: 'slice-test',
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'decision-hash',
    question: 'Where should contentHash be computed?',
    context: 'Persist hooks run only after the pipeline completes.',
    classification: 'DECIDED',
    answer: 'Compute it lazily from the embedding hook.',
    oracleVotes: [],
    stage: 'implementation',
    ...overrides,
  };
}
