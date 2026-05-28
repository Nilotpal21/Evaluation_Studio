/**
 * Identity Verification API Routes
 *
 * POST   /initiate     Initiate a verification flow (OTP, HMAC, OAuth, etc.)
 * POST   /complete     Complete a verification flow with proof
 * GET    /:attemptId   Get verification attempt status
 *
 * All routes require authentication (SDK session or API key).
 * The router is created via a factory function that receives dependencies.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelArtifactType } from '@agent-platform/shared-auth';
import type { ChannelType } from '../channels/types.js';
import type { VerifyIdentity } from '../contexts/identity/use-cases/verify-identity.js';
import type { VerificationTokenStore } from '../contexts/identity/infrastructure/verification-token-store.js';
import type {
  VerificationProof,
  VerificationResult,
} from '../contexts/identity/domain/identity-verifier.js';
import type { VerificationDeliveryService } from '../contexts/identity/domain/verification-delivery.js';

const log = createLogger('identity-verification');

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const ALLOWED_METHODS = [
  'hmac',
  'otp',
  'oauth',
  'email_link',
  'webhook',
  'provider',
  'none',
  'cookie',
  'caller_id',
] as const;

const initiateSchema = z.object({
  method: z.enum(ALLOWED_METHODS),
  identityValue: z.string().min(1),
  identityType: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const completeSchema = z.object({
  attemptId: z.string().min(1),
  proof: z.object({
    type: z.string().min(1),
    value: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
  }),
});

// =============================================================================
// FACTORY
// =============================================================================

export interface IdentityVerificationRouterDeps {
  verifyIdentity: VerifyIdentity;
  tokenStore: VerificationTokenStore;
  completeVerification: (
    attemptId: string,
    proof: VerificationProof,
  ) => Promise<VerificationResult>;
  /** Optional delivery service for sending OTP codes / magic-link tokens via email. */
  deliveryService?: VerificationDeliveryService;
}

function resolveProjectId(req: Request): string | undefined {
  return typeof req.tenantContext?.projectId === 'string' ? req.tenantContext.projectId : undefined;
}

function resolveSessionPrincipal(req: Request): string | undefined {
  if (typeof req.tenantContext?.sessionPrincipal === 'string') {
    return req.tenantContext.sessionPrincipal;
  }

  return typeof req.tenantContext?.sessionId === 'string' ? req.tenantContext.sessionId : undefined;
}

function resolveGrantScope(req: Request): string {
  const authScope = req.tenantContext?.authScope;
  if (authScope === 'session' || authScope === 'user') {
    return authScope;
  }

  return req.tenantContext?.verifiedUserId ? 'user' : 'session';
}

function resolveTraceId(req: Request): string {
  const requestId = req.headers['x-request-id'];
  if (typeof requestId === 'string' && requestId.trim().length > 0) {
    return requestId;
  }

  return randomUUID();
}

export function createIdentityVerificationRouter(deps: IdentityVerificationRouterDeps): Router {
  const router = Router();

  // All routes require authentication — check tenantContext presence
  router.use((req: Request, res: Response, next) => {
    if (!req.tenantContext?.tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // POST /initiate — Start a verification flow
  // ---------------------------------------------------------------------------
  router.post('/initiate', async (req: Request, res: Response) => {
    try {
      const parsed = initiateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        });
        return;
      }

      const { method, identityValue, identityType, metadata } = parsed.data;
      const ctx = req.tenantContext!;
      const channelType = ((metadata?.channelType as string) ??
        ctx.channelId ??
        'web_chat') as ChannelType;
      const traceId = resolveTraceId(req);

      const result = await deps.verifyIdentity.execute({
        method,
        tenantId: ctx.tenantId,
        projectId: resolveProjectId(req),
        sessionId: ctx.sessionId ?? '',
        sessionPrincipalId: resolveSessionPrincipal(req),
        channelType,
        identityValue,
        identityType: identityType as ChannelArtifactType,
        policySource: 'identity_verification_route',
        grantScope: resolveGrantScope(req),
        traceId,
        metadata,
      });

      // When no delivery service is configured, return the full result unchanged
      // (ALPHA backward-compatible behavior — raw code/token in response)
      if (!deps.deliveryService) {
        res.json(result);
        return;
      }

      // Delivery service is configured — strip raw secrets from challengeData and dispatch
      if (result.success && result.challengeData) {
        const challengeData = { ...result.challengeData };

        if (challengeData.code) {
          const code = challengeData.code as string;
          delete challengeData.code;

          const delivery = await deps.deliveryService.deliverCode('email', identityValue, code);
          challengeData.deliveryStatus = delivery.delivered ? 'sent' : 'failed';

          if (!delivery.delivered) {
            log.warn('OTP code delivery failed', {
              tenantId: ctx.tenantId,
              attemptId: result.attemptId,
              error: delivery.error,
            });
          }
        } else if (challengeData.token) {
          const token = challengeData.token as string;
          delete challengeData.token;

          const delivery = await deps.deliveryService.deliverCode('email', identityValue, token);
          challengeData.deliveryStatus = delivery.delivered ? 'sent' : 'failed';

          if (!delivery.delivered) {
            log.warn('Email-link token delivery failed', {
              tenantId: ctx.tenantId,
              attemptId: result.attemptId,
              error: delivery.error,
            });
          }
        }

        res.json({ ...result, challengeData });
        return;
      }

      res.json(result);
    } catch (error) {
      log.error('Initiate verification failed', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: req.tenantContext?.tenantId,
        method: req.body?.method,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to initiate verification' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /complete — Complete a verification flow with proof
  // ---------------------------------------------------------------------------
  router.post('/complete', async (req: Request, res: Response) => {
    try {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        });
        return;
      }

      const { attemptId, proof } = parsed.data;
      const ctx = req.tenantContext!;
      const traceId = resolveTraceId(req);
      const enrichedProof: VerificationProof = {
        ...proof,
        metadata: {
          ...proof.metadata,
          tenantId: ctx.tenantId,
          projectId: resolveProjectId(req),
          sessionPrincipalId: resolveSessionPrincipal(req),
          traceId,
        },
      } as VerificationProof;
      const result = await deps.completeVerification(attemptId, enrichedProof);

      res.json(result);
    } catch (error) {
      log.error('Complete verification failed', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: req.tenantContext?.tenantId,
        attemptId: req.body?.attemptId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to complete verification' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /:attemptId — Get verification attempt status
  // ---------------------------------------------------------------------------
  router.get('/:attemptId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const attemptId = req.params.attemptId;
      if (!attemptId || attemptId.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'attemptId is required' },
        });
        return;
      }

      const attempt = await deps.tokenStore.get(tenantId, attemptId);
      const projectId = resolveProjectId(req);
      const sessionPrincipalId = resolveSessionPrincipal(req);

      if (
        !attempt ||
        attempt.tenantId !== tenantId ||
        !projectId ||
        !sessionPrincipalId ||
        attempt.projectId !== projectId ||
        attempt.sessionPrincipalId !== sessionPrincipalId
      ) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Verification attempt not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          attemptId: attempt.id,
          status: attempt.status,
          method: attempt.method,
          expiresAt: attempt.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      log.error('Get verification status failed', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: req.tenantContext?.tenantId,
        attemptId: req.params.attemptId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get verification status' },
      });
    }
  });

  return router;
}
