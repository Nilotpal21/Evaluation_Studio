import { z } from 'zod';

export const JWTConfigSchema = z.object({
  secret: z.string().min(32, 'JWT secret must be at least 32 characters'),
  accessExpiry: z
    .string()
    .regex(/^\d+[smhd]$/, 'Invalid expiry format (e.g., 15m, 1h, 7d)')
    .default('15m'),
  refreshExpiry: z
    .string()
    .regex(/^\d+[smhd]$/, 'Invalid expiry format')
    .default('7d'),
});

export type JWTConfig = z.infer<typeof JWTConfigSchema>;
