/**
 * SSO Auth Code Store
 *
 * Delegates to sso-state-store.ts (Redis-backed when available).
 * Falls back to in-memory for backward compatibility.
 */

import {
  setAuthCode as setAuthCodeInStore,
  consumeAuthCode as consumeAuthCodeFromStore,
  type AuthCodeData as StoreAuthCodeData,
} from '@/services/sso/sso-state-store';
import { getConfig, isConfigLoaded } from '@/config';

export interface AuthCodeData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  needsOnboarding?: boolean;
  pendingInvitations?: number;
  pendingInvitationChoice?: boolean;
  inviteToken?: string;
}

function getAuthCodeTtl(): number {
  if (!isConfigLoaded()) return 60;
  return getConfig().auth.sso.authCodeTtlSeconds;
}

export async function storeAuthCode(code: string, data: AuthCodeData): Promise<void> {
  const storeData: StoreAuthCodeData = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
    needsOnboarding: data.needsOnboarding,
    pendingInvitations: data.pendingInvitations,
    pendingInvitationChoice: data.pendingInvitationChoice,
    inviteToken: data.inviteToken,
  };
  await setAuthCodeInStore(code, storeData, getAuthCodeTtl());
}

export async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  const result = await consumeAuthCodeFromStore(code);
  if (!result) return null;
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    needsOnboarding: result.needsOnboarding,
    pendingInvitations: result.pendingInvitations,
    pendingInvitationChoice: result.pendingInvitationChoice,
    inviteToken: result.inviteToken,
  };
}
