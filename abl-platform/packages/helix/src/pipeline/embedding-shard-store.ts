import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Decision, EmbeddingRecord, EmbeddingShardPaths, Finding } from '../types.js';

const JSONL_ENCODING = 'utf-8';
const MAX_ACTIVE_SHARD_WRITE_LOCKS = 256;
const MAX_DEDUPE_RECORDS = 100_000;

export interface EmbeddingShardStoreLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ShardWriterOptions {
  /** When true, skip all writes. */
  dryRun?: boolean;
  logger?: EmbeddingShardStoreLogger;
}

export interface EmbeddingShardAppendResult {
  shardPath: string;
  written: boolean;
  duplicateOf?: string;
  dryRun?: boolean;
}

interface EmbeddingShardStoreIo {
  appendFile: typeof appendFile;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
}

export interface EmbeddingShardStoreOptions extends ShardWriterOptions {
  io?: Partial<EmbeddingShardStoreIo>;
}

export function createLogger(module: string): EmbeddingShardStoreLogger {
  return {
    warn: (message, context) => writeLogLine(module, 'WARN', message, context),
    error: (message, context) => writeLogLine(module, 'ERROR', message, context),
  };
}

export const createEmbeddingShardLogger = createLogger;

const defaultLogger = createLogger('helix.embedding-shard-store');

const defaultIo: EmbeddingShardStoreIo = {
  appendFile,
  mkdir,
  readFile,
  writeFile,
};

export class EmbeddingShardStore {
  private readonly dryRun: boolean;
  private readonly io: EmbeddingShardStoreIo;
  private readonly logger: EmbeddingShardStoreLogger;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(options: EmbeddingShardStoreOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.logger = options.logger ?? defaultLogger;
    this.io = { ...defaultIo, ...options.io };
  }

  async appendRecord(
    record: EmbeddingRecord,
    shardPaths: EmbeddingShardPaths,
    options: ShardWriterOptions = {},
  ): Promise<EmbeddingShardAppendResult> {
    const shardPath = resolveShardPath(record, shardPaths);
    const effectiveDryRun = options.dryRun ?? this.dryRun;
    const effectiveLogger = options.logger ?? this.logger;

    if (effectiveDryRun) {
      return { shardPath, written: false, dryRun: true };
    }

    assertRecordCanBeWritten(record);

    return this.withShardLock(shardPath, () =>
      this.appendRecordAfterLock(record, shardPath, effectiveLogger),
    );
  }

  async readShardFile(
    shardPath: string,
    options: { logger?: EmbeddingShardStoreLogger } = {},
  ): Promise<EmbeddingRecord[]> {
    const effectiveLogger = options.logger ?? this.logger;
    let raw: string;

    try {
      raw = await this.io.readFile(shardPath, JSONL_ENCODING);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return [];
      }
      const message = error instanceof Error ? error.message : String(error);
      effectiveLogger.error('Embedding shard read failed', { shardPath, error: message });
      throw error;
    }

    const records: EmbeddingRecord[] = [];
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isEmbeddingRecord(parsed)) {
          effectiveLogger.warn('Skipping malformed embedding shard line', {
            shardPath,
            lineNumber: index + 1,
            reason: 'record-shape',
          });
          continue;
        }
        records.push(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        effectiveLogger.warn('Skipping malformed embedding shard line', {
          shardPath,
          lineNumber: index + 1,
          error: message,
        });
      }
    }

    return records;
  }

  async writeConsolidatedFile(filePath: string, records: EmbeddingRecord[]): Promise<void> {
    const deduped = dedupeEmbeddingRecords(records, this.logger);
    const contents =
      deduped.map((record) => JSON.stringify(record)).join('\n') + (deduped.length > 0 ? '\n' : '');

    try {
      await this.io.mkdir(dirname(filePath), { recursive: true });
      await this.io.writeFile(filePath, contents, JSONL_ENCODING);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Embedding consolidated shard write failed', { filePath, error: message });
      throw new Error(`Embedding consolidated shard write failed for ${filePath}: ${message}`, {
        cause: error,
      });
    }
  }

  private async appendRecordAfterLock(
    record: EmbeddingRecord,
    shardPath: string,
    logger: EmbeddingShardStoreLogger,
  ): Promise<EmbeddingShardAppendResult> {
    try {
      await this.io.mkdir(dirname(shardPath), { recursive: true });

      const existingRecords = await this.readShardFile(shardPath, { logger });
      const duplicate = existingRecords.find(
        (existing) => existing.kind === record.kind && existing.contentHash === record.contentHash,
      );
      if (duplicate) {
        return { shardPath, written: false, duplicateOf: duplicate.id };
      }

      await this.io.appendFile(shardPath, `${JSON.stringify(record)}\n`, JSONL_ENCODING);
      return { shardPath, written: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Embedding shard append failed', {
        shardPath,
        recordId: record.id,
        kind: record.kind,
        error: message,
      });
      throw new Error(`Embedding shard append failed for ${record.kind} ${record.id}: ${message}`, {
        cause: error,
      });
    }
  }

  private async withShardLock<T>(shardPath: string, task: () => Promise<T>): Promise<T> {
    const priorWrite = this.writeLocks.get(shardPath);
    if (!priorWrite && this.writeLocks.size >= MAX_ACTIVE_SHARD_WRITE_LOCKS) {
      throw new Error(
        `Too many active embedding shard write locks (${MAX_ACTIVE_SHARD_WRITE_LOCKS}).`,
      );
    }

    const currentWrite = (async () => {
      if (priorWrite) {
        try {
          await priorWrite;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn('Continuing queued embedding shard write after prior failure', {
            shardPath,
            error: message,
          });
        }
      }
      return task();
    })();

    const trackedWrite = currentWrite.then(
      () => undefined,
      () => undefined,
    );
    this.writeLocks.set(shardPath, trackedWrite);

    try {
      return await currentWrite;
    } finally {
      if (this.writeLocks.get(shardPath) === trackedWrite) {
        this.writeLocks.delete(shardPath);
      }
    }
  }
}

