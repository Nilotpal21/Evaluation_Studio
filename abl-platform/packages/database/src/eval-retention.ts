import {
  CH_EVAL_DATA_TTL_DAYS,
  CH_PRODUCTION_SCORES_TTL_DAYS,
  EVAL_RETENTION_MAX_TTL_DAYS,
  EVAL_RETENTION_MIN_TTL_DAYS,
  EVAL_SYNTHETIC_DATA_TTL_DAYS,
} from './constants/eval-limits.js';

export const EVAL_KNOWN_SOURCES = ['production', 'eval', 'synthetic'] as const;

export type EvalKnownSource = (typeof EVAL_KNOWN_SOURCES)[number];

export interface TenantEvalRetentionConfig {
  evalConversationsTtlDays?: number;
  evalScoresTtlDays?: number;
  productionScoresTtlDays?: number;
  syntheticTtlDays?: number;
  hardDeleteExpiredRuns?: boolean;
  scrubPiiOnStore?: boolean;
}

export interface TenantSettingsWithEvalRetention {
  evalRetention?: TenantEvalRetentionConfig | null;
}

export interface EvalRetentionDefaults {
  evalConversationsTtlDays: number;
  evalScoresTtlDays: number;
  productionScoresTtlDays: number;
  syntheticTtlDays: number;
  hardDeleteExpiredRuns: boolean;
  scrubPiiOnStore: boolean;
}

export interface EvalRetentionContract extends EvalRetentionDefaults {
  overrides: TenantEvalRetentionConfig;
}

export const DEFAULT_EVAL_RETENTION: EvalRetentionDefaults = {
  evalConversationsTtlDays: CH_EVAL_DATA_TTL_DAYS,
  evalScoresTtlDays: CH_EVAL_DATA_TTL_DAYS,
  productionScoresTtlDays: CH_PRODUCTION_SCORES_TTL_DAYS,
  syntheticTtlDays: EVAL_SYNTHETIC_DATA_TTL_DAYS,
  hardDeleteExpiredRuns: false,
  scrubPiiOnStore: false,
};

export function normalizeEvalKnownSource(value: unknown): EvalKnownSource {
  return EVAL_KNOWN_SOURCES.includes(value as EvalKnownSource)
    ? (value as EvalKnownSource)
    : 'eval';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveOptionalTtl(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

export function assertEvalRetentionTtlBounds(ttlDays: number, fieldName: string): void {
  if (
    !Number.isInteger(ttlDays) ||
    ttlDays < EVAL_RETENTION_MIN_TTL_DAYS ||
    ttlDays > EVAL_RETENTION_MAX_TTL_DAYS
  ) {
    throw new Error(
      `${fieldName} must be an integer between ${EVAL_RETENTION_MIN_TTL_DAYS} and ${EVAL_RETENTION_MAX_TTL_DAYS}`,
    );
  }
}

export function resolveEvalRetentionContract(
  settings?: TenantSettingsWithEvalRetention | null,
): EvalRetentionContract {
  const overrides = settings?.evalRetention ?? {};
  const contract: EvalRetentionContract = {
    evalConversationsTtlDays: resolveOptionalTtl(
      overrides.evalConversationsTtlDays,
      DEFAULT_EVAL_RETENTION.evalConversationsTtlDays,
    ),
    evalScoresTtlDays: resolveOptionalTtl(
      overrides.evalScoresTtlDays,
      DEFAULT_EVAL_RETENTION.evalScoresTtlDays,
    ),
    productionScoresTtlDays: resolveOptionalTtl(
      overrides.productionScoresTtlDays,
      DEFAULT_EVAL_RETENTION.productionScoresTtlDays,
    ),
    syntheticTtlDays: resolveOptionalTtl(
      overrides.syntheticTtlDays,
      DEFAULT_EVAL_RETENTION.syntheticTtlDays,
    ),
    hardDeleteExpiredRuns: overrides.hardDeleteExpiredRuns === true,
    scrubPiiOnStore: overrides.scrubPiiOnStore === true,
    overrides: { ...overrides },
  };

  assertEvalRetentionTtlBounds(
    contract.evalConversationsTtlDays,
    'evalRetention.evalConversationsTtlDays',
  );
  assertEvalRetentionTtlBounds(contract.evalScoresTtlDays, 'evalRetention.evalScoresTtlDays');
  assertEvalRetentionTtlBounds(
    contract.productionScoresTtlDays,
    'evalRetention.productionScoresTtlDays',
  );
  assertEvalRetentionTtlBounds(contract.syntheticTtlDays, 'evalRetention.syntheticTtlDays');

  if (contract.syntheticTtlDays >= contract.evalConversationsTtlDays) {
    throw new Error(
      'evalRetention.syntheticTtlDays must be strictly shorter than evalRetention.evalConversationsTtlDays',
    );
  }
  if (contract.syntheticTtlDays >= contract.evalScoresTtlDays) {
    throw new Error(
      'evalRetention.syntheticTtlDays must be strictly shorter than evalRetention.evalScoresTtlDays',
    );
  }

  return contract;
}

export function resolveEvalConversationTtlDays(
  contract: EvalRetentionContract,
  knownSource: EvalKnownSource,
): number {
  return knownSource === 'synthetic'
    ? contract.syntheticTtlDays
    : contract.evalConversationsTtlDays;
}

export function resolveEvalScoreTtlDays(
  contract: EvalRetentionContract,
  knownSource: EvalKnownSource,
): number {
  return knownSource === 'synthetic' ? contract.syntheticTtlDays : contract.evalScoresTtlDays;
}

export function assertDefaultSyntheticRetentionIsShorter(): void {
  if (DEFAULT_EVAL_RETENTION.syntheticTtlDays >= DEFAULT_EVAL_RETENTION.evalConversationsTtlDays) {
    throw new Error('Default synthetic eval TTL must be shorter than default conversation TTL');
  }
  if (DEFAULT_EVAL_RETENTION.syntheticTtlDays >= DEFAULT_EVAL_RETENTION.evalScoresTtlDays) {
    throw new Error('Default synthetic eval TTL must be shorter than default score TTL');
  }
}
