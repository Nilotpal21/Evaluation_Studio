/**
 * Configuration Loader Factory
 *
 * Creates a loader instance for any config schema.
 * Each app calls createConfigLoader() once with its composed schema.
 */

import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { createVaultProvider, type VaultProvider, type VaultType } from './vault/index.js';
import { mapEnvToConfig, type EnvMapping, BASE_ENV_MAPPING } from './env-mapping.js';
import { sealConfig } from './sealer.js';
import type { ConfigMeta } from './types.js';
import { diffConfigs } from './validation/config-diff.js';

export interface LoadConfigOptions {
  /** Vault provider type to use */
  vaultType?: VaultType;
  /** Pre-created vault provider (takes precedence over vaultType) */
  vaultProvider?: VaultProvider;
  /** Whether to throw on validation errors */
  throwOnError?: boolean;
  /** Whether to log configuration summary */
  logSummary?: boolean;
  /** When true, suppresses throwing validation errors in non-dev environments even if throwOnError is true */
  unsafe?: boolean;
}

export interface ConfigLoaderResult<T> {
  /** Load (or reload) configuration from vault */
  loadConfig(options?: LoadConfigOptions): Promise<T>;
  /** Get the loaded configuration (throws if not loaded) */
  getConfig(): T;
  /** Check if configuration has been loaded */
  isConfigLoaded(): boolean;
  /** Reload configuration */
  reloadConfig(options?: LoadConfigOptions): Promise<T>;
  /** Get metadata about the loaded configuration */
  getConfigMeta(): ConfigMeta | null;
}

export interface CreateConfigLoaderOptions {
  /** Custom env var -> config path mapping (merged with BASE_ENV_MAPPING) */
  envMapping?: EnvMapping;
  /** Production validation function */
  productionChecks?: (config: unknown) => string[];
  /** Log summary function */
  logSummary?: (config: unknown) => void;
}

/**
 * Create a config loader for a given schema.
 *
 * Usage:
 *   const { loadConfig, getConfig } = createConfigLoader(MyConfigSchema, {
 *     envMapping: { 'MY_VAR': 'my.path' },
 *   });
 */