const defaultStore = new EmbeddingShardStore();

export async function appendEmbeddingRecord(
  record: EmbeddingRecord,
  shardPaths: EmbeddingShardPaths,
  options: ShardWriterOptions = {},
): Promise<string | undefined> {
  const result = await defaultStore.appendRecord(record, shardPaths, options);
  return result.written ? result.shardPath : undefined;
}

export async function readEmbeddingShardFile(shardPath: string): Promise<EmbeddingRecord[]> {
  return defaultStore.readShardFile(shardPath);
}

export async function writeConsolidatedShardFile(
  filePath: string,
  records: EmbeddingRecord[],
): Promise<void> {
  await defaultStore.writeConsolidatedFile(filePath, records);
}

export function dedupeEmbeddingRecords(
  records: readonly EmbeddingRecord[],
  logger: EmbeddingShardStoreLogger = defaultLogger,
): EmbeddingRecord[] {
  const seen = new Map<string, EmbeddingRecord>();
  const deduped: EmbeddingRecord[] = [];

  for (const record of records) {
    if (seen.size >= MAX_DEDUPE_RECORDS && !seen.has(buildDedupeKey(record))) {
      throw new Error(`Embedding record dedupe exceeded ${MAX_DEDUPE_RECORDS} unique records.`);
    }

    const key = buildDedupeKey(record);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, record);
      deduped.push(record);
      continue;
    }

    logger.warn('Skipping duplicate embedding record with matching contentHash', {
      keptRecordId: existing.id,
      skippedRecordId: record.id,
      kind: record.kind,
      contentHash: record.contentHash,
      existingSessionId: existing.metadata.sessionId,
      skippedSessionId: record.metadata.sessionId,
    });
  }

  return deduped;
}

export function computeEmbeddingContentHash(text: string): string {
  return createHash('sha256').update(normalizeHashText(text), JSONL_ENCODING).digest('hex');
}

export function computeFindingContentHash(finding: Finding): string {
  return computeEmbeddingContentHash(buildFindingEmbeddingText(finding));
}

export function computeDecisionContentHash(decision: Decision): string {
  return computeEmbeddingContentHash(buildDecisionEmbeddingText(decision));
}

export function buildFindingEmbeddingText(finding: Finding): string {
  const files = finding.files
    .map((file) => {
      const lines = file.lines ? `:${file.lines[0]}-${file.lines[1]}` : '';
      const snippet = file.snippet?.trim() ? `\n${file.snippet.trim()}` : '';
      return `${file.path}${lines}${snippet}`;
    })
    .sort();

  return [
    `kind=finding`,
    `severity=${finding.severity}`,
    `category=${finding.category}`,
    `title=${finding.title}`,
    `description=${finding.description}`,
    `suggestedFix=${finding.suggestedFix ?? ''}`,
    `files=${files.join('\n')}`,
  ].join('\n');
}

export function buildDecisionEmbeddingText(decision: Decision): string {
  return [
    `kind=decision`,
    `classification=${decision.classification}`,
    `question=${decision.question}`,
    `context=${decision.context}`,
    `answer=${decision.answer ?? ''}`,
  ].join('\n');
}

function resolveShardPath(record: EmbeddingRecord, shardPaths: EmbeddingShardPaths): string {
  if (record.kind === 'finding') {
    return shardPaths.findingsShardPath;
  }
  if (record.kind === 'decision') {
    return shardPaths.decisionsShardPath;
  }
  throw new Error(`Unsupported embedding record kind: ${String(record.kind)}`);
}

function assertRecordCanBeWritten(record: EmbeddingRecord): void {
  if (!record.id.trim()) {
    throw new Error('Embedding shard record id must be non-empty.');
  }
  if (!record.contentHash.trim()) {
    throw new Error(`Embedding shard record ${record.id} is missing contentHash.`);
  }
}

function isEmbeddingRecord(value: unknown): value is EmbeddingRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const metadata = candidate.metadata as Record<string, unknown> | undefined;
  return (
    typeof candidate.id === 'string' &&
    (candidate.kind === 'finding' || candidate.kind === 'decision') &&
    typeof candidate.contentHash === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.dimensions === 'number' &&
    Array.isArray(candidate.vector) &&
    Boolean(metadata) &&
    typeof metadata?.featureSlug === 'string' &&
    typeof metadata?.sessionId === 'string' &&
    Array.isArray(metadata?.files) &&
    typeof metadata?.createdAt === 'string'
  );
}

function buildDedupeKey(record: EmbeddingRecord): string {
  return `${record.kind}:${record.contentHash}`;
}

function normalizeHashText(text: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function writeLogLine(
  module: string,
  level: 'WARN' | 'ERROR',
  message: string,
  context?: Record<string, unknown>,
): void {
  const contextSuffix = context ? ` ${safeStringify(context)}` : '';
  process.stderr.write(`[${module}] ${level} ${message}${contextSuffix}\n`);
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}
