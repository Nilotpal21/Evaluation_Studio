/**
 * Identity Context — Public API
 *
 * Re-exports all domain types, use cases, and infrastructure adapters.
 * Provides a `createIdentityContext()` factory that wires everything together,
 * returning a typed object with all use cases ready to invoke.
 */

import type { VerificationMethod } from '@agent-platform/shared-auth';

// =============================================================================
// DOMAIN
// =============================================================================

export type { IdentityArtifact } from './domain/identity-artifact.js';
export { hash as hashArtifact, create as createArtifact } from './domain/identity-artifact.js';

export type { IdentityTier } from './domain/identity-tier.js';
export { canPromoteTo, tierFromVerification } from './domain/identity-tier.js';

export type {
  VerificationAttempt,
  VerificationStatus,
  CreateVerificationAttemptInput,
} from './domain/verification-attempt.js';
export { createVerificationAttempt, isExpired, canAttempt } from './domain/verification-attempt.js';

export type { SessionResolutionKey } from './domain/session-resolution-key.js';
export { buildResolutionKeyId } from './domain/session-resolution-key.js';
export type {
  SessionResolutionRecord,
  SessionResolutionWriteInput,
} from './domain/session-resolution-record.js';
export { normalizeSessionResolutionRecord } from './domain/session-resolution-record.js';

export type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from './domain/identity-verifier.js';

export type { VerificationDeliveryService } from './domain/verification-delivery.js';

// =============================================================================
// USE CASES
// =============================================================================

export { VerifyIdentity } from './use-cases/verify-identity.js';

export type { SessionResolutionStore, ResolveSessionResult } from './use-cases/resolve-session.js';
export { ResolveSession } from './use-cases/resolve-session.js';

export type {
  CompleteVerificationDeps,
  CompleteVerificationPostFailure,
  CompleteVerificationSessionSnapshot,
} from './use-cases/complete-verification.js';
export { CompleteVerification } from './use-cases/complete-verification.js';

export { RegisterResolutionKey } from './use-cases/register-resolution-key.js';

export type { PromoteTierInput, PromoteTierResult } from './use-cases/promote-tier.js';
export { PromoteTier } from './use-cases/promote-tier.js';

// =============================================================================
// INFRASTRUCTURE — VERIFIERS
// =============================================================================

export { HmacVerifier } from './infrastructure/verifiers/hmac-verifier.js';
export { OtpVerifier } from './infrastructure/verifiers/otp-verifier.js';
export { EmailLinkVerifier } from './infrastructure/verifiers/email-link-verifier.js';
export { OAuthVerifier } from './infrastructure/verifiers/oauth-verifier.js';
export type { OAuthProviderAdapter } from './infrastructure/verifiers/oauth-verifier.js';
export {
  GoogleOAuthAdapter,
  MicrosoftOAuthAdapter,
  GitHubOAuthAdapter,
} from './infrastructure/verifiers/oauth-adapters.js';
export type { ArcticLikeProvider } from './infrastructure/verifiers/oauth-adapters.js';
export { ProviderVerifier } from './infrastructure/verifiers/provider-verifier.js';
export { WebhookVerifier } from './infrastructure/verifiers/webhook-verifier.js';
export type {
  SendChallengePayload,
  SendChallengeFn,
} from './infrastructure/verifiers/webhook-verifier.js';
export { ConfigurableOAuthProviderAdapter } from './infrastructure/verifiers/configurable-oauth-provider-adapter.js';
export type { OAuthProviderConfig } from './infrastructure/verifiers/configurable-oauth-provider-adapter.js';

// =============================================================================
// INFRASTRUCTURE — DELIVERY
// =============================================================================

export { EmailDeliveryAdapter } from './infrastructure/email-delivery-adapter.js';
export type { EmailSender } from './infrastructure/email-delivery-adapter.js';

// =============================================================================
// INFRASTRUCTURE — STORES
// =============================================================================

export type {
  StoredVerificationAttempt,
  VerificationTokenStore,
} from './infrastructure/verification-token-store.js';
export { RedisResolutionKeyStore } from './infrastructure/resolution-key-store.js';
export type { RedisLike } from './infrastructure/resolution-key-store.js';

// =============================================================================
// FACTORY
// =============================================================================

import type { IdentityVerifier } from './domain/identity-verifier.js';
import type { SessionResolutionStore } from './use-cases/resolve-session.js';
import type { VerificationTokenStore } from './infrastructure/verification-token-store.js';
import { VerifyIdentity } from './use-cases/verify-identity.js';
import { ResolveSession } from './use-cases/resolve-session.js';
import { RegisterResolutionKey } from './use-cases/register-resolution-key.js';
import { PromoteTier } from './use-cases/promote-tier.js';

/** Dependencies required to wire the identity context. */
export interface IdentityContextDeps {
  /** Map of verification method to its verifier adapter. */
  readonly verifiers: Map<VerificationMethod, IdentityVerifier>;
  /** Session resolution key store (Redis-backed in production). */
  readonly resolutionStore: SessionResolutionStore;
  /** Verification token store (for OTP, OAuth, email-link, webhook flows). */
  readonly tokenStore: VerificationTokenStore;
}

/** Wired identity context with all use cases ready to invoke. */
export interface IdentityContext {
  readonly verifyIdentity: VerifyIdentity;
  readonly resolveSession: ResolveSession;
  readonly registerResolutionKey: RegisterResolutionKey;
  readonly promoteTier: PromoteTier;
}

/**
 * Wire all identity use cases from their dependencies.
 * Returns a typed object — callers access use cases directly
 * without needing to know their constructor signatures.
 */
export function createIdentityContext(deps: IdentityContextDeps): IdentityContext {
  return {
    verifyIdentity: new VerifyIdentity(deps.verifiers),
    resolveSession: new ResolveSession(deps.resolutionStore),
    registerResolutionKey: new RegisterResolutionKey(deps.resolutionStore),
    promoteTier: new PromoteTier(),
  };
}
