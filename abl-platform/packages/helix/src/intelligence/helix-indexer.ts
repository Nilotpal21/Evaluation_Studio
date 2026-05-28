/**
 * HelixIndexer — thin CLI rebuild path for `helix index rebuild`.
 *
 * Walks all per-session JSONL shard files under the embedding cache root,
 * consolidates them into flat `findings.jsonl` and `decisions.jsonl` files,
 * and emits an `IndexRebuildResult` with counts.
 *
 * Design decisions (from LLD D-L1):
 * - The indexer does NOT duplicate ShardWriter logic; it delegates all
 *   shard I/O to `readEmbeddingShardFile` and `writeConsolidatedShardFile`.
 * - When `dryRun = true` it scans and counts without writing.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EmbeddingRecord,
  HelixEmbeddingProviderConfig,
  IndexRebuildResult,
} from '../types.js';
import {
  buildEmbeddingShardManifest,
  buildEmbeddingShardPaths,
  emptyIndexRebuildResult,
} from './embedding-config.js';
import { readEmbeddingShardFile, writeConsolidatedShardFile } from './shard-writer.js';

export interface HelixIndexerOptions {
  dryRun?: boolean;
}

/**
 * Rebuild the consolidated JSONL index from all per-session shard files.
 *
 * @param provider  Embedding provider config (must have `enabled: true`).
 * @param options   `{ dryRun?: boolean }`.
 * @returns         `IndexRebuildResult` with counts and optional manifest.
 */
export async function rebuildEmbeddingIndex(
  provider: HelixEmbeddingProviderConfig,
  options: HelixIndexerOptions = {},
): Promise<IndexRebuildResult> {
  const startMs = Date.now();
  const { dryRun = false } = options;

  if (!provider.enabled) {
    return emptyIndexRebuildResult({ dryRun, durationMs: 0 });
  }

  const basePath = provider.shardBasePath;

  // Walk findings shards
  const findingsRecords = await collectShards(join(basePath, 'findings'));
  // Walk decisions shards
  const decisionsRecords = await collectShards(join(basePath, 'decisions'));

  const filesScanned = findingsRecords.filesScanned + decisionsRecords.filesScanned;
  const rowsSkipped = findingsRecords.rowsSkipped + decisionsRecords.rowsSkipped;

  if (!dryRun) {
    if (findingsRecords.records.length > 0) {
      const mockSessionId = 'consolidated';
      const shardPaths = buildEmbeddingShardPaths({ basePath, sessionId: mockSessionId });
      await writeConsolidatedShardFile(
        shardPaths.consolidatedFindingsPath,
        findingsRecords.records,
      );
    }
    if (decisionsRecords.records.length > 0) {
      const mockSessionId = 'consolidated';
      const shardPaths = buildEmbeddingShardPaths({ basePath, sessionId: mockSessionId });
      await writeConsolidatedShardFile(
        shardPaths.consolidatedDecisionsPath,
        decisionsRecords.records,
      );
    }
  }

  const generatedAt = new Date().toISOString();
  const manifest = buildEmbeddingShardManifest({
    basePath,
    shards: [],
    generatedAt,
    model: provider.modelId,
    dimensions: provider.dimensions,
  });

  const durationMs = Date.now() - startMs;

  return {
    dryRun,
    filesScanned,
    findingsWritten: dryRun ? 0 : findingsRecords.records.length,
    decisionsWritten: dryRun ? 0 : decisionsRecords.records.length,
    rowsSkipped,
    shardsCompacted: dryRun ? 0 : findingsRecords.filesScanned + decisionsRecords.filesScanned,
    durationMs,
    manifest,
  };
}

// ── Private helpers ────────────────────────────────────────────────────────────

interface CollectResult {
  records: EmbeddingRecord[];
  filesScanned: number;
  rowsSkipped: number;
}

async function collectShards(shardDir: string): Promise<CollectResult> {
  let files: string[];
  try {
    files = await readdir(shardDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { records: [], filesScanned: 0, rowsSkipped: 0 };
    }
    throw err;
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
  const allRecords: EmbeddingRecord[] = [];
  let rowsSkipped = 0;

  for (const file of jsonlFiles) {
    const filePath = join(shardDir, file);
    try {
      const records = await readEmbeddingShardFile(filePath);
      allRecords.push(...records);
    } catch {
      rowsSkipped++;
      process.stderr.write(`[helix:indexer] failed to read shard ${filePath} — skipping\n`);
    }
  }

  return { records: allRecords, filesScanned: jsonlFiles.length, rowsSkipped };
}
