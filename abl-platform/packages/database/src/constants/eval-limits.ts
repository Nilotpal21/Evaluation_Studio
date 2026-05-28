/**
 * Eval Domain Constants
 *
 * Single source of truth for all validation limits, defaults, and
 * configuration values used across Zod schemas, Mongoose models,
 * and ClickHouse DDL.
 */

// ── String Length Limits ─────────────────────────────────────────────
export const EVAL_NAME_MAX_LENGTH = 200;
export const EVAL_DESCRIPTION_MAX_LENGTH = 2000;
export const EVAL_NOTES_MAX_LENGTH = 2000;
export const EVAL_TRAIT_MAX_LENGTH = 100;
export const EVAL_TAG_MAX_LENGTH = 100;
export const EVAL_CATEGORY_MAX_LENGTH = 100;
export const EVAL_AGENT_NAME_MAX_LENGTH = 200;
export const EVAL_MILESTONE_MAX_LENGTH = 500;
export const EVAL_GOALS_MAX_LENGTH = 2000;
export const EVAL_CONSTRAINTS_MAX_LENGTH = 2000;
export const EVAL_SYSTEM_PROMPT_MAX_LENGTH = 5000;
export const EVAL_LONG_TEXT_MAX_LENGTH = 5000;
export const EVAL_JUDGE_PROMPT_MAX_LENGTH = 10_000;

// ── Array Size Limits ────────────────────────────────────────────────
export const EVAL_BEHAVIOR_TRAITS_MAX_COUNT = 20;
export const EVAL_SESSION_VARIABLES_MAX_BYTES = 32 * 1024;

// ── Numeric Range Bounds ─────────────────────────────────────────────
export const EVAL_TEMPERATURE_MIN = 0;
export const EVAL_TEMPERATURE_MAX = 2;
export const EVAL_MAX_TURNS_MIN = 1;
export const EVAL_MAX_TURNS_MAX = 200;
export const EVAL_VARIANTS_MIN = 1;
export const EVAL_VARIANTS_MAX = 10;
export const EVAL_MAX_CONCURRENCY_MIN = 1;
export const EVAL_MAX_CONCURRENCY_MAX = 20;

// ── Default Values ───────────────────────────────────────────────────
export const EVAL_DEFAULT_VERSION = 1;
export const EVAL_DEFAULT_MAX_TURNS = 10;
export const EVAL_DEFAULT_TEMPERATURE = 0;
export const EVAL_DEFAULT_VARIANTS = 3;
export const EVAL_DEFAULT_MAX_CONCURRENCY = 5;
export const EVAL_DEFAULT_PERSONA_TEMPERATURE = 0.7;
export const EVAL_DEFAULT_PERSONA_MAX_TOKENS = 512;
export const EVAL_DEFAULT_CONFIDENCE = 1.0;

// ── Query & Pagination ───────────────────────────────────────────────
export const EVAL_LIST_DEFAULT_PAGE_SIZE = 50;
export const EVAL_LIST_MAX_PAGE_SIZE = 100;

// ── ClickHouse Constants ─────────────────────────────────────────────
export const CH_EVAL_DATA_TTL_DAYS = 730;
export const CH_PRODUCTION_SCORES_TTL_DAYS = 365;
export const EVAL_RETENTION_MIN_TTL_DAYS = 7;
export const EVAL_RETENTION_MAX_TTL_DAYS = 730;
export const EVAL_SYNTHETIC_DATA_TTL_DAYS = 30;
