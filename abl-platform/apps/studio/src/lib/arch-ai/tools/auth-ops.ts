import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { consumeFlowSecrets } from './secret-store';
import { invalidateProjectCaches } from './cache-invalidation';

const log = createLogger('arch-ai:auth-ops');

const SUPPORTED_AUTH_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
  'basic',
  'custom_header',
  'digest',
  'azure_ad',
  'none',
] as const;
type SupportedAuthType = (typeof SUPPORTED_AUTH_TYPES)[number];

// Mirrors AUTH_TYPE_METADATA[<type>].secretFields[].key in
// apps/studio/src/components/auth-profiles/auth-type-metadata.ts.
// Keep these arrays in sync when the metadata source-of-truth changes.
const REQUIRED_SECRETS: Record<SupportedAuthType, string[]> = {
  api_key: ['apiKey'],
  bearer: ['token'],
  oauth2_app: ['clientId', 'clientSecret'],
  oauth2_client_credentials: ['clientId', 'clientSecret'],
  basic: ['username', 'password'],
  custom_header: ['headerValues'],
  digest: ['username', 'password'],
  azure_ad: ['clientId', 'clientSecret'],
  none: [],
};

interface AuthOpsInput {
  action: string;
  profileId?: string;
  profileName?: string;
  authType?: string;
  config?: Record<string, unknown>;
  flowId?: string;
  confirmed?: boolean;
}

interface AuthOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsSecrets?: boolean;
  flowId?: string;
  requiredSecrets?: string[];
  message?: string;
  needsConfirmation?: boolean;
  warning?: string;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function isSupportedAuthType(t: string): t is SupportedAuthType {
  return (SUPPORTED_AUTH_TYPES as readonly string[]).includes(t);
}

function missing(param: string, action: string): AuthOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

function translateConfig(
  authType: SupportedAuthType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (authType === 'oauth2_app') {
    const { scopes, ...rest } = config;
    return scopes ? { ...rest, defaultScopes: scopes } : rest;
  }
  return { ...config };
}

function buildCreatePayload(
  input: AuthOpsInput,
  secrets: Record<string, string>,
  ctx: ToolPermissionContext,
): Record<string, unknown> {
  const authType = input.authType as SupportedAuthType;
  const config = translateConfig(authType, input.config ?? {});
  const connectionMode = authType === 'oauth2_app' ? 'per_user' : 'shared';

  return {
    name: input.profileName,
    authType,
    config,
    secrets,
    scope: 'project',
    projectId: ctx.projectId,
    visibility: 'shared',
    connectionMode,
  };
}

