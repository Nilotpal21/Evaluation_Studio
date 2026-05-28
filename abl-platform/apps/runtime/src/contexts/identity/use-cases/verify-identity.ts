/**
 * Verify Identity Use Case
 *
 * Dispatches an identity verification request to the appropriate verifier
 * from a registry keyed by VerificationMethod. Iterates over registered
 * verifiers and delegates to the first one that supports the input.
 */

import type { VerificationMethod } from '@agent-platform/shared-auth';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
} from '../domain/identity-verifier.js';

export class VerifyIdentity {
  constructor(private readonly verifiers: Map<VerificationMethod, IdentityVerifier>) {}

  async execute(input: VerificationInput): Promise<VerificationInitResult> {
    // Direct lookup by method when specified (preferred path)
    if (input.method) {
      const verifier = this.verifiers.get(input.method);
      if (verifier && verifier.supports(input)) {
        return verifier.initiate(input);
      }
      if (verifier) {
        return {
          success: false,
          error: {
            code: 'VERIFIER_UNSUPPORTED',
            message: `Verifier '${input.method}' does not support the given input`,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'NO_VERIFIER',
          message: `No registered verifier for method '${input.method}'`,
        },
      };
    }

    // Fallback: iterate verifiers for backward compatibility
    for (const verifier of this.verifiers.values()) {
      if (verifier.supports(input)) {
        return verifier.initiate(input);
      }
    }

    return {
      success: false,
      error: {
        code: 'NO_VERIFIER',
        message: 'No registered verifier supports the given input',
      },
    };
  }
}
