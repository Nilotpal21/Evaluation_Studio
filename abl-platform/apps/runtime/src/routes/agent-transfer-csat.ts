/**
 * Agent Transfer CSAT Routes
 *
 * POST /api/v1/agent-transfer/csat/submit
 *
 * Proxies CSAT rating submissions to the SmartAssist CSAT API.
 * Authenticates the request, resolves the adapter by provider name,
 * and forwards the rating payload.
 */

import { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { z } from 'zod';
import {
  getAdapterRegistry,
  getTransferTraceEmitter,
  isAgentTransferInitialized,
} from '../services/agent-transfer/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const router: RouterType = Router();
const log = createLogger('agent-transfer-csat');

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

const submitCsatSchema = z.object({
  provider: z.string().min(1),
  userId: z.string().min(1),
  channel: z.string().min(1),
  botId: z.string().min(1),
  score: z.number().int().min(0).max(10),
  surveyType: z.enum(['csat', 'nps', 'likeDislike']).default('csat'),
  comments: z.string().max(1000).optional(),
});

router.post('/submit', async (req, res) => {
  const parsed = submitCsatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const { provider, userId, channel, botId, score, surveyType, comments } = parsed.data;

  if (!isAgentTransferInitialized()) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Agent transfer subsystem not initialized' },
    });
  }

  const registry = getAdapterRegistry();
  if (!registry) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Adapter registry not available' },
    });
  }

  const adapter = registry.get(provider);
  if (!adapter) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'PROVIDER_NOT_FOUND',
        message: 'No adapter registered for the specified provider',
      },
    });
  }

  if (typeof adapter.submitCsatRating !== 'function') {
    return res.status(501).json({
      success: false,
      error: {
        code: 'NOT_SUPPORTED',
        message: 'The specified provider does not support CSAT submission',
      },
    });
  }

  try {
    const result = await adapter.submitCsatRating({
      userId,
      channel,
      botId,
      score,
      surveyType,
      comments,
    });

    if (!result.success) {
      log.error('CSAT submission failed', {
        provider,
        tenantId: req.tenantContext?.tenantId,
        error: result.error?.message,
      });
      return res.status(502).json({
        success: false,
        error: result.error ?? { code: 'CSAT_ERROR', message: 'CSAT submission failed' },
      });
    }

    const traceEmitter = getTransferTraceEmitter();
    const tenantId = req.tenantContext?.tenantId;
    if (traceEmitter && tenantId) {
      void Promise.resolve(
        traceEmitter.emit({
          type: 'agent_transfer.csat_completed',
          timestamp: Date.now(),
          data: {
            tenantId,
            projectId: req.tenantContext?.projectId ?? '',
            contactId: userId,
            provider,
            channel,
            score,
            ...(comments !== undefined ? { feedback: comments } : {}),
          },
        }),
      ).catch((emitErr) =>
        log.warn('Failed to emit CSAT completion trace from API route', {
          provider,
          tenantId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        }),
      );
    }

    return res.json({ success: true, data: { message: result.data?.message } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Unexpected error in CSAT submit', {
      provider,
      tenantId: req.tenantContext?.tenantId,
      error: message,
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

export default router;
