import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import {
  buildDefaultEmbeddingProviderConfig,
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDING_REQUEST_BUDGET,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_STAGE_MODEL_POLICY,
  DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE,
  DEFAULT_ENABLE_DUELING_PLANNERS,
  DEFAULT_HELIX_EMBEDDINGS_ENABLED,
  DEFAULT_OPENAI_MODEL,
  mergeStageModelPolicy,
} from '../runtime-config.js';
import { resolveHelixFeatureFlags } from '../workspace-context.js';

describe('runtime-config stage model policy', () => {
  it('defines role defaults for the control-plane rewrite', () => {
    expect(DEFAULT_STAGE_MODEL_POLICY.roles?.explore?.preferredEngine).toBe('codex-cli');
    expect(DEFAULT_STAGE_MODEL_POLICY.roles?.implement?.preferredEngine).toBe('codex-cli');
    expect(DEFAULT_STAGE_MODEL_POLICY.roles?.plan?.preferredEngine).toBe('claude-code');
    expect(DEFAULT_STAGE_MODEL_POLICY.roles?.review?.preferredEngine).toBe('claude-code');
    expect(DEFAULT_STAGE_MODEL_POLICY.roles?.synthesize?.preferredEngine).toBe('claude-api');
    expect(DEFAULT_STAGE_MODEL_POLICY.stages?.['deep-scan']?.preferredEngine).toBe('claude-api');
    expect(DEFAULT_STAGE_MODEL_POLICY.stages?.reproduce?.preferredEngine).toBe('claude-api');
    expect(DEFAULT_STAGE_MODEL_POLICY.stages?.['root-cause']?.preferredEngine).toBe('claude-api');
    expect(DEFAULT_STAGE_MODEL_POLICY.stages?.regression?.preferredEngine).toBe('codex-cli');
    expect(DEFAULT_STAGE_MODEL_POLICY.stages?.regression?.defaultPrimary).toMatchObject({
      engine: 'codex-cli',
      model: 'gpt-5.4',
    });
  });

  // ── UT-9: Config defaults for new cross-provider fields ──────

  it('default useOpenAiArchitectureOracle is false', () => {
    expect(DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE).toBe(false);
  });

  it('default enableDuelingPlanners is false', () => {
    expect(DEFAULT_ENABLE_DUELING_PLANNERS).toBe(false);
  });

  it('default openaiModel is gpt-5', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5');
  });

  it('default embeddings config is disabled and uses the per-session shard base', () => {
    const workDir = resolve('fixture-workdir');
    const provider = buildDefaultEmbeddingProviderConfig({ workDir });

    expect(DEFAULT_HELIX_EMBEDDINGS_ENABLED).toBe(false);
    expect(provider).toMatchObject({
      kind: 'bge-m3-local',
      enabled: false,
      modelId: 'bge-m3',
      modelKey: 'bge-m3-1024',
      dimensions: 1024,
      baseUrl: DEFAULT_EMBEDDING_BASE_URL,
      timeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS,
      maxBatchSize: DEFAULT_EMBEDDING_MAX_BATCH_SIZE,
      requestBudget: DEFAULT_EMBEDDING_REQUEST_BUDGET,
      shardLayout: 'per-session',
      shardBasePath: join(workDir, '.helix/cache/embeddings/bge-m3-1024'),
    });
  });

  it('normalizes flat SHARD_BASE_PATH values to the authoritative shard base', () => {
    const workDir = resolve('fixture-workdir');
    const flags = resolveHelixFeatureFlags({
      SHARD_BASE_PATH: '.helix/cache/embeddings/bge-m3-1024/findings.jsonl',
    });
    const provider = buildDefaultEmbeddingProviderConfig({
      workDir,
      shardBasePath: flags.embeddingShardBasePath,
    });

    expect(provider.shardBasePath).toBe(join(workDir, '.helix/cache/embeddings/bge-m3-1024'));
  });

  it('rejects embedding shard bases outside the configured workDir', () => {
    expect(() =>
      buildDefaultEmbeddingProviderConfig({
        workDir: resolve('fixture-workdir'),
        shardBasePath: resolve('outside-workdir/.helix/cache/embeddings/bge-m3-1024'),
      }),
    ).toThrow(/inside the configured workDir/);
  });

  it('merges role rules without dropping stage rules', () => {
    const merged = mergeStageModelPolicy(
      {
        roles: {
          explore: { preferredEngine: 'codex-cli' },
        },
        stages: {
          'deep-scan': { preferredEngine: 'codex-cli' },
        },
      },
      {
        roles: {
          review: {
            preferredEngine: 'claude-code',
            defaultPrimary: { engine: 'claude-code', model: 'claude-sonnet-4-6' },
          },
        },
      },
    );

    expect(merged?.roles?.explore?.preferredEngine).toBe('codex-cli');
    expect(merged?.roles?.review?.preferredEngine).toBe('claude-code');
    expect(merged?.roles?.review?.defaultPrimary?.model).toBe('claude-sonnet-4-6');
    expect(merged?.stages?.['deep-scan']?.preferredEngine).toBe('codex-cli');
  });
});

