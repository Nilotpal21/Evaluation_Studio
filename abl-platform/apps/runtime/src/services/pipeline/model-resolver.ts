/**
 * Pipeline Model Resolver
 *
 * Resolves the LanguageModel for the pipeline classifier based on config.
 *
 * Resolution paths:
 *   'default' (or missing) — delegates to session.llmClient.resolveLanguageModel('tool_selection')
 *   'tenant'               — loads TenantModel by tenantModelId, resolves credential, creates provider
 */

import type { LanguageModel } from 'ai';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { createVercelProvider } from '@agent-platform/llm';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineConfig } from './types.js';
import { parseJsonField } from '../llm/utils.js';

const log = createLogger('pipeline-model-resolver');
const DEFAULT_PIPELINE_OPERATION = 'tool_selection';

/**
 * Minimal session interface — avoids importing the full SessionState type.
 * The pipeline resolver only needs the LLM client and tenant ID.
 */
interface PipelineSession {
  llmClient?: {
    resolveLanguageModel(operationType: string): Promise<LanguageModel | null>;
  };
  tenantId?: string;
}

/**
 * Resolve the LanguageModel for the pipeline classifier.
 */
export async function resolvePipelineModel(
  config: PipelineConfig,
  session: PipelineSession,
): Promise<LanguageModel | null> {
  log.debug('Resolving pipeline model', {
    modelSource: config.modelSource,
    tenantModelId: config.tenantModelId,
  });

  if (config.modelSource === 'tenant' && config.tenantModelId) {
    if (!session.tenantId) {
      log.warn('Cannot resolve tenant model without tenantId, falling back to default');
      return session.llmClient?.resolveLanguageModel(DEFAULT_PIPELINE_OPERATION) ?? null;
    }
    try {
      const model = await resolveTenantModel(config.tenantModelId, session.tenantId);
      log.info('Pipeline model resolved via tenant model', {
        tenantModelId: config.tenantModelId,
        modelId: typeof model === 'string' ? model : model.modelId,
      });
      return model;
    } catch (err) {
      log.warn('tenant model resolution failed for pipeline, falling back to default', {
        tenantModelId: config.tenantModelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return session.llmClient?.resolveLanguageModel(DEFAULT_PIPELINE_OPERATION) ?? null;
    }
  }

  // Default path: delegate to existing resolution
  log.debug('Pipeline model resolved via default (tool_selection)');
  return session.llmClient?.resolveLanguageModel(DEFAULT_PIPELINE_OPERATION) ?? null;
}

/**
 * Load a TenantModel by ID, resolve its primary credential, and create a LanguageModel.
 * Follows the Arch Tier 1a pattern (apps/studio/src/lib/arch-llm.ts:297-342).
 */
async function resolveTenantModel(tenantModelId: string, tenantId: string): Promise<LanguageModel> {
  if (!tenantId) {
    throw new Error('Cannot resolve tenant model without tenantId');
  }

  const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

  const tenantModel = await TenantModel.findOne({
    _id: tenantModelId,
    tenantId,
    isActive: true,
  }).lean();

  if (!tenantModel) {
    throw new Error(`TenantModel ${tenantModelId} not found or inactive`);
  }

  const connections = (tenantModel as any).connections ?? [];
  const connection =
    connections.find((c: any) => c.isPrimary && c.isActive) ??
    connections.find((c: any) => c.isActive) ??
    connections[0];

  if (!connection?.credentialId) {
    throw new Error(`TenantModel ${tenantModelId} has no active connection with a credential`);
  }

  // Do NOT use .lean() — LLMCredential has a post-find decryption hook
  // that usually decrypts encryptedApiKey and encryptedEndpoint. Some legacy
  // failures preserve ciphertext, so we still resolve plaintext explicitly below.
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
    isActive: true,
  });

  if (!credential || !(credential as any).encryptedApiKey) {
    throw new Error(`Credential for TenantModel ${tenantModelId} not found or has no API key`);
  }

  const provider = (tenantModel as any).provider ?? 'openai';
  const modelId = (tenantModel as any).modelId;
  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  try {
    apiKey = await resolveTenantPlaintextValue(
      (credential as { encryptedApiKey?: string | null }).encryptedApiKey ?? null,
      tenantId,
      {
        decryptionFailed: Boolean(
          (credential as { _decryptionFailed?: boolean })._decryptionFailed,
        ),
      },
    );
    baseUrl = await resolveTenantPlaintextValue(
      (credential as { encryptedEndpoint?: string | null }).encryptedEndpoint ?? null,
      tenantId,
    );
  } catch (decryptErr) {
    throw new Error(
      `Credential for TenantModel ${tenantModelId} could not be decrypted: ${
        decryptErr instanceof Error ? decryptErr.message : String(decryptErr)
      }`,
    );
  }

  if (!apiKey) {
    throw new Error(`Credential for TenantModel ${tenantModelId} not found or has no API key`);
  }

  // Extract authConfig — post-find decryption hook already decrypted it;
  // parseJsonField handles the string/object normalization (Mixed field).
  const authConfig = parseJsonField((credential as { authConfig?: unknown }).authConfig) as
    | Record<string, unknown>
    | undefined;

  return createVercelProvider(
    provider,
    apiKey,
    baseUrl ?? undefined,
    modelId,
    undefined,
    authConfig,
  );
}
