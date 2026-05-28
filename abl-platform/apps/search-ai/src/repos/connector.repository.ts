/**
 * Connector Repository
 *
 * Pure data access layer for connector-related database operations.
 * Every query is scoped by tenantId — NEVER uses findById.
 */

import { getLazyModel } from '../db/index.js';
import type {
  IConnectorConfig,
  ISearchSource,
  ISearchIndex,
  IEndUserOAuthToken,
} from '@agent-platform/database/models';

// Models bound to platform database
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');

// ─── Index ───────────────────────────────────────────────────────────────

export async function findIndexByIdAndTenant(
  indexId: string,
  tenantId: string,
): Promise<ISearchIndex | null> {
  return SearchIndex.findOne({ _id: indexId, tenantId }).lean();
}

// ─── Source ──────────────────────────────────────────────────────────────

export async function findSourcesByIndex(
  indexId: string,
  tenantId: string,
): Promise<ISearchSource[]> {
  return SearchSource.find({ indexId, tenantId }).lean();
}

export async function findSourceByIdAndTenant(
  sourceId: string | unknown,
  tenantId: string,
): Promise<ISearchSource | null> {
  return SearchSource.findOne({ _id: sourceId, tenantId }).lean();
}

export async function createSource(data: {
  tenantId: string;
  indexId: string;
  name: string;
  sourceType: string;
  sourceConfig: Record<string, unknown>;
  status: string;
}): Promise<ISearchSource> {
  return SearchSource.create(data);
}

export async function deleteSourceByIdAndTenant(
  sourceId: string | unknown,
  tenantId: string,
): Promise<void> {
  await SearchSource.findOneAndDelete({ _id: sourceId, tenantId });
}

// ─── Connector ───────────────────────────────────────────────────────────

export async function findConnectorsBySourceIds(
  tenantId: string,
  sourceIds: unknown[],
): Promise<IConnectorConfig[]> {
  return ConnectorConfig.find({
    tenantId,
    sourceId: { $in: sourceIds },
  })
    .sort({ createdAt: -1 })
    .lean();
}

export async function findConnectorByTypeAndSources(
  tenantId: string,
  sourceIds: unknown[],
  connectorType: string,
): Promise<IConnectorConfig | null> {
  return ConnectorConfig.findOne({
    tenantId,
    sourceId: { $in: sourceIds },
    connectorType,
  }).lean();
}

export async function findConnectorByIdAndTenant(
  connectorId: string,
  tenantId: string,
): Promise<IConnectorConfig | null> {
  return ConnectorConfig.findOne({ _id: connectorId, tenantId });
}

export async function findConnectorByIdAndTenantLean(
  connectorId: string,
  tenantId: string,
): Promise<IConnectorConfig | null> {
  return ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
}

export async function createConnector(data: Record<string, unknown>): Promise<IConnectorConfig> {
  return ConnectorConfig.create(data);
}

export async function deleteConnectorByIdAndTenant(
  connectorId: string,
  tenantId: string,
): Promise<void> {
  await ConnectorConfig.findOneAndDelete({ _id: connectorId, tenantId });
}

export async function updateConnectorPermissionMode(
  connectorId: string,
  tenantId: string,
  mode: string,
): Promise<IConnectorConfig | null> {
  return ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    { 'permissionConfig.mode': mode },
    { new: true },
  );
}

export async function updateConnectorDeltaSyncTimestamp(
  connectorId: string,
  tenantId: string,
): Promise<void> {
  await ConnectorConfig.updateOne(
    { _id: connectorId, tenantId },
    { $set: { 'syncState.lastDeltaSyncAt': new Date() } },
  );
}

// ─── OAuth Token ─────────────────────────────────────────────────────────

export async function findOAuthToken(
  tokenId: string | unknown,
  tenantId: string,
): Promise<IEndUserOAuthToken | null> {
  return EndUserOAuthToken.findOne({ _id: tokenId, tenantId });
}

export async function revokeOAuthToken(tokenId: string | unknown, tenantId: string): Promise<void> {
  await EndUserOAuthToken.findOneAndUpdate({ _id: tokenId, tenantId }, { revokedAt: new Date() });
}

export async function findOAuthTokenByFilter(
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<IEndUserOAuthToken | null> {
  return EndUserOAuthToken.findOne({ ...filter, tenantId });
}

export async function createOAuthToken(data: Record<string, unknown>): Promise<IEndUserOAuthToken> {
  return EndUserOAuthToken.create(data);
}

// ─── Delta Token ─────────────────────────────────────────────────────────

export async function countDeltaTokens(connectorId: string, tenantId: string): Promise<number> {
  const { DriveDeltaToken } = await import('@agent-platform/database');
  return DriveDeltaToken.countDocuments({ connectorId, tenantId });
}

export async function findDeltaTokens(connectorId: string, tenantId: string): Promise<any[]> {
  const { DriveDeltaToken } = await import('@agent-platform/database');
  return DriveDeltaToken.find({ tenantId, connectorId }).sort({ lastSyncAt: -1 }).lean();
}

export async function deleteDeltaToken(
  connectorId: string,
  tenantId: string,
  driveId: string,
): Promise<number> {
  const { DriveDeltaToken } = await import('@agent-platform/database');
  const result = await DriveDeltaToken.deleteOne({
    tenantId,
    connectorId,
    driveId,
  });
  return result.deletedCount;
}

// ─── Sync Checkpoint ─────────────────────────────────────────────────────

export async function deleteSyncCheckpoints(connectorId: string, tenantId: string): Promise<void> {
  const { SyncCheckpoint } = await import('@agent-platform/database');
  await SyncCheckpoint.deleteMany({ tenantId, connectorId });
}
