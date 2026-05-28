/**
 * Model Resolution Cache Invalidation
 *
 * Clears local caches (provider, chat resolution, model resolution) and
 * optionally publishes invalidation messages to other pods via Redis pub/sub.
 *
 * Follows the same InvalidationTransport pattern used by KMS/DEK cache
 * invalidation (see packages/database/src/kms/kms-resolver.ts).
 *
 * Local cache clearing is injected via setLocalCacheInvalidator() to keep
 * the transport layer testable without pulling in the full runtime dependency tree.
 *
 * Messages are HMAC-SHA256 signed when a signing key is configured, preventing
 * untrusted messages from triggering cache flushes. Unsigned messages are
 * rejected when signing is active; accepted when no key is configured (dev mode).
 */

import { createHmac } from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('model-cache-invalidation');

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Transport for cross-pod cache invalidation pub/sub.
 * Reuses the same interface as KMS InvalidationTransport.
 */
export interface ModelInvalidationTransport {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  shutdown(): Promise<void>;
}

/** Callback that clears local in-memory caches. */
export type LocalCacheInvalidator = (tenantId?: string) => void;

/** Wire format for invalidation messages. */
interface InvalidationEnvelope {
  tenantId: string | null;
  /** HMAC-SHA256 hex digest of the JSON payload (excluding this field). */
  hmac?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const CHANNEL = 'model-hub:invalidation';

// ─── State ──────────────────────────────────────────────────────────────

let transport: ModelInvalidationTransport | null = null;
let localInvalidator: LocalCacheInvalidator | null = null;
let hmacKey: string | null = null;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Set the cross-pod invalidation transport (typically Redis pub/sub).
 * Must be called during server startup before any invalidation occurs.
 */
export function setModelInvalidationTransport(t: ModelInvalidationTransport): void {
  transport = t;
}

/**
 * Set the local cache invalidation callback. Called during server startup
 * to wire the provider/chat/resolution cache clearing functions.
 */
export function setLocalCacheInvalidator(fn: LocalCacheInvalidator): void {
  localInvalidator = fn;
}

/**
 * Set the HMAC signing key for message integrity. Derived from the
 * encryption master key during server startup. When set, published
 * messages are signed and received messages without a valid HMAC are rejected.
 */
export function setInvalidationHmacKey(key: string): void {
  hmacKey = key;
}

/**
 * Subscribe to cross-pod invalidation messages. Call once during startup.
 * When a message arrives from another pod, local caches are cleared.
 */
export async function subscribeModelInvalidation(): Promise<void> {
  if (!transport) {
    log.warn('No invalidation transport configured — cross-pod invalidation disabled');
    return;
  }

  await transport.subscribe(CHANNEL, (message: string) => {
    try {
      const parsed = JSON.parse(message) as InvalidationEnvelope;

      // Verify HMAC when signing is configured
      if (hmacKey) {
        const expectedHmac = computeHmac(parsed.tenantId);
        if (parsed.hmac !== expectedHmac) {
          log.warn('Rejected invalidation message with invalid HMAC', {
            tenantId: parsed.tenantId,
          });
          return; // Drop the message — do NOT fall back to full invalidation
        }
      }

      log.info('Received cross-pod model invalidation', { tenantId: parsed.tenantId });
      invalidateLocalCaches(parsed.tenantId ?? undefined);
    } catch (err) {
      log.warn('Failed to parse invalidation message, ignoring', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Do NOT fall back to full invalidation on bad message — that would
      // let a malformed message trigger a thundering-herd cache rebuild.
    }
  });

  log.info('Model cache invalidation subscriber active', { hmacEnabled: !!hmacKey });
}

/**
 * Shutdown the invalidation transport. Call during graceful shutdown.
 */
export async function shutdownModelInvalidation(): Promise<void> {
  if (transport) {
    try {
      await transport.shutdown();
    } catch (err) {
      log.warn('Error shutting down model invalidation transport', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    transport = null;
  }
}

/**
 * Invalidate model resolution caches on this pod and notify other pods.
 *
 * @param tenantId Optional tenant to scope the invalidation. If omitted, all caches are cleared.
 */
export function invalidateModelResolutionCaches(tenantId?: string): void {
  // Clear local caches immediately
  invalidateLocalCaches(tenantId);

  // Publish to other pods (fire-and-forget)
  if (transport) {
    const envelope: InvalidationEnvelope = { tenantId: tenantId ?? null };
    if (hmacKey) {
      envelope.hmac = computeHmac(envelope.tenantId);
    }
    transport.publish(CHANNEL, JSON.stringify(envelope)).catch((err) => {
      log.warn('Failed to publish model invalidation', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
    });
  }
}

// ─── Internal ───────────────────────────────────────────────────────────

function invalidateLocalCaches(tenantId?: string): void {
  if (localInvalidator) {
    localInvalidator(tenantId);
  }
}

/**
 * Compute HMAC-SHA256 over the tenantId payload. The HMAC covers only the
 * payload (tenantId) so that the signature can be computed before serialization
 * and verified independently of JSON key ordering.
 */
function computeHmac(tenantId: string | null): string {
  return createHmac('sha256', hmacKey!).update(String(tenantId)).digest('hex');
}
