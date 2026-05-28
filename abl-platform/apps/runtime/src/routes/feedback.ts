/**
 * Feedback Route
 *
 * Public GET endpoint for email CSAT feedback collection.
 * No auth middleware — the signed JWT token IS the authorization.
 */

import { type Router as RouterType } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import { runtimeRegistry } from '../openapi/registry.js';
import { verifyFeedbackToken } from '../services/email/feedback-token.js';
import { getRedisClient, isRedisAvailable } from '../services/redis/redis-client.js';
import { getTraceStore } from '../services/trace-store.js';

const log = createLogger('feedback-route');

const DEDUP_TTL_SECONDS = 30 * 24 * 3600; // 30 days, matches token TTL

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:40px;border-radius:12px;background:white;box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:400px}</style>
</head><body><div class="card"><h2>${title}</h2><p>${message}</p></div></body></html>`;
}

const feedbackTokenParamsSchema = z.object({
  token: z.string().min(1).describe('Signed feedback token'),
});

const feedbackRatingQuerySchema = z.object({
  rating: z.preprocess((value) => {
    if (Array.isArray(value)) {
      return value[0];
    }
    if (typeof value === 'string') {
      return Number.parseInt(value, 10);
    }
    return value;
  }, z.number().int().min(1).max(5)),
});

export function createFeedbackRouter(): RouterType {
  const openapi = createOpenAPIRouter(runtimeRegistry, {
    basePath: '/api/v1/feedback',
    tags: ['Feedback'],
    wrapAsyncHandlers: true,
  });
  const router: RouterType = openapi.router;

  openapi.route(
    'get',
    '/:token',
    {
      summary: 'Record CSAT feedback',
      description: 'Records an email feedback rating from a signed public feedback link.',
      params: feedbackTokenParamsSchema,
      query: feedbackRatingQuerySchema,
      response: z.string(),
      responseContentType: 'text/html',
      auth: false,
    },
    async (req, res) => {
      const { token } = req.params;

      // Verify token
      const payload = verifyFeedbackToken(token);
      if (!payload) {
        res
          .status(404)
          .type('html')
          .send(htmlPage('Not Found', 'This feedback link is invalid or has expired.'));
        return;
      }

      // Validate rating
      const ratingResult = feedbackRatingQuerySchema.safeParse(req.query);
      if (!ratingResult.success) {
        res
          .status(400)
          .type('html')
          .send(htmlPage('Invalid Rating', 'Rating must be between 1 and 5.'));
        return;
      }
      const rating = ratingResult.data.rating;

      // Deduplication via Redis
      const dedupKey = `feedback:csat:${payload.tenantId}:${payload.messageId}`;
      try {
        const redis = getRedisClient();
        if (redis && isRedisAvailable()) {
          const existing = await redis.get(dedupKey);
          if (existing) {
            res
              .type('html')
              .send(htmlPage('Thank you!', 'Your feedback has already been recorded.'));
            return;
          }
          await redis.set(dedupKey, String(rating), 'EX', DEDUP_TTL_SECONDS);
        }
      } catch (err) {
        log.warn('Redis dedup check failed, proceeding without dedup', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Emit trace event
      try {
        getTraceStore().addEvent(payload.sessionId, {
          id: randomUUID(),
          type: 'feedback.submitted',
          sessionId: payload.sessionId,
          timestamp: new Date(),
          data: {
            rating_type: 'star',
            rating_value: rating,
            target_message_id: payload.messageId,
          },
        });
      } catch (err) {
        log.error('Failed to emit feedback trace event', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      log.info('CSAT feedback recorded', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        messageId: payload.messageId,
        rating,
      });

      res
        .type('html')
        .send(htmlPage('Thank you!', 'Your feedback has been recorded. You can close this page.'));
    },
  );

  return router;
}

export default createFeedbackRouter();
