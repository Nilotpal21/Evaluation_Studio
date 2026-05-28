/**
 * Auth Profile Resolver Factory
 *
 * Shared factory for creating auth profile resolvers used by ConnectionService
 * across Studio, Runtime, and Workflow Engine. Centralizes the logic for:
 * - Profile lookup with tenant + project scope validation
 * - Status checking (only active profiles)
 * - Secret decryption and config merging
 *
 * Project isolation: a connection in project A can only resolve profiles that
 * are either tenant-scoped (projectId: null) or belong to the same project.
 */

import type { AuthProfileResolverLike } from './connection-service.js';
import { createLogger } from '../logger.js';
import { AuthProfileError } from '@agent-platform/shared/services/auth-profile';

const log = createLogger('auth-profile-resolver');

/**
 * Minimal model interface for AuthProfile lookups.
 * Avoids importing Mongoose directly — callers pass their model.
 */
export interface AuthProfileModelLike {
  findOne(
    filter: Record<string, unknown>,
  ): { lean(): Promise<AuthProfileDocument | null> } | Promise<AuthProfileDocument | null>;
  /**
   * Optional: compare-and-swap status update for lazy expiry transitions.
   * When absent the resolver still rejects expired profiles but cannot persist
   * the status flip — next read repeats the check (still correct, just chattier).
   */
  findOneAndUpdate?: (filter: Record<string, unknown>, update: Record<string, unknown>) => unknown;
}

export interface AuthProfileDocument {
  _id: string;
  tenantId: string;
  projectId: string | null;
  status: string;
  name?: string;
  enabled?: boolean;
  expiresAt?: Date | string | null;
  config?: Record<string, unknown> | null;
  encryptedSecrets?: string | Record<string, unknown> | null;
}

/**
 * Grace window before treating `expiresAt` as truly expired. Avoids rejecting
 * a token that's about to be refreshed by an in-flight refresh handler.
 */
const EXPIRY_GRACE_MS = 60_000;

export interface DecryptFn {
  (ciphertext: string, tenantId: string): string | Promise<string>;
}

export interface AuthProfileResolverFactoryOpts {
  /** Mongoose AuthProfile model (or compatible) */
  authProfileModel: AuthProfileModelLike;
  /** Decryption function: (ciphertext, tenantId) => plaintext JSON string */
  decrypt?: DecryptFn;
}

/**
 * Creates an AuthProfileResolverLike that validates project scope and decrypts secrets.
 *
 * When `decrypt` is provided, uses it to decrypt `encryptedSecrets` (runtime/WE path).
 * When omitted, assumes Mongoose auto-decrypt plugin handles it (Studio path).
 */
export function createAuthProfileResolver(
  opts: AuthProfileResolverFactoryOpts,
): AuthProfileResolverLike {
  const { authProfileModel, decrypt } = opts;

  return {
    async resolve({ authProfileId, tenantId, projectId }) {
      // Build filter: tenant-scoped profiles (projectId: null) are always accessible.
      // Project-scoped profiles must match the requesting project.
      const filter: Record<string, unknown> = {
        _id: authProfileId,
        tenantId,
      };
      if (projectId) {
        // Allow tenant-scoped (null) OR matching project
        filter.$or = [{ projectId: null }, { projectId }];
      }

      const queryResult = authProfileModel.findOne(filter);
      const profile =
        queryResult && typeof (queryResult as any).lean === 'function'
          ? await (queryResult as any).lean()
          : await queryResult;

      if (!profile) {
        throw new Error(`Auth profile not found: ${authProfileId}`);
      }

      if (profile.enabled === false) {
        throw new AuthProfileError(
          'AUTH_PROFILE_DISABLED',
          `Auth profile "${profile.name ?? authProfileId}" is disabled. Re-enable it in Auth Profiles to allow workflows, agents, and tools to use it.`,
          403,
        );
      }
      if (profile.status === 'pending_authorization') {
        throw new AuthProfileError(
          'AUTH_PROFILE_NOT_AUTHORIZED',
          `Auth profile ${authProfileId} has not completed authorization. Open the profile and click Authorize to complete setup.`,
          403,
        );
      }

      // Lazy expiry transition: flip an active-but-past-expiresAt profile to
      // `expired` at point-of-use rather than via a background sweep. The
      // `findOneAndUpdate` filter is compare-and-swap (`status: 'active'`) so
      // it loses cleanly to a concurrent revoke or successful token refresh.
      if (profile.status === 'active' && profile.expiresAt) {
        const expiresAtMs =
          profile.expiresAt instanceof Date
            ? profile.expiresAt.getTime()
            : new Date(profile.expiresAt).getTime();
        if (Number.isFinite(expiresAtMs) && expiresAtMs + EXPIRY_GRACE_MS < Date.now()) {
          if (authProfileModel.findOneAndUpdate) {
            try {
              await Promise.resolve(
                authProfileModel.findOneAndUpdate(
                  { _id: authProfileId, tenantId, status: 'active' },
                  { $set: { status: 'expired' }, $inc: { profileVersion: 1 } },
                ),
              );
            } catch (err) {
              // Persisting the flip is best-effort — the throw below still
              // protects this request even if the write fails.
              log.warn('Failed to persist lazy expiry transition', {
                authProfileId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          throw new AuthProfileError(
            'AUTH_PROFILE_EXPIRED',
            `Auth profile "${profile.name ?? authProfileId}" expired at ${new Date(expiresAtMs).toISOString()}. Re-authorize or rotate credentials.`,
            403,
          );
        }
      }

      if (profile.status !== 'active') {
        throw new Error(`Auth profile is ${profile.status} — reactivate it before testing`);
      }

      // Resolve secrets
      let secrets: Record<string, unknown> = {};
      if (profile.encryptedSecrets) {
        try {
          if (typeof profile.encryptedSecrets === 'object' && profile.encryptedSecrets !== null) {
            // Mongoose plugin already decrypted to an object
            secrets = profile.encryptedSecrets as Record<string, unknown>;
          } else if (typeof profile.encryptedSecrets === 'string') {
            // String value: could be already-decrypted JSON (Mongoose plugin ran)
            // or still-encrypted ciphertext (no plugin, raw lean query).
            // Try JSON.parse first — if it succeeds, the plugin already decrypted it.
            // Only call explicit decrypt if it looks like ciphertext (not valid JSON).
            let parsed = false;
            if (
              profile.encryptedSecrets.startsWith('{') ||
              profile.encryptedSecrets.startsWith('[')
            ) {
              try {
                secrets = JSON.parse(profile.encryptedSecrets);
                parsed = true;
              } catch {
                // Not valid JSON despite looking like it — fall through to decrypt
              }
            }
            if (!parsed && decrypt) {
              const decrypted = await Promise.resolve(decrypt(profile.encryptedSecrets, tenantId));
              secrets = JSON.parse(decrypted);
            } else if (!parsed) {
              // No decrypt fn and not JSON — attempt parse anyway for better error message
              secrets = JSON.parse(profile.encryptedSecrets);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('Failed to parse auth profile secrets', { authProfileId, error: message });
          throw new Error(`Auth profile secret resolution failed for ${authProfileId}: ${message}`);
        }
      }

      const config = (profile.config as Record<string, unknown>) ?? {};
      return { ...config, ...secrets };
    },
  };
}
