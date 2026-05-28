/**
 * Connector Config Version Service
 *
 * Manages version history for connector configuration changes.
 * Uses optimistic concurrency control via a unique compound index
 * on { tenantId, connectorId, version } for safe auto-increment.
 */

import type { IConnectorConfigVersion } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';

const logger = createLogger('connector-config-version');

const ConnectorConfigVersion = getLazyModel<IConnectorConfigVersion>('ConnectorConfigVersion');

const MAX_VERSION_RETRIES = 3;

/**
 * Create a new version snapshot for a connector config.
 * Auto-increments the version number using optimistic concurrency:
 * reads latest version + 1, retries up to 3 times on duplicate key error.
 */
export async function createVersion(params: {
  connectorId: string;
  tenantId: string;
  configSnapshot: Record<string, unknown>;
  changedFields: string[];
  changedBy: string;
  changeSource: 'user' | 'system' | 'import' | 'restore';
  summary: string;
}): Promise<IConnectorConfigVersion> {
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const latestVersion = await getLatestVersion(params.connectorId, params.tenantId);
    const nextVersion = latestVersion + 1;

    try {
      const doc = await ConnectorConfigVersion.create({
        connectorId: params.connectorId,
        tenantId: params.tenantId,
        version: nextVersion,
        configSnapshot: params.configSnapshot,
        changedFields: params.changedFields,
        changedBy: params.changedBy,
        changeSource: params.changeSource,
        summary: params.summary,
      });
      return doc.toObject() as IConnectorConfigVersion;
    } catch (err: unknown) {
      // Duplicate key error (code 11000) means a concurrent write
      // claimed this version number — retry with the next version
      if (isDuplicateKeyError(err)) {
        logger.warn('Version conflict, retrying', {
          connectorId: params.connectorId,
          attempt: attempt + 1,
          conflictVersion: nextVersion,
        });
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to create version after ${MAX_VERSION_RETRIES} attempts due to concurrent writes`,
  );
}

/**
 * Get paginated version history for a connector, ordered by version descending.
 */
export async function getVersionHistory(
  connectorId: string,
  tenantId: string,
  options: { page?: number; limit?: number } = {},
): Promise<{ versions: IConnectorConfigVersion[]; total: number; page: number; limit: number }> {
  const page = options.page ?? 1;
  const limit = Math.min(options.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  const [versions, total] = await Promise.all([
    ConnectorConfigVersion.find({ connectorId, tenantId })
      .sort({ version: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IConnectorConfigVersion[]>(),
    ConnectorConfigVersion.countDocuments({ connectorId, tenantId }),
  ]);

  return { versions, total, page, limit };
}

/**
 * Get a specific version snapshot by version number.
 */
export async function getVersionSnapshot(
  connectorId: string,
  tenantId: string,
  versionNumber: number,
): Promise<IConnectorConfigVersion | null> {
  return ConnectorConfigVersion.findOne({
    connectorId,
    tenantId,
    version: versionNumber,
  }).lean<IConnectorConfigVersion>();
}

/**
 * Get the latest version number for a connector. Returns 0 if no versions exist.
 */
export async function getLatestVersion(connectorId: string, tenantId: string): Promise<number> {
  const latest = await ConnectorConfigVersion.findOne({ connectorId, tenantId })
    .sort({ version: -1 })
    .select('version')
    .lean<Pick<IConnectorConfigVersion, 'version'>>();

  return latest?.version ?? 0;
}

/**
 * Diff two version snapshots by comparing their configSnapshot objects.
 */
export async function diffVersions(
  connectorId: string,
  tenantId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{
  fromVersion: number;
  toVersion: number;
  changes: Array<{
    path: string;
    oldValue: unknown;
    newValue: unknown;
    type: 'added' | 'removed' | 'changed';
  }>;
}> {
  const [fromSnap, toSnap] = await Promise.all([
    getVersionSnapshot(connectorId, tenantId, fromVersion),
    getVersionSnapshot(connectorId, tenantId, toVersion),
  ]);

  if (!fromSnap) {
    throw new Error(`Version ${fromVersion} not found`);
  }
  if (!toSnap) {
    throw new Error(`Version ${toVersion} not found`);
  }

  const changes = computeConfigDiff(fromSnap.configSnapshot, toSnap.configSnapshot);

  return { fromVersion, toVersion, changes };
}

/**
 * Restore a previous version's config by creating a new version with changeSource 'restore'.
 */
export async function restoreVersion(
  connectorId: string,
  tenantId: string,
  versionNumber: number,
  restoredBy: string,
): Promise<IConnectorConfigVersion> {
  const targetVersion = await getVersionSnapshot(connectorId, tenantId, versionNumber);
  if (!targetVersion) {
    throw new Error(`Version ${versionNumber} not found`);
  }

  return createVersion({
    connectorId,
    tenantId,
    configSnapshot: targetVersion.configSnapshot,
    changedFields: Object.keys(targetVersion.configSnapshot),
    changedBy: restoredBy,
    changeSource: 'restore',
    summary: `Restored from version ${versionNumber}`,
  });
}

/**
 * Compute a structural diff between two config snapshot objects.
 */
function computeConfigDiff(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
  prefix = '',
): Array<{
  path: string;
  oldValue: unknown;
  newValue: unknown;
  type: 'added' | 'removed' | 'changed';
}> {
  const changes: Array<{
    path: string;
    oldValue: unknown;
    newValue: unknown;
    type: 'added' | 'removed' | 'changed';
  }> = [];

  const oldKeys = Object.keys(oldConfig);
  const newKeys = Object.keys(newConfig);
  const allKeysObj: Record<string, true> = {};
  for (const k of oldKeys) allKeysObj[k] = true;
  for (const k of newKeys) allKeysObj[k] = true;

  for (const key of Object.keys(allKeysObj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inOld = key in oldConfig;
    const inNew = key in newConfig;

    if (!inOld && inNew) {
      changes.push({ path, oldValue: undefined, newValue: newConfig[key], type: 'added' });
    } else if (inOld && !inNew) {
      changes.push({ path, oldValue: oldConfig[key], newValue: undefined, type: 'removed' });
    } else if (
      typeof oldConfig[key] === 'object' &&
      oldConfig[key] !== null &&
      typeof newConfig[key] === 'object' &&
      newConfig[key] !== null &&
      !Array.isArray(oldConfig[key]) &&
      !Array.isArray(newConfig[key])
    ) {
      // Recurse into nested objects
      const nested = computeConfigDiff(
        oldConfig[key] as Record<string, unknown>,
        newConfig[key] as Record<string, unknown>,
        path,
      );
      changes.push(...nested);
    } else if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
      changes.push({ path, oldValue: oldConfig[key], newValue: newConfig[key], type: 'changed' });
    }
  }

  return changes;
}

/**
 * Check if an error is a MongoDB duplicate key error (code 11000).
 */
function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: number }).code === 11000;
  }
  return false;
}
