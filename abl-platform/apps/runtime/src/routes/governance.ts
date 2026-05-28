import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  GovernancePolicy,
  GovernancePolicyVersion,
  GovernanceOverride,
  METRIC_REGISTRY,
} from '@agent-platform/database';
import {
  requireProjectWideAnalyticsAccess,
  requireProjectPermission,
  requireGovernanceReadAccess,
} from '../middleware/rbac.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import {
  CreatePolicyBodySchema,
  UpdatePolicyBodySchema,
  CreateOverrideBodySchema,
} from './governance-contracts.js';
import { GovernanceStatusService } from '../services/governance-status.service.js';
import { GovernanceAuditService } from '../services/governance-audit.service.js';
import { GovernanceCache } from '../services/cache/governance-cache.js';
import governanceFrameworksRouter from './governance-frameworks.js';

const log = createLogger('governance');
const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

function getTenantId(req: Request): string {
  return (req as any).tenantContext!.tenantId as string;
}

function getUserId(req: Request): string | null {
  return (req as any).user?.userId ?? (req as any).user?.id ?? null;
}

async function getGovernanceStatusService(): Promise<GovernanceStatusService> {
  const cache = await GovernanceCache.create();
  return new GovernanceStatusService(cache);
}

const auditService = new GovernanceAuditService();

async function governancePolicyNameExists(
  tenantId: string,
  projectId: string,
  name: string,
  excludePolicyId?: string,
): Promise<boolean> {
  const filter: {
    tenantId: string;
    projectId: string;
    name: string;
    _id?: { $ne: string };
  } = {
    tenantId,
    projectId,
    name,
  };

  if (excludePolicyId) {
    filter._id = { $ne: excludePolicyId };
  }

  return (await GovernancePolicy.exists(filter)) !== null;
}

// ─── 1. GET /status ──────────────────────────────────────────────────────────

router.get('/status', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectWideAnalyticsAccess(req, res, projectId))) return;

  const period = typeof req.query.period === 'string' ? req.query.period : '7d';

  try {
    const service = await getGovernanceStatusService();
    const data = await service.getStatus(tenantId, projectId, period);
    res.json({ success: true, data });
  } catch (err) {
    log.error('Failed to get governance status', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      success: false,
      error: { code: 'GOVERNANCE_DATA_UNAVAILABLE', message: 'Governance status unavailable' },
    });
  }
});

// ─── 2. GET /audit ───────────────────────────────────────────────────────────

router.get('/audit', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireGovernanceReadAccess(req, res, projectId))) return;

  const period = typeof req.query.period === 'string' ? req.query.period : '7d';
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));

  const pipelineTypes =
    typeof req.query.pipelineType === 'string' && req.query.pipelineType
      ? req.query.pipelineType.split(',').map((s) => s.trim())
      : undefined;
  const agentNames =
    typeof req.query.agentName === 'string' && req.query.agentName
      ? req.query.agentName.split(',').map((s) => s.trim())
      : undefined;
  const severities =
    typeof req.query.severity === 'string' && req.query.severity
      ? req.query.severity.split(',').map((s) => s.trim())
      : undefined;
  const eventTypes =
    typeof req.query.eventType === 'string' && req.query.eventType
      ? (req.query.eventType.split(',').map((s) => s.trim()) as ('breach' | 'recovery')[])
      : undefined;

  try {
    const data = await auditService.getAuditEvents(tenantId, projectId, period, page, limit, {
      pipelineTypes,
      agentNames,
      severities,
      eventTypes,
    });
    res.json({ success: true, data });
  } catch (err) {
    log.error('Failed to get audit events', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      success: false,
      error: { code: 'GOVERNANCE_DATA_UNAVAILABLE', message: 'Audit data unavailable' },
    });
  }
});

// ─── 3. POST /audit/:eventRef/override ──────────────────────────────────────

router.post('/audit/:eventRef/override', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectPermission(req, res, 'governance:write', projectId))) return;

  const parsed = CreateOverrideBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'GOVERNANCE_VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }

  const eventRef = decodeURIComponent(req.params.eventRef);
  const userId = getUserId(req);

  try {
    const override = await GovernanceOverride.create({
      tenantId,
      projectId,
      eventRef,
      reviewedBy: userId,
      justification: parsed.data.justification,
      originalSeverity: parsed.data.originalSeverity,
      policyVersion: parsed.data.policyVersion,
    });

    writeAuditLog({
      action: 'governance_override.create',
      userId,
      tenantId,
      metadata: {
        resourceType: 'governance_override',
        resourceId: String(override._id),
        eventRef,
        reviewedBy: userId,
      },
    });

    res.status(201).json({ success: true, data: { _id: String(override._id) } });
  } catch (err: unknown) {
    if ((err as any)?.code === 11000) {
      res.status(409).json({
        success: false,
        error: {
          code: 'GOVERNANCE_OVERRIDE_EXISTS',
          message: 'Override already exists for this event',
        },
      });
      return;
    }
    log.error('Failed to create override', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create override' },
    });
  }
});

