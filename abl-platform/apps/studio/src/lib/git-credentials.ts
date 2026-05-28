import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ResolvedCredentials } from '@agent-platform/project-io/git';

const log = createLogger('git-credentials');

interface GitCredentialResolutionContext {
  projectId?: string | null;
  userId?: string | null;
}

interface AuthProfileForGitCredentials {
  _id: string;
  tenantId: string;
  projectId?: string | null;
  scope?: string;
  createdBy?: string;
  status?: string;
  authType?: string;
  encryptedSecrets?: string | Record<string, unknown> | null;
}

const GIT_AUTH_PROFILE_TYPES = new Set(['bearer', 'api_key', 'oauth2_token']);
const GENERIC_AUTH_PROFILE_ERROR = 'Auth profile cannot be used for git credentials';
const AUTH_PROFILE_REQUIRED_ERROR = 'Git integration requires an auth profile';

/**
 * Resolve encrypted git credentials to usable tokens.
 *
 * Git integrations are auth-profile only. The older secretId credential lane
 * was never a working setup path and is intentionally unsupported.
 */
export async function resolveGitCredentials(
  authProfileId: string | null | undefined,
  tenantId: string,
  projectIdOrContext?: string | GitCredentialResolutionContext | null,
): Promise<ResolvedCredentials> {
  if (!authProfileId) {
    throw new Error(AUTH_PROFILE_REQUIRED_ERROR);
  }

  const { AuthProfile } = await import('@agent-platform/database/models');
  const context =
    typeof projectIdOrContext === 'string'
      ? { projectId: projectIdOrContext }
      : (projectIdOrContext ?? {});
  const profileQuery: Record<string, unknown> = {
    _id: authProfileId,
    tenantId,
    status: 'active',
  };

  if (context.projectId) {
    profileQuery.$or = [{ projectId: context.projectId }, { projectId: null, scope: 'tenant' }];
  }

  const profile = (await (AuthProfile as any).findOne(
    profileQuery,
  )) as AuthProfileForGitCredentials | null;

  if (!profile) {
    throw new Error(GENERIC_AUTH_PROFILE_ERROR);
  }

  if (profile.scope === 'personal') {
    throw new Error(GENERIC_AUTH_PROFILE_ERROR);
  }

  if (!profile.authType || !GIT_AUTH_PROFILE_TYPES.has(profile.authType)) {
    throw new Error(`Auth profile type is not supported for git credentials`);
  }

  let secrets: Record<string, unknown>;
  if (typeof profile.encryptedSecrets === 'string') {
    try {
      secrets = JSON.parse(profile.encryptedSecrets);
    } catch {
      throw new Error(GENERIC_AUTH_PROFILE_ERROR);
    }
  } else {
    secrets = profile.encryptedSecrets ?? {};
  }

  const token =
    (secrets.token as string) ??
    (secrets.accessToken as string) ??
    (secrets.apiKey as string) ??
    '';

  if (!token) {
    throw new Error(GENERIC_AUTH_PROFILE_ERROR);
  }

  log.debug('Git credentials resolved from auth profile', {
    source: 'auth-profile',
    authType: profile.authType,
  });
  return parseGitToken(token);
}

/**
 * Parse a raw git token value into ResolvedCredentials.
 * Handles Bitbucket "username:token" and "email:token" formats.
 */
function parseGitToken(raw: string): ResolvedCredentials {
  // For Bitbucket credentials, the value may be "username:token" or "email:api_token"
  if (raw.includes(':')) {
    const colonIndex = raw.indexOf(':');
    const identity = raw.slice(0, colonIndex);
    const token = raw.slice(colonIndex + 1);

    // If identity looks like an email, use the new API token auth path
    if (identity.includes('@')) {
      return { email: identity, token };
    }
    // TODO(legacy-cleanup): Legacy app-password auth (username:appPassword)
    return { username: identity, token };
  }

  return { token: raw };
}
