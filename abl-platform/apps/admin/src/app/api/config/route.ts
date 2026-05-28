/**
 * Config API Route (Read-Only)
 *
 * GET /api/config?env=dev — Read config for environment
 *
 * Configuration mutations are managed via GitOps (Git + ArgoCD).
 *
 * NOTE: Does NOT import @agent-platform/config because Turbopack cannot
 * resolve ESM workspace packages as server externals. Env mapping is inlined.
 */

import { NextResponse } from 'next/server';
import { getVaultClient, maskSecret } from '../../../lib/vault-client';
import { logAdminAction } from '../../../lib/audit-logger';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { createLogger } from '../../../lib/logger';

const SENSITIVE_KEYS = ['secret', 'key', 'password', 'token', 'credential'];

/** Only these top-level config sections are exposed via API */
const ALLOWED_CONFIG_SECTIONS = new Set([
  'env',
  'database',
  'server',
  'llm',
  'cors',
  'redis',
  'scheduler',
  'archive',
  'observability',
  'security',
  'region',
  'rateLimit',
]);

/** Only these environment names are valid */
const ALLOWED_ENVIRONMENTS = new Set(['dev', 'staging', 'prod', 'test']);
const log = createLogger('admin-config-route');

/**
 * Env var → nested config path mapping.
 * Duplicated from @agent-platform/config/env-mapping to avoid Turbopack bundling issues.
 */
const ENV_MAPPING: Record<string, string> = {
  NODE_ENV: 'env',
  DATABASE_URL: 'database.url',
  JWT_SECRET: 'jwt.secret',
  JWT_ACCESS_EXPIRY: 'jwt.accessExpiry',
  JWT_REFRESH_EXPIRY: 'jwt.refreshExpiry',
  PORT: 'server.port',
  HOST: 'server.host',
  API_URL: 'server.apiUrl',
  FRONTEND_URL: 'server.frontendUrl',
  ANTHROPIC_API_KEY: 'llm.anthropicApiKey',
  OPENAI_API_KEY: 'llm.openaiApiKey',
  LLM_MODEL: 'llm.defaultModel',
  LLM_PROVIDER: 'llm.provider',
  REDIS_URL: 'redis.url',
  REDIS_PASSWORD: 'redis.password',
  REDIS_ENABLED: 'redis.enabled',
  REDIS_TLS: 'redis.tls',
  REDIS_TLS_ENABLED: 'redis.tls',
  REDIS_CLUSTER: 'redis.cluster',
  CORS_ORIGINS: 'cors.origins',
  LOG_LEVEL: 'observability.loggingLevel',
  OTEL_ENABLED: 'observability.enabled',
  RATE_LIMIT_ENABLED: 'security.rateLimiting.enabled',
  AWS_REGION: 'region.current',
};

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s));
}

function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      masked[key] = maskConfig(value as Record<string, unknown>);
    } else if (isSensitive(key) && typeof value === 'string') {
      masked[key] = maskSecret(value);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function filterAllowedSections(config: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ALLOWED_CONFIG_SECTIONS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      !(parts[i] in current) ||
      typeof current[parts[i]] !== 'object' ||
      current[parts[i]] === null
    ) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// Keep in sync with packages/config/src/env-mapping.ts.
const STRING_VALUED_ENV_KEYS = new Set<string>(['REDIS_URL', 'MONGODB_URI']);

function coerceValue(value: string, envKey?: string): string | number | boolean | string[] {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (
    value.includes(',') &&
    !value.startsWith('{') &&
    !(envKey && STRING_VALUED_ENV_KEYS.has(envKey))
  ) {
    return value.split(',').map((s) => s.trim());
  }
  return value;
}

function mapEnvToConfig(envValues: Record<string, string | undefined>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [envKey, configPath] of Object.entries(ENV_MAPPING)) {
    const rawValue = envValues[envKey];
    if (rawValue === undefined) continue;
    setNestedValue(config, configPath, coerceValue(rawValue, envKey));
  }
  return config;
}

export const GET = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const rawEnv = ctx.request.nextUrl.searchParams.get('env') ?? 'dev';

  // Validate environment parameter to prevent path traversal in vault lookups
  const env = ALLOWED_ENVIRONMENTS.has(rawEnv) ? rawEnv : 'dev';

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'config_view',
    target: `config/${env}`,
    environment: env,
    ipAddress: ctx.user.ipAddress,
  });

  try {
    const envConfig = mapEnvToConfig(process.env as Record<string, string>);

    // Overlay any vault-stored values
    const vault = await getVaultClient();
    const vaultOverrides = await vault.getAll(`/agent-platform/${env}/`);
    if (vaultOverrides) {
      const prefix = `/agent-platform/${env}/`;
      for (const [vaultKey, value] of Object.entries(vaultOverrides)) {
        const configPath = vaultKey.replace(prefix, '').replace(/\//g, '.');
        const topLevel = configPath.split('.')[0];
        if (ALLOWED_CONFIG_SECTIONS.has(topLevel)) {
          setNestedValue(envConfig, configPath, value);
        }
      }
    }

    const masked = maskConfig(envConfig as Record<string, unknown>);
    const config = filterAllowedSections(masked);

    return NextResponse.json({
      environment: env,
      config,
    });
  } catch (err) {
    log.error('Failed to read admin config', {
      error: err instanceof Error ? err.message : String(err),
      environment: env,
    });
    return NextResponse.json({ error: 'Failed to read config' }, { status: 500 });
  }
});