// ─── 4. GET /report.csv ──────────────────────────────────────────────────────

router.get('/report.csv', async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (!(await requireGovernanceReadAccess(req, res, projectId))) return;

  // Lazy import to avoid loading pdfkit/papaparse unless reports are used
  const { GovernanceReportService } = await import('../services/governance-report.service.js');
  const svc = new GovernanceReportService(auditService);
  const tenantId = getTenantId(req);
  const period = typeof req.query.period === 'string' ? req.query.period : '7d';

  try {
    await svc.streamCsvReport(tenantId, projectId, period, res);
  } catch (err) {
    log.error('CSV report failed', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: { code: 'GOVERNANCE_REPORT_FAILED', message: 'CSV generation failed' },
      });
    }
  }
});

// ─── 5. GET /report.pdf ──────────────────────────────────────────────────────

router.get('/report.pdf', async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (!(await requireGovernanceReadAccess(req, res, projectId))) return;

  const { GovernanceReportService } = await import('../services/governance-report.service.js');
  const svc = new GovernanceReportService(auditService);
  const tenantId = getTenantId(req);
  const period = typeof req.query.period === 'string' ? req.query.period : '7d';

  try {
    await svc.streamPdfReport(tenantId, projectId, period, res);
  } catch (err) {
    log.error('PDF report failed', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: { code: 'GOVERNANCE_REPORT_FAILED', message: 'PDF generation failed' },
      });
    }
  }
});

// ─── 6. /frameworks sub-router (before parameterized routes) ─────────────────

router.use('/frameworks', governanceFrameworksRouter);

// ─── 7. GET /policies ────────────────────────────────────────────────────────

router.get('/policies', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectWideAnalyticsAccess(req, res, projectId))) return;

  try {
    const policies = await GovernancePolicy.find({ tenantId, projectId }).lean();
    res.json({ success: true, data: policies });
  } catch (err) {
    log.error('Failed to list policies', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list policies' },
    });
  }
});

// ─── 8. POST /policies ───────────────────────────────────────────────────────

router.post('/policies', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectPermission(req, res, 'governance:write', projectId))) return;

  const parsed = CreatePolicyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'GOVERNANCE_VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }

  // Validate metric names against METRIC_REGISTRY
  for (const rule of parsed.data.rules) {
    const validMetrics = METRIC_REGISTRY[rule.pipelineType];
    if (!validMetrics || !validMetrics.includes(rule.metric)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'GOVERNANCE_VALIDATION_ERROR',
          message: `Metric '${rule.metric}' is not valid for pipeline type '${rule.pipelineType}'`,
        },
      });
      return;
    }
  }

  const userId = getUserId(req);

  try {
    if (await governancePolicyNameExists(tenantId, projectId, parsed.data.name)) {
      res.status(409).json({
        success: false,
        error: {
          code: 'GOVERNANCE_POLICY_EXISTS',
          message: 'A policy with this name already exists in this project',
        },
      });
      return;
    }

    const policy = await GovernancePolicy.create({
      tenantId,
      projectId,
      name: parsed.data.name,
      description: parsed.data.description,
      rules: parsed.data.rules,
      status: parsed.data.status ?? 'enabled',
      createdBy: userId,
      version: 1,
    });

    writeAuditLog({
      action: 'governance_policy.create',
      userId,
      tenantId,
      metadata: {
        resourceType: 'governance_policy',
        resourceId: String(policy._id),
        name: policy.name,
      },
    });

    res.status(201).json({ success: true, data: policy.toObject() });
  } catch (err: unknown) {
    if ((err as any)?.code === 11000) {
      res.status(409).json({
        success: false,
        error: {
          code: 'GOVERNANCE_POLICY_EXISTS',
          message: 'A policy with this name already exists in this project',
        },
      });
      return;
    }
    log.error('Failed to create policy', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create policy' },
    });
  }
});

// ─── 9. GET /policies/:policyId ──────────────────────────────────────────────

