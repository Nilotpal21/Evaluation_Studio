import type {
  HelixEmbeddingProviderConfig,
  HelixMcpServerDefinition,
  HelixStageModelPolicy,
  ModelSpec,
  StageExecutionRole,
  StageModelPolicyRule,
  StageType,
} from './types.js';
import {
  HELIX_EMBEDDING_DIMENSIONS,
  HELIX_EMBEDDING_MODEL_ID,
  HELIX_EMBEDDING_MODEL_KEY,
  HELIX_EMBEDDING_SHARD_LAYOUT,
  resolveEmbeddingShardBasePath,
} from './intelligence/embedding-config.js';

const DEFAULT_CLAUDE_REVIEW_PRIMARY = {
  engine: 'claude-code',
  model: 'claude-opus-4-7',
} as const;

const DEFAULT_CLAUDE_SYNTHESIS_PRIMARY = {
  engine: 'claude-api',
  model: 'claude-sonnet-4-6',
} as const;

const DEFAULT_CODEX_PRIMARY = {
  engine: 'codex-cli',
  model: 'gpt-5.5',
} as const;

const DEFAULT_CLAUDE_MODEL_REVIEW_PRIMARY: ModelSpec = {
  ...DEFAULT_CLAUDE_REVIEW_PRIMARY,
  maxTurns: 20,
  maxBudgetUsd: 10,
};

const DEFAULT_CLAUDE_ARCHITECTURE_REVIEW_PRIMARY: ModelSpec = {
  ...DEFAULT_CLAUDE_REVIEW_PRIMARY,
  maxTurns: 25,
  maxBudgetUsd: 12,
};

export const DEFAULT_STAGE_MODEL_POLICY: HelixStageModelPolicy = {
  roles: {
    bootstrap: {
      preferredEngine: 'claude-code',
      defaultPrimary: { ...DEFAULT_CLAUDE_REVIEW_PRIMARY },
    },
    explore: {
      preferredEngine: 'codex-cli',
      defaultPrimary: { ...DEFAULT_CODEX_PRIMARY },
    },
    plan: {
      preferredEngine: 'claude-code',
      defaultPrimary: { ...DEFAULT_CLAUDE_REVIEW_PRIMARY },
    },
    implement: {
      preferredEngine: 'codex-cli',
      defaultPrimary: { ...DEFAULT_CODEX_PRIMARY },
    },
    review: {
      preferredEngine: 'claude-code',
      defaultPrimary: { ...DEFAULT_CLAUDE_REVIEW_PRIMARY },
    },
    verify: {
      preferredEngine: 'claude-code',
      defaultPrimary: { ...DEFAULT_CLAUDE_REVIEW_PRIMARY },
    },
    synthesize: {
      preferredEngine: 'claude-api',
      defaultPrimary: { ...DEFAULT_CLAUDE_SYNTHESIS_PRIMARY },
    },
  },
  stages: {
    'deep-scan': {
      preferredEngine: 'claude-api',
      defaultPrimary: { ...DEFAULT_CLAUDE_SYNTHESIS_PRIMARY },
    },
    implementation: { preferredEngine: 'codex-cli' },
    testing: { preferredEngine: 'codex-cli' },
    reproduce: {
      preferredEngine: 'claude-api',
      defaultPrimary: { ...DEFAULT_CLAUDE_SYNTHESIS_PRIMARY },
    },
    'root-cause': {
      preferredEngine: 'claude-api',
      defaultPrimary: { ...DEFAULT_CLAUDE_SYNTHESIS_PRIMARY },
    },
    'oracle-analysis': { preferredEngine: 'claude-code' },
    'plan-generation': { preferredEngine: 'claude-code' },
    'manifest-compilation': { preferredEngine: 'claude-code' },
    'user-checkpoint': { preferredEngine: 'claude-code' },
    review: { preferredEngine: 'claude-code' },
    'bulk-review': { preferredEngine: 'claude-code' },
    regression: {
      preferredEngine: 'codex-cli',
      defaultPrimary: { ...DEFAULT_CODEX_PRIMARY },
    },
    'doc-sync': { preferredEngine: 'claude-code' },
  },
  architectureReview: {
    preferredEngine: 'claude-code',
    defaultPrimary: { ...DEFAULT_CLAUDE_ARCHITECTURE_REVIEW_PRIMARY },
  },
  modelReview: {
    preferredEngine: 'claude-code',
    defaultPrimary: { ...DEFAULT_CLAUDE_MODEL_REVIEW_PRIMARY },
  },
};

// ── Cross-Provider Quorum Feature Defaults ────────────────────
// No env reads in this file — env parsing lives in workspace-context.ts.
export const DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE = false;
export const DEFAULT_ENABLE_DUELING_PLANNERS = false;
export const DEFAULT_OPENAI_MODEL = 'gpt-5';
export const DEFAULT_HELIX_EMBEDDINGS_ENABLED = false;
export const DEFAULT_EMBEDDING_BASE_URL = 'http://localhost:8000';
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 120_000;
export const DEFAULT_EMBEDDING_MAX_BATCH_SIZE = 8;
export const DEFAULT_EMBEDDING_REQUEST_BUDGET = 4;

