/**
 * Unified Callback Router
 *
 * POST /api/v1/callbacks/:callbackId
 *
 * Handles callbacks from all async execution patterns:
 * - Async tool results
 * - A2A push notification updates
 * - Human approval/input responses
 *
 * The callback is atomically claimed from Redis (exactly-once guarantee),
 * then enqueued to BullMQ for reliable processing. Returns 200 immediately
 * to prevent external systems from retrying.
 *
 * Security: HMAC-SHA256 signature verification via x-callback-signature header.
 */

import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { isDEKEnvelopeFormat } from '@agent-platform/shared-encryption';
import type { CallbackRegistry } from '@agent-platform/execution';
import type { SuspensionStore } from '@agent-platform/execution';

const log = createLogger('callback-router');

export interface ResumptionQueue {
  add(name: string, data: unknown): Promise<void>;
}

export interface CallbackRouterDeps {
  callbackRegistry: CallbackRegistry;
  suspensionStore: SuspensionStore;
  resumptionQueue: ResumptionQueue;
  decryptSecret?: (encrypted: string, tenantId: string) => Promise<string>;
}

export function createCallbackRouter(deps: CallbackRouterDeps): Router {
  const router = Router();

  router.post('/:callbackId', async (req: Request, res: Response) => {
    const { callbackId } = req.params;

    // 1. Atomic claim from Redis (GET + DEL)
    let entry = await deps.callbackRegistry.claim(callbackId);

    // Fallback to MongoDB if Redis entry evicted.
    // HMAC signature verification (below) is the security boundary here — not tenantId,
    // since external agents calling back have no auth context to provide one.
    if (!entry) {
      const suspension = await deps.suspensionStore.loadByCallbackId(callbackId);
      if (suspension && suspension.status === 'suspended') {
        entry = {
          callbackId,
          suspensionId: suspension.suspensionId,
          sessionId: suspension.sessionId,
          tenantId: suspension.tenantId,
          expiresAt: suspension.expiresAt.getTime(),
        };
      }
    }

    if (!entry) {
      // Return 200 to prevent external systems from retrying
      return res.status(200).json({ ok: true, status: 'already_processed' });
    }

    // 2. HMAC signature verification (if secret is configured on the suspension)
    const suspension = await deps.suspensionStore.load(entry.suspensionId);
    if (suspension?.callbackSecret) {
      const signature = getHeader(req.headers, 'x-callback-signature');
      if (!signature) {
        log.warn('Callback missing required signature', { callbackId });
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Signature required' },
        });
      }

      try {
        let secret = suspension.callbackSecret;
        if (deps.decryptSecret && isDEKEnvelopeFormat(suspension.callbackSecret)) {
          secret = await deps.decryptSecret(suspension.callbackSecret, entry.tenantId);
        }
        const rawBody =
          (req as any).rawBody ||
          (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const expectedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const actualSig = String(signature).replace('sha256=', '');
        const sigBuf = Buffer.from(actualSig, 'hex');
        const expectedBuf = Buffer.from(expectedSig, 'hex');
        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          return res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid signature' },
          });
        }
      } catch (err) {
        log.error('HMAC verification failed', {
          callbackId,
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Verification temporarily unavailable',
          },
        });
      }
    }

    // 3. Store payload as safety net for race condition
    // (callback arrives before suspension persisted)
    // This is handled by BullMQ retry, but the payload is preserved

    // 4. Enqueue resume job to BullMQ
    try {
      await deps.resumptionQueue.add('resume', {
        suspensionId: entry.suspensionId,
        callbackId,
        tenantId: entry.tenantId,
        payload: req.body,
        receivedAt: Date.now(),
      });
    } catch (err) {
      // Re-register callback so it can be retried
      await deps.callbackRegistry.register(entry);
      log.error('Failed to enqueue resume job', {
        callbackId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    log.info('Callback processed', {
      callbackId,
      suspensionId: entry.suspensionId,
      sessionId: entry.sessionId,
    });

    return res.json({ ok: true });
  });

  return router;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}
