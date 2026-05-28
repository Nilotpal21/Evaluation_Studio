/**
 * Stamp `revokedAt = now` on every active per-user OAuth grant for an auth
 * profile. This is the action that actually stops workflow-engine consumers
 * from handing out cached tokens — flipping `AuthProfile.status` alone is
 * not checked by the engine's grant resolver.
 *
 * Centralizing this here so the studio revoke routes (project + workspace),
 * the runtime `revokeOAuthGrantForProfile` helper, and any future caller
 * all use the same filter + update shape. Drift between these implementations
 * is the kind of bug data-flow audits exist to catch (ABLP-1123).
 */

import { buildAuthProfileOAuthProviderKey } from '@agent-platform/shared-auth-profile';

export interface EndUserTokenRevokerInput {
  /** Tenant the profile belongs to. Required for multi-tenant safety. */
  tenantId: string;
  /** AuthProfile._id (string). Used to derive the provider key. */
  profileId: string;
}

export interface EndUserTokenRevokerDeps {
  /** Mongoose model (or compatible) for `EndUserOAuthToken`. */
  tokenModel: {
    updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ modifiedCount: number }>;
  };
}

export interface EndUserTokenRevokerResult {
  /** Number of token rows that transitioned from active to revoked. */
  modifiedCount: number;
}

export async function revokeEndUserTokensForProfile(
  input: EndUserTokenRevokerInput,
  deps: EndUserTokenRevokerDeps,
): Promise<EndUserTokenRevokerResult> {
  const provider = buildAuthProfileOAuthProviderKey(input.profileId);
  const result = await deps.tokenModel.updateMany(
    { tenantId: input.tenantId, provider, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return { modifiedCount: result?.modifiedCount ?? 0 };
}
