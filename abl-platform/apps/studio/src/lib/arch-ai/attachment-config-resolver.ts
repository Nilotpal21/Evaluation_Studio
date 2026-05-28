import { createLogger } from '@abl/compiler/platform/logger.js';
import { ProjectAttachmentConfig, TenantAttachmentConfig } from '@agent-platform/database';

const log = createLogger('lib:arch-ai:attachment-config-resolver');

export interface ResolvedArchAttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip';
}

const PLATFORM_DEFAULTS: ResolvedArchAttachmentConfig = {
  enabled: true,
  maxFileSizeBytes: 20 * 1024 * 1024,
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

export async function resolveArchAttachmentConfig(
  tenantId: string,
  projectId: string,
): Promise<ResolvedArchAttachmentConfig> {
  const [projectConfig, tenantConfig] = await Promise.all([
    ProjectAttachmentConfig.findOne({ tenantId, projectId }).lean(),
    TenantAttachmentConfig.findOne({ tenantId }).lean(),
  ]);

  log.debug('resolving arch attachment config', {
    tenantId,
    projectId,
    hasProjectConfig: projectConfig !== null,
    hasTenantConfig: tenantConfig !== null,
  });

  function pick<T>(
    projectValue: T | null | undefined,
    tenantValue: T | null | undefined,
    fallback: T,
  ): T {
    if (projectValue !== null && projectValue !== undefined) {
      return projectValue;
    }
    if (tenantValue !== null && tenantValue !== undefined) {
      return tenantValue;
    }
    return fallback;
  }

  return {
    enabled: pick(projectConfig?.enabled, undefined, PLATFORM_DEFAULTS.enabled),
    maxFileSizeBytes: pick(
      projectConfig?.maxFileSizeBytes,
      tenantConfig?.maxFileSizeBytes,
      PLATFORM_DEFAULTS.maxFileSizeBytes,
    ),
    maxFilesPerSession: pick(
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
      undefined,
      PLATFORM_DEFAULTS.defaultProcessingMode,
    ),
  };
}
