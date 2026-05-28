/**
 * Archive Service
 *
 * Orchestrates data archival: creates NDJSON streams from Mongoose queries,
 * pipes through gzip, and uploads via ArchiveStore.
 * Supports sessions and audit log archival.
 */

import crypto from 'crypto';
import { Readable } from 'stream';
import type { AuditLog } from '@abl/compiler/platform/core/types';
import {
  ClickHouseAuditReader,
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
  type QueryAuditParams,
} from '@abl/compiler/platform/stores';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { ArchiveStore, ArchiveManifest, ArchiveOptions } from './archive-types';
import { S3ArchiveStore } from './s3-archive-store';
import { LocalArchiveStore } from './local-archive-store';

interface ArchiveRuntimeConfig {
  archive?: {
    store?: string;
    basePath?: string;
    localDir?: string;
    provider?: string;
    s3?: {
      defaultBucket?: string;
      regionBuckets?: string;
      encryption?: string;
      kmsKeyId?: string;
    };
  };
}

function getConfig(): ArchiveRuntimeConfig {
  return {
    archive: {
      store: process.env.ARCHIVE_STORE || 'local',
      basePath: process.env.ARCHIVE_PATH || './data/archives',
      localDir: process.env.ARCHIVE_PATH || './data/archives',
      provider: process.env.ARCHIVE_PROVIDER || 'local',
    },
  };
}

const DEFAULT_BATCH_SIZE = 500;

let archiveStore: ArchiveStore | null = null;

interface AuditArchiveBatch {
  logs: AuditLog[];
  total: number;
}

function buildAuditArchiveQueryParams(
  options: ArchiveOptions,
  olderThan: Date,
  batchSize: number,
  offset: number,
): QueryAuditParams {
  return {
    tenantId: options.tenantId,
    startTime: new Date(0),
    endTime: olderThan,
    limit: batchSize,
    offset,
  };
}

async function queryAuditLogsForArchiveBatch(
  options: ArchiveOptions,
  olderThan: Date,
  batchSize: number,
  offset: number,
): Promise<AuditArchiveBatch> {
  const queryParams = buildAuditArchiveQueryParams(options, olderThan, batchSize, offset);

  if (isInMemoryAuditTestBackendEnabled()) {
    return queryInMemoryAuditTestLogs(queryParams);
  }

  const reader = new ClickHouseAuditReader(getClickHouseClient());
  return reader.query(queryParams);
}

/**
 * Get or create the archive store based on config.
 */
export function getArchiveStore(): ArchiveStore {
  if (archiveStore) return archiveStore;

  const config = getConfig();

  if (config.archive?.provider === 's3' && config.archive?.s3?.defaultBucket) {
    const regionBuckets = config.archive.s3.regionBuckets
      ? (JSON.parse(config.archive.s3.regionBuckets) as Record<string, string>)
      : undefined;
    archiveStore = new S3ArchiveStore({
      defaultBucket: config.archive.s3.defaultBucket,
      regionBuckets,
      encryption: config.archive.s3.encryption === 'SSE-KMS' ? 'aws:kms' : 'AES256',
      kmsKeyId: config.archive.s3.kmsKeyId,
    });
  } else {
    const localDir = config.archive?.localDir || './data/archives';
    archiveStore = new LocalArchiveStore(localDir);
  }

  return archiveStore;
}

/**
 * Archive sessions older than the given date.
 * Returns the created manifest or null if no records to archive.
 */
export async function archiveSessions(options: ArchiveOptions): Promise<ArchiveManifest | null> {
  const { Session, ArchiveManifest } = await import('@agent-platform/database/models');
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const olderThan = options.olderThan || new Date();

  // Count records
  const count = await Session.countDocuments({
    tenantId: options.tenantId,
    status: 'archived',
    archivedAt: { $lt: olderThan },
  });

  if (count === 0) return null;

  // Track date range
  let dateRangeStart = new Date();
  let dateRangeEnd = new Date(0);

  // Stream records as NDJSON using a Readable stream with incremental checksum
  const { stream, getResult } = createNDJSONStream(async function* () {
    let lastId: string | undefined;

    while (true) {
      const filter: Record<string, unknown> = {
        tenantId: options.tenantId,
        status: 'archived',
        archivedAt: { $lt: olderThan },
      };
      if (lastId) filter._id = { $gt: lastId };

      const sessions = await Session.find(filter).sort({ _id: 1 }).limit(batchSize).lean();

      if (sessions.length === 0) break;

      for (const session of sessions) {
        if (session.createdAt < dateRangeStart) dateRangeStart = session.createdAt;
        if (session.createdAt > dateRangeEnd) dateRangeEnd = session.createdAt;
        yield { ...session, id: session._id };
      }

      lastId = sessions[sessions.length - 1]._id as string;
      if (sessions.length < batchSize) break;
    }
  });

  // Upload stream directly — ArchiveStore.upload accepts NodeJS.ReadableStream
  const store = getArchiveStore();
  const result = await store.upload(options.tenantId, 'sessions', stream, {
    recordCount: count,
    checksum: 'pending', // Will be finalized after stream is consumed
  });

  const { checksum, recordCount } = getResult();

  // Create manifest record in DB
  const manifest = await ArchiveManifest.create({
    tenantId: options.tenantId,
    type: 'sessions',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    storageKey: result.path,
    region: result.region,
    checksum,
    dateRangeStart,
    dateRangeEnd,
  });
  const manifestObj = manifest.toObject();

  return {
    id: manifestObj._id,
    tenantId: options.tenantId,
    type: 'sessions',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    path: result.path,
    region: result.region,
    checksum,
    createdAt: manifestObj.createdAt,
  };
}

