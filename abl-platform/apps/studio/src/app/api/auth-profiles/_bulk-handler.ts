/**
 * Shared bulk action handler for auth profiles.
 *
 * Used by both tenant-scoped (/api/auth-profiles/bulk) and
 * project-scoped (/api/projects/:id/auth-profiles/bulk) routes.
 */

import { NextResponse } from 'next/server';
import {
  buildAuthProfileOAuthGrantFilter,
  buildAuthProfileOAuthGrantProvider,
  buildVisibleOAuthGrantUserFilter,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import { parseDslProperties } from '@agent-platform/shared';
import { getAuthProfileMigrationState } from '@agent-platform/shared/services/auth-profile';

// ─── Consumer check models (same as single-profile delete) ──────────────

interface ConsumerCheck {
  type: string;
  field?: string;
}

// Keep durable-grant delete blockers in sync with the runtime workspace
// delete route in apps/runtime/src/routes/auth-profiles.ts.
export const CONSUMER_CHECKS: ConsumerCheck[] = [
  { type: 'AuthProfile', field: 'linkedAppProfileId' },
  { type: 'EndUserOAuthToken', field: 'provider' },
  { type: 'ProjectTool' },
  { type: 'ChannelConnection' },
  { type: 'TenantModel', field: 'connections.authProfileId' },
  { type: 'ConnectorConfig' },
  { type: 'ConnectorConnection' },
  { type: 'MCPServerConfig' },
  { type: 'ServiceNode' },
  { type: 'TenantGuardrailProviderConfig' },
  { type: 'GuardrailPolicy' },
  { type: 'GitIntegration' },
  { type: 'WebhookSubscription' },
  { type: 'WebhookSubscriptionConnector' },
  { type: 'ModelConfig' },
  { type: 'TenantServiceInstance' },
  { type: 'OrgProxyConfig' },
  { type: 'ArchWorkspaceConfig' },
  { type: 'TriggerRegistration' },
  { type: 'ProjectSettings', field: 'publicApiAccess.scopes.search\\.query.authProfileIds' },
];

export interface BulkResult {
  id: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  reason?: string;
}

interface ConsumerModel {
  countDocuments?: Function;
  find?: Function;
  deleteMany?: Function;
}

export type ModelMap = Record<string, ConsumerModel | undefined>;

export interface BulkActionContext {
  action: 'delete' | 'revoke' | 'activate';
  profileId: string;
  profile: Record<string, unknown>;
  tenantId: string;
  projectId?: string;
  userId?: string;
  isAdmin?: boolean;
  workspaceOnly?: boolean;
  /** Query filter for ownership scoping (tenant or project) */
  ownershipFilter: Record<string, unknown>;
  modelMap: ModelMap;
  AuthProfile: {
    findOneAndDelete: Function;
    findOneAndUpdate: Function;
  };
}

function canExposeConsumerType(params: { type: string; workspaceOnly?: boolean }): boolean {
  // ConnectorConnection bridges and linked AuthProfile (oauth2_token) are internal.
  // All other entity types (channels, models, services, etc.) are user-visible consumers.
  const hiddenTypes = ['ConnectorConnection', 'AuthProfile'];
  return !hiddenTypes.includes(params.type);
}

export function buildConsumerCountFilter(params: {
  type: string;
  profileId: string;
  tenantId: string;
  field?: string;
  projectId?: string;
  userId?: string;
  isAdmin?: boolean;
  workspaceOnly?: boolean;
  visibleOnly?: boolean;
}): Record<string, unknown> {
  if (
    params.visibleOnly === true &&
    !canExposeConsumerType({
      type: params.type,
      workspaceOnly: params.workspaceOnly,
    })
  ) {
    return { _id: '__never__' };
  }

  const filter: Record<string, unknown> =
    params.type === 'EndUserOAuthToken'
      ? buildAuthProfileOAuthGrantFilter(params.profileId)
      : {
          [params.field ?? 'authProfileId']: params.profileId,
        };

  switch (params.type) {
    case 'AuthProfile':
      filter.tenantId = params.tenantId;
      filter.status = 'active';
      if (params.visibleOnly) {
        if (params.workspaceOnly === true) {
          filter.projectId = null;
          filter.scope = 'tenant';
        } else if (params.projectId) {
          filter.projectId = params.projectId;
        }

        if (!params.isAdmin && params.userId) {
          filter.$or = [
            { visibility: 'shared' },
            { visibility: 'personal', createdBy: params.userId },
          ];
        }
      }
      break;
    case 'EndUserOAuthToken':
      filter.tenantId = params.tenantId;
      if (params.visibleOnly && !params.isAdmin && params.userId) {
        Object.assign(filter, buildVisibleOAuthGrantUserFilter(params.userId));
      }
      break;
    case 'ConnectorConnection':
      filter.tenantId = params.tenantId;
      if (params.projectId) {
        filter.projectId = params.projectId;
      }
      if (params.visibleOnly && !params.isAdmin && params.userId) {
        filter.$or = [{ scope: 'tenant' }, { scope: 'user', userId: params.userId }];
      }
      break;
    case 'ChannelConnection':
      filter.tenantId = params.tenantId;
      if (params.projectId) {
        filter.projectId = params.projectId;
      }
      break;
    case 'ServiceNode':
      filter.tenantId = params.tenantId;
      if (params.projectId) {
        filter.projectId = params.projectId;
      }
      break;
    case 'ProjectSettings':
      // ProjectSettings stores authProfileIds in a Mixed field with literal dot key.
      // MongoDB matches array contents: if profileId is in the array, the doc matches.
      filter.tenantId = params.tenantId;
      break;
    default:
      filter.tenantId = params.tenantId;
      break;
  }

  return filter;
}

export function buildConsumerAggregateMatch(params: {
  type: string;
  field: string;
  profileIds: string[];
  tenantId: string;
  projectId?: string;
  userId?: string;
  workspaceOnly?: boolean;
}): Record<string, unknown> {
  const match: Record<string, unknown> =
    params.type === 'EndUserOAuthToken'
      ? {
          [params.field]: {
            $in: params.profileIds.map((profileId) =>
              buildAuthProfileOAuthGrantProvider(profileId),
            ),
          },
        }
      : {
          [params.field]: { $in: params.profileIds },
        };

  switch (params.type) {
    case 'AuthProfile':
      match.tenantId = params.tenantId;
      match.status = 'active';
      if (params.workspaceOnly === true) {
        match.projectId = null;
        match.scope = 'tenant';
      } else if (params.projectId) {
        match.projectId = params.projectId;
      }
      if (params.userId) {
        match.$or = [
          { visibility: 'shared' },
          { visibility: 'personal', createdBy: params.userId },
        ];
      }
      break;
    case 'EndUserOAuthToken':
      match.tenantId = params.tenantId;
      match.revokedAt = null;
      if (params.userId) {
        Object.assign(match, buildVisibleOAuthGrantUserFilter(params.userId));
      }
      break;
    case 'ConnectorConnection':
      match.tenantId = params.tenantId;
      if (params.projectId) {
        match.projectId = params.projectId;
      }
      if (params.userId) {
        match.$or = [{ scope: 'tenant' }, { scope: 'user', userId: params.userId }];
      }
      break;
    case 'ChannelConnection':
      match.tenantId = params.tenantId;
      if (params.projectId) {
        match.projectId = params.projectId;
      }
      break;
    case 'ServiceNode':
      match.tenantId = params.tenantId;
      if (params.projectId) {
        match.projectId = params.projectId;
      }
      break;
    case 'ProjectSettings':
      match.tenantId = params.tenantId;
      break;
    default:
      match.tenantId = params.tenantId;
      break;
  }

  return match;
}

export interface DeleteBlocker {
  type: string;
  count: number;
}

export interface DeleteBlockerSummary {
  visibleConsumers: DeleteBlocker[];
  allConsumers: DeleteBlocker[];
  hiddenBlockers: boolean;
}

const AUTO_CASCADE_DELETE_BLOCKER_TYPES = new Set(['AuthProfile', 'EndUserOAuthToken']);

function parseAuthProfileRefFromToolDsl(dslContent: unknown): string | null {
  if (typeof dslContent !== 'string' || dslContent.trim().length === 0) {
    return null;
  }
  const authProfileRef = parseDslProperties(dslContent).auth_profile;
  if (typeof authProfileRef !== 'string') {
    return null;
  }
  const trimmed = authProfileRef.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function countProjectToolConsumers(params: {
  model: ConsumerModel | undefined;
  profileName?: string;
  tenantId: string;
  projectId?: string;
  workspaceOnly?: boolean;
  isAdmin?: boolean;
}): Promise<{ totalCount: number; visibleCount: number }> {
  const profileName = params.profileName?.trim();
  if (!profileName || !params.model?.find) {
    return { totalCount: 0, visibleCount: 0 };
  }

  const toolFilter: Record<string, unknown> = {
    tenantId: params.tenantId,
    dslContent: { $regex: 'auth_profile\\s*:' },
  };
  if (params.projectId) {
    toolFilter.projectId = params.projectId;
  }

  // Query only candidate tools that contain an auth_profile property.
  const query = params.model.find(toolFilter);
  const selected = query?.select ? query.select('_id dslContent') : query;
  const rawTools = selected?.lean ? await selected.lean() : await selected;
  const tools = Array.isArray(rawTools) ? rawTools : [];
  const totalCount = tools.reduce((count: number, tool: Record<string, unknown>) => {
    return parseAuthProfileRefFromToolDsl(tool.dslContent) === profileName ? count + 1 : count;
  }, 0);

  if (params.projectId) {
    return { totalCount, visibleCount: totalCount };
  }
  if (params.workspaceOnly && params.isAdmin !== true) {
    return { totalCount, visibleCount: 0 };
  }
  return { totalCount, visibleCount: totalCount };
}

export function hasDeleteBlockers(summary: DeleteBlockerSummary): boolean {
  return summary.visibleConsumers.length > 0 || summary.hiddenBlockers;
}

export function canAutoCascadeInternalDeleteBlockers(params: {
  profile: Record<string, unknown>;
  summary: DeleteBlockerSummary;
}): boolean {
  if (params.profile.authType !== 'oauth2_app') {
    return false;
  }
  if (params.summary.allConsumers.length === 0) {
    return false;
  }
  return params.summary.allConsumers.every((entry) =>
    AUTO_CASCADE_DELETE_BLOCKER_TYPES.has(entry.type),
  );
}

export async function cleanupAutoCascadeInternalDependencies(params: {
  profileId: string;
  tenantId: string;
  modelMap: ModelMap;
}): Promise<void> {
  const authProfileModel = params.modelMap.AuthProfile;
  if (authProfileModel?.deleteMany) {
    await authProfileModel.deleteMany({
      tenantId: params.tenantId,
      authType: 'oauth2_token',
      linkedAppProfileId: params.profileId,
    });
  }

  const oauthGrantModel = params.modelMap.EndUserOAuthToken;
  if (oauthGrantModel?.deleteMany) {
    await oauthGrantModel.deleteMany({
      ...buildAuthProfileOAuthGrantFilter(params.profileId),
      tenantId: params.tenantId,
    });
  }
}

export function formatDeleteBlockerLabel(blocker: DeleteBlocker): string {
  switch (blocker.type) {
    case 'AuthProfile':
      return `${blocker.count} active linked token${blocker.count === 1 ? '' : 's'}`;
    case 'EndUserOAuthToken':
      return `${blocker.count} active OAuth grant${blocker.count === 1 ? '' : 's'}`;
    case 'ProjectTool':
      return `${blocker.count} HTTP tool${blocker.count === 1 ? '' : 's'}`;
    case 'ConnectorConnection':
      return `${blocker.count} connector connection${blocker.count === 1 ? '' : 's'}`;
    case 'ProjectSettings':
      return `used as identity provider in ${blocker.count} project${blocker.count === 1 ? "'s" : "s'"} Public API access settings`;
    default:
      return `${blocker.count} ${blocker.type}`;
  }
}

export async function summarizeDeleteBlockers(params: {
  profileId: string;
  profileName?: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  isAdmin?: boolean;
  workspaceOnly?: boolean;
  modelMap: ModelMap;
}): Promise<DeleteBlockerSummary> {
  const counts = await Promise.all(
    CONSUMER_CHECKS.map(async ({ type, field }) => {
      const model = params.modelMap[type];
      if (!model) {
        return { type, totalCount: 0, visibleCount: 0 };
      }

      if (type === 'ProjectTool') {
        const { totalCount, visibleCount } = await countProjectToolConsumers({
          model,
          profileName: params.profileName,
          tenantId: params.tenantId,
          projectId: params.projectId,
          workspaceOnly: params.workspaceOnly,
          isAdmin: params.isAdmin,
        });
        return { type, totalCount, visibleCount };
      }

      if (!model.countDocuments) {
        return { type, totalCount: 0, visibleCount: 0 };
      }

      const [totalCount, visibleCount] = await Promise.all([
        model.countDocuments(
          buildConsumerCountFilter({
            type,
            profileId: params.profileId,
            tenantId: params.tenantId,
            field,
          }),
        ),
        model.countDocuments(
          buildConsumerCountFilter({
            type,
            profileId: params.profileId,
            tenantId: params.tenantId,
            field,
            projectId: params.projectId,
            userId: params.userId,
            isAdmin: params.isAdmin,
            workspaceOnly: params.workspaceOnly,
            visibleOnly: true,
          }),
        ),
      ]);

      return { type, totalCount, visibleCount };
    }),
  );

  return {
    visibleConsumers: counts
      .filter((entry) => entry.visibleCount > 0)
      .map(({ type, visibleCount }) => ({ type, count: visibleCount })),
    allConsumers: counts
      .filter((entry) => entry.totalCount > 0)
      .map(({ type, totalCount }) => ({ type, count: totalCount })),
    hiddenBlockers: counts.some((entry) => entry.totalCount > entry.visibleCount),
  };
}

/**
 * Execute a single bulk action on one profile.
 * Returns the result entry for that profile.
 */
export async function executeBulkAction(ctx: BulkActionContext): Promise<BulkResult> {
  const {
    action,
    profileId,
    profile,
    tenantId,
    projectId,
    userId,
    isAdmin,
    workspaceOnly,
    ownershipFilter,
    modelMap,
    AuthProfile,
  } = ctx;

  switch (action) {
    case 'delete': {
      const migration = getAuthProfileMigrationState(profile);
      if (migration) {
        return {
          id: profileId,
          status: 'error',
          error: migration.message,
        };
      }

      let blockerSummary = await summarizeDeleteBlockers({
        profileId,
        profileName: typeof profile.name === 'string' ? profile.name : undefined,
        tenantId,
        projectId,
        userId,
        isAdmin,
        workspaceOnly,
        modelMap,
      });

      if (hasDeleteBlockers(blockerSummary)) {
        const canAutoCascade = canAutoCascadeInternalDeleteBlockers({
          profile,
          summary: blockerSummary,
        });
        if (canAutoCascade) {
          await cleanupAutoCascadeInternalDependencies({
            profileId,
            tenantId,
            modelMap,
          });
          blockerSummary = await summarizeDeleteBlockers({
            profileId,
            profileName: typeof profile.name === 'string' ? profile.name : undefined,
            tenantId,
            projectId,
            userId,
            isAdmin,
            workspaceOnly,
            modelMap,
          });
        }
      }

      if (hasDeleteBlockers(blockerSummary)) {
        const visibleParts = blockerSummary.visibleConsumers.map(formatDeleteBlockerLabel);
        const hiddenSuffix = blockerSummary.hiddenBlockers
          ? blockerSummary.visibleConsumers.length > 0
            ? ', plus other resources outside this scope'
            : 'resources outside this scope or hidden from your account'
          : '';
        return {
          id: profileId,
          status: 'error',
          error:
            blockerSummary.visibleConsumers.length > 0
              ? `Cannot delete — referenced by ${visibleParts.join(', ')}${hiddenSuffix}`
              : `Cannot delete — referenced by ${hiddenSuffix}`,
        };
      }

      await AuthProfile.findOneAndDelete(ownershipFilter);
      return { id: profileId, status: 'ok' };
    }
    case 'revoke': {
      const migration = getAuthProfileMigrationState(profile);
      if (migration) {
        return {
          id: profileId,
          status: 'error',
          error: migration.message,
        };
      }

      const currentStatus = profile.status as string | undefined;
      if (currentStatus === 'expired' || currentStatus === 'revoked') {
        return {
          id: profileId,
          status: 'skipped',
          reason: `Profile is ${currentStatus}`,
        };
      }
      // `findOneAndUpdate` bypasses Mongoose middleware so the AuthProfile
      // pre-save hook does NOT fire — `profileVersion` would stay put and
      // cross-pod credential caches (keyed on `{tenantId, profileId,
      // profileVersion}`) would keep serving stale secrets for the cache
      // TTL. Bumping inline keeps the caches self-invalidating.
      await AuthProfile.findOneAndUpdate(ownershipFilter, {
        $set: { status: 'revoked' },
        $inc: { profileVersion: 1 },
      });
      return { id: profileId, status: 'ok' };
    }
    case 'activate': {
      const migration = getAuthProfileMigrationState(profile);
      if (migration) {
        return {
          id: profileId,
          status: 'error',
          error: migration.message,
        };
      }

      // Same hook-bypass concern as the revoke branch above — bump
      // profileVersion explicitly so caches re-decrypt fresh.
      await AuthProfile.findOneAndUpdate(ownershipFilter, {
        $set: { status: 'active' },
        $inc: { profileVersion: 1 },
      });
      return { id: profileId, status: 'ok' };
    }
  }
}

/**
 * Load the model map from @agent-platform/database/models.
 */
export async function loadModelMap(): Promise<
  ModelMap & {
    AuthProfile: {
      findOne: Function;
      findOneAndDelete: Function;
      findOneAndUpdate: Function;
    };
  }
> {
  const {
    AuthProfile,
    ChannelConnection,
    TenantModel,
    ConnectorConfig,
    ConnectorConnection,
    MCPServerConfig,
    ServiceNode,
    TenantGuardrailProviderConfig,
    GuardrailPolicy,
    GitIntegration,
    WebhookSubscription,
    WebhookSubscriptionConnector,
    ModelConfig,
    TenantServiceInstance,
    OrgProxyConfig,
    ArchWorkspaceConfig,
    TriggerRegistration,
    EndUserOAuthToken,
    ProjectSettings,
    ProjectTool,
  } = await import('@agent-platform/database/models');

  const modelMap: ModelMap = {
    AuthProfile,
    ChannelConnection,
    TenantModel,
    ConnectorConfig,
    ConnectorConnection,
    MCPServerConfig,
    ServiceNode,
    TenantGuardrailProviderConfig,
    GuardrailPolicy,
    GitIntegration,
    WebhookSubscription,
    WebhookSubscriptionConnector,
    ModelConfig,
    TenantServiceInstance,
    OrgProxyConfig,
    ArchWorkspaceConfig,
    TriggerRegistration,
    EndUserOAuthToken,
    ProjectSettings,
    ProjectTool,
  };

  return { ...modelMap, AuthProfile };
}
