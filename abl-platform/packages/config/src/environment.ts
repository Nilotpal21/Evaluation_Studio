/**
 * Unified Environment Type
 *
 * Canonical environment values used across the entire platform.
 */

/** Canonical environment type */
export type Environment = 'dev' | 'staging' | 'production';

/** Valid environment values for validation (Zod, Mongoose, route guards) */
export const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

/** Valid environment values including 'global' (for env var contexts where variables can be shared across all environments) */
export const VALID_ENVIRONMENTS_WITH_GLOBAL = ['global', 'dev', 'staging', 'production'] as const;

/** @deprecated Use VALID_ENVIRONMENTS_WITH_GLOBAL — 'global' replaces null for base variable values */
export const VALID_ENVIRONMENTS_NULLABLE = ['dev', 'staging', 'production', null] as const;

const ENV_ALIASES: Record<string, Environment> = {
  development: 'dev',
  dev: 'dev',
  staging: 'staging',
  stg: 'staging',
  production: 'production',
  prod: 'production',
};

/**
 * Normalize any environment string to the canonical form.
 *
 * Maps common aliases:
 * - 'development' -> 'dev'
 * - 'production' -> 'production' (identity)
 * - 'prod' -> 'production'
 * - 'stg' -> 'staging'
 *
 * Throws if the input doesn't match any known alias.
 */
export function normalizeEnvironment(raw: string | undefined): Environment {
  if (!raw) return 'dev';
  const normalized = ENV_ALIASES[raw.toLowerCase().trim()];
  if (!normalized) {
    throw new Error(
      `Unknown environment "${raw}". Valid values: ${Object.keys(ENV_ALIASES).join(', ')}`,
    );
  }
  return normalized;
}

/**
 * Check if the environment is production.
 */
export function isProduction(env: Environment): boolean {
  return env === 'production';
}

/**
 * Check if the environment is a development environment.
 */
export function isDevelopment(env: Environment): boolean {
  return env === 'dev';
}
