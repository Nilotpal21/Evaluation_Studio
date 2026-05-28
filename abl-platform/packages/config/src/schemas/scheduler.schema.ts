import { z } from 'zod';

export const SchedulerConfigSchema = z.object({
  retentionCron: z.string().default('0 2 * * *'), // Daily at 02:00 UTC
  gdprCheckCron: z.string().default('0 */6 * * *'), // Every 6 hours
  enabled: z.boolean().default(false),
});

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
