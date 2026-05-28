import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  EmbeddingShardPaths,
  HelixEmbeddingProviderConfig,
  IndexRebuildResult,
  ShardManifest,
} from '../types.js';

export const HELIX_EMBEDDING_MODEL_ID = 'bge-m3';
export const HELIX_EMBEDDING_DIMENSIONS = 1024;
export const HELIX_EMBEDDING_MODEL_KEY = `${HELIX_EMBEDDING_MODEL_ID}-${HELIX_EMBEDDING_DIMENSIONS}`;
export const HELIX_EMBEDDING_CACHE_ROOT = '.helix/cache/embeddings';
export const HELIX_EMBEDDING_SHARD_LAYOUT = 'per-session';

const CONSOLIDATED_FINDINGS_FILE = 'findings.jsonl';
const CONSOLIDATED_DECISIONS_FILE = 'decisions.jsonl';
const FINDINGS_SHARD_DIR = 'findings';
const DECISIONS_SHARD_DIR = 'decisions';

export function resolveEmbeddingShardBasePath(workDir: string, override?: string): string {
  const normalizedOverride = normalizeShardBasePathOverride(override);
  const configuredPath =
    normalizedOverride ?? join(HELIX_EMBEDDING_CACHE_ROOT, HELIX_EMBEDDING_MODEL_KEY);
  const resolvedPath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(workDir, configuredPath);
  assertPathInsideWorkDir(workDir, resolvedPath);
  return resolvedPath;
}

export function buildEmbeddingShardPaths(params: {
  basePath: string;
  sessionId: string;
  modelKey?: string;
}): EmbeddingShardPaths {
  const sessionId = params.sessionId.trim();
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error('Embedding shard session id must be a non-empty path segment.');
  }

  return {
    modelKey: params.modelKey ?? HELIX_EMBEDDING_MODEL_KEY,
    basePath: params.basePath,
    findingsShardPath: join(params.basePath, FINDINGS_SHARD_DIR, `${sessionId}.jsonl`),
    decisionsShardPath: join(params.basePath, DECISIONS_SHARD_DIR, `${sessionId}.jsonl`),
    consolidatedFindingsPath: join(params.basePath, CONSOLIDATED_FINDINGS_FILE),
    consolidatedDecisionsPath: join(params.basePath, CONSOLIDATED_DECISIONS_FILE),
  };
}

export function buildEmbeddingShardManifest(params: {
  basePath: string;
  shards: EmbeddingShardPaths[];
  generatedAt: string;
  model?: string;
  dimensions?: number;
}): ShardManifest {
  return {
    version: 1,
    model: params.model ?? HELIX_EMBEDDING_MODEL_ID,
    dimensions: params.dimensions ?? HELIX_EMBEDDING_DIMENSIONS,
    layout: HELIX_EMBEDDING_SHARD_LAYOUT,
    basePath: params.basePath,
    generatedAt: params.generatedAt,
    shards: params.shards,
    consolidated: {
      findingsPath: join(params.basePath, CONSOLIDATED_FINDINGS_FILE),
      decisionsPath: join(params.basePath, CONSOLIDATED_DECISIONS_FILE),
    },
  };
}

export function emptyIndexRebuildResult(params: {
  dryRun: boolean;
  durationMs: number;
  manifest?: ShardManifest;
}): IndexRebuildResult {
  return {
    dryRun: params.dryRun,
    filesScanned: 0,
    findingsWritten: 0,
    decisionsWritten: 0,
    rowsSkipped: 0,
    shardsCompacted: 0,
    durationMs: params.durationMs,
    ...(params.manifest ? { manifest: params.manifest } : {}),
  };
}

export function getEmbeddingShardPathsForSession(
  provider: HelixEmbeddingProviderConfig | undefined,
  sessionId: string,
): EmbeddingShardPaths | undefined {
  if (provider?.enabled !== true) {
    return undefined;
  }

  return buildEmbeddingShardPaths({
    basePath: provider.shardBasePath,
    sessionId,
    modelKey: provider.modelKey,
  });
}

function normalizeShardBasePathOverride(override: string | undefined): string | undefined {
  const trimmed = override?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutTrailingSlash = trimmed.replace(/[\\/]+$/g, '');
  const leaf = basename(withoutTrailingSlash);
  if (
    leaf === CONSOLIDATED_FINDINGS_FILE ||
    leaf === CONSOLIDATED_DECISIONS_FILE ||
    leaf === FINDINGS_SHARD_DIR ||
    leaf === DECISIONS_SHARD_DIR
  ) {
    return dirname(withoutTrailingSlash);
  }

  return withoutTrailingSlash;
}

function assertPathInsideWorkDir(workDir: string, candidatePath: string): void {
  const relativePath = relative(resolve(workDir), candidatePath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return;
  }

  throw new Error('Embedding shard base path must stay inside the configured workDir.');
}
