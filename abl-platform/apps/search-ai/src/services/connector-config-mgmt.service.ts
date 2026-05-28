/**
 * Connector Config Management Service
 *
 * Handles config export (JSON/YAML), drift detection against templates,
 * drift resolution actions, and config import with preview.
 */

import { createLogger } from '@abl/compiler/platform';
import type {
  IConnectorConfig,
  IConnectorConfigVersion,
  IConnectorTemplate,
} from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { ConnectorError } from './connector.service.js';
import * as versionService from './connector-config-version.service.js';
import { writeAuditEntry as writeConnectorAuditEntry } from './connector-audit.service.js';

const logger = createLogger('connector-config-mgmt-service');

const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorTemplate = getLazyModel<IConnectorTemplate>('ConnectorTemplate');

// ─── Types ────────────────────────────────────────────────────────────────

export interface ExportOptions {
  format: 'json' | 'yaml';
  includeScope: boolean;
  includeFilters: boolean;
  includeSchedule: boolean;
  includePermissionMode: boolean;
  includeCredentials: boolean;
}

export interface ConfigDriftResponse {
  hasDrift: boolean;
  templateName: string | null;
  templateAppliedAtVersion: string | null;
  deviations: Array<{
    field: string;
    templateValue: unknown;
    currentValue: unknown;
    deviatedAtVersion: string;
  }>;
}

export interface DiffChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  type: 'added' | 'removed' | 'changed';
}

// ─── Export ───────────────────────────────────────────────────────────────

export async function exportConfig(
  connectorId: string,
  tenantId: string,
  options: ExportOptions,
): Promise<{ config: Record<string, unknown>; version: string; exportedAt: string }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const connectionConfig = (connector.connectionConfig ?? {}) as Record<string, unknown>;
  const filterConfig = (connector.filterConfig ?? {}) as Record<string, unknown>;

  const config: Record<string, unknown> = {
    connectorType: connector.connectorType,
    name: connectionConfig.displayName ?? connectionConfig.siteName ?? connector.connectorType,
  };

  if (options.includeScope) {
    config.scope = {
      siteUrl: connectionConfig.siteUrl,
      siteId: connectionConfig.siteId,
    };
  }

  if (options.includeFilters) {
    config.filters = filterConfig;
  }

  if (options.includeSchedule) {
    config.schedule = connectionConfig.syncSchedule ?? null;
  }

  if (options.includePermissionMode) {
    config.permissionMode = connectionConfig.permissionMode ?? 'public_access';
  }

  if (options.includeCredentials) {
    logger.warn('Credentials included in config export', { connectorId, tenantId });
    config.credentials = {
      clientId: connectionConfig.clientId,
      tenantDirectoryId: connectionConfig.tenantId,
    };
  }

  const latestVersion = await versionService.getLatestVersion(connectorId, tenantId);

  return {
    config,
    version: `v${latestVersion}`,
    exportedAt: new Date().toISOString(),
  };
}

// ─── Drift Detection ─────────────────────────────────────────────────────

export async function getConfigDrift(
  connectorId: string,
  tenantId: string,
): Promise<ConfigDriftResponse> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const templateId = (connector.connectionConfig as Record<string, unknown>)?.templateId as
    | string
    | undefined;

  if (!templateId) {
    return {
      hasDrift: false,
      templateName: null,
      templateAppliedAtVersion: null,
      deviations: [],
    };
  }

  const template = await ConnectorTemplate.findOne({ _id: templateId, tenantId }).lean();
  if (!template) {
    return {
      hasDrift: false,
      templateName: null,
      templateAppliedAtVersion: null,
      deviations: [],
    };
  }

  const templateConfig = template.configSnapshot ?? {};
  const currentConfig: Record<string, unknown> = {
    filterConfig: connector.filterConfig ?? {},
    permissionMode:
      (connector.connectionConfig as Record<string, unknown>)?.permissionMode ?? 'public_access',
    syncSchedule: (connector.connectionConfig as Record<string, unknown>)?.syncSchedule ?? null,
  };

  const deviations: ConfigDriftResponse['deviations'] = [];

  for (const key of Object.keys(templateConfig)) {
    const templateVal = templateConfig[key];
    const currentVal = currentConfig[key];
    if (JSON.stringify(templateVal) !== JSON.stringify(currentVal)) {
      deviations.push({
        field: key,
        templateValue: templateVal,
        currentValue: currentVal,
        deviatedAtVersion: 'unknown',
      });
    }
  }

  return {
    hasDrift: deviations.length > 0,
    templateName: template.name,
    templateAppliedAtVersion: `v${template._v ?? 1}`,
    deviations,
  };
}

// ─── Drift Resolution ────────────────────────────────────────────────────

export async function reapplyTemplate(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<IConnectorConfigVersion> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const templateId = (connector.connectionConfig as Record<string, unknown>)?.templateId as
    | string
    | undefined;
  if (!templateId) {
    throw new ConnectorError('NO_TEMPLATE', 'Connector was not created from a template', 400);
  }

  const template = await ConnectorTemplate.findOne({ _id: templateId, tenantId }).lean();
  if (!template) {
    throw new ConnectorError('TEMPLATE_NOT_FOUND', 'Template no longer exists', 404);
  }

  const updatedConfig = { ...template.configSnapshot };
  await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    {
      $set: {
        filterConfig: updatedConfig.filterConfig ?? connector.filterConfig,
        'connectionConfig.permissionMode':
          updatedConfig.permissionMode ??
          (connector.connectionConfig as Record<string, unknown>)?.permissionMode,
        'connectionConfig.syncSchedule':
          updatedConfig.syncSchedule ??
          (connector.connectionConfig as Record<string, unknown>)?.syncSchedule,
      },
    },
    { new: true },
  );

  const version = await versionService.createVersion({
    connectorId,
    tenantId,
    configSnapshot: updatedConfig,
    changedFields: Object.keys(updatedConfig),
    changedBy: actor,
    changeSource: 'restore',
    summary: `Re-applied template "${template.name}"`,
  });

  await writeConfigAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'config.reapply_template',
    category: 'config',
    metadata: {
      templateId,
      templateName: template.name,
    },
  });

  return version;
}

