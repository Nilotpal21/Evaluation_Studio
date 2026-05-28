/**
 * IdP Token Validation — Barrel Export
 *
 * Entry point for external IdP token validation and search session tokens.
 * Import via: `import { ... } from '@agent-platform/shared-auth/idp'`
 */

export { IdPTokenValidator } from './idp-token-validator.js';
export type { IdPValidatorLogger } from './idp-token-validator.js';

export { issueSearchSessionToken, verifySearchSessionToken } from './search-session-token.js';

export type {
  IdPProvider,
  UserIdentity,
  IdPValidationConfig,
  RedisLike,
  SearchSessionTokenPayload,
  SearchSessionTokenOptions,
} from './types.js';
