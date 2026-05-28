import { z } from 'zod';

export const EncryptionConfigSchema = z.object({
  // Explicit toggle — undefined means auto (backward compat: enabled when masterKey is set)
  enabled: z.boolean().optional(),
  // 32-byte hex string (64 characters) for AES-256 encryption
  masterKey: z.string().min(64).max(64).optional(),
});

export type EncryptionConfig = z.infer<typeof EncryptionConfigSchema>;
