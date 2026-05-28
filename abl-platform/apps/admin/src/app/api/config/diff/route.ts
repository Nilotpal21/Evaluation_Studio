/**
 * Config Diff API
 *
 * GET  /api/config/diff?left=dev&right=staging — Compare config between two environments
 * POST /api/config/diff — Compare config between two raw config objects
 *
 * NOTE: diffConfigs and mapEnvToConfig are inlined here because
 * @agent-platform/config cannot be imported in Turbopack (ESM resolution failure).
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { getVaultClient } from '../../../../lib/vault-client';

// ─── Inlined constants (from @agent-platform/config) ─────────────────────

const ALLOWED_ENVIRONMENTS = new Set(['dev', 'staging', 'prod', 'test']);

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

const SENSITIVE_PATHS = [
  'jwt.secret',
  'encryption.masterKey',
  'llm.anthropicApiKey',
  'llm.openaiApiKey',
  'oauth.google.clientSecret',
  'database.url',
  'redis.url',
  'redis.password',
];

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

// ─── Inlined helpers ─────────────────────────────────────────────────────

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

function mapEnvToConfig(envValues: Record<string, string | undefined>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [envKey, configPath] of Object.entries(ENV_MAPPING)) {
    const rawValue = envValues[envKey];
    if (rawValue === undefined) continue;
    setNestedValue(config, configPath, coerceValue(rawValue, envKey));
  }
  return config;
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

interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  leftValue?: unknown;
  rightValue?: unknown;
  isSensitive: boolean;
}

interface ConfigDiff {
  entries: DiffEntry[];
  hasCriticalDiffs: boolean;
  summary: { added: number; removed: number; changed: number; same: number };
}

function diffConfigs(left: Record<string, unknown>, right: Record<string, unknown>): ConfigDiff {
  const entries: DiffEntry[] = [];

  function walk(l: Record<string, unknown>, r: Record<string, unknown>, prefix: string): void {
    const allKeys = new Set([...Object.keys(l), ...Object.keys(r)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const isSensitive = SENSITIVE_PATHS.includes(path);
      const lVal = l[key];
      const rVal = r[key];

      if (!(key in l)) {
        entries.push({
          path,
          status: 'added',
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else if (!(key in r)) {
        entries.push({
          path,
          status: 'removed',
          leftValue: isSensitive ? '***' : lVal,
          isSensitive,
        });
      } else if (Array.isArray(lVal) && Array.isArray(rVal)) {
        const lJson = JSON.stringify(lVal);
        const rJson = JSON.stringify(rVal);
        entries.push({
          path,
          status: lJson === rJson ? 'same' : 'changed',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else if (
        typeof lVal === 'object' &&
        lVal !== null &&
        typeof rVal === 'object' &&
        rVal !== null &&
        !Array.isArray(lVal) &&
        !Array.isArray(rVal)
      ) {
        walk(lVal as Record<string, unknown>, rVal as Record<string, unknown>, path);
      } else if (JSON.stringify(lVal) !== JSON.stringify(rVal)) {
        entries.push({
          path,
          status: 'changed',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else {
        entries.push({
          path,
          status: 'same',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      }
    }
  }

  walk(left, right, '');

  const summary = {
    added: entries.filter((e) => e.status === 'added').length,
    removed: entries.filter((e) => e.status === 'removed').length,
    changed: entries.filter((e) => e.status === 'changed').length,
    same: entries.filter((e) => e.status === 'same').length,
  };

  const hasCriticalDiffs = entries.some((e) => e.isSensitive && e.status === 'changed');

  return { entries, hasCriticalDiffs, summary };
}

// ─── Config loader ───────────────────────────────────────────────────────

async function loadConfigForEnv(env: string): Promise<Record<string, unknown>> {
  const envConfig = mapEnvToConfig(process.env as Record<string, string>);

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

  return filterAllowedSections(envConfig as Record<string, unknown>);
}

// ─── Route handlers ──────────────────────────────────────────────────────

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const rawLeft = ctx.request.nextUrl.searchParams.get('left') ?? '';
  const rawRight = ctx.request.nextUrl.searchParams.get('right') ?? '';

  if (!ALLOWED_ENVIRONMENTS.has(rawLeft) || !ALLOWED_ENVIRONMENTS.has(rawRight)) {
    return NextResponse.json(
      { error: 'Invalid environment. Must be one of: dev, staging, prod, test' },
      { status: 400 },
    );
  }

  if (rawLeft === rawRight) {
    return NextResponse.json(
      { error: 'Left and right environments must be different' },
      { status: 400 },
    );
  }

  try {
    const [leftConfig, rightConfig] = await Promise.all([
      loadConfigForEnv(rawLeft),
      loadConfigForEnv(rawRight),
    ]);

    const diff = diffConfigs(leftConfig, rightConfig);
    return NextResponse.json(diff);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});

export const POST = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const {
    left,
    right,
    leftLabel: _leftLabel,
    rightLabel: _rightLabel,
  } = (await ctx.request.json()) as {
    left: Record<string, unknown>;
    right: Record<string, unknown>;
    leftLabel?: string;
    rightLabel?: string;
  };

  if (!left || !right) {
    return NextResponse.json(
      { error: 'Both left and right configs are required' },
      { status: 400 },
    );
  }

  const diff = diffConfigs(left, right);
  return NextResponse.json(diff);
});
