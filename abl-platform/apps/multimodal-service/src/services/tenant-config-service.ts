/**
 * Tenant Attachment Config Service
 *
 * Reads and writes per-tenant attachment configuration from MongoDB.
 * Provides upload validation against the tenant's configured limits.
 *
 * All queries are tenant-scoped: findOne({ tenantId }), never findById().
 * Returns platform defaults when no tenant-specific config exists.
 */

import { TenantAttachmentConfig, type ITenantAttachmentConfig } from '@agent-platform/database';

// =============================================================================
// DEFAULT CONFIGURATION VALUES
// =============================================================================

/** Default max file size: 20 MB */
const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Default max attachments per session */
const DEFAULT_MAX_ATTACHMENTS_PER_SESSION = 100;

/** Default max total storage per tenant: 1 GB */
const DEFAULT_MAX_TOTAL_STORAGE_BYTES = 1024 * 1024 * 1024;

const DEFAULT_RETENTION_DAYS = { image: 90, document: 90, audio: 90, video: 90 };

/** Platform defaults used when no tenant-specific config exists. */
const PLATFORM_DEFAULTS: Omit<
  ITenantAttachmentConfig,
  '_id' | 'tenantId' | 'createdAt' | 'updatedAt' | '_v'
> = {
  maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  allowedMimeTypes: [],
  blockedMimeTypes: [],
  scanEnabled: true,
  processingEnabled: true,
  embeddingEnabled: true,
  piiPolicy: 'redact',
  maxAttachmentsPerSession: DEFAULT_MAX_ATTACHMENTS_PER_SESSION,
  maxTotalStorageBytes: DEFAULT_MAX_TOTAL_STORAGE_BYTES,
  retentionDays: DEFAULT_RETENTION_DAYS,
};

// =============================================================================
// TYPES
// =============================================================================

/** Fields that can be updated via the admin API. */
export type TenantAttachmentConfigUpdate = Partial<
  Pick<
    ITenantAttachmentConfig,
    | 'maxFileSizeBytes'
    | 'allowedMimeTypes'
    | 'blockedMimeTypes'
    | 'scanEnabled'
    | 'processingEnabled'
    | 'embeddingEnabled'
    | 'maxAttachmentsPerSession'
    | 'maxTotalStorageBytes'
    | 'retentionDays'
  >
>;

export interface UploadValidationResult {
  allowed: boolean;
  reason?: string;
}

// =============================================================================
// SERVICE
// =============================================================================

export class TenantConfigService {
  /**
   * Get the attachment configuration for a tenant.
   * Returns the stored config if one exists, otherwise returns platform defaults
   * with the given tenantId.
   */
  async getConfig(tenantId: string): Promise<ITenantAttachmentConfig> {
    const config = await TenantAttachmentConfig.findOne({ tenantId }).lean();

    if (config) {
      return config;
    }

    // Return platform defaults as a synthetic config (not persisted)
    return {
      _id: '',
      tenantId,
      ...PLATFORM_DEFAULTS,
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Create or update the attachment configuration for a tenant.
   * Uses findOneAndUpdate with upsert to handle both cases atomically.
   */
  async updateConfig(
    tenantId: string,
    updates: TenantAttachmentConfigUpdate,
  ): Promise<ITenantAttachmentConfig> {
    const config = await TenantAttachmentConfig.findOneAndUpdate(
      { tenantId },
      { $set: updates },
      { new: true, upsert: true, lean: true },
    );

    // upsert: true guarantees a document is returned
    return config!;
  }

  /**
   * Validate whether an upload is allowed based on the tenant's config.
   *
   * Checks:
   * 1. File size against maxFileSizeBytes
   * 2. MIME type against blockedMimeTypes (if any)
   * 3. MIME type against allowedMimeTypes (if configured; empty = all allowed)
   */
  async validateUpload(
    tenantId: string,
    mimeType: string,
    sizeBytes: number,
  ): Promise<UploadValidationResult> {
    const config = await this.getConfig(tenantId);

    // Check file size
    if (sizeBytes > config.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `File size ${sizeBytes} bytes exceeds tenant limit of ${config.maxFileSizeBytes} bytes`,
      };
    }

    // Check blocked MIME types (takes precedence)
    if (config.blockedMimeTypes.length > 0 && config.blockedMimeTypes.includes(mimeType)) {
      return {
        allowed: false,
        reason: `MIME type '${mimeType}' is blocked for this tenant`,
      };
    }

    // Check allowed MIME types (empty = all allowed)
    if (config.allowedMimeTypes.length > 0 && !config.allowedMimeTypes.includes(mimeType)) {
      return {
        allowed: false,
        reason: `MIME type '${mimeType}' is not in the allowed list for this tenant`,
      };
    }

    return { allowed: true };
  }
}
