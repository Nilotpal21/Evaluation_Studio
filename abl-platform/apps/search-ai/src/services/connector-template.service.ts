/**
 * Connector Template Service
 *
 * CRUD and apply operations for connector configuration templates.
 * Templates store a snapshot of connector config that can be reused
 * when creating new connectors.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IConnectorConfig, IConnectorTemplate } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { ConnectorError } from './connector.service.js';

const logger = createLogger('connector-template-service');

const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorTemplate = getLazyModel<IConnectorTemplate>('ConnectorTemplate');

// ─── List Templates ──────────────────────────────────────────────────────

export async function listTemplates(
  indexId: string,
  tenantId: string,
  options?: { search?: string; page?: number; limit?: number },
): Promise<{ templates: IConnectorTemplate[]; total: number }> {
  const page = options?.page ?? 1;
  const limit = Math.min(options?.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { tenantId };
  if (options?.search) {
    filter.name = { $regex: options.search, $options: 'i' };
  }

  const [templates, total] = await Promise.all([
    ConnectorTemplate.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ConnectorTemplate.countDocuments(filter),
  ]);

  return {
    templates: templates as IConnectorTemplate[],
    total,
  };
}

// ─── Create Template ─────────────────────────────────────────────────────

export async function createTemplate(
  sourceConnectorId: string,
  tenantId: string,
  name: string,
  description?: string,
): Promise<IConnectorTemplate> {
  const connector = await ConnectorConfig.findOne({ _id: sourceConnectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Source connector not found', 404);
  }

  const connectionConfig = (connector.connectionConfig ?? {}) as Record<string, unknown>;
  const configSnapshot: Record<string, unknown> = {
    filterConfig: connector.filterConfig ?? {},
    permissionMode: connectionConfig.permissionMode ?? 'public_access',
    syncSchedule: connectionConfig.syncSchedule ?? null,
    connectorType: connector.connectorType,
  };

  const template = await ConnectorTemplate.create({
    tenantId,
    name,
    description: description ?? '',
    connectorType: connector.connectorType,
    configSnapshot,
    permissionMode: connectionConfig.permissionMode === 'enabled' ? 'enabled' : 'disabled',
    createdBy: tenantId,
    updatedBy: tenantId,
    usageCount: 0,
  });

  logger.info('Template created', { templateId: template._id, name, tenantId });

  return template.toObject() as IConnectorTemplate;
}

// ─── Apply Template ──────────────────────────────────────────────────────

export async function applyTemplate(
  templateId: string,
  indexId: string,
  tenantId: string,
  securityDecision?: string,
): Promise<{ connectorId: string; name: string; status: 'draft'; templateId: string }> {
  const template = await ConnectorTemplate.findOne({ _id: templateId, tenantId }).lean();
  if (!template) {
    throw new ConnectorError('TEMPLATE_NOT_FOUND', 'Template not found', 404);
  }

  const snapshot = (template.configSnapshot ?? {}) as Record<string, unknown>;

  // Determine permission mode based on security decision
  let permissionMode = template.permissionMode;
  if (securityDecision === 'disable_permissions') {
    permissionMode = 'disabled';
  }

  const connectionConfig: Record<string, unknown> = {
    displayName: `${template.name} (from template)`,
    permissionMode,
    syncSchedule: snapshot.syncSchedule ?? null,
    templateId: template._id,
  };

  const filterConfig = (snapshot.filterConfig as Record<string, unknown>) ?? {
    mode: 'include',
    siteUrls: [],
    libraryNames: [],
    contentTypes: [],
    modifiedSince: null,
  };

  // Import createConnector inline to avoid circular deps
  const { createConnector } = await import('./connector.service.js');
  const result = await createConnector(indexId, tenantId, {
    name: `${template.name} (from template)`,
    connectorType: template.connectorType,
    connectionConfig,
    filterConfig,
  });

  // Increment usage count
  await ConnectorTemplate.findOneAndUpdate(
    { _id: templateId, tenantId },
    { $inc: { usageCount: 1 } },
  );

  const connectorId = (result.connector as Record<string, unknown>)._id as string;

  return {
    connectorId,
    name: `${template.name} (from template)`,
    status: 'draft',
    templateId: template._id,
  };
}

// ─── Import Config ───────────────────────────────────────────────────────

export async function importConnectorConfig(
  indexId: string,
  tenantId: string,
  config: Record<string, unknown>,
  securityDecision?: string,
): Promise<{ connectorId: string; name: string; status: 'draft' }> {
  const connectorType = (config.connectorType as string) ?? 'sharepoint';
  const name = (config.name as string) ?? `Imported ${connectorType}`;

  // Strip credentials from import
  const safeConfig = { ...config };
  delete safeConfig.credentials;
  delete safeConfig.clientSecret;
  delete safeConfig.refreshToken;

  let permissionMode = (safeConfig.permissionMode as string) ?? 'public_access';
  if (securityDecision === 'disable_permissions') {
    permissionMode = 'disabled';
  }

  const connectionConfig: Record<string, unknown> = {
    displayName: name,
    permissionMode,
    syncSchedule: safeConfig.schedule ?? null,
  };

  if (safeConfig.scope && typeof safeConfig.scope === 'object') {
    const scope = safeConfig.scope as Record<string, unknown>;
    connectionConfig.siteUrl = scope.siteUrl;
    connectionConfig.siteId = scope.siteId;
  }

  const filterConfig = (safeConfig.filters as Record<string, unknown>) ?? {
    mode: 'include',
    siteUrls: [],
    libraryNames: [],
    contentTypes: [],
    modifiedSince: null,
  };

  const { createConnector } = await import('./connector.service.js');
  const result = await createConnector(indexId, tenantId, {
    name,
    connectorType,
    connectionConfig,
    filterConfig,
  });

  const connectorId = (result.connector as Record<string, unknown>)._id as string;

  return { connectorId, name, status: 'draft' };
}
