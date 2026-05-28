import { z } from 'zod';

/**
 * Security configuration — reconciled from PlatformConfig.SecurityConfig
 */
/** Accept an array or a comma-separated string (single values have no comma). */
const stringOrArray = z.union([
  z.array(z.string()),
  z.string().transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
]);

export const SecurityConfigSchema = z.object({
  piiDetection: z.boolean().default(true),
  piiRedaction: z.boolean().default(true),
  superAdminUserIds: stringOrArray.default([]),
  oauthAllowedRedirectOrigins: stringOrArray.default([]),
  /** IP allowlist for platform admin routes. Empty = no IP restriction (identity-only). */
  platformAdminAllowedIps: stringOrArray.default([]),
  rateLimiting: z
    .object({
      enabled: z.boolean().default(false),
      requestsPerMinute: z.coerce.number().int().positive().default(60),
      tokensPerMinute: z.coerce.number().int().positive().default(100000),
    })
    .default({}),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
