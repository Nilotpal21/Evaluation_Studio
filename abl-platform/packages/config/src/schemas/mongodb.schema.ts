import { z } from 'zod';
import { DEFAULT_MONGODB_PORT } from '../constants.js';

export const MongoDBConfigSchema = z.object({
  // Connection
  enabled: z.boolean().default(false),
  url: z
    .string()
    .default(
      `mongodb://abl_admin:abl_dev_password@localhost:${DEFAULT_MONGODB_PORT}/?authSource=admin`,
    ),
  database: z.string().default('abl_platform'),

  // Pool
  minPoolSize: z.coerce.number().int().min(0).default(2),
  maxPoolSize: z.coerce.number().int().min(1).default(5),
  maxIdleTimeMs: z.coerce.number().int().default(30_000),
  waitQueueTimeoutMs: z.coerce.number().int().min(0).default(10_000),

  // Timeouts
  connectTimeoutMs: z.coerce.number().int().default(10_000),
  socketTimeoutMs: z.coerce.number().int().default(45_000),
  serverSelectionTimeoutMs: z.coerce.number().int().default(30_000),
  heartbeatFrequencyMs: z.coerce.number().int().default(10_000),

  // SSL/TLS
  tls: z.boolean().default(false),
  tlsCAFile: z.string().optional(),
  tlsCertFile: z.string().optional(),
  tlsKeyFile: z.string().optional(),
  tlsAllowInvalidCertificates: z.boolean().default(false),

  // Replica Set / Atlas
  replicaSet: z.string().optional(),
  authSource: z.string().default('admin'),
  authMechanism: z.enum(['SCRAM-SHA-256', 'SCRAM-SHA-1', 'MONGODB-X509', 'MONGODB-AWS']).optional(),

  // Write/Read Concerns
  writeConcern: z.enum(['0', '1', 'majority']).default('majority'),
  readPreference: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .default('primaryPreferred'),
  readConcern: z.enum(['local', 'majority', 'linearizable', 'snapshot']).optional(),

  // Retry & Compression
  retryWrites: z.boolean().default(true),
  retryReads: z.boolean().default(true),
  compressors: z.string().optional(),

  // Sharding
  directConnection: z.boolean().default(false),

  // Performance
  autoIndex: z.boolean().default(false),
  slowQueryThresholdMs: z.coerce.number().int().default(200),

  // App metadata
  appName: z.string().default('abl-platform'),
});

export type MongoDBConfig = z.infer<typeof MongoDBConfigSchema>;