export async function updateTemplateFromCurrent(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ templateId: string; updatedAt: string }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const templateId = (connector.connectionConfig as Record<string, unknown>)?.templateId as
    | string
    | undefined;
  if (!templateId) {
    throw new ConnectorError('NO_TEMPLATE', 'Connector was not created from a template', 400);
  }

  const currentSnapshot: Record<string, unknown> = {
    filterConfig: connector.filterConfig ?? {},
    permissionMode:
      (connector.connectionConfig as Record<string, unknown>)?.permissionMode ?? 'public_access',
    syncSchedule: (connector.connectionConfig as Record<string, unknown>)?.syncSchedule ?? null,
  };

  const updatedTemplate = await ConnectorTemplate.findOneAndUpdate(
    { _id: templateId, tenantId },
    { $set: { configSnapshot: currentSnapshot, updatedBy: actor } },
    { new: true },
  );

  if (!updatedTemplate) {
    throw new ConnectorError('TEMPLATE_NOT_FOUND', 'Template no longer exists', 404);
  }

  await writeConfigAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'config.update_template',
    category: 'config',
    metadata: {
      templateId,
      templateName: updatedTemplate.name,
    },
  });

  return {
    templateId,
    updatedAt: new Date().toISOString(),
  };
}

export async function ignoreDrift(
  connectorId: string,
  tenantId: string,
): Promise<{ acknowledged: true }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    { $set: { 'connectionConfig.driftIgnoredAt': new Date().toISOString() } },
  );

  return { acknowledged: true };
}

// ─── Import ──────────────────────────────────────────────────────────────

export async function previewImport(
  connectorId: string,
  tenantId: string,
  importedConfig: Record<string, unknown>,
): Promise<{ diff: DiffChange[]; requiresConfirmation: true }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const currentConfig: Record<string, unknown> = {
    connectorType: connector.connectorType,
    filterConfig: connector.filterConfig ?? {},
    permissionMode:
      (connector.connectionConfig as Record<string, unknown>)?.permissionMode ?? 'public_access',
    syncSchedule: (connector.connectionConfig as Record<string, unknown>)?.syncSchedule ?? null,
  };

  const changes = computeDiff(currentConfig, importedConfig);

  return { diff: changes, requiresConfirmation: true };
}

export async function confirmImport(
  connectorId: string,
  tenantId: string,
  importedConfig: Record<string, unknown>,
  actor: string,
): Promise<IConnectorConfigVersion> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Strip credentials from imported config
  const safeConfig = { ...importedConfig };
  delete safeConfig.credentials;
  delete safeConfig.clientSecret;
  delete safeConfig.refreshToken;

  // Apply imported config
  const updateFields: Record<string, unknown> = {};
  if (safeConfig.filterConfig !== undefined) {
    updateFields.filterConfig = safeConfig.filterConfig;
  }
  if (safeConfig.permissionMode !== undefined) {
    updateFields['connectionConfig.permissionMode'] = safeConfig.permissionMode;
  }
  if (safeConfig.syncSchedule !== undefined) {
    updateFields['connectionConfig.syncSchedule'] = safeConfig.syncSchedule;
  }

  if (Object.keys(updateFields).length > 0) {
    await ConnectorConfig.findOneAndUpdate(
      { _id: connectorId, tenantId },
      { $set: updateFields },
      { new: true },
    );
  }

  const version = await versionService.createVersion({
    connectorId,
    tenantId,
    configSnapshot: safeConfig,
    changedFields: Object.keys(safeConfig),
    changedBy: actor,
    changeSource: 'import',
    summary: 'Imported configuration',
  });

  await writeConfigAuditEntry({
    connectorId,
    tenantId,
    actor,
    actorType: 'user',
    event: 'config.import',
    category: 'config',
    metadata: {
      changedFields: Object.keys(safeConfig),
    },
  });

  return version;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function computeDiff(
  current: Record<string, unknown>,
  imported: Record<string, unknown>,
): DiffChange[] {
  const changes: DiffChange[] = [];
  // Collect all unique keys without using Set constructor
  const currentKeys = Object.keys(current);
  const importedKeys = Object.keys(imported);
  const allKeysObj: Record<string, true> = {};
  for (const k of currentKeys) allKeysObj[k] = true;
  for (const k of importedKeys) allKeysObj[k] = true;
  const allKeys = Object.keys(allKeysObj);

  for (const key of allKeys) {
    const inCurrent = key in current;
    const inImported = key in imported;

    if (!inCurrent && inImported) {
      changes.push({ path: key, oldValue: undefined, newValue: imported[key], type: 'added' });
    } else if (inCurrent && !inImported) {
      changes.push({ path: key, oldValue: current[key], newValue: undefined, type: 'removed' });
    } else if (JSON.stringify(current[key]) !== JSON.stringify(imported[key])) {
      changes.push({
        path: key,
        oldValue: current[key],
        newValue: imported[key],
        type: 'changed',
      });
    }
  }

  return changes;
}

async function writeConfigAuditEntry(params: {
  connectorId: string;
  tenantId: string;
  actor: string;
  actorType: 'user' | 'system';
  event: string;
  category: 'config';
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await writeConnectorAuditEntry(params);
  } catch (err) {
    logger.error('Failed to write audit entry', {
      event: params.event,
      connectorId: params.connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
