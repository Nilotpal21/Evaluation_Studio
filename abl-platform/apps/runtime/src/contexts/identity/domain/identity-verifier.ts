/**
 * Identity Verifier Port
 *
 * Defines the port interface for identity verification strategies (HMAC, OTP, OAuth, etc.).
 * Each verifier handles a specific VerificationMethod and follows the initiate/complete pattern.
 * Implementations are provided as adapters in the infrastructure layer.
 */

import type { VerificationMethod, ChannelArtifactType } from '@agent-platform/shared-auth';
import type { ChannelType } from '../../../channels/types.js';

// =============================================================================
// SUPPORTING TYPES
// =============================================================================

export interface VerificationInput {
  readonly method?: VerificationMethod;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly sessionId: string;
  readonly sessionPrincipalId?: string;
  readonly channelType: ChannelType;
  readonly identityValue: string;
  readonly identityType: ChannelArtifactType;
  readonly policySource?: string;
  readonly grantScope?: string;
  readonly traceId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VerificationInitResult {
  readonly success: boolean;
  readonly attemptId?: string;
  readonly challengeData?: Record<string, unknown>;
  readonly error?: { code: string; message: string };
}

export interface VerificationProof {
  readonly type:
    | 'otp_code'
    | 'hmac_signature'
    | 'oauth_token'
    | 'provider_assertion'
    | 'email_link_token'
    | 'webhook_challenge_response';
  readonly value: string;
  readonly timestamp?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  readonly success: boolean;
  readonly identityTier?: number;
  readonly verifiedIdentity?: string;
  readonly error?: { code: string; message: string };
}

// =============================================================================
// PORT INTERFACE
// =============================================================================

/**
 * Port interface for identity verification strategies.
 * Each implementation handles a single VerificationMethod.
 */
export interface IdentityVerifier {
  /** The verification method this verifier handles. */
  readonly method: VerificationMethod;

  /** Initiate a verification flow (e.g., send OTP, generate challenge). */
  initiate(input: VerificationInput): Promise<VerificationInitResult>;

  /** Complete a verification flow with proof (e.g., OTP code, HMAC signature). */
  complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult>;

  /** Check whether this verifier can handle the given input. */
  supports(input: VerificationInput): boolean;
}
