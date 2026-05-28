import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseDslToToolForm } from '@agent-platform/shared/tools';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createTTLCache, type TTLCache } from './cache';
import { buildToolTestEndpointUrls } from '@/lib/tool-test-endpoint-service';
import { extractToolNames } from '@/lib/arch-ai/topology-helpers';

const log = createLogger('arch-ai:platform-context');

/** 5 min TTL for project-scoped data */
const PROJECT_CACHE_TTL = 5 * 60 * 1000;
/** 15 min TTL for tenant-scoped model list */
const MODELS_CACHE_TTL = 15 * 60 * 1000;
const ACTIVE_DRAFT_STATUSES = ['draft', 'needs_input', 'ready_to_test', 'ready_to_apply', 'failed'];

export const projectCache: TTLCache<unknown> = createTTLCache<unknown>(200, PROJECT_CACHE_TTL);
const modelsCache: TTLCache<unknown> = createTTLCache<unknown>(50, MODELS_CACHE_TTL);

interface PlatformContextInput {
  action: string;
  agentName?: string;
  toolType?: string;
}

interface PlatformContextResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface ToolRecord {
  id: string;
  name: string;
  toolType: string;
  description: string | null;
  dslContent: string;
  variableNamespaceIds: string[];
}

interface ToolRecordSource {
  id?: unknown;
  name?: unknown;
  toolType?: unknown;
  description?: unknown;
  dslContent?: unknown;
  variableNamespaceIds?: unknown;
}

interface ToolEndpointRecord {
  projectToolId: string;
  invokeCapability: string;
  specCapability: string;
  status: string;
}

interface AuthProfileRecord {
  id: string;
  name: string;
  authType: string;
  status: string;
  inherited: boolean;
  scope: string;
  visibility: string;
  connectionMode: string;
}

interface AgentRecord {
  name: string;
  description: string | null;
  dslContent: string | null;
}

interface EnvVarRecord {
  id: string;
  key: string;
  environment: string;
}

interface ConfigVarRecord {
  id: string;
  key: string;
  value: string;
}

interface MembershipRecord {
  variableId: string;
  namespaceId: string;
  variableType: 'env' | 'config';
}

interface ToolReadinessDetail {
  id: string;
  name: string;
  type: string;
  description: string | null;
  variableNamespaceIds: string[];
  implementation: Record<string, unknown>;
  readiness: Record<string, unknown>;
  impactedAgents: string[];
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function shouldUseProjectCache(ctx: ToolPermissionContext): boolean {
  return !ctx.sessionId;
}

function getProjectCacheKey(ctx: ToolPermissionContext, action: string): string {
  return `${ctx.user.tenantId}:${ctx.projectId}:${action}`;
}

function normalizeStringArray(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractTemplateKeys(text: string, prefix: 'env' | 'config'): string[] {
  const pattern = new RegExp(`\\{\\{${prefix}\\.([A-Za-z][A-Za-z0-9_]*)\\}\\}`, 'g');
  const keys: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    if (typeof match[1] === 'string') {
      keys.push(match[1].toUpperCase());
    }
    match = pattern.exec(text);
  }
  return normalizeStringArray(keys);
}

function extractConfigTemplateKey(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^\{\{config\.([A-Za-z][A-Za-z0-9_]*)\}\}$/);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function intersectsNamespaces(variableNamespaceIds: string[], toolNamespaceIds: string[]): boolean {
  if (toolNamespaceIds.length === 0) {
    return true;
  }

  return variableNamespaceIds.some((namespaceId) => toolNamespaceIds.includes(namespaceId));
}

function toToolRecord(raw: ToolRecordSource): ToolRecord {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    toolType: String(raw.toolType ?? ''),
    description: typeof raw.description === 'string' ? raw.description : null,
    dslContent: String(raw.dslContent ?? ''),
    variableNamespaceIds: Array.isArray(raw.variableNamespaceIds)
      ? raw.variableNamespaceIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value)
      : [],
  };
}

function buildNamespaceMembershipMap(
  memberships: MembershipRecord[],
  variableType: 'env' | 'config',
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const membership of memberships) {
    if (membership.variableType !== variableType) {
      continue;
    }
    const variableId = membership.variableId;
    const next = map.get(variableId) ?? [];
    next.push(membership.namespaceId);
    map.set(variableId, next);
  }
  return map;
}