export async function executeAuthOps(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('auth_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (!ctx.authToken) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Auth token required for auth profile operations',
      },
    };
  }

  try {
    switch (action) {
      case 'list':
        return listProfiles(ctx);
      case 'read':
        if (!input.profileId) return missing('profileId', action);
        return readProfile(input.profileId, ctx);
      case 'create':
        return createProfile(input, ctx);
      case 'update':
        if (!input.profileId) return missing('profileId', action);
        return updateProfile(input, ctx);
      case 'delete': {
        if (!input.profileId) return missing('profileId', action);
        if (isDangerousAction('auth_ops', action) && !input.confirmed) {
          return {
            needsConfirmation: true,
            warning: `Delete auth profile "${input.profileId}"? Tools using it will break.`,
          };
        }
        return deleteProfile(input.profileId, ctx);
      }
      case 'validate':
        if (!input.profileId) return missing('profileId', action);
        return validateProfile(input.profileId, ctx);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('auth_ops action failed', { action, projectId: ctx.projectId, error: message });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}

// ---------------------------------------------------------------------------
// REST API helpers
// ---------------------------------------------------------------------------

async function apiFetch(
  path: string,
  ctx: ToolPermissionContext,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.authToken}`,
      ...(options?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function listProfiles(ctx: ToolPermissionContext): Promise<AuthOpsResult> {
  const res = await apiFetch('/auth-profiles?limit=50', ctx);
  if (!res.ok) {
    return {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: `Failed to list auth profiles: ${res.status}`,
      },
    };
  }
  const body = await res.json();
  return { success: true, data: body.data ?? [] };
}

async function readProfile(profileId: string, ctx: ToolPermissionContext): Promise<AuthOpsResult> {
  const res = await apiFetch(`/auth-profiles/${profileId}`, ctx);
  if (!res.ok) {
    return {
      success: false,
      error: {
        code: res.status === 404 ? 'NOT_FOUND' : 'FETCH_ERROR',
        message: `Failed to read auth profile: ${res.status}`,
      },
    };
  }
  const body = await res.json();
  return { success: true, data: body.data };
}

interface ExistingProfileSummary {
  _id: string;
  name: string;
  authType: string;
  createdBy: string;
  createdAt: Date;
}

async function findExistingProfile(query: {
  tenantId: string;
  projectId: string;
  name: string;
  visibility: 'shared' | 'personal';
  environment: string | null;
}): Promise<ExistingProfileSummary | null> {
  // NEVER findById — scope by (tenantId, projectId, name, visibility) plus
  // optional environment to mirror the unique-index partial filter.
  const { AuthProfile } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = {
    tenantId: query.tenantId,
    projectId: query.projectId,
    name: query.name,
    visibility: query.visibility,
  };
  if (query.environment !== null) filter.environment = query.environment;

  const found = await AuthProfile.findOne(filter)
    .select('_id name authType createdBy createdAt')
    .lean();
  if (!found) return null;
  const doc = found as {
    _id: unknown;
    name: string;
    authType: string;
    createdBy: string;
    createdAt: Date;
  };
  return {
    _id: String(doc._id),
    name: doc.name,
    authType: doc.authType,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  };
}

async function buildProfileNameCollisionResult(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const profileName = input.profileName ?? '';
  let existing: ExistingProfileSummary | null = null;
  try {
    existing = await findExistingProfile({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name: profileName,
      visibility: 'shared',
      environment: null,
    });
  } catch (err) {
    // Lookup failure is non-fatal — fall back to the generic collision
    // message so the caller still sees PROFILE_NAME_COLLISION instead of a
    // misleading 500.
    log.warn('Profile collision lookup failed', {
      projectId: ctx.projectId,
      profileName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!existing) {
    return {
      success: false,
      error: {
        code: 'PROFILE_NAME_COLLISION',
        message: `A profile named '${profileName}' already exists in this project.`,
      },
    };
  }

  const createdAtIso = existing.createdAt.toISOString();
  return {
    success: false,
    error: {
      code: 'PROFILE_NAME_COLLISION',
      message: `A profile named '${profileName}' already exists in this project (created by ${existing.createdBy} on ${createdAtIso.slice(0, 10)}).`,
    },
    data: {
      existingProfileId: existing._id,
      existingProfileSummary: {
        name: existing.name,
        authType: existing.authType,
        createdBy: existing.createdBy,
        createdAt: existing.createdAt,
      },
    },
  };
}

async function createProfile(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  if (!input.profileName) return missing('profileName', 'create');
  if (!input.authType) return missing('authType', 'create');

  if (!isSupportedAuthType(input.authType)) {
    return {
      success: false,
      error: {
        code: 'UNSUPPORTED_AUTH_TYPE',
        message:
          input.authType === 'oauth2_token'
            ? 'oauth2_token profiles are created automatically by the OAuth callback flow — use the OAuthLaunch widget instead.'
            : `Auth type "${input.authType}" is not supported via auth_ops. Supported: ${SUPPORTED_AUTH_TYPES.join(', ')}.`,
      },
    };
  }

  // 'none' has no secrets — skip the flowId exchange and create immediately.
  let secrets: Record<string, string> = {};
  if (input.authType !== 'none') {
    if (!input.flowId) {
      const flowId = crypto.randomUUID();
      return {
        success: false,
        needsSecrets: true,
        flowId,
        requiredSecrets: REQUIRED_SECRETS[input.authType],
        message: `Use collect_secret with flowId "${flowId}" for each required secret, then call create again with the flowId`,
      };
    }

    const consumed = await consumeFlowSecrets(input.flowId);
    if (!consumed) {
      return {
        success: false,
        error: {
          code: 'SECRETS_EXPIRED',
          message:
            'Secrets for this flow have expired or were already consumed. Start a new flow by calling create without flowId.',
        },
      };
    }
    secrets = consumed;
  }

  const payload = buildCreatePayload(input, secrets, ctx);
  const res = await apiFetch('/auth-profiles', ctx, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    if (res.status === 409) {
      return buildProfileNameCollisionResult(input, ctx);
    }
    return {
      success: false,
      error: {
        code: apiError?.code ?? 'CREATE_FAILED',
        message: apiError?.message ?? `Create failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);

  const body = await res.json();
  const data = body.data ?? {};
  const { syncActiveDraftFromAuthProfile } =
    await import('@/lib/arch-ai/integration-draft-service');
  await syncActiveDraftFromAuthProfile({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    authProfileId: data.id as string,
  });
  log.info('Auth profile created', {
    projectId: ctx.projectId,
    profileId: data.id,
    authType: input.authType,
  });
  return {
    success: true,
    data: { id: data.id, name: data.name, authType: data.authType, status: data.status },
  };
}

