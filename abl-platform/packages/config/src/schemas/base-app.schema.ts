import { z } from 'zod';
import { EnvironmentSchema } from './environment.schema.js';
import { AuthConfigSchema } from './auth.schema.js';
import { DatabaseConfigSchema } from './database.schema.js';
import { JWTConfigSchema } from './jwt.schema.js';
import { OAuthConfigSchema } from './oauth.schema.js';
import { ServerConfigSchema } from './server.schema.js';
import { LLMConfigSchema } from './llm.schema.js';
import { EncryptionConfigSchema } from './encryption.schema.js';
import { RateLimitConfigSchema } from './rate-limit.schema.js';
import { CORSConfigSchema } from './cors.schema.js';
import { RedisConfigSchema } from './redis.schema.js';
import { SchedulerConfigSchema } from './scheduler.schema.js';
import { ArchiveConfigSchema } from './archive.schema.js';
import { ObservabilityConfigSchema } from './observability.schema.js';
import { SecurityConfigSchema } from './security.schema.js';
import { RegionConfigSchema } from './region.schema.js';

/**
 * Base application config schema — shared by all apps.
 * Apps extend this with app-specific schemas via composeConfigSchema().
 */
export const BaseAppConfigSchema = z.object({
  env: EnvironmentSchema,
  auth: AuthConfigSchema.default({}),
  database: DatabaseConfigSchema.default({}),
  jwt: JWTConfigSchema,
  oauth: OAuthConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  llm: LLMConfigSchema.default({}),
  encryption: EncryptionConfigSchema.default({}),
  rateLimit: RateLimitConfigSchema.default({}),
  cors: CORSConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  scheduler: SchedulerConfigSchema.default({}),
  archive: ArchiveConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  region: RegionConfigSchema.default({}),
});

export type BaseAppConfig = z.infer<typeof BaseAppConfigSchema>;