export function buildDefaultEmbeddingProviderConfig(config: {
  workDir: string;
  enabled?: boolean;
  baseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
  requestBudget?: number;
  shardBasePath?: string;
}): HelixEmbeddingProviderConfig {
  return {
    kind: 'bge-m3-local',
    enabled: config.enabled ?? DEFAULT_HELIX_EMBEDDINGS_ENABLED,
    modelId: HELIX_EMBEDDING_MODEL_ID,
    modelKey: HELIX_EMBEDDING_MODEL_KEY,
    dimensions: HELIX_EMBEDDING_DIMENSIONS,
    baseUrl: config.baseUrl?.trim() || DEFAULT_EMBEDDING_BASE_URL,
    ...(config.authToken?.trim() ? { authToken: config.authToken.trim() } : {}),
    timeoutMs: positiveIntegerOrDefault(config.timeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS),
    maxBatchSize: positiveIntegerOrDefault(config.maxBatchSize, DEFAULT_EMBEDDING_MAX_BATCH_SIZE),
    requestBudget: positiveIntegerOrDefault(config.requestBudget, DEFAULT_EMBEDDING_REQUEST_BUDGET),
    shardBasePath: resolveEmbeddingShardBasePath(config.workDir, config.shardBasePath),
    shardLayout: HELIX_EMBEDDING_SHARD_LAYOUT,
  };
}

export function isHelixEmbeddingsEnabled(config: {
  embeddingProvider?: Pick<HelixEmbeddingProviderConfig, 'enabled'>;
}): boolean {
  return config.embeddingProvider?.enabled === true;
}

export function buildDefaultHelixMcpServers(config: {
  workDir: string;
  sessionDir: string;
  journalDir: string;
}): Record<string, HelixMcpServerDefinition> {
  return {
    helix: {
      command: 'pnpm',
      args: [
        'exec',
        'tsx',
        'packages/helix/src/mcp-cli.ts',
        '--workdir',
        config.workDir,
        '--session-dir',
        config.sessionDir,
        '--journal-dir',
        config.journalDir,
      ],
    },
  };
}

export function mergeStageModelPolicy(
  base: HelixStageModelPolicy | undefined,
  override: HelixStageModelPolicy | undefined,
): HelixStageModelPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  const mergedStages: Partial<Record<StageType, StageModelPolicyRule>> = {
    ...(base?.stages ?? {}),
  };
  const mergedRoles: Partial<Record<StageExecutionRole, StageModelPolicyRule>> = {
    ...(base?.roles ?? {}),
  };

  for (const [stage, rule] of Object.entries(override?.stages ?? {}) as Array<
    [StageType, StageModelPolicyRule | undefined]
  >) {
    mergedStages[stage] = mergeStageModelPolicyRule(mergedStages[stage], rule);
  }

  for (const [role, rule] of Object.entries(override?.roles ?? {}) as Array<
    [StageExecutionRole, StageModelPolicyRule | undefined]
  >) {
    mergedRoles[role] = mergeStageModelPolicyRule(mergedRoles[role], rule);
  }

  return {
    ...(base ?? {}),
    ...(override ?? {}),
    stages: mergedStages,
    roles: mergedRoles,
    architectureReview: mergeStageModelPolicyRule(
      base?.architectureReview,
      override?.architectureReview,
    ),
    modelReview: mergeStageModelPolicyRule(base?.modelReview, override?.modelReview),
  };
}

export function mergeMcpServers(
  base: Record<string, HelixMcpServerDefinition> | undefined,
  override: Record<string, HelixMcpServerDefinition> | undefined,
): Record<string, HelixMcpServerDefinition> | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged = new Map<string, HelixMcpServerDefinition>();

  for (const [name, server] of Object.entries(base ?? {})) {
    merged.set(name, {
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(server.env ? { env: { ...server.env } } : {}),
    });
  }

  for (const [name, server] of Object.entries(override ?? {})) {
    const existing = merged.get(name);
    merged.set(name, {
      ...(existing ?? {}),
      ...server,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(existing?.env || server.env
        ? {
            env: {
              ...(existing?.env ?? {}),
              ...(server.env ?? {}),
            },
          }
        : {}),
    });
  }

  return Object.fromEntries(merged.entries());
}

function mergeStageModelPolicyRule(
  base: StageModelPolicyRule | undefined,
  override: StageModelPolicyRule | undefined,
): StageModelPolicyRule | undefined {
  if (!base && !override) {
    return undefined;
  }

  const mergedDefaultPrimary =
    base?.defaultPrimary || override?.defaultPrimary
      ? {
          ...(base?.defaultPrimary ?? {}),
          ...(override?.defaultPrimary ?? {}),
        }
      : undefined;

  return {
    ...(base ?? {}),
    ...(override ?? {}),
    ...(mergedDefaultPrimary?.engine
      ? {
          defaultPrimary: mergedDefaultPrimary as ModelSpec,
        }
      : {}),
  };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  return fallback;
}
