import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createTTLCache } from './cache';
import {
  registerProjectConfigCache,
  invalidateProjectCaches,
  invalidateSettingsCache,
} from './cache-invalidation';

const log = createLogger('arch-ai:project-config');

/** 5 min TTL — same as platform-context */
const CACHE_TTL = 5 * 60 * 1000;

const configCache = createTTLCache<unknown>(200, CACHE_TTL);

// Register for cross-module invalidation
registerProjectConfigCache(configCache);

interface ProjectConfigInput {
  action: string;
  name?: string;
  description?: string | null;
  entryAgentName?: string | null;
  messageRetentionDays?: number | null;
  language?: string;
  enableThinking?: boolean;
  thinkingBudget?: number | null;
  thoughtDescription?: string | null;
  confirmed?: boolean;
}

interface ProjectConfigResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; availableAgents?: string[] };
  needsConfirmation?: boolean;
  warning?: string;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

export async function executeProjectConfig(
  input: ProjectConfigInput,
  ctx: ToolPermissionContext,
): Promise<ProjectConfigResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('project_config', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    switch (action) {
      case 'get_config':
        return getConfig(projectId, tenantId);
      case 'update_config':
        return updateConfig(projectId, tenantId, input);
      case 'get_settings':
        return getSettings(projectId, tenantId, ctx.authToken);
      case 'update_settings':
        return updateSettings(projectId, tenantId, input, ctx.authToken);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Project config action failed', { action, projectId, error: message });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}

// ---------------------------------------------------------------------------
// get_config
// ---------------------------------------------------------------------------

async function getConfig(projectId: string, tenantId: string): Promise<ProjectConfigResult> {
  const cacheKey = `${tenantId}:${projectId}:get_config`;
  const cached = configCache.get(cacheKey);
  if (cached) return { success: true, data: cached };

  const { getProjectById } = await import('@/services/project-service');
  const project = await getProjectById(projectId, tenantId);
  if (!project) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } };
  }

  const data = {
    name: project.name,
    description: project.description ?? null,
    entryAgentName: project.entryAgentName ?? null,
    messageRetentionDays: project.messageRetentionDays ?? null,
    language: project.language ?? null,
    kind: project.kind,
    channels: project.channels ?? [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };

  configCache.set(cacheKey, data);
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// update_config
// ---------------------------------------------------------------------------

async function updateConfig(
  projectId: string,
  tenantId: string,
  input: ProjectConfigInput,
): Promise<ProjectConfigResult> {
  const update: Partial<import('@/services/project-service').UpdateProjectInput> = {};

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed || trimmed.length > 100) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'name must be 1-100 non-whitespace characters' },
      };
    }
    update.name = trimmed;
  }

  if (input.description !== undefined) {
    update.description = input.description;
  }

  if (input.messageRetentionDays !== undefined) {
    if (
      input.messageRetentionDays !== null &&
      (!Number.isInteger(input.messageRetentionDays) || input.messageRetentionDays <= 0)
    ) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'messageRetentionDays must be a positive integer or null',
        },
      };
    }
    update.messageRetentionDays = input.messageRetentionDays;
  }

  if (input.language !== undefined) {
    update.language = input.language;
  }

  if (input.entryAgentName !== undefined) {
    if (input.entryAgentName !== null) {
      const { getProjectAgents } = await import('@/services/project-service');
      const agents = await getProjectAgents(projectId, tenantId);
      const agentNames = (agents as Record<string, unknown>[]).map((a) => a.name as string);
      if (!agentNames.includes(input.entryAgentName)) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: `Agent "${input.entryAgentName}" not found in project`,
            availableAgents: agentNames,
          },
        };
      }
    }
    update.entryAgentName = input.entryAgentName;
  }

  if (Object.keys(update).length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No fields to update' },
    };
  }

  const { updateProject } = await import('@/services/project-service');
  const updated = await updateProject(projectId, update, tenantId);
  if (!updated) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found or was deleted' },
    };
  }

  invalidateProjectCaches(tenantId, projectId);

  return {
    success: true,
    data: {
      name: updated.name,
      description: updated.description ?? null,
      entryAgentName: updated.entryAgentName ?? null,
      messageRetentionDays: updated.messageRetentionDays ?? null,
      language: updated.language ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// get_settings
// ---------------------------------------------------------------------------

async function getSettings(
  projectId: string,
  tenantId: string,
  authToken?: string,
): Promise<ProjectConfigResult> {
  const cacheKey = `${tenantId}:${projectId}:get_settings`;
  const cached = configCache.get(cacheKey);
  if (cached) return { success: true, data: cached };

  if (!authToken) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for settings' },
    };
  }

  const url = `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/settings`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: `Failed to fetch settings: ${response.status}` },
    };
  }

  const body = await response.json();
  const raw = body.data ?? body;

  const data = {
    enableThinking: raw.enableThinking ?? false,
    thinkingBudget: raw.thinkingBudget ?? null,
    thoughtDescription: raw.thoughtDescription ?? null,
  };

  configCache.set(cacheKey, data);
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// update_settings
// ---------------------------------------------------------------------------

async function updateSettings(
  projectId: string,
  tenantId: string,
  input: ProjectConfigInput,
  authToken?: string,
): Promise<ProjectConfigResult> {
  if (!input.confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      warning: 'Changing thinking settings affects runtime behavior. Confirm?',
    };
  }

  if (!authToken) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for settings' },
    };
  }

  const payload: Record<string, unknown> = {};
  if (input.enableThinking !== undefined) payload.enableThinking = input.enableThinking;
  if (input.thinkingBudget !== undefined) payload.thinkingBudget = input.thinkingBudget;
  if (input.thoughtDescription !== undefined) payload.thoughtDescription = input.thoughtDescription;

  if (Object.keys(payload).length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No settings fields to update' },
    };
  }

  const url = `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/settings`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const message =
      (errBody as Record<string, unknown>)?.error ??
      `Failed to update settings: ${response.status}`;
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: String(message) },
    };
  }

  const result = await response.json();
  log.info('Project settings updated', { projectId, fields: Object.keys(payload) });

  invalidateSettingsCache(tenantId, projectId);

  return { success: true, data: result.data ?? result };
}