/**
 * Archive messages older than the given date.
 * (Traces are not stored in the platform DB — they're runtime-level.)
 */
export async function archiveTraces(options: ArchiveOptions): Promise<ArchiveManifest | null> {
  const { Message, ArchiveManifest } = await import('@agent-platform/database/models');
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const olderThan = options.olderThan || new Date();

  // Archive messages as proxy for "traces" since trace events
  // are stored at runtime level, not in platform DB
  const count = await Message.countDocuments({
    tenantId: options.tenantId,
    timestamp: { $lt: olderThan },
  });

  if (count === 0) return null;

  let dateRangeStart = new Date();
  let dateRangeEnd = new Date(0);

  const { stream, getResult } = createNDJSONStream(async function* () {
    let lastId: string | undefined;

    while (true) {
      const filter: Record<string, unknown> = {
        tenantId: options.tenantId,
        timestamp: { $lt: olderThan },
      };
      if (lastId) filter._id = { $gt: lastId };

      const messages = await Message.find(filter).sort({ _id: 1 }).limit(batchSize).lean();

      if (messages.length === 0) break;

      for (const msg of messages) {
        if (msg.timestamp < dateRangeStart) dateRangeStart = msg.timestamp;
        if (msg.timestamp > dateRangeEnd) dateRangeEnd = msg.timestamp;
        yield { ...msg, id: msg._id };
      }

      lastId = messages[messages.length - 1]._id as string;
      if (messages.length < batchSize) break;
    }
  });

  const store = getArchiveStore();
  const result = await store.upload(options.tenantId, 'traces', stream, {
    recordCount: count,
    checksum: 'pending',
  });

  const { checksum, recordCount } = getResult();

  const manifest = await ArchiveManifest.create({
    tenantId: options.tenantId,
    type: 'traces',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    storageKey: result.path,
    region: result.region,
    checksum,
    dateRangeStart,
    dateRangeEnd,
  });
  const manifestObj = manifest.toObject();

  return {
    id: manifestObj._id,
    tenantId: options.tenantId,
    type: 'traces',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    path: result.path,
    region: result.region,
    checksum,
    createdAt: manifestObj.createdAt,
  };
}

/**
 * Archive shared audit logs from the ClickHouse-backed pipeline store.
 */
export async function archiveAuditLogs(options: ArchiveOptions): Promise<ArchiveManifest | null> {
  const { ArchiveManifest } = await import('@agent-platform/database/models');
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const olderThan = options.olderThan || new Date();
  const firstBatch = await queryAuditLogsForArchiveBatch(options, olderThan, batchSize, 0);
  const count = firstBatch.total;

  if (count === 0) return null;

  let dateRangeStart = firstBatch.logs[0]?.timestamp ?? olderThan;
  let dateRangeEnd = firstBatch.logs[0]?.timestamp ?? olderThan;

  const { stream, getResult } = createNDJSONStream(async function* () {
    let offset = 0;
    let logs = firstBatch.logs;

    while (logs.length > 0) {
      for (const log of logs) {
        if (log.timestamp < dateRangeStart) dateRangeStart = log.timestamp;
        if (log.timestamp > dateRangeEnd) dateRangeEnd = log.timestamp;
        yield log;
      }

      offset += logs.length;
      if (offset >= count) {
        break;
      }

      logs = (await queryAuditLogsForArchiveBatch(options, olderThan, batchSize, offset)).logs;
    }
  });

  const store = getArchiveStore();
  const result = await store.upload(options.tenantId, 'audit_logs', stream, {
    recordCount: count,
    checksum: 'pending',
  });

  const { checksum, recordCount } = getResult();

  const manifest = await ArchiveManifest.create({
    tenantId: options.tenantId,
    type: 'audit_logs',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    storageKey: result.path,
    region: result.region,
    checksum,
    dateRangeStart,
    dateRangeEnd,
  });
  const manifestObj = manifest.toObject();

  return {
    id: manifestObj._id,
    tenantId: options.tenantId,
    type: 'audit_logs',
    recordCount,
    sizeBytes: result.sizeBytes,
    format: 'ndjson.gz',
    path: result.path,
    region: result.region,
    checksum,
    createdAt: manifestObj.createdAt,
  };
}

/**
 * Create a Readable stream that yields NDJSON lines on-demand from an async generator.
 * Computes SHA-256 checksum incrementally without buffering the entire dataset in memory.
 */
function createNDJSONStream(generator: () => AsyncGenerator<any>): {
  stream: Readable;
  getResult: () => { checksum: string; recordCount: number };
} {
  const hash = crypto.createHash('sha256');
  let recordCount = 0;
  let done = false;

  const iter = generator();

  const stream = new Readable({
    async read() {
      try {
        const { value, done: iterDone } = await iter.next();
        if (iterDone) {
          if (!done) {
            done = true;
          }
          this.push(null);
          return;
        }
        const line = JSON.stringify(value) + '\n';
        const buf = Buffer.from(line, 'utf-8');
        hash.update(buf);
        recordCount++;
        this.push(buf);
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  const getResult = () => ({
    checksum: hash.digest('hex'),
    recordCount,
  });

  return { stream, getResult };
}
