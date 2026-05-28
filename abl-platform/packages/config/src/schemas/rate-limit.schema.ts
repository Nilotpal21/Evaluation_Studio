import { z } from 'zod';

export const RateLimitConfigSchema = z.object({
  authWindowMs: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000), // 15 minutes
  authMax: z.coerce.number().int().positive().default(20),
  apiWindowMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000), // 1 minute
  apiMax: z.coerce.number().int().positive().default(100),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
