/**
 * A2A Callback Handler — Express router for A2A push notification callbacks.
 *
 * POST /a2a/callbacks/:callbackId
 *
 * When a remote agent completes a task it was working on for us, it POSTs
 * the result here. This handler:
 * 1. Claims the callback atomically (idempotent)
 * 2. Verifies the Bearer token matches the callbackSecret
 * 3. Enqueues a resume job for reliable cross-pod processing
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { A2ATracingPort } from '../domain/ports.js';

export interface A2ACallbackRegistry {
  claim(
    callbackId: string,
  ): Promise<{ suspensionId: string; sessionId: string; tenantId: string } | null>;
  register(entry: unknown): Promise<void>;
}

export interface A2ACallbackSuspensionLookup {
  /** Look up suspension by ID to retrieve callbackSecret for verification */
  load(suspensionId: string): Promise<{ callbackSecret: string; tenantId: string } | null>;
  /** Decrypt the stored callback secret (secrets may be encrypted at rest) */
  decryptSecret?(encrypted: string, tenantId: string): Promise<string>;
}

export interface A2AResumptionQueue {
  add(name: string, data: unknown): Promise<void>;
}

export interface A2ACallbackDeps {
  callbackRegistry: A2ACallbackRegistry;
  resumptionQueue: A2AResumptionQueue;
  tracing: A2ATracingPort;
  /** Optional: suspension store for token verification. If not provided, token check is skipped. */
  suspensionLookup?: A2ACallbackSuspensionLookup;
}

export function createA2ACallbackRouter(deps: A2ACallbackDeps): Router {
  const router = Router();

  router.post('/:callbackId', async (req: Request, res: Response) => {
    const { callbackId } = req.params;

    // 1. Atomic claim — prevents duplicate processing
    const entry = await deps.callbackRegistry.claim(callbackId);
    if (!entry) {
      return res.status(200).json({ ok: true, status: 'already_processed' });
    }

    // 2. Verify Bearer token if suspension lookup is available
    if (deps.suspensionLookup) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      if (token) {
        const suspension = await deps.suspensionLookup.load(entry.suspensionId);
        if (suspension?.callbackSecret) {
          // Decrypt the secret if encryption is available, otherwise compare raw
          const secret = deps.suspensionLookup.decryptSecret
            ? await deps.suspensionLookup.decryptSecret(
                suspension.callbackSecret,
                suspension.tenantId,
              )
            : suspension.callbackSecret;
          if (secret !== token) {
            // Token mismatch — re-register callback (it wasn't legitimately consumed)
            await deps.callbackRegistry.register(entry);
            return res.status(401).json({ error: 'Invalid callback token' });
          }
        }
      }
      // If no token provided, allow through (backward compat with agents that don't send tokens)
    }

    // 3. Extract A2A notification payload
    const payload = req.body?.params || req.body;

    // 4. Enqueue to BullMQ for reliable cross-pod processing
    try {
      await deps.resumptionQueue.add('resume', {
        suspensionId: entry.suspensionId,
        callbackId,
        tenantId: entry.tenantId,
        payload,
        receivedAt: Date.now(),
      });
    } catch (err) {
      // Re-register callback if enqueue fails so it can be retried
      await deps.callbackRegistry.register(entry);
      return res.status(503).json({ error: 'Service unavailable' });
    }

    // 5. Trace the callback
    deps.tracing.traceInbound({
      sourceIp: req.ip || 'unknown',
      taskId: payload?.id || callbackId,
      tenantId: entry.tenantId,
      agentName: 'a2a-callback',
      durationMs: 0,
      status: 'success',
    });

    return res.json({ ok: true });
  });

  return router;
}
