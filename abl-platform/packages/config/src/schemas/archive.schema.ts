import { z } from 'zod';

export const ArchiveConfigSchema = z.object({
  provider: z.enum(['s3', 'local']).default('local'),
  s3: z
    .object({
      defaultBucket: z.string().optional(),
      regionBuckets: z.string().default('{}'), // JSON: { "eu-west-1": "kore-archives-eu" }
      encryption: z.enum(['SSE-S3', 'SSE-KMS']).default('SSE-S3'),
      kmsKeyId: z.string().optional(),
    })
    .default({}),
  localDir: z.string().default('./data/archives'),
});

export type ArchiveConfig = z.infer<typeof ArchiveConfigSchema>;