function buildImpactedAgentMap(agents: AgentRecord[]): Map<string, string[]> {
  const impacted = new Map<string, string[]>();
  for (const agent of agents) {
    for (const toolName of extractToolNames(agent.dslContent)) {
      const next = impacted.get(toolName) ?? [];
      next.push(agent.name);
      impacted.set(toolName, next);
    }
  }

  for (const [toolName, names] of impacted.entries()) {
    impacted.set(toolName, normalizeStringArray(names));
  }
  return impacted;
}

function resolveToolReadiness(params: {
  tool: ToolRecord;
  endpoint: ToolEndpointRecord | null;
  envVars: EnvVarRecord[];
  envMemberships: Map<string, string[]>;
  configVars: ConfigVarRecord[];
  configMemberships: Map<string, string[]>;
  authProfiles: AuthProfileRecord[];
  impactedAgents: string[];
}): ToolReadinessDetail {
  const envKeys = extractTemplateKeys(params.tool.dslContent, 'env');
  const configKeys = extractTemplateKeys(params.tool.dslContent, 'config');

  let parsedHttpForm: ReturnType<typeof parseDslToToolForm> | null = null;
  if (params.tool.toolType === 'http') {
    try {
      parsedHttpForm = parseDslToToolForm(params.tool.dslContent, 'http');
    } catch (err: unknown) {
      log.warn('Failed to parse project tool DSL while building platform context', {
        toolId: params.tool.id,
        toolName: params.tool.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const httpForm = parsedHttpForm?.toolType === 'http' ? parsedHttpForm : null;

  const endpointUrls = params.endpoint
    ? buildToolTestEndpointUrls({
        invokeCapability: params.endpoint.invokeCapability,
        specCapability: params.endpoint.specCapability,
      })
    : null;
  const isStudioTestApi =
    httpForm?.endpoint && endpointUrls
      ? httpForm.endpoint === endpointUrls.invokeUrl && params.endpoint?.status === 'active'
      : false;

  const envRequirements = envKeys.map((key) => {
    const matchingVars = params.envVars.filter((variable) => {
      if (variable.key !== key) {
        return false;
      }
      const namespaces = params.envMemberships.get(variable.id) ?? [];
      return intersectsNamespaces(namespaces, params.tool.variableNamespaceIds);
    });

    return {
      key,
      availableEnvironments: normalizeStringArray(
        matchingVars.map((variable) => variable.environment),
      ),
      ready: matchingVars.length > 0,
    };
  });

  const configRequirements = configKeys.map((key) => {
    const matchingVar = params.configVars.find((variable) => {
      if (variable.key !== key) {
        return false;
      }
      const namespaces = params.configMemberships.get(variable.id) ?? [];
      return intersectsNamespaces(namespaces, params.tool.variableNamespaceIds);
    });

    return {
      key,
      exists: Boolean(matchingVar),
      valuePreview: matchingVar?.value ?? null,
    };
  });

  const authProfileRef = httpForm?.authProfileRef ?? null;
  const authProfileConfigKey = extractConfigTemplateKey(authProfileRef);
  const authProfileFromConfig = authProfileConfigKey
    ? params.configVars.find((variable) => {
        if (variable.key !== authProfileConfigKey) {
          return false;
        }
        const namespaces = params.configMemberships.get(variable.id) ?? [];
        return intersectsNamespaces(namespaces, params.tool.variableNamespaceIds);
      })
    : null;
  const resolvedAuthProfile = authProfileRef
    ? (params.authProfiles.find((profile) => {
        if (authProfileConfigKey) {
          return (
            profile.name === authProfileFromConfig?.value ||
            profile.id === authProfileFromConfig?.value
          );
        }
        return profile.name === authProfileRef || profile.id === authProfileRef;
      }) ?? null)
    : null;

  const authReady = !authProfileRef
    ? true
    : authProfileConfigKey
      ? Boolean(authProfileFromConfig && resolvedAuthProfile)
      : Boolean(resolvedAuthProfile);

  const missingEnvKeys = envRequirements
    .filter((requirement) => !requirement.ready)
    .map((requirement) => requirement.key);
  const missingConfigKeys = configRequirements
    .filter((requirement) => !requirement.exists)
    .map((requirement) => requirement.key);

  const overallReady =
    (params.tool.toolType !== 'http' || Boolean(httpForm?.endpoint)) &&
    missingEnvKeys.length === 0 &&
    missingConfigKeys.length === 0 &&
    authReady;

  return {
    id: params.tool.id,
    name: params.tool.name,
    type: params.tool.toolType,
    description: params.tool.description,
    variableNamespaceIds: params.tool.variableNamespaceIds,
    implementation:
      params.tool.toolType === 'http'
        ? {
            mode: isStudioTestApi ? 'studio_test_api' : 'external',
            endpoint: httpForm?.endpoint ?? null,
            method: httpForm?.method ?? null,
            studioTestEndpoint:
              params.endpoint && endpointUrls
                ? {
                    status: params.endpoint.status,
                    invokeUrl: endpointUrls.invokeUrl,
                    specUrl: endpointUrls.specUrl,
                    active: isStudioTestApi,
                  }
                : null,
          }
        : { mode: params.tool.toolType },
    readiness: {
      overallReady,
      missingEnvKeys,
      missingConfigKeys,
      envRequirements,
      configRequirements,
      auth: {
        required: Boolean(authProfileRef),
        reference: authProfileRef,
        source: authProfileConfigKey ? 'config_template' : 'direct',
        configKey: authProfileConfigKey,
        configuredValue: authProfileFromConfig?.value ?? null,
        ready: authReady,
        resolvedProfile:
          resolvedAuthProfile && authReady
            ? {
                id: resolvedAuthProfile.id,
                name: resolvedAuthProfile.name,
                status: resolvedAuthProfile.status,
                authType: resolvedAuthProfile.authType,
              }
            : null,
      },
    },
    impactedAgents: params.impactedAgents,
  };
}

async function loadProjectReadiness(ctx: ToolPermissionContext): Promise<{
  tools: ToolReadinessDetail[];
  agents: AgentRecord[];
  authProfiles: AuthProfileRecord[];
  activeDraft: unknown;
}> {
  const { ensureDb } = await import('@/lib/ensure-db');
  const { getProjectAgents } = await import('@/services/project-service');
  const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');
  await ensureDb();

  const {
    ToolTestEndpoint,
    AuthProfile,
    EnvironmentVariable,
    ProjectConfigVariable,
    VariableNamespaceMembership,
  } = await import('@agent-platform/database/models');

  const [
    toolsResult,
    agentsRaw,
    endpointDocs,
    envDocs,
    configDocs,
    membershipDocs,
    authProfileDocs,
  ] = await Promise.all([
    findProjectToolsByProject(ctx.user.tenantId, ctx.projectId),
    getProjectAgents(ctx.projectId, ctx.user.tenantId),
    ToolTestEndpoint.find(
      { tenantId: ctx.user.tenantId, projectId: ctx.projectId },
      { projectToolId: 1, invokeCapability: 1, specCapability: 1, status: 1 },
    ).lean(),
    EnvironmentVariable.find(
      { tenantId: ctx.user.tenantId, projectId: ctx.projectId },
      { _id: 1, key: 1, environment: 1 },
    ).lean(),
    ProjectConfigVariable.find(
      { tenantId: ctx.user.tenantId, projectId: ctx.projectId },
      { _id: 1, key: 1, value: 1 },
    ).lean(),
    VariableNamespaceMembership.find(
      { tenantId: ctx.user.tenantId, projectId: ctx.projectId },
      { variableId: 1, namespaceId: 1, variableType: 1 },
    ).lean(),
    AuthProfile.find(
      {
        tenantId: ctx.user.tenantId,
        $and: [
          {
            $or: [{ projectId: ctx.projectId }, { projectId: null, scope: 'tenant' }],
          },
          {
            $or: [{ visibility: 'shared' }, { createdBy: ctx.user.userId }],
          },
        ],
      },
      {
        _id: 1,
        name: 1,
        authType: 1,
        status: 1,
        projectId: 1,
        scope: 1,
        visibility: 1,
        connectionMode: 1,
      },
    ).lean(),
  ]);

  const agents: AgentRecord[] = (agentsRaw as Record<string, unknown>[]).map((agent) => ({
    name: String(agent.name ?? ''),
    description: typeof agent.description === 'string' ? agent.description : null,
    dslContent: typeof agent.dslContent === 'string' ? agent.dslContent : null,
  }));
  const tools = toolsResult.data.map(toToolRecord);
  const endpoints = new Map<string, ToolEndpointRecord>(
    (endpointDocs as Record<string, unknown>[]).map((endpoint) => [
      String(endpoint.projectToolId),
      {
        projectToolId: String(endpoint.projectToolId),
        invokeCapability: String(endpoint.invokeCapability),
        specCapability: String(endpoint.specCapability),
        status: String(endpoint.status),
      },
    ]),
  );
  const envVars: EnvVarRecord[] = (envDocs as Record<string, unknown>[]).map((envVar) => ({
    id: String(envVar._id ?? ''),
    key: String(envVar.key ?? '').toUpperCase(),
    environment: String(envVar.environment ?? ''),
  }));
  const configVars: ConfigVarRecord[] = (configDocs as Record<string, unknown>[]).map(
    (configVar) => ({
      id: String(configVar._id ?? ''),
      key: String(configVar.key ?? '').toUpperCase(),
      value: String(configVar.value ?? ''),
    }),
  );
  const memberships: MembershipRecord[] = (membershipDocs as Record<string, unknown>[]).map(
    (membership) => ({
      variableId: String(membership.variableId ?? ''),
      namespaceId: String(membership.namespaceId ?? ''),
      variableType: membership.variableType === 'config' ? 'config' : 'env',
    }),
  );
  const authProfiles: AuthProfileRecord[] = (authProfileDocs as Record<string, unknown>[]).map(
    (profile) => ({
      id: String(profile._id ?? ''),
      name: String(profile.name ?? ''),
      authType: String(profile.authType ?? ''),
      status: String(profile.status ?? ''),
      inherited: profile.projectId === null,
      scope: String(profile.scope ?? ''),
      visibility: String(profile.visibility ?? ''),
      connectionMode: String(profile.connectionMode ?? ''),
    }),
  );

  const impactedAgentMap = buildImpactedAgentMap(agents);
  const envMemberships = buildNamespaceMembershipMap(memberships, 'env');
  const configMemberships = buildNamespaceMembershipMap(memberships, 'config');
  const toolDetails = tools.map((tool) =>
    resolveToolReadiness({
      tool,
      endpoint: endpoints.get(tool.id) ?? null,
      envVars,
      envMemberships,
      configVars,
      configMemberships,
      authProfiles,
      impactedAgents: impactedAgentMap.get(tool.name) ?? [],
    }),
  );

  const activeDraft = ctx.sessionId
    ? await import('@/lib/arch-ai/integration-draft-service').then(
        ({ getActiveIntegrationDraftForSession }) =>
          getActiveIntegrationDraftForSession({
            tenantId: ctx.user.tenantId,
            projectId: ctx.projectId,
            sessionId: ctx.sessionId!,
          }),
      )
    : null;

  return {
    tools: toolDetails,
    agents,
    authProfiles,
    activeDraft,
  };
}

export async function executePlatformContext(
  input: PlatformContextInput,
  ctx: ToolPermissionContext,
): Promise<PlatformContextResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('platform_context', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    switch (action) {
      case 'get_summary':
        return getSummary(ctx);
      case 'list_agents':
        return listAgents(projectId, tenantId);
      case 'list_models':
        return listModels(tenantId, ctx.authToken);
      case 'list_tools':
        return listTools(ctx);
      case 'list_channels':
        return listChannels(projectId, tenantId);
      case 'list_auth_profiles':
        return listAuthProfiles(ctx);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Platform context action failed', { action, projectId, error: message });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}

async function getSummary(ctx: ToolPermissionContext): Promise<PlatformContextResult> {
  const cacheKey = getProjectCacheKey(ctx, 'get_summary');
  if (shouldUseProjectCache(ctx)) {
    const cached = projectCache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }
  }

  const { ensureDb } = await import('@/lib/ensure-db');
  await ensureDb();
  const { ChannelConnection, ArchIntegrationDraft } =
    await import('@agent-platform/database/models');

  const readiness = await loadProjectReadiness(ctx);
  const channelCount = await ChannelConnection.countDocuments({
    projectId: ctx.projectId,
    tenantId: ctx.user.tenantId,
  });
  const activeDraftCount = await ArchIntegrationDraft.countDocuments({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    status: { $in: ACTIVE_DRAFT_STATUSES },
  });

  const readyToolCount = readiness.tools.filter((tool) =>
    Boolean((tool.readiness as { overallReady?: boolean }).overallReady),
  ).length;
  const data = {
    agentCount: readiness.agents.length,
    toolCount: readiness.tools.length,
    readyToolCount,
    needsSetupToolCount: readiness.tools.length - readyToolCount,
    channelCount,
    guardrailCount: 0,
    agentNames: readiness.agents.map((agent) => agent.name),
    activeIntegrationDraft: readiness.activeDraft,
    activeIntegrationDraftCount: activeDraftCount,
  };

  if (shouldUseProjectCache(ctx)) {
    projectCache.set(cacheKey, data);
  }
  return { success: true, data };
}

async function listAgents(projectId: string, tenantId: string): Promise<PlatformContextResult> {
  const cacheKey = `${tenantId}:${projectId}:list_agents`;
  const cached = projectCache.get(cacheKey);
  if (cached) {
    return { success: true, data: cached };
  }

  const { getProjectAgents } = await import('@/services/project-service');
  const agents = await getProjectAgents(projectId, tenantId);

  const data = {
    agents: (agents as Record<string, unknown>[]).map((agent) => ({
      name: agent.name,
      description: agent.description ?? null,
    })),
  };

  projectCache.set(cacheKey, data);
  return { success: true, data };
}

async function listModels(tenantId: string, authToken?: string): Promise<PlatformContextResult> {
  const cacheKey = `${tenantId}:models`;
  const cached = modelsCache.get(cacheKey);
  if (cached) {
    return { success: true, data: cached };
  }

  if (!authToken) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for model listing' },
    };
  }

  const url = `${getStudioBaseUrl()}/api/tenant-models`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    return {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: `Failed to fetch tenant models: ${response.status}`,
      },
    };
  }

  const body = await response.json();
  const data = { models: body.data ?? body };
  modelsCache.set(cacheKey, data, MODELS_CACHE_TTL);
  return { success: true, data };
}

async function listTools(ctx: ToolPermissionContext): Promise<PlatformContextResult> {
  const cacheKey = getProjectCacheKey(ctx, 'list_tools');
  if (shouldUseProjectCache(ctx)) {
    const cached = projectCache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }
  }

  const readiness = await loadProjectReadiness(ctx);
  const data = {
    tools: readiness.tools,
    activeIntegrationDraft: readiness.activeDraft,
  };

  if (shouldUseProjectCache(ctx)) {
    projectCache.set(cacheKey, data);
  }
  return { success: true, data };
}