export function createConfigLoader<Output, Def extends ZodTypeDef = ZodTypeDef, Input = Output>(
  schema: ZodType<Output, Def, Input>,
  options: CreateConfigLoaderOptions = {},
): ConfigLoaderResult<Output> {
  let config: Output | null = null;
  let provider: VaultProvider | null = null;
  let meta: ConfigMeta | null = null;
  let reloadPromise: Promise<Output> | null = null;

  const mergedMapping: EnvMapping = {
    ...BASE_ENV_MAPPING,
    ...options.envMapping,
  };

  async function loadConfig(loadOpts: LoadConfigOptions = {}): Promise<Output> {
    const {
      vaultType = 'env',
      vaultProvider,
      throwOnError = true,
      logSummary = true,
      unsafe,
    } = loadOpts;

    try {
      // Initialize vault provider
      if (vaultProvider) {
        provider = vaultProvider;
      } else {
        provider = await createVaultProvider(vaultType, {
          allowedKeys: Object.keys(mergedMapping),
        });
      }
      await provider.initialize();

      // Get all config values from vault
      const envValues = await provider.getAll();

      // Map env vars to nested config using declarative mapping
      const rawConfig = mapEnvToConfig(envValues, mergedMapping);

      // Validate with Zod
      const result = schema.safeParse(rawConfig);

      const warnings: string[] = [];

      if (!result.success) {
        const errors = formatValidationErrors(result.error);
        console.error('[Config] Validation failed:');
        errors.forEach((err) => console.error(`  - ${err}`));

        // In production, validation errors ALWAYS throw (unsafe has no effect).
        // In dev, if unsafe=true, suppress the throw so the app can start with partial config.
        // Logic: throw when throwOnError is true, UNLESS we are in dev AND unsafe is true.
        const shouldThrow = throwOnError && !(unsafe === true && isDevEnvironment(envValues));
        if (shouldThrow) {
          throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
        }

        // safeParse failed, but we suppressed the throw (dev + unsafe mode).
        // Attempt schema.parse() which applies Zod defaults — it may succeed
        // when safeParse failed due to refinements/transforms that run after
        // defaults are applied. If it still throws, fall back to using the
        // raw config so the app can start in degraded dev mode.
        let parsed: Output;
        try {
          parsed = schema.parse(rawConfig);
        } catch {
          console.warn(
            '[Config] Full parse also failed (unsafe dev mode) — using raw config with defaults. ' +
              'Fix the validation errors above for a complete configuration.',
          );
          parsed = rawConfig as Output;
        }
        config = sealConfig(parsed as Output & object, isDevEnvironment(envValues)) as Output;
      } else {
        // Run production checks
        if (options.productionChecks) {
          const prodWarnings = options.productionChecks(result.data);
          warnings.push(...prodWarnings);
          if (prodWarnings.length > 0) {
            console.warn('[Config] Production warnings:');
            prodWarnings.forEach((w) => console.warn(`  - ${w}`));
          }
        }

        config = sealConfig(result.data as Output & object, isDevEnvironment(envValues)) as Output;
      }

      meta = {
        loadedAt: new Date(),
        environment: envValues.NODE_ENV ?? 'dev',
        vaultType: provider.name,
        validationWarnings: warnings,
      };

      if (logSummary && options.logSummary) {
        options.logSummary(config);
      }

      return config;
    } catch (error) {
      console.error('[Config] Failed to load configuration:', error);
      throw error;
    }
  }

  function getConfig(): Output {
    if (!config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }
    return config;
  }

  function isConfigLoaded(): boolean {
    return config !== null;
  }

  async function reloadConfig(loadOpts?: LoadConfigOptions): Promise<Output> {
    // Concurrency guard — if a reload is already in-flight, return its promise
    if (reloadPromise) {
      return reloadPromise;
    }

    reloadPromise = doReload(loadOpts).finally(() => {
      reloadPromise = null;
    });
    return reloadPromise;
  }

  async function doReload(loadOpts?: LoadConfigOptions): Promise<Output> {
    const previousConfig = config;
    const previousProvider = provider;
    const previousMeta = meta;

    try {
      // Reset provider/meta so loadConfig creates fresh ones,
      // but keep config intact until new config loads successfully.
      // Do NOT close the previous provider yet — if reload fails,
      // we need to restore it in a usable state.
      provider = null;
      meta = null;

      const newConfig = await loadConfig(loadOpts);

      // Only close the previous provider AFTER the new config loads successfully
      if (previousProvider) {
        try {
          await previousProvider.close();
        } catch {
          // Best-effort close — don't let cleanup errors affect the reload
        }
      }

      // Log changed keys (not values) for audit trail
      if (previousConfig) {
        try {
          const diff = diffConfigs(
            previousConfig as Record<string, unknown>,
            newConfig as Record<string, unknown>,
          );
          const diffs = diff.entries.filter((e) => e.status !== 'same');
          if (diffs.length > 0) {
            console.info(
              `[Config] Reloaded — ${diffs.length} change(s) detected:`,
              diffs.map((d) => `${d.status} ${d.path}`),
            );
          } else {
            console.info('[Config] Reloaded — no changes detected');
          }
        } catch {
          // diffConfigs failure should never prevent reload
          console.info('[Config] Reloaded (diff unavailable)');
        }
      }

      return newConfig;
    } catch (error) {
      // Reload failed — restore previous config, provider, and meta so callers never see null
      if (previousConfig) {
        config = previousConfig;
        provider = previousProvider;
        meta = previousMeta
          ? {
              ...previousMeta,
              lastReloadError: error instanceof Error ? error.message : String(error),
            }
          : null;
      }
      throw error;
    }
  }

  function getConfigMeta(): ConfigMeta | null {
    return meta;
  }

  return { loadConfig, getConfig, isConfigLoaded, reloadConfig, getConfigMeta };
}

function formatValidationErrors(error: ZodError): string[] {
  return error.errors.map((err) => {
    const path = err.path.join('.');
    return `${path}: ${err.message}`;
  });
}

function isDevEnvironment(envValues: Record<string, string>): boolean {
  const env = (envValues.NODE_ENV ?? 'development').toLowerCase();
  return env === 'development' || env === 'dev';
}
