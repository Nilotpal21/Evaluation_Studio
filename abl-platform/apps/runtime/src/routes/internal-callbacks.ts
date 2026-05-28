/**
 * Internal Callbacks Route
 *
 * POST /api/internal/workflow-callback — receives push callbacks from workflow-engine
 * for async workflow executions. Uses HMAC auth (not JWT).
 */
import { Router } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { InMemoryRateLimiter } from '../middleware/rate-limiter.js';
import type { WorkflowCallbackHandler } from '../services/workflow/workflow-callback-handler.js';

const log = createLogger('internal-callbacks');

/** IP-based rate limiter for internal callback endpoint. Default: 120 requests/min per IP. */
const CALLBACK_RATE_LIMIT = parseInt(process.env.INTERNAL_CALLBACK_RATE_LIMIT ?? '120', 10);
const callbackRateLimiter = new InMemoryRateLimiter({ maxEntries: 1000 });

export function createInternalCallbacksRouter(callbackHandler: WorkflowCallbackHandler): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      // IP-based rate limiting (defense-in-depth — HMAC is primary auth)
      const clientIp = req.ip ?? 'unknown';
      const rateResult = callbackRateLimiter.check(
        `ip:${clientIp}`,
        'request',
        CALLBACK_RATE_LIMIT,
      );
      if (!rateResult.allowed) {
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many callback requests' },
        });
        return;
      }

      // Access raw body captured by global express.json({ verify }) middleware
      const rawBody = (req as { rawBody?: Buffer | string }).rawBody;
      if (!rawBody) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_RAW_BODY', message: 'Raw body not available' },
        });
        return;
      }
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');

      // Extract HMAC headers
      const signature = req.headers['x-webhook-signature'] as string | undefined;
      const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;

      if (!signature || !timestamp) {
        res.status(401).json({
          success: false,
          error: { code: 'HMAC_VERIFICATION_FAILED', message: 'Missing signature headers' },
        });
        return;
      }

      // Verify HMAC
      if (!callbackHandler.verifyHmac(bodyStr, signature, timestamp)) {
        log.warn('HMAC verification failed for workflow callback', {
          hasSignature: !!signature,
          hasTimestamp: !!timestamp,
        });
        res.status(401).json({
          success: false,
          error: { code: 'HMAC_VERIFICATION_FAILED', message: 'Invalid signature' },
        });
        return;
      }

      // Process callback (Zod validation happens inside handler)
      const result = await callbackHandler.handleCallback(req.body);

      if (result.error) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: result.error },
        });
        return;
      }

      res.status(200).json({ success: true, injected: result.injected });
    } catch (err) {
      log.error('Error processing workflow callback', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred processing the callback',
        },
      });
    }
  });

  return router;
}