async function updateProfile(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const readRes = await readProfile(input.profileId!, ctx);
  if (!readRes.success) return readRes;
  if ((readRes.data as Record<string, unknown>)?.inherited) {
    return {
      success: false,
      error: {
        code: 'INHERITED_PROFILE',
        message:
          'This is a workspace-level auth profile. It can only be modified in Settings > Auth Profiles.',
      },
    };
  }

  const updatePayload: Record<string, unknown> = {};
  if (input.config) {
    const existingAuthType = (readRes.data as Record<string, unknown>)?.authType as string;
    if (existingAuthType && isSupportedAuthType(existingAuthType)) {
      updatePayload.config = translateConfig(existingAuthType, input.config);
    } else {
      updatePayload.config = input.config;
    }
  }
  if (input.profileName) updatePayload.name = input.profileName;

  if (input.flowId) {
    const secrets = await consumeFlowSecrets(input.flowId);
    if (!secrets) {
      return {
        success: false,
        error: {
          code: 'SECRETS_EXPIRED',
          message:
            'Secrets for this flow have expired or were already consumed. Start a new flow by calling update without flowId.',
        },
      };
    }
    updatePayload.secrets = secrets;
  }

  const res = await apiFetch(`/auth-profiles/${input.profileId}`, ctx, {
    method: 'PUT',
    body: JSON.stringify(updatePayload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    return {
      success: false,
      error: {
        code: apiError?.code ?? 'UPDATE_FAILED',
        message: apiError?.message ?? `Update failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  const body = await res.json();
  await import('@/lib/arch-ai/integration-draft-service').then(
    ({ syncActiveDraftFromAuthProfile }) =>
      syncActiveDraftFromAuthProfile({
        tenantId: ctx.user.tenantId,
        projectId: ctx.projectId,
        userId: ctx.user.userId,
        sessionId: ctx.sessionId,
        authProfileId: input.profileId!,
      }),
  );
  return { success: true, data: body.data };
}

async function deleteProfile(
  profileId: string,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const readRes = await readProfile(profileId, ctx);
  if (!readRes.success) return readRes;
  if ((readRes.data as Record<string, unknown>)?.inherited) {
    return {
      success: false,
      error: {
        code: 'INHERITED_PROFILE',
        message:
          'This is a workspace-level auth profile. It can only be modified in Settings > Auth Profiles.',
      },
    };
  }

  const res = await apiFetch(`/auth-profiles/${profileId}`, ctx, { method: 'DELETE' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string; consumers?: unknown } })
      .error;
    return {
      success: false,
      error: {
        code: res.status === 409 ? 'PROFILE_IN_USE' : (apiError?.code ?? 'DELETE_FAILED'),
        message: apiError?.message ?? `Delete failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  const { removeActiveDraftAuthProfile } = await import('@/lib/arch-ai/integration-draft-service');
  await removeActiveDraftAuthProfile({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    authProfileId: profileId,
  });
  log.info('Auth profile deleted', { projectId: ctx.projectId, profileId });
  return { success: true, data: { deleted: profileId } };
}

async function validateProfile(
  profileId: string,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const res = await apiFetch(`/auth-profiles/${profileId}/validate`, ctx, {
    method: 'POST',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    return {
      success: false,
      error: {
        code: apiError?.code ?? 'VALIDATE_FAILED',
        message: apiError?.message ?? `Validate failed: ${res.status}`,
      },
    };
  }

  const body = await res.json();
  return { success: true, data: body.data };
}
