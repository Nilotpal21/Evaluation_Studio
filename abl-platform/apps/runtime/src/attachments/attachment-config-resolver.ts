/**
 * Attachment Config Resolver
 *
 * Resolves attachment configuration with a 3-tier fallback chain:
 *   project config → tenant config → platform defaults
 *
 * Each field is resolved independently: a project-level null/undefined
 * field falls through to the tenant value, then to the platform default.
 */

import { ProjectAttachmentConfig, TenantAttachmentConfig } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('attachment-config-resolver');

// =============================================================================
// TYPES
// =============================================================================

export interface ResolvedAttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip';
}

// =============================================================================
// PLATFORM DEFAULTS
// =============================================================================

const PLATFORM_DEFAULTS: ResolvedAttachmentConfig = {
  enabled: true,
  maxFileSizeBytes: 20 * 1024 * 1024, // 20 MB
  maxFilesPerSession: 100,
  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/markdown',
    'text/plain',
    'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg',
    'audio/wav',
    'audio/webm',
    'video/mp4',
    'video/webm',
  ],
  piiPolicy: 'redact',
  defaultProcessingMode: 'full',
};

// =============================================================================
// RESOLVER
// =============================================================================

/**
 * Resolve the effective attachment config for a project by merging:
 *   1. ProjectAttachmentConfig (per-project overrides, fields may be null)
 *   2. TenantAttachmentConfig (per-tenant defaults)
 *   3. Platform defaults (hardcoded)
 *
 * A field at a higher tier takes precedence only when it is not null/undefined.
 */
export async function resolveAttachmentConfig(
  tenantId: string,
  projectId: string,
): Promise<ResolvedAttachmentConfig> {
  const [projectConfig, tenantConfig] = await Promise.all([
    ProjectAttachmentConfig.findOne({ projectId, tenantId }).lean(),
    TenantAttachmentConfig.findOne({ tenantId }).lean(),
  ]);

  log.debug('Resolving attachment config', {
    tenantId,
    projectId,
    hasProjectConfig: projectConfig !== null,
    hasTenantConfig: tenantConfig !== null,
  });

  // Helper: pick the first non-null/undefined value from the chain
  function pick<T>(
    projectVal: T | null | undefined,
    tenantVal: T | null | undefined,
    defaultVal: T,
  ): T {
    if (projectVal !== null && projectVal !== undefined) return projectVal;
    if (tenantVal !== null && tenantVal !== undefined) return tenantVal;
    return defaultVal;
  }

  return {
    enabled: pick(
      projectConfig?.enabled,
      // TenantAttachmentConfig does not have an `enabled` field, always inherit default
      undefined,
      PLATFORM_DEFAULTS.enabled,
    ),
    maxFileSizeBytes: pick(
      projectConfig?.maxFileSizeBytes,
      tenantConfig?.maxFileSizeBytes,
      PLATFORM_DEFAULTS.maxFileSizeBytes,
    ),
    maxFilesPerSession: pick(
      // ProjectAttachmentConfig does not have maxFilesPerSession, skip
      undefined,
      tenantConfig?.maxAttachmentsPerSession,
      PLATFORM_DEFAULTS.maxFilesPerSession,
    ),
    allowedMimeTypes: pick(
      projectConfig?.allowedMimeTypes,
      tenantConfig?.allowedMimeTypes,
      PLATFORM_DEFAULTS.allowedMimeTypes,
    ),
    piiPolicy: pick(projectConfig?.piiPolicy, tenantConfig?.piiPolicy, PLATFORM_DEFAULTS.piiPolicy),
    defaultProcessingMode: pick(
      projectConfig?.defaultProcessingMode,
      undefined, // TenantAttachmentConfig has no defaultProcessingMode field
      PLATFORM_DEFAULTS.defaultProcessingMode,
    ),
  };
}

/**
 * Export defaults for testing and reference.
 */
export { PLATFORM_DEFAULTS };
