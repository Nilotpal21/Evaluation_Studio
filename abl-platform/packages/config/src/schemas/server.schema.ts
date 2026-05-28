import { z } from 'zod';
import { DEFAULT_RUNTIME_PORT } from '../constants.js';

export const ServerConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(DEFAULT_RUNTIME_PORT),
  host: z.string().default('localhost'),
  apiUrl: z.string().url().optional(),
  frontendUrl: z.string().url().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
