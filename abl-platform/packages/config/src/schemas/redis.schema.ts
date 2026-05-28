import { z } from 'zod';

const RedisTlsSchema = z.object({
  enabled: z.boolean().default(false),
  caFile: z.string().optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  rejectUnauthorized: z.boolean().default(true),
});

const TlsField = z
  .union([
    z
      .boolean()
      .transform(
        (val): z.infer<typeof RedisTlsSchema> => ({ enabled: val, rejectUnauthorized: true }),
      ),
    RedisTlsSchema,
  ])
  .default({ enabled: false, rejectUnauthorized: true });

/**
 * Redis is enabled when:
 * - `REDIS_ENABLED=true`, or
 * - `REDIS_URL` is set to a non-empty string (explicit opt-in via URL).
 *
 * `REDIS_ENABLED=false` still wins and disables Redis even if a URL is present.
 */
export const RedisConfigSchema = z
  .object({
    url: z.string().optional(),
    password: z.string().optional(),
    enabled: z.boolean().optional(),
    tls: TlsField,
    cluster: z.boolean().default(false),
  })
  .transform((data) => {
    const hasUrl = typeof data.url === 'string' && data.url.trim().length > 0;
    const enabled = data.enabled === false ? false : data.enabled === true || hasUrl;
    return { ...data, enabled };
  });

export type RedisConfig = z.infer<typeof RedisConfigSchema>;