// ── UT-9: resolveHelixFeatureFlags env parsing ──────────────────

describe('UT-9: resolveHelixFeatureFlags', () => {
  let savedOracle: string | undefined;
  let savedDueling: string | undefined;
  let savedModel: string | undefined;
  let savedEmbeddingsEnabled: string | undefined;
  let savedEmbeddingBaseUrl: string | undefined;
  let savedEmbeddingAuthToken: string | undefined;
  let savedEmbeddingTimeoutMs: string | undefined;
  let savedEmbeddingMaxBatchSize: string | undefined;
  let savedEmbeddingRequestBudget: string | undefined;
  let savedEmbeddingShardBasePath: string | undefined;
  let savedEmbeddingDisabled: string | undefined;
  let savedShardBasePath: string | undefined;

  beforeEach(() => {
    savedOracle = process.env.HELIX_USE_OPENAI_ARCHITECTURE_ORACLE;
    savedDueling = process.env.HELIX_ENABLE_DUELING_PLANNERS;
    savedModel = process.env.HELIX_OPENAI_MODEL;
    savedEmbeddingsEnabled = process.env.HELIX_EMBEDDINGS_ENABLED;
    savedEmbeddingBaseUrl = process.env.HELIX_EMBEDDING_BASE_URL;
    savedEmbeddingAuthToken = process.env.HELIX_EMBEDDING_AUTH_TOKEN;
    savedEmbeddingTimeoutMs = process.env.HELIX_EMBEDDING_TIMEOUT_MS;
    savedEmbeddingMaxBatchSize = process.env.HELIX_EMBEDDING_MAX_BATCH_SIZE;
    savedEmbeddingRequestBudget = process.env.HELIX_EMBEDDING_REQUEST_BUDGET;
    savedEmbeddingShardBasePath = process.env.HELIX_EMBEDDING_SHARD_BASE_PATH;
    savedEmbeddingDisabled = process.env.HELIX_EMBEDDING_DISABLED;
    savedShardBasePath = process.env.SHARD_BASE_PATH;
  });

  afterEach(() => {
    restoreEnv('HELIX_USE_OPENAI_ARCHITECTURE_ORACLE', savedOracle);
    restoreEnv('HELIX_ENABLE_DUELING_PLANNERS', savedDueling);
    restoreEnv('HELIX_OPENAI_MODEL', savedModel);
    restoreEnv('HELIX_EMBEDDINGS_ENABLED', savedEmbeddingsEnabled);
    restoreEnv('HELIX_EMBEDDING_BASE_URL', savedEmbeddingBaseUrl);
    restoreEnv('HELIX_EMBEDDING_AUTH_TOKEN', savedEmbeddingAuthToken);
    restoreEnv('HELIX_EMBEDDING_TIMEOUT_MS', savedEmbeddingTimeoutMs);
    restoreEnv('HELIX_EMBEDDING_MAX_BATCH_SIZE', savedEmbeddingMaxBatchSize);
    restoreEnv('HELIX_EMBEDDING_REQUEST_BUDGET', savedEmbeddingRequestBudget);
    restoreEnv('HELIX_EMBEDDING_SHARD_BASE_PATH', savedEmbeddingShardBasePath);
    restoreEnv('HELIX_EMBEDDING_DISABLED', savedEmbeddingDisabled);
    restoreEnv('SHARD_BASE_PATH', savedShardBasePath);
  });

  it('HELIX_USE_OPENAI_ARCHITECTURE_ORACLE=true returns useOpenAiArchitectureOracle: true', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_USE_OPENAI_ARCHITECTURE_ORACLE: 'true',
    });
    expect(result.useOpenAiArchitectureOracle).toBe(true);
  });

  it('HELIX_OPENAI_MODEL=gpt-5-turbo returns openaiModel: gpt-5-turbo', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_OPENAI_MODEL: 'gpt-5-turbo',
    });
    expect(result.openaiModel).toBe('gpt-5-turbo');
  });

  it('HELIX_OPENAI_MODEL with whitespace-only falls through to undefined', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_OPENAI_MODEL: '  ',
    });
    expect(result.openaiModel).toBeUndefined();
  });

  it('empty env returns all undefined', () => {
    const result = resolveHelixFeatureFlags({});
    expect(result.useOpenAiArchitectureOracle).toBeUndefined();
    expect(result.enableDuelingPlanners).toBeUndefined();
    expect(result.openaiModel).toBeUndefined();
    expect(result.embeddingsEnabled).toBeUndefined();
    expect(result.embeddingBaseUrl).toBeUndefined();
    expect(result.embeddingAuthToken).toBeUndefined();
    expect(result.embeddingTimeoutMs).toBeUndefined();
    expect(result.embeddingMaxBatchSize).toBeUndefined();
    expect(result.embeddingRequestBudget).toBeUndefined();
    expect(result.embeddingShardBasePath).toBeUndefined();
  });

  it('HELIX_ENABLE_DUELING_PLANNERS=true returns enableDuelingPlanners: true', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_ENABLE_DUELING_PLANNERS: 'true',
    });
    expect(result.enableDuelingPlanners).toBe(true);
  });

  it('HELIX_USE_OPENAI_ARCHITECTURE_ORACLE=false falls through to undefined', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_USE_OPENAI_ARCHITECTURE_ORACLE: 'false',
    });
    expect(result.useOpenAiArchitectureOracle).toBeUndefined();
  });

  it('HELIX_EMBEDDINGS_ENABLED=true returns embeddingsEnabled: true', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_EMBEDDINGS_ENABLED: 'true',
    });
    expect(result.embeddingsEnabled).toBe(true);
  });

  it('HELIX_EMBEDDING_DISABLED disables embeddings even when opt-in is present', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_EMBEDDINGS_ENABLED: 'true',
      HELIX_EMBEDDING_DISABLED: '1',
    });
    expect(result.embeddingsEnabled).toBe(false);
  });

  it('parses BGE-M3 endpoint, auth, timeout, request budget, and shard base env', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_EMBEDDING_BASE_URL: ' http://127.0.0.1:8000 ',
      HELIX_EMBEDDING_AUTH_TOKEN: ' secret-token ',
      HELIX_EMBEDDING_TIMEOUT_MS: '3000',
      HELIX_EMBEDDING_MAX_BATCH_SIZE: '5',
      HELIX_EMBEDDING_REQUEST_BUDGET: '2',
      HELIX_EMBEDDING_SHARD_BASE_PATH: '.helix/custom-embeddings',
    });

    expect(result.embeddingBaseUrl).toBe('http://127.0.0.1:8000');
    expect(result.embeddingAuthToken).toBe('secret-token');
    expect(result.embeddingTimeoutMs).toBe(3000);
    expect(result.embeddingMaxBatchSize).toBe(5);
    expect(result.embeddingRequestBudget).toBe(2);
    expect(result.embeddingShardBasePath).toBe('.helix/custom-embeddings');
  });

  it('invalid numeric BGE-M3 env values are ignored', () => {
    const result = resolveHelixFeatureFlags({
      HELIX_EMBEDDING_TIMEOUT_MS: '-1',
      HELIX_EMBEDDING_MAX_BATCH_SIZE: '0',
      HELIX_EMBEDDING_REQUEST_BUDGET: 'abc',
    });

    expect(result.embeddingTimeoutMs).toBeUndefined();
    expect(result.embeddingMaxBatchSize).toBeUndefined();
    expect(result.embeddingRequestBudget).toBeUndefined();
  });

  it('defaults preserve existing behavior (feature-spec §17 row 23 regression)', () => {
    // When no HELIX_* env vars are set, the defaults should not activate new features
    const flags = resolveHelixFeatureFlags({});
    expect(flags.useOpenAiArchitectureOracle ?? DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE).toBe(false);
    expect(flags.enableDuelingPlanners ?? DEFAULT_ENABLE_DUELING_PLANNERS).toBe(false);
    expect(flags.openaiModel ?? DEFAULT_OPENAI_MODEL).toBe('gpt-5');
    expect(flags.embeddingsEnabled ?? DEFAULT_HELIX_EMBEDDINGS_ENABLED).toBe(false);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value !== undefined) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
