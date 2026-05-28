import { z } from 'zod';

export const DatabaseConfigSchema = z.object({
  url: z.string().optional(),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
