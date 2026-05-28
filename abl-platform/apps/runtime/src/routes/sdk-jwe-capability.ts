/**
 * SDK JWE Capability Route (Project-Scoped)
 *
 * Mounted at /api/projects/:projectId/sdk-jwe-capability
 *
 * Reports coarse runtime readiness for Hosted Exchange JWE activation without
 * exposing key IDs, raw key material, decrypted claims, or tenant internals.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import {
  getRuntimeSdkJweKeyProvider,
  getRuntimeSdkTokenEnvelopeDeps,
} from '../services/identity/sdk-jwe-runtime-config.js';

const log = createLogger('sdk-jwe-capability-route');
const router: RouterType = Router({ mergeParams: true });

const sdkJweCapabilityResponseSchema = z.object({
  success: z.literal(true),
  supported: z.boolean(),
  canIssueBootstrap: z.boolean(),
  canIssueSession: z.boolean(),
  canVerify: z.boolean(),
  blockedReason: z
    .enum([
      'provider_disabled',
      'key_provider_unavailable',
      'transport_budget_unverified',
      'diagnostics_unready',
      'redaction_unverified',
    ])
    .optional(),
  maxEncryptedBootstrapBytes: z.number(),
  maxEncryptedSessionBytes: z.number(),
});

type SdkJweCapabilityResponse = z.infer<typeof sdkJweCapabilityResponseSchema>;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

router.get('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel:read'))) return;

    const capability = getRuntimeSdkJweKeyProvider().getCapability();
    const deps = getRuntimeSdkTokenEnvelopeDeps();
    const projectId = (req.params as Record<string, string>).projectId;

    writeAuditLog({
      action: 'sdk-jwe-capability:inspect',
      userId: req.tenantContext?.userId,
      tenantId: req.tenantContext?.tenantId,
      metadata: {
        projectId,
        supported: capability.supported,
        blockedReason: capability.blockedReason ?? 'none',
      },
    });

    const body: SdkJweCapabilityResponse = {
      success: true,
      supported: capability.supported,
      canIssueBootstrap: capability.canIssueBootstrap,
      canIssueSession: capability.canIssueSession,
      canVerify: capability.canVerify,
      ...(capability.blockedReason ? { blockedReason: capability.blockedReason } : {}),
      maxEncryptedBootstrapBytes: deps.maxEncryptedBootstrapBytes,
      maxEncryptedSessionBytes: deps.maxEncryptedSessionBytes,
    };

    res.json(body);
  } catch (error) {
    log.error('Failed to inspect SDK JWE capability', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'CAPABILITY_FAILED', message: 'Failed to inspect SDK JWE capability' },
    });
  }
});

export default router;
