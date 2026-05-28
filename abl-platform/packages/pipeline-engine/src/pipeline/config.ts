/**
 * Pipeline Engine Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Defines a minimal schema for the pipeline engine's needs:
 * JWT (for eval service auth) and pipeline-specific env vars.
 */

import { z } from 'zod';
import { createConfigLoader, JWTConfigSchema, EnvironmentSchema } from '@agent-platform/config';

const PipelineEngineConfigSchema = z.object({
  env: EnvironmentSchema,
  jwt: JWTConfigSchema,
  eval: z
    .object({
      serviceUserId: z.string().default('pipeline-engine'),
    })
    .default({}),
});

export type PipelineEngineConfig = z.infer<typeof PipelineEngineConfigSchema>;

const loader = createConfigLoader(PipelineEngineConfigSchema, {
  envMapping: {
    EVAL_SERVICE_USER_ID: 'eval.serviceUserId',
  },
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
