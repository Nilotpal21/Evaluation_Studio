/**
 * Omnichannel Settings Service
 *
 * Read/write project-level omnichannel configuration.
 * Follows the pattern from project-settings-repo.ts using dynamic imports
 * for database models and findOneAndUpdate for atomic upserts.
 *
 * Settings are stored in the OmnichannelProjectSettings collection,
 * separate from the main ProjectSettings to avoid coupling.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IOmnichannelProjectSettings, IOmnichannelProjectSettingsUpdate } from './types.js';

const log = createLogger('omnichannel-settings');

/** Default settings matching the feature spec */
const DEFAULT_SETTINGS: IOmnichannelProjectSettings = {
  recall: {
    enabled: false,
    maxMessages: 20,
    maxAgeDays: 30,
    defaultAllowedChannels: [],
  },
  identity: {
    requireVerification: true,
    minTier: 2,
  },
  consent: {
    requireExplicitConsent: true,
    defaultCapabilities: [],
  },
  liveSync: {
    enabled: false,
    joinMode: 'prompt',
    transcriptMode: 'final_only',
  },
  retention: {
    maxRetentionDays: 90,
    enableAutoPurge: false,
  },
};

/**
 * Get omnichannel settings for a project.
 *
 * Returns stored settings merged with defaults for any missing fields.
 * If no settings document exists, returns the full defaults.
 *
 * @param tenantId - Tenant scope
 * @param projectId - Project scope
 * @returns Full omnichannel settings with defaults applied
 */
export async function getOmnichannelSettings(
  tenantId: string,
  projectId: string,
): Promise<IOmnichannelProjectSettings> {
  try {
    const { OmnichannelProjectSettings } = await import('@agent-platform/database/models');
    const doc = await OmnichannelProjectSettings.findOne({
      tenantId,
      projectId,
    }).lean();

    if (!doc) {
      return { ...DEFAULT_SETTINGS };
    }

    // Merge stored values with defaults for any missing nested fields
    return mergeWithDefaults(doc as Partial<IOmnichannelProjectSettings>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to get omnichannel settings', {
      tenantId,
      projectId,
      error: message,
    });
    // Return defaults on error to allow graceful degradation
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Update omnichannel settings for a project.
 *
 * Performs a partial merge: only provided fields are updated.
 * Uses findOneAndUpdate with upsert for atomic operation.
 *
 * @param tenantId - Tenant scope
 * @param projectId - Project scope
 * @param updates - Partial settings to merge
 * @returns Updated full settings with defaults applied
 */
export async function updateOmnichannelSettings(
  tenantId: string,
  projectId: string,
  updates: IOmnichannelProjectSettingsUpdate,
): Promise<IOmnichannelProjectSettings> {
  const { OmnichannelProjectSettings } = await import('@agent-platform/database/models');

  // Build $set object for nested updates
  const $set: Record<string, unknown> = { tenantId, projectId };

  if (updates.recall) {
    if (updates.recall.enabled !== undefined) $set['recall.enabled'] = updates.recall.enabled;
    if (updates.recall.maxMessages !== undefined)
      $set['recall.maxMessages'] = updates.recall.maxMessages;
    if (updates.recall.maxAgeDays !== undefined)
      $set['recall.maxAgeDays'] = updates.recall.maxAgeDays;
    if (updates.recall.defaultAllowedChannels !== undefined)
      $set['recall.defaultAllowedChannels'] = updates.recall.defaultAllowedChannels;
  }

  if (updates.identity) {
    if (updates.identity.requireVerification !== undefined)
      $set['identity.requireVerification'] = updates.identity.requireVerification;
    if (updates.identity.minTier !== undefined) $set['identity.minTier'] = updates.identity.minTier;
  }

  if (updates.consent) {
    if (updates.consent.requireExplicitConsent !== undefined)
      $set['consent.requireExplicitConsent'] = updates.consent.requireExplicitConsent;
    if (updates.consent.defaultCapabilities !== undefined)
      $set['consent.defaultCapabilities'] = updates.consent.defaultCapabilities;
  }

  if (updates.liveSync) {
    if (updates.liveSync.enabled !== undefined) $set['liveSync.enabled'] = updates.liveSync.enabled;
    if (updates.liveSync.joinMode !== undefined)
      $set['liveSync.joinMode'] = updates.liveSync.joinMode;
    if (updates.liveSync.transcriptMode !== undefined)
      $set['liveSync.transcriptMode'] = updates.liveSync.transcriptMode;
  }

  if (updates.retention) {
    if (updates.retention.maxRetentionDays !== undefined)
      $set['retention.maxRetentionDays'] = updates.retention.maxRetentionDays;
    if (updates.retention.enableAutoPurge !== undefined)
      $set['retention.enableAutoPurge'] = updates.retention.enableAutoPurge;
  }

  const doc = await OmnichannelProjectSettings.findOneAndUpdate(
    { tenantId, projectId },
    { $set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  log.info('Omnichannel settings updated', { tenantId, projectId });
  return mergeWithDefaults(doc as Partial<IOmnichannelProjectSettings>);
}

/**
 * Merge a partial settings document with defaults.
 * Ensures all nested fields have values even if the stored document is sparse.
 */
function mergeWithDefaults(doc: Partial<IOmnichannelProjectSettings>): IOmnichannelProjectSettings {
  return {
    recall: {
      enabled: doc.recall?.enabled ?? DEFAULT_SETTINGS.recall.enabled,
      maxMessages: doc.recall?.maxMessages ?? DEFAULT_SETTINGS.recall.maxMessages,
      maxAgeDays: doc.recall?.maxAgeDays ?? DEFAULT_SETTINGS.recall.maxAgeDays,
      defaultAllowedChannels:
        doc.recall?.defaultAllowedChannels ?? DEFAULT_SETTINGS.recall.defaultAllowedChannels,
    },
    identity: {
      requireVerification:
        doc.identity?.requireVerification ?? DEFAULT_SETTINGS.identity.requireVerification,
      minTier: doc.identity?.minTier ?? DEFAULT_SETTINGS.identity.minTier,
    },
    consent: {
      requireExplicitConsent:
        doc.consent?.requireExplicitConsent ?? DEFAULT_SETTINGS.consent.requireExplicitConsent,
      defaultCapabilities:
        doc.consent?.defaultCapabilities ?? DEFAULT_SETTINGS.consent.defaultCapabilities,
    },
    liveSync: {
      enabled: doc.liveSync?.enabled ?? DEFAULT_SETTINGS.liveSync.enabled,
      joinMode: doc.liveSync?.joinMode ?? DEFAULT_SETTINGS.liveSync.joinMode,
      transcriptMode: doc.liveSync?.transcriptMode ?? DEFAULT_SETTINGS.liveSync.transcriptMode,
    },
    retention: {
      maxRetentionDays:
        doc.retention?.maxRetentionDays ?? DEFAULT_SETTINGS.retention.maxRetentionDays,
      enableAutoPurge: doc.retention?.enableAutoPurge ?? DEFAULT_SETTINGS.retention.enableAutoPurge,
    },
  };
}
