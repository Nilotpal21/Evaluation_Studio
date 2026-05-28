/**
 * Project Settings Repository
 *
 * MongoDB queries for ProjectSettings (working copy) and
 * ProjectSettingsVersion (versioned snapshots).
 * Used by: services/settings-version-service.ts, routes/project-settings.ts
 */

import type { ProjectSessionLifecycleConfig } from '@abl/compiler/platform/core/types';
import type { IProjectMemorySettings, IProjectSdkDefaults } from '@agent-platform/database/models';

export type ProjectTransferTtlChannel = 'chat' | 'email' | 'voice' | 'messaging' | 'campaign';

// ─── Working Copy ────────────────────────────────────────────────────────

export async function findProjectSettings(
  projectId: string,
  tenantId: string,
): Promise<any | null> {
  const { ProjectSettings } = await import('@agent-platform/database/models');
  return ProjectSettings.findOne({ projectId, tenantId }).lean();
}

export async function upsertProjectSettings(
  projectId: string,
  tenantId: string,
  data: {
    enableThinking?: boolean;
    thinkingBudget?: number | null;
    thoughtDescription?: string | null;
    promptOverrides?: Record<string, unknown>;
    traceDimensions?: string[];
    memory?: IProjectMemorySettings | null;
    publicApiAccess?: Record<string, unknown> | null;
    sdkDefaults?: IProjectSdkDefaults | null;
  },
): Promise<any> {
  const { ProjectSettings } = await import('@agent-platform/database/models');
  const $set: Record<string, unknown> = { projectId, tenantId };
  if (data.enableThinking !== undefined) $set.enableThinking = data.enableThinking;
  if (data.thinkingBudget !== undefined) $set.thinkingBudget = data.thinkingBudget;
  if (data.thoughtDescription !== undefined) $set.thoughtDescription = data.thoughtDescription;
  if (data.promptOverrides !== undefined) $set.promptOverrides = data.promptOverrides;
  if (data.traceDimensions !== undefined) $set.traceDimensions = data.traceDimensions;
  if (data.memory !== undefined) $set.memory = data.memory;
  if (data.publicApiAccess !== undefined) $set.publicApiAccess = data.publicApiAccess;
  if (data.sdkDefaults !== undefined) $set.sdkDefaults = data.sdkDefaults;

  return ProjectSettings.findOneAndUpdate(
    { projectId, tenantId },
    { $set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

export async function upsertProjectSessionLifecycle(
  projectId: string,
  tenantId: string,
  sessionLifecycle: ProjectSessionLifecycleConfig | null,
  options?: {
    transferTtl?: Partial<Record<ProjectTransferTtlChannel, number>> | null;
  },
): Promise<any> {
  const { ProjectSettings } = await import('@agent-platform/database/models');
  const $set: Record<string, unknown> = {
    projectId,
    tenantId,
    sessionLifecycle,
  };
  const $unset: Record<string, ''> = {};

  if (options && Object.prototype.hasOwnProperty.call(options, 'transferTtl')) {
    if (options.transferTtl && Object.keys(options.transferTtl).length > 0) {
      $set['agentTransfer.session.ttl'] = options.transferTtl;
    } else {
      $unset['agentTransfer.session.ttl'] = '';
    }
  }

  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) {
    update.$unset = $unset;
  }

  return ProjectSettings.findOneAndUpdate({ projectId, tenantId }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();
}

// ─── Versioned Snapshots ─────────────────────────────────────────────────

export async function createSettingsVersion(data: {
  tenantId: string;
  projectId: string;
  version: string;
  status: string;
  settings: {
    enableThinking: boolean;
    thinkingBudget: number | null;
    thoughtDescription: string | null;
    promptOverrides?: Record<string, unknown>;
    memory?: IProjectMemorySettings | null;
  };
  sourceHash: string;
  changelog?: string;
  createdBy: string;
}): Promise<any> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.create({
    tenantId: data.tenantId,
    projectId: data.projectId,
    version: data.version,
    status: data.status,
    settings: data.settings,
    sourceHash: data.sourceHash,
    changelog: data.changelog ?? null,
    createdBy: data.createdBy,
  });
}

export async function findSettingsVersion(
  projectId: string,
  tenantId: string,
  version: string,
): Promise<any | null> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.findOne({ projectId, tenantId, version }).lean();
}

export async function findSettingsVersionById(id: string, tenantId: string): Promise<any | null> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.findOne({ _id: id, tenantId }).lean();
}

export async function findActiveSettingsVersion(
  projectId: string,
  tenantId: string,
): Promise<any | null> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.findOne({ projectId, tenantId, status: 'active' }).lean();
}

export async function findLatestSettingsVersion(
  projectId: string,
  tenantId: string,
): Promise<any | null> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.findOne({ projectId, tenantId }).sort({ createdAt: -1 }).lean();
}

export async function listSettingsVersions(
  projectId: string,
  tenantId: string,
  opts: { skip: number; take: number },
): Promise<any[]> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.find({ projectId, tenantId })
    .sort({ createdAt: -1 })
    .skip(opts.skip)
    .limit(opts.take)
    .lean();
}

export async function countSettingsVersions(projectId: string, tenantId: string): Promise<number> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  return ProjectSettingsVersion.countDocuments({ projectId, tenantId });
}

export async function getAllSettingsVersionNumbers(
  projectId: string,
  tenantId: string,
): Promise<string[]> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  const docs = await ProjectSettingsVersion.find({ projectId, tenantId }, { version: 1 }).lean();
  return docs.map((d: any) => d.version);
}

export async function promoteSettingsVersion(params: {
  id: string;
  currentStatus: string;
  newStatus: string;
  promotedBy: string;
}): Promise<{ count: number }> {
  const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
  const result = await ProjectSettingsVersion.updateOne(
    { _id: params.id, status: params.currentStatus },
    {
      $set: {
        status: params.newStatus,
        promotedBy: params.promotedBy,
        promotedAt: new Date(),
      },
    },
  );
  return { count: result.modifiedCount };
}
