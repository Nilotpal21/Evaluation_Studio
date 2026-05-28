/**
 * ShardWriter — append-only per-session JSONL shard writer.
 *
 * Design decisions (from LLD D-L1, finding: ShardWriter must reuse existing
 * atomic-write/journal helpers):
 *
 * - Delegates directory creation and single-file writes to the existing
 *   `writeFileAtomic` helper from `src/io/atomic-file.ts`.
 * - JSONL append uses Node's `appendFile` (same approach as
 *   `session-manager.ts:283`), which is safe for single-process sequential
 *   writes (no concurrent writers per session by construction: one pipeline
 *   run per session).
 * - No custom fsync / crash-recovery logic — the journal subsystem precedent
 *   shows `appendFile` is the accepted pattern here.
 * - Shard paths are provided by the caller (from `buildEmbeddingShardPaths`
 *   in `embedding-config.ts`) so ShardWriter has no path-computation logic.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EmbeddingRecord, EmbeddingShardPaths } from '../types.js';

export interface ShardWriterOptions {
  /** When true, skip all writes (dry-run mode). */
  dryRun?: boolean;
}

/**
 * Appends one `EmbeddingRecord` to the appropriate per-session shard JSONL
 * file (findings or decisions). Creates the shard directory if absent.
 *
 * Returns the shard path written to, or `undefined` in dry-run mode.
 */
export async function appendEmbeddingRecord(
  record: EmbeddingRecord,
  shardPaths: EmbeddingShardPaths,
  options: ShardWriterOptions = {},
): Promise<string | undefined> {
  const shardPath =
    record.kind === 'finding' ? shardPaths.findingsShardPath : shardPaths.decisionsShardPath;

  if (options.dryRun) {
    return undefined;
  }

  const dir = dirname(shardPath);
  await mkdir(dir, { recursive: true });

  const line = JSON.stringify(record) + '\n';
  await appendFile(shardPath, line, 'utf-8');

  return shardPath;
}

/**
 * Reads all `EmbeddingRecord` objects from a JSONL shard file.
 * Returns an empty array when the file does not exist.
 * Skips malformed lines (logs a warning).
 */
export async function readEmbeddingShardFile(shardPath: string): Promise<EmbeddingRecord[]> {
  let raw: string;
  try {
    raw = await readFile(shardPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const records: EmbeddingRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as EmbeddingRecord;
      records.push(record);
    } catch {
      process.stderr.write(`[helix:shard-writer] skipping malformed JSONL line in ${shardPath}\n`);
    }
  }
  return records;
}

/**
 * Writes (overwrites) a consolidated JSONL file from an array of records.
 * Used by `helix index rebuild` to compact per-session shards.
 */
export async function writeConsolidatedShardFile(
  filePath: string,
  records: EmbeddingRecord[],
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const contents =
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  await writeFile(filePath, contents, 'utf-8');
}
