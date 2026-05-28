/**
 * Backwards-compatible re-export for auth-profile validation helpers.
 *
 * The implementation lives in @agent-platform/shared-auth-profile.
 */
export {
  AuthProfileError,
  validateLinkedAppProfile,
  validateResolvedOAuth2TokenLinkedApp,
} from '@agent-platform/shared-auth-profile';
export type {
  ValidateLinkedAppParams,
  ValidateResolvedOAuth2TokenLinkedAppParams,
} from '@agent-platform/shared-auth-profile';
