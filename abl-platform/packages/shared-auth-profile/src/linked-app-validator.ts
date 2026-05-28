/**
 * Validates that a linkedAppProfileId references a valid, active oauth2_app
 * profile within the same tenant. Used during oauth2_token create and update.
 */
import { createLogger } from '@agent-platform/shared-observability';
import { AuthProfileError } from './errors.js';

const log = createLogger('linked-app-validator');

export { AuthProfileError };

export interface ValidateLinkedAppParams {
  linkedAppProfileId: string;
  tenantId: string;
  requiredScope?: 'tenant' | 'project';
  requiredVisibility?: 'shared' | 'personal';
  requiredProjectId?: string | null;
  requiredOwnerId?: string;
}

export interface ValidateResolvedOAuth2TokenLinkedAppParams {
  profileId?: string;
  tenantId: string;
  linkedAppProfileId?: string | null;
  scope?: 'tenant' | 'project';
  visibility?: 'shared' | 'personal';
  projectId?: string | null;
  createdBy?: string;
}

function resolveRequiredProjectId(params: {
  requiredScope?: 'tenant' | 'project';
  requiredProjectId?: string | null;
}): string | null | undefined {
  if (params.requiredScope === 'project') {
    if (typeof params.requiredProjectId !== 'string' || params.requiredProjectId.length === 0) {
      throw new AuthProfileError(
        'AUTH_PROFILE_VALIDATION_FAILED',
        'Project-scoped linked OAuth app validation requires a projectId.',
      );
    }

    return params.requiredProjectId;
  }

  if (params.requiredScope === 'tenant') {
    return null;
  }

  return params.requiredProjectId;
}

function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(String(expiresAt)).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export async function validateLinkedAppProfile(params: ValidateLinkedAppParams): Promise<{
  _id: string;
  authType: string;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  scope?: 'tenant' | 'project';
  visibility?: 'shared' | 'personal';
  projectId?: string | null;
  createdBy?: string;
}> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const requiredProjectId = resolveRequiredProjectId(params);

  const profile = await AuthProfile.findOne({
    _id: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  if (!profile) {
    throw new AuthProfileError(
      'AUTH_PROFILE_CROSS_TENANT_LINK',
      'Linked OAuth app must belong to the same tenant.',
    );
  }

  if (profile.authType !== 'oauth2_app') {
    throw new AuthProfileError(
      'AUTH_PROFILE_INCOMPATIBLE_TYPE',
      `linkedAppProfileId must reference a profile with authType 'oauth2_app'. Got '${profile.authType}'.`,
    );
  }

  if (profile.status !== 'active') {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `OAuth app profile is not active (status: ${profile.status}).`,
    );
  }

  if (isExpired(profile.expiresAt)) {
    throw new AuthProfileError(
      'AUTH_PROFILE_EXPIRED',
      'OAuth app profile has expired. Re-authorize or replace the linked app profile.',
    );
  }

  if (params.requiredScope && profile.scope !== params.requiredScope) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `Linked OAuth app must use scope '${params.requiredScope}'.`,
    );
  }

  if (params.requiredVisibility && profile.visibility !== params.requiredVisibility) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `Linked OAuth app must use visibility '${params.requiredVisibility}'.`,
    );
  }

  if (requiredProjectId !== undefined) {
    const expectedProjectId = requiredProjectId;
    const actualProjectId = profile.projectId ?? null;
    if (actualProjectId !== expectedProjectId) {
      throw new AuthProfileError(
        'AUTH_PROFILE_VALIDATION_FAILED',
        expectedProjectId
          ? 'Linked OAuth app must belong to the same project.'
          : 'Linked OAuth app must be workspace-scoped.',
      );
    }
  }

  if (params.requiredOwnerId !== undefined && profile.createdBy !== params.requiredOwnerId) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Linked OAuth app must belong to the same owner.',
    );
  }

  log.debug('Linked app profile validated', {
    linkedAppProfileId: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  return profile;
}

export async function validateResolvedOAuth2TokenLinkedApp(
  params: ValidateResolvedOAuth2TokenLinkedAppParams,
) {
  if (typeof params.linkedAppProfileId !== 'string' || params.linkedAppProfileId.length === 0) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'oauth2_token profiles must reference linkedAppProfileId.',
    );
  }

  if (params.scope !== 'tenant' && params.scope !== 'project') {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `Resolved oauth2_token profile "${params.profileId ?? 'unknown'}" has an invalid scope.`,
    );
  }

  if (params.visibility !== 'shared' && params.visibility !== 'personal') {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `Resolved oauth2_token profile "${params.profileId ?? 'unknown'}" has an invalid visibility.`,
    );
  }

  if (
    params.visibility === 'personal' &&
    (typeof params.createdBy !== 'string' || params.createdBy.length === 0)
  ) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `Resolved oauth2_token profile "${params.profileId ?? 'unknown'}" is missing createdBy for personal visibility validation.`,
    );
  }

  return validateLinkedAppProfile({
    linkedAppProfileId: params.linkedAppProfileId,
    tenantId: params.tenantId,
    requiredScope: params.scope,
    requiredVisibility: params.visibility,
    requiredProjectId: params.scope === 'tenant' ? null : params.projectId,
    requiredOwnerId: params.visibility === 'personal' ? params.createdBy : undefined,
  });
}
