/**
 * SSO OIDC State Store
 *
 * Delegates to sso-state-store.ts (Redis-backed when available).
 * Falls back to in-memory for backward compatibility.
 */

import {
  setOIDCState,
  consumeOIDCState as atomicConsumeOIDCState,
} from '@/services/sso/sso-state-store';
import { getConfig, isConfigLoaded } from '@/config';

function getOidcStateTtl(): number {
  if (!isConfigLoaded()) return 600;
  return getConfig().auth.sso.oidcStateTtlSeconds;
}

/**
 * Store an OIDC state parameter with its associated organization ID.
 */
export async function storeOIDCState(
  state: string,
  orgId: string,
  adminRedirect?: string,
): Promise<void> {
  await setOIDCState(
    state,
    {
      orgId,
      nonce: '',
      codeVerifier: '',
      ...(adminRedirect ? { adminRedirect } : {}),
    },
    getOidcStateTtl(),
  );
}

/**
 * Atomically consume (validate and remove) an OIDC state parameter.
 * Returns the associated orgId if valid, null otherwise.
 */
export async function consumeOIDCState(
  state: string,
): Promise<{ orgId: string; adminRedirect?: string } | null> {
  const data = await atomicConsumeOIDCState(state);
  if (!data) return null;
  return {
    orgId: data.orgId,
    ...(data.adminRedirect ? { adminRedirect: data.adminRedirect } : {}),
  };
}
