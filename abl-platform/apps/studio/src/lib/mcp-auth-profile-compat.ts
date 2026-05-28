import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('mcp-auth-profile-compat');

const MCP_INCOMPATIBLE_AUTH_TYPES = new Set([
  'aws_iam',
  'digest',
  'hawk',
  'ssh_key',
  'ws_security',
]);

interface McpAuthProfileValidationResult {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
}

interface McpAuthProfileRecord {
  _id: string;
  authType: string;
  connectionMode?: 'shared' | 'per_user';
  visibility?: 'shared' | 'personal';
  createdBy?: string;
  config?: Record<string, unknown>;
}

interface McpProfileLookupParams {
  tenantId: string;
  projectId: string;
  profileId: string;
  userId?: string;
}

async function findAccessibleMcpProfile(
  params: McpProfileLookupParams,
): Promise<McpAuthProfileRecord | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();

  const profile = (await AuthProfile.findOne({
    _id: params.profileId,
    tenantId: params.tenantId,
    status: 'active',
    $and: [
      {
        $or: [
          { projectId: params.projectId },
          { projectId: null },
          { projectId: { $exists: false } },
        ],
      },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { visibility: { $ne: 'personal' } },
    ],
  })
    .select('_id authType connectionMode visibility createdBy config')
    .lean()) as McpAuthProfileRecord | null;

  return profile;
}

export async function validateMcpAuthProfileCompatibility(params: {
  tenantId: string;
  projectId: string;
  authProfileId: string;
  transport: 'http' | 'sse';
  userId?: string;
}): Promise<McpAuthProfileValidationResult> {
  const profile = await findAccessibleMcpProfile({
    tenantId: params.tenantId,
    projectId: params.projectId,
    profileId: params.authProfileId,
    userId: params.userId,
  });

  if (!profile) {
    return {
      ok: false,
      status: 404,
      code: 'AUTH_PROFILE_NOT_FOUND',
      message: 'Auth profile not found',
    };
  }

  if (MCP_INCOMPATIBLE_AUTH_TYPES.has(profile.authType)) {
    return {
      ok: false,
      status: 400,
      code: 'AUTH_TYPE_NOT_MCP_COMPATIBLE',
      message: `Auth type "${profile.authType}" is not compatible with MCP server auth`,
    };
  }

  if (profile.authType === 'api_key' && profile.config?.placement === 'query') {
    return {
      ok: false,
      status: 400,
      code: 'AUTH_TYPE_NOT_MCP_COMPATIBLE',
      message: 'api_key auth with query placement is not compatible with MCP server auth',
    };
  }

  if (profile.connectionMode === 'per_user') {
    return {
      ok: false,
      status: 400,
      code: 'AUTH_PROFILE_PER_USER_IN_MCP',
      message: 'Per-user auth profiles are not supported for MCP server auth',
    };
  }

  if (profile.authType === 'mtls' && params.transport === 'sse') {
    return {
      ok: false,
      status: 400,
      code: 'MCP_TRANSPORT_NOT_TLS_CAPABLE',
      message: 'mTLS auth profiles require HTTP transport',
    };
  }

  log.debug('MCP auth profile compatibility validated', {
    authProfileId: profile._id,
    authType: profile.authType,
    transport: params.transport,
  });

  return { ok: true };
}

export async function validateMcpEnvProfileCompatibility(params: {
  tenantId: string;
  projectId: string;
  envProfileId: string;
  userId?: string;
}): Promise<McpAuthProfileValidationResult> {
  const profile = await findAccessibleMcpProfile({
    tenantId: params.tenantId,
    projectId: params.projectId,
    profileId: params.envProfileId,
    userId: params.userId,
  });

  if (!profile) {
    return {
      ok: false,
      status: 404,
      code: 'AUTH_PROFILE_NOT_FOUND',
      message: 'Auth profile not found',
    };
  }

  log.debug('MCP env profile compatibility validated', {
    authProfileId: profile._id,
    authType: profile.authType,
  });

  return { ok: true };
}