router.get('/policies/:policyId', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectWideAnalyticsAccess(req, res, projectId))) return;

  try {
    const policy = await GovernancePolicy.findOne({
      _id: req.params.policyId,
      tenantId,
      projectId,
    }).lean();
    if (!policy) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
      return;
    }
    res.json({ success: true, data: policy });
  } catch (err) {
    log.error('Failed to get policy', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get policy' },
    });
  }
});

// ─── 10. PUT /policies/:policyId ─────────────────────────────────────────────

router.put('/policies/:policyId', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectPermission(req, res, 'governance:write', projectId))) return;

  const parsed = UpdatePolicyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'GOVERNANCE_VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }

  // Validate metric names
  for (const rule of parsed.data.rules) {
    const validMetrics = METRIC_REGISTRY[rule.pipelineType];
    if (!validMetrics || !validMetrics.includes(rule.metric)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'GOVERNANCE_VALIDATION_ERROR',
          message: `Metric '${rule.metric}' is not valid for pipeline type '${rule.pipelineType}'`,
        },
      });
      return;
    }
  }

  const userId = getUserId(req);

  try {
    // Read current version for optimistic concurrency check
    const original = await GovernancePolicy.findOne({
      _id: req.params.policyId,
      tenantId,
      projectId,
    }).lean();
    if (!original) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
      return;
    }

    if (
      parsed.data.name !== original.name &&
      (await governancePolicyNameExists(
        tenantId,
        projectId,
        parsed.data.name,
        String(original._id),
      ))
    ) {
      res.status(409).json({
        success: false,
        error: {
          code: 'GOVERNANCE_POLICY_EXISTS',
          message: 'A policy with this name already exists in this project',
        },
      });
      return;
    }

    // Version-check atomic update — returns null if another writer changed version
    const updated = await GovernancePolicy.findOneAndUpdate(
      { _id: req.params.policyId, tenantId, projectId, version: original.version },
      {
        $set: {
          name: parsed.data.name,
          description: parsed.data.description,
          rules: parsed.data.rules,
          status: parsed.data.status ?? original.status,
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean();

    if (!updated) {
      res.status(409).json({
        success: false,
        error: { code: 'GOVERNANCE_CONFLICT', message: 'Policy was modified by another request' },
      });
      return;
    }

    // Append snapshot for thresholdAtTime resolution
    try {
      await GovernancePolicyVersion.create({
        tenantId,
        projectId,
        policyId: String(updated._id),
        version: updated.version,
        rules: updated.rules,
        createdAt: new Date(),
      });
    } catch (snapshotErr) {
      // Compensating restore
      log.error('Policy version snapshot failed — restoring original', {
        error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
      });
      try {
        await GovernancePolicy.findOneAndUpdate(
          { _id: req.params.policyId, tenantId, projectId },
          { $set: { rules: original.rules, version: original.version } },
        );
      } catch (restoreErr) {
        log.error('Compensating restore also failed — manual cleanup needed', {
          policyId: req.params.policyId,
          error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
      }
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to save policy version snapshot' },
      });
      return;
    }

    // Invalidate cache
    const cache = await GovernanceCache.create();
    await cache.invalidate(tenantId, projectId);

    writeAuditLog({
      action: 'governance_policy.update',
      userId,
      tenantId,
      metadata: {
        resourceType: 'governance_policy',
        resourceId: String(updated._id),
        version: updated.version,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    if ((err as { code?: number } | null)?.code === 11000) {
      res.status(409).json({
        success: false,
        error: {
          code: 'GOVERNANCE_POLICY_EXISTS',
          message: 'A policy with this name already exists in this project',
        },
      });
      return;
    }

    log.error('Failed to update policy', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update policy' },
    });
  }
});

// ─── 11. DELETE /policies/:policyId ──────────────────────────────────────────

router.delete('/policies/:policyId', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const projectId = req.params.projectId;
  if (!(await requireProjectPermission(req, res, 'governance:write', projectId))) return;

  const userId = getUserId(req);

  try {
    const result = await GovernancePolicy.deleteOne({
      _id: req.params.policyId,
      tenantId,
      projectId,
    });
    if (result.deletedCount === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
      return;
    }

    // Clean up version snapshots
    await GovernancePolicyVersion.deleteMany({
      tenantId,
      projectId,
      policyId: req.params.policyId,
    });

    // Invalidate cache
    const cache = await GovernanceCache.create();
    await cache.invalidate(tenantId, projectId);

    writeAuditLog({
      action: 'governance_policy.delete',
      userId,
      tenantId,
      metadata: {
        resourceType: 'governance_policy',
        resourceId: req.params.policyId,
      },
    });

    res.status(204).end();
  } catch (err) {
    log.error('Failed to delete policy', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete policy' },
    });
  }
});

export default router;
