import { z } from 'zod';
import { DEFAULT_LOCAL_ORIGINS } from '../constants.js';

export const CORSConfigSchema = z.object({
  origins: z
    .union([z.array(z.string()), z.string().transform((s) => s.split(',').map((o) => o.trim()))])
    .default([...DEFAULT_LOCAL_ORIGINS, 'http://127.0.0.1:5173']),
  credentials: z.boolean().default(true),
  methods: z.array(z.string()).default(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  allowedHeaders: z
    .array(z.string())
    .default([
      'Content-Type',
      'Authorization',
      'X-SDK-Token',
      'X-Public-Key',
      'X-Tenant-Id',
      'X-Request-Id',
    ]),
  exposedHeaders: z.array(z.string()).default(['X-Request-Id', 'X-Trace-Id']),
});

export type CORSConfig = z.infer<typeof CORSConfigSchema>;