async function listChannels(projectId: string, tenantId: string): Promise<PlatformContextResult> {
  const cacheKey = `${tenantId}:${projectId}:list_channels`;
  const cached = projectCache.get(cacheKey);
  if (cached) {
    return { success: true, data: cached };
  }

  const { ensureDb } = await import('@/lib/ensure-db');
  await ensureDb();
  const { ChannelConnection } = await import('@agent-platform/database/models');

  const channels = await ChannelConnection.find(
    { projectId, tenantId },
    { name: 1, channelType: 1 },
  ).lean();
  const data = {
    channels: (channels as Record<string, unknown>[]).map((channel) => ({
      name: channel.name ?? null,
      type: channel.channelType ?? null,
    })),
  };

  projectCache.set(cacheKey, data);
  return { success: true, data };
}

async function listAuthProfiles(ctx: ToolPermissionContext): Promise<PlatformContextResult> {
  const cacheKey = `${ctx.user.tenantId}:${ctx.projectId}:list_auth_profiles`;
  if (shouldUseProjectCache(ctx)) {
    const cached = projectCache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }
  }

  const readiness = await loadProjectReadiness(ctx);
  const data = { authProfiles: readiness.authProfiles };

  if (shouldUseProjectCache(ctx)) {
    projectCache.set(cacheKey, data);
  }
  return { success: true, data };
}
