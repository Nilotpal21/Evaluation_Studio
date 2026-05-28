/**
 * Validates auth profile update payloads.
 * - Prevents authType mutation
 * - Re-validates linkedAppProfileId if changed on oauth2_token profiles
 */
import { validateLinkedAppProfile, AuthProfileError } from './linked-app-validator.js';

export interface ValidateUpdateParams {
  existingProfile: {
    authType: string;
    tenantId: string;
    linkedAppProfileId?: string;
    scope?: 'tenant' | 'project';
    visibility?: 'shared' | 'personal';
    projectId?: string | null;
    createdBy?: string;
  };
  updatePayload: Record<string, unknown>;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseScope(value: unknown): 'tenant' | 'project' | undefined {
  if (value === undefined) return undefined;
  if (value === 'tenant' || value === 'project') return value;
  throw new AuthProfileError(
    'AUTH_PROFILE_VALIDATION_FAILED',
    'Profile scope must be tenant or project.',
  );
}

function parseVisibility(value: unknown): 'shared' | 'personal' | undefined {
  if (value === undefined) return undefined;
  if (value === 'shared' || value === 'personal') return value;
  throw new AuthProfileError(
    'AUTH_PROFILE_VALIDATION_FAILED',
    'Profile visibility must be shared or personal.',
  );
}

function parseProjectId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AuthProfileError(
    'AUTH_PROFILE_VALIDATION_FAILED',
    'Profile projectId must be a non-empty string or null.',
  );
}

function parseOwnerId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AuthProfileError(
    'AUTH_PROFILE_VALIDATION_FAILED',
    'Profile owner must be a non-empty string.',
  );
}

function parseLinkedAppProfileId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AuthProfileError(
    'AUTH_PROFILE_VALIDATION_FAILED',
    'linkedAppProfileId must be a non-empty string or null.',
  );
}

export async function validateAuthProfileUpdate(params: ValidateUpdateParams): Promise<void> {
  const { existingProfile, updatePayload } = params;
  const hasLinkedAppUpdate = hasOwn(updatePayload, 'linkedAppProfileId');

  // Prevent authType mutation
  if (updatePayload.authType && updatePayload.authType !== existingProfile.authType) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'authType cannot be changed after creation. Create a new profile instead.',
    );
  }

  if (hasLinkedAppUpdate && existingProfile.authType !== 'oauth2_token') {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'linkedAppProfileId is only valid for oauth2_token profiles.',
    );
  }

  if (existingProfile.authType !== 'oauth2_token') {
    return;
  }

  const hasScopeUpdate = hasOwn(updatePayload, 'scope');
  const hasVisibilityUpdate = hasOwn(updatePayload, 'visibility');
  const hasProjectIdUpdate = hasOwn(updatePayload, 'projectId');
  const hasCreatedByUpdate = hasOwn(updatePayload, 'createdBy');

  const effectiveLinkedAppProfileId = parseLinkedAppProfileId(
    hasLinkedAppUpdate ? updatePayload.linkedAppProfileId : existingProfile.linkedAppProfileId,
  );
  const effectiveScope = parseScope(hasScopeUpdate ? updatePayload.scope : existingProfile.scope);
  const effectiveVisibility = parseVisibility(
    hasVisibilityUpdate ? updatePayload.visibility : existingProfile.visibility,
  );
  const effectiveProjectId = parseProjectId(
    hasProjectIdUpdate ? updatePayload.projectId : existingProfile.projectId,
  );
  const effectiveOwnerId = parseOwnerId(
    hasCreatedByUpdate ? updatePayload.createdBy : existingProfile.createdBy,
  );

  if (!effectiveLinkedAppProfileId) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'oauth2_token profiles must reference linkedAppProfileId.',
    );
  }

  if (!effectiveScope) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Cannot validate linked OAuth app scope without profile scope context.',
    );
  }

  if (!effectiveVisibility) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Cannot validate linked OAuth app visibility without profile visibility context.',
    );
  }

  if (effectiveScope === 'project' && !effectiveProjectId) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Project-scoped oauth2_token profiles require a projectId for linked-app validation.',
    );
  }

  if (effectiveVisibility === 'personal' && !effectiveOwnerId) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Cannot validate linked OAuth app ownership without profile owner context.',
    );
  }

  const linkedAppChanged =
    hasLinkedAppUpdate && effectiveLinkedAppProfileId !== existingProfile.linkedAppProfileId;
  const scopeChanged = hasScopeUpdate && effectiveScope !== existingProfile.scope;
  const visibilityChanged =
    hasVisibilityUpdate && effectiveVisibility !== existingProfile.visibility;
  const projectChanged = hasProjectIdUpdate && effectiveProjectId !== existingProfile.projectId;
  const ownerChanged = hasCreatedByUpdate && effectiveOwnerId !== existingProfile.createdBy;

  if (
    !linkedAppChanged &&
    !scopeChanged &&
    !visibilityChanged &&
    !projectChanged &&
    !ownerChanged
  ) {
    return;
  }

  await validateLinkedAppProfile({
    linkedAppProfileId: effectiveLinkedAppProfileId,
    tenantId: existingProfile.tenantId,
    requiredScope: effectiveScope,
    requiredVisibility: effectiveVisibility,
    requiredProjectId: effectiveScope === 'project' ? effectiveProjectId : null,
    requiredOwnerId: effectiveVisibility === 'personal' ? effectiveOwnerId : undefined,
  });
}
