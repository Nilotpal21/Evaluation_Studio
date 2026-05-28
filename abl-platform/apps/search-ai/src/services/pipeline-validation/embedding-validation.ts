/**
 * Embedding-specific Validation
 *
 * Async validation rules for embedding configuration that require
 * external lookups (credential checks, provider registry).
 *
 * These are separate from the synchronous PipelineValidationService
 * because they require tenantId for DB access.
 *
 * Reference: docs/searchai/pipelines/design/backend/04-CONFIGURABLE-EMBEDDING-PROVIDERS.md
 */

import type { IActiveEmbeddingConfig } from '@agent-platform/database';
import { hasEmbeddingCredentials } from '../llm-config/embedding-credentials.js';
import { validateEmbeddingConfig } from '../provider-registry/embedding-providers.js';
import type { ValidationError } from './types.js';

/**
 * Validate embedding configuration with async checks.
 *
 * Checks:
 * 1. Provider/model/dimensions valid in registry
 * 2. Credentials available for tenant (if provider requires them)
 *
 * @param config - Active embedding configuration to validate
 * @param tenantId - Tenant ID for credential lookup
 * @returns Array of validation errors (empty if valid)
 */
export async function validateEmbeddingConfigAsync(
  config: IActiveEmbeddingConfig,
  tenantId: string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  // 1. Validate provider/model/dimensions against registry
  const registryResult = validateEmbeddingConfig(config.provider, config.model, config.dimensions);

  if (!registryResult.valid) {
    errors.push({
      code: 'EMBEDDING_CONFIG_MISMATCH',
      message: registryResult.error!,
      severity: 'error',
      path: 'activeEmbeddingConfig',
      context: {
        provider: config.provider,
        model: config.model,
        dimensions: config.dimensions,
      },
    });
  }

  // 2. Check credential availability
  const credentialsAvailable = await hasEmbeddingCredentials(config.provider, tenantId);

  if (!credentialsAvailable) {
    errors.push({
      code: 'EMBEDDING_CREDENTIALS_UNAVAILABLE',
      message:
        `Cannot configure '${config.provider}' embeddings: no API key found for this tenant. ` +
        `Add credentials in Settings > LLM Providers.`,
      severity: 'error',
      path: 'activeEmbeddingConfig.provider',
      context: {
        provider: config.provider,
        tenantId,
      },
    });
  }

  return errors;
}
