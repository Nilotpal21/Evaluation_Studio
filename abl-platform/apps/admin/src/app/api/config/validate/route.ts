/**
 * Config Validation API
 *
 * POST /api/config/validate — Validate a config object against basic schema checks
 *
 * NOTE: Uses inlined validation instead of @agent-platform/config because
 * Turbopack cannot resolve ESM workspace packages as server externals.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';

// ─── Inlined basic config schema ─────────────────────────────────────────
// Simplified version of BaseAppConfigSchema — validates structure without
// importing the full schema tree from @agent-platform/config.

const BasicConfigSchema = z.object({
  env: z.string().optional(),
  database: z
    .object({
      url: z.string().optional(),
    })
    .passthrough()
    .optional(),
  jwt: z
    .object({
      secret: z.string().optional(),
      accessExpiry: z.string().optional(),
      refreshExpiry: z.string().optional(),
    })
    .passthrough()
    .optional(),
  server: z
    .object({
      port: z.union([z.string(), z.number()]).optional(),
      host: z.string().optional(),
      apiUrl: z.string().optional(),
      frontendUrl: z.string().optional(),
    })
    .passthrough()
    .optional(),
  llm: z
    .object({
      anthropicApiKey: z.string().optional(),
      openaiApiKey: z.string().optional(),
      defaultModel: z.string().optional(),
      provider: z.string().optional(),
    })
    .passthrough()
    .optional(),
  encryption: z
    .object({
      enabled: z.boolean().optional(),
      masterKey: z.string().optional(),
    })
    .passthrough()
    .optional(),
  cors: z
    .object({
      origins: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  redis: z
    .object({
      url: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  observability: z
    .object({
      enabled: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  oauth: z.record(z.unknown()).optional(),
  security: z.record(z.unknown()).optional(),
  region: z.record(z.unknown()).optional(),
  rateLimit: z.record(z.unknown()).optional(),
  scheduler: z.record(z.unknown()).optional(),
  archive: z.record(z.unknown()).optional(),
});

// ─── Inlined production checks ───────────────────────────────────────────

interface ProductionWarning {
  level: 'error' | 'warning';
  field: string;
  message: string;
}

function validateProductionConfig(config: z.infer<typeof BasicConfigSchema>): ProductionWarning[] {
  const issues: ProductionWarning[] = [];

  if (config.env !== 'production') return issues;

  if (config.jwt?.secret === 'development-secret-change-in-production') {
    issues.push({
      level: 'error',
      field: 'jwt.secret',
      message: 'JWT_SECRET is using default value — this is insecure for production',
    });
  }

  if (config.jwt?.secret && config.jwt.secret.length < 64) {
    issues.push({
      level: 'warning',
      field: 'jwt.secret',
      message: 'JWT_SECRET should be at least 64 characters for production',
    });
  }

  if (!config.database?.url) {
    issues.push({
      level: 'error',
      field: 'database.url',
      message: 'DATABASE_URL is not configured',
    });
  }

  if (!config.llm?.anthropicApiKey && !config.llm?.openaiApiKey) {
    issues.push({
      level: 'warning',
      field: 'llm',
      message: 'No LLM API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)',
    });
  }

  if (config.cors?.origins?.some((o: string) => o === '*')) {
    issues.push({
      level: 'error',
      field: 'cors.origins',
      message: 'CORS_ORIGINS contains wildcard "*" — this is insecure for production',
    });
  }

  if (config.redis?.enabled && !config.redis?.url) {
    issues.push({
      level: 'error',
      field: 'redis.url',
      message: 'Redis is enabled but REDIS_URL is not configured',
    });
  }

  return issues;
}

// ─── Route handler ───────────────────────────────────────────────────────

export const POST = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const body = await ctx.request.json();

  const result = BasicConfigSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json({
      valid: false,
      errors: result.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  const warnings = validateProductionConfig(result.data);

  return NextResponse.json({
    valid: true,
    warnings: warnings.map((w) => ({
      level: w.level,
      field: w.field,
      message: w.message,
    })),
  });
});
