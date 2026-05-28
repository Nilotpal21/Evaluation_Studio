/**
 * OAuth Identity Verifier (Arctic v3)
 *
 * Adapter implementing the IdentityVerifier port for OAuth-based identity verification.
 * Uses Arctic v3 provider instances (Google, Microsoft, GitHub, etc.) behind an
 * OAuthProviderAdapter abstraction to decouple the verifier from specific providers.
 *
 * Two-step flow:
 *   1. initiate() -> generates state + PKCE code verifier, stores them in the
 *      VerificationTokenStore (serialised as JSON in `codeHash`), creates an
 *      authorization URL via the Arctic provider, returns the redirect URL.
 *   2. complete() -> loads the attempt from the store, validates the state parameter,
 *      exchanges the authorization code for tokens via the Arctic provider, calls
 *      the userinfo endpoint to extract the verified email, marks the attempt as
 *      verified, and returns the identity at tier 2.
 *
 * Security:
 *   - PKCE (code verifier/challenge) protects against authorization code interception.
 *   - State parameter protects against CSRF.
 *   - Both survive the redirect round-trip via VerificationTokenStore.
 */

import { randomBytes } from 'node:crypto';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import { createVerificationAttempt, isExpired } from '../../domain/verification-attempt.js';
import type { VerificationTokenStore } from '../verification-token-store.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** OAuth flow expiry in milliseconds (10 minutes). */
const OAUTH_TTL_MS = 600_000;

/** Byte length for state parameter generation. */
const STATE_BYTE_LENGTH = 32;

/** Byte length for PKCE code verifier generation. */
const CODE_VERIFIER_BYTE_LENGTH = 32;

const log = createLogger('oauth-verifier');

// =============================================================================
// PROVIDER ADAPTER PORT
// =============================================================================

/**
 * Abstraction over Arctic v3 provider instances.
 * Each provider (Google, Microsoft, GitHub) has slightly different signatures;
 * this port normalises them so the verifier logic stays provider-agnostic.
 */
export interface OAuthProviderAdapter {
  /** Build the authorization URL for the redirect. */
  createAuthorizationURL(state: string, codeVerifier: string): URL;

  /** Exchange the authorization code (+ code verifier) for tokens. */
  validateAuthorizationCode(code: string, codeVerifier: string): Promise<{ accessToken: string }>;

  /** Fetch the user's verified email using the access token (e.g., userinfo endpoint). */
  fetchUserEmail(accessToken: string): Promise<string>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class OAuthVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'oauth';

  constructor(
    private readonly tokenStore: VerificationTokenStore,
    private readonly provider: OAuthProviderAdapter,
  ) {}

  /**
   * Generate state + PKCE code verifier, store them, create the authorization URL,
   * and return the redirect URL in challengeData.
   */
  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    const state = randomBytes(STATE_BYTE_LENGTH).toString('hex');
    const codeVerifier = randomBytes(CODE_VERIFIER_BYTE_LENGTH).toString('hex');

    const attempt = createVerificationAttempt({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionPrincipalId: input.sessionPrincipalId,
      method: 'oauth',
      identityValue: input.identityValue,
      identityType: input.identityType,
      policySource: input.policySource,
      grantScope: input.grantScope,
      traceId: input.traceId,
      expiresAt: new Date(Date.now() + OAUTH_TTL_MS),
    });

    // Store state + codeVerifier as JSON in codeHash so they survive the redirect round-trip
    const codeHash = JSON.stringify({ state, codeVerifier });
    await this.tokenStore.create({ ...attempt, codeHash });

    const authUrl = this.provider.createAuthorizationURL(state, codeVerifier);

    log.info('OAuth verification initiated', {
      tenantId: input.tenantId,
      attemptId: attempt.id,
      method: 'oauth',
    });

    return {
      success: true,
      attemptId: attempt.id,
      challengeData: {
        userAction: 'redirect',
        redirectUrl: authUrl.toString(),
      },
    };
  }

  /**
   * Validate the OAuth callback: check state, exchange code for tokens,
   * fetch verified email, and mark the attempt as verified.
   */
  async complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const stored = await this.tokenStore.get(tenantId, attemptId);

    if (!stored) {
      log.warn('OAuth attempt not found', { tenantId, attemptId, method: 'oauth' });
      return {
        success: false,
        error: { code: 'OAUTH_ATTEMPT_NOT_FOUND', message: 'OAuth verification attempt not found' },
      };
    }

    if (isExpired(stored)) {
      log.warn('OAuth attempt expired', { tenantId, attemptId, method: 'oauth' });
      return {
        success: false,
        error: { code: 'OAUTH_EXPIRED', message: 'OAuth verification attempt has expired' },
      };
    }

    let storedState: string;
    let codeVerifier: string;
    try {
      const parsed = JSON.parse(stored.codeHash) as { state: string; codeVerifier: string };
      storedState = parsed.state;
      codeVerifier = parsed.codeVerifier;
    } catch {
      return {
        success: false,
        error: { code: 'OAUTH_DATA_CORRUPT', message: 'Stored OAuth data is corrupted' },
      };
    }

    const submittedState = proof.metadata?.state as string | undefined;
    if (submittedState !== storedState) {
      log.warn('OAuth state mismatch', { tenantId, attemptId, method: 'oauth' });
      return {
        success: false,
        error: { code: 'OAUTH_STATE_MISMATCH', message: 'OAuth state parameter does not match' },
      };
    }

    // Exchange authorization code for tokens
    let accessToken: string;
    try {
      const tokens = await this.provider.validateAuthorizationCode(proof.value, codeVerifier);
      accessToken = tokens.accessToken;
    } catch (err) {
      log.error('OAuth token exchange failed', {
        tenantId,
        attemptId,
        method: 'oauth',
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: {
          code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
          message: 'Failed to exchange authorization code for tokens',
        },
      };
    }

    // Fetch verified email from userinfo
    let verifiedEmail: string;
    try {
      verifiedEmail = await this.provider.fetchUserEmail(accessToken);
    } catch (err) {
      log.error('OAuth userinfo fetch failed', {
        tenantId,
        attemptId,
        method: 'oauth',
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: {
          code: 'OAUTH_USERINFO_FAILED',
          message: 'Failed to fetch user email from provider',
        },
      };
    }

    await this.tokenStore.markVerified(tenantId, attemptId);

    log.info('OAuth verification completed', { tenantId, attemptId, method: 'oauth' });

    return {
      success: true,
      identityTier: 2,
      verifiedIdentity: verifiedEmail,
    };
  }

  /**
   * OAuth is a general-purpose verifier triggered by orchestration, not metadata.
   */
  supports(_input: VerificationInput): boolean {
    return true;
  }
}
