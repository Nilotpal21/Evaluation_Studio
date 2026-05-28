import { resolve } from 'node:path';

import type { ReplayExecutionContext, WorkspaceExecutionContext } from './types.js';

export function resolveCliWorkspaceContext(
  requestedWorkDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceExecutionContext {
  const sourceWorkDir = env.HELIX_SOURCE_WORKDIR?.trim();
  if (!sourceWorkDir) {
    return { mode: 'in-place' };
  }

  const resolvedSourceWorkDir = resolve(sourceWorkDir);
  const resolvedWorktreeDir = resolve(env.HELIX_WORKTREE_DIR?.trim() || requestedWorkDir);
  if (resolvedSourceWorkDir === resolvedWorktreeDir) {
    return { mode: 'in-place' };
  }

  return {
    mode: 'git-worktree',
    sourceWorkDir: resolvedSourceWorkDir,
    worktreeDir: resolvedWorktreeDir,
  };
}

export function resolveInitialLiveContext(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.HELIX_INITIAL_LIVE_CONTEXT_JSON?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return parsed.trim() ? [parsed.trim()] : [];
    }

    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
  } catch {
    // Fall back to a single raw guidance string when the env is not JSON.
  }

  return raw.length > 0 ? [raw] : [];
}

export function resolveHelixFeatureFlags(env: NodeJS.ProcessEnv = process.env): {
  useOpenAiArchitectureOracle?: boolean;
  enableDuelingPlanners?: boolean;
  openaiModel?: string;
  embeddingsEnabled?: boolean;
  embeddingBaseUrl?: string;
  embeddingAuthToken?: string;
  embeddingTimeoutMs?: number;
  embeddingMaxBatchSize?: number;
  embeddingRequestBudget?: number;
  embeddingShardBasePath?: string;
} {
  const useOpenAiArchitectureOracle =
    env.HELIX_USE_OPENAI_ARCHITECTURE_ORACLE === 'true' ? true : undefined;
  const enableDuelingPlanners = env.HELIX_ENABLE_DUELING_PLANNERS === 'true' ? true : undefined;
  const openaiModel = env.HELIX_OPENAI_MODEL?.trim() || undefined;
  const embeddingsDisabled = parseBooleanEnv(env.HELIX_EMBEDDING_DISABLED) === true;
  const embeddingsEnabled = embeddingsDisabled
    ? false
    : parseBooleanEnv(env.HELIX_EMBEDDINGS_ENABLED);
  const embeddingBaseUrl = env.HELIX_EMBEDDING_BASE_URL?.trim() || undefined;
  const embeddingAuthToken = env.HELIX_EMBEDDING_AUTH_TOKEN?.trim() || undefined;
  const embeddingTimeoutMs = parsePositiveIntegerEnv(env.HELIX_EMBEDDING_TIMEOUT_MS);
  const embeddingMaxBatchSize = parsePositiveIntegerEnv(env.HELIX_EMBEDDING_MAX_BATCH_SIZE);
  const embeddingRequestBudget = parsePositiveIntegerEnv(env.HELIX_EMBEDDING_REQUEST_BUDGET);
  const embeddingShardBasePath =
    env.HELIX_EMBEDDING_SHARD_BASE_PATH?.trim() || env.SHARD_BASE_PATH?.trim() || undefined;
  return {
    useOpenAiArchitectureOracle,
    enableDuelingPlanners,
    openaiModel,
    embeddingsEnabled,
    embeddingBaseUrl,
    embeddingAuthToken,
    embeddingTimeoutMs,
    embeddingMaxBatchSize,
    embeddingRequestBudget,
    embeddingShardBasePath,
  };
}

export function resolveReplayContext(
  env: NodeJS.ProcessEnv = process.env,
): ReplayExecutionContext | undefined {
  const raw = env.HELIX_REPLAY_CONTEXT_JSON?.trim();
  if (!raw) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const changedFiles = Array.isArray((parsed as { changedFiles?: unknown }).changedFiles)
      ? (parsed as { changedFiles: unknown[] }).changedFiles
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : undefined;

    const tags = Array.isArray((parsed as { tags?: unknown }).tags)
      ? (parsed as { tags: unknown[] }).tags
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : undefined;

    const avoidPaths = Array.isArray((parsed as { avoidPaths?: unknown }).avoidPaths)
      ? (parsed as { avoidPaths: unknown[] }).avoidPaths
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : undefined;

    const historicalFileHintsSource = (parsed as { historicalFileHints?: unknown })
      .historicalFileHints;
    const historicalFileHints =
      historicalFileHintsSource &&
      typeof historicalFileHintsSource === 'object' &&
      !Array.isArray(historicalFileHintsSource)
        ? Object.fromEntries(
            Object.entries(historicalFileHintsSource)
              .map(([futurePath, candidates]) => {
                if (typeof futurePath !== 'string' || !futurePath.trim()) {
                  return null;
                }
                if (!Array.isArray(candidates)) {
                  return null;
                }
                const normalizedCandidates = candidates
                  .filter((entry): entry is string => typeof entry === 'string')
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0);
                if (normalizedCandidates.length === 0) {
                  return null;
                }
                return [futurePath.trim(), normalizedCandidates] as const;
              })
              .filter((entry): entry is readonly [string, string[]] => entry !== null),
          )
        : undefined;

    if (
      (!changedFiles || changedFiles.length === 0) &&
      (!avoidPaths || avoidPaths.length === 0) &&
      (!tags || tags.length === 0) &&
      (!historicalFileHints || Object.keys(historicalFileHints).length === 0)
    ) {
      return undefined;
    }

    return {
      changedFiles,
      historicalFileHints:
        historicalFileHints && Object.keys(historicalFileHints).length > 0
          ? historicalFileHints
          : undefined,
      avoidPaths,
      tags,
    };
  } catch {
    return undefined;
  }
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}
