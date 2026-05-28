/**
 * SDK Token Diagnostics Route (Project-Scoped)
 *
 * Mounted at /api/projects/:projectId/sdk-token-diagnostics
 *
 * POST / - Inspect token envelope metadata without exposing claims or key state.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { writeAuditLog } from '../repos/auth-repo.js';

const log = createLogger('sdk-token-diagnostics-route');
const router: RouterType = Router({ mergeParams: true });

const MAX_DIAGNOSTIC_TOKEN_BYTES = 16 * 1024;

const diagnoseTokenSchema = z
  .object({
    token: z.string().min(1).max(MAX_DIAGNOSTIC_TOKEN_BYTES),
  })
  .strict();

type DiagnosticEnvelope = 'signed' | 'jwe' | 'unknown';

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

function getDiagnosticEnvelope(token: string): DiagnosticEnvelope {
  const segmentCount = token.split('.').length;
  if (segmentCount === 5) return 'jwe';
  if (segmentCount === 3) return 'signed';
  return 'unknown';
}

router.post('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'credential:read'))) return;

    const parsed = diagnoseTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid request body' },
      });
      return;
    }

    const { token } = parsed.data;
    const envelope = getDiagnosticEnvelope(token);
    const projectId = (req.params as Record<string, string>).projectId;

    writeAuditLog({
      action: 'sdk-token-diagnostics:inspect',
      userId: req.tenantContext?.userId,
      tenantId: req.tenantContext?.tenantId,
      metadata: {
        projectId,
        envelope,
      },
    });

    res.json({
      success: true,
      envelope,
      claimsAvailable: false,
    });
  } catch (err: unknown) {
    log.error('Failed to inspect SDK token diagnostics', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'DIAGNOSTICS_FAILED', message: 'Failed to inspect SDK token' },
    });
  }
});

export default router;
