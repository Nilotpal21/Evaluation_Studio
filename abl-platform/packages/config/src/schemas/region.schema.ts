import { z } from 'zod';

/**
 * Region configuration for multi-region deployments.
 */
export const RegionConfigSchema = z.object({
  current: z.enum(['us-east-1', 'eu-west-1', 'ap-southeast-1']).default('us-east-1'),
  isPrimary: z.boolean().default(true),
  dataResidency: z.boolean().default(false),
});

export type RegionConfig = z.infer<typeof RegionConfigSchema>;
