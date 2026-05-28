import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  GovernancePolicy,
  GovernancePolicyVersion,
  GovernanceOverride,
} from '@agent-platform/database';
import { requireProjectWideAnalyticsAccess } from '../middleware/rbac.js';
import { GovernanceStatusService } from '../services/governance-status.service.js';
import { GovernanceCache } from '../services/cache/governance-cache.js';
import { evaluateAll } from '../services/governance-frameworks.service.js';
import { periodToDays } from './pipeline-analytics-helpers.js';

const log = createLogger('governance');
const router: RouterType = Router({ mergeParams: true });

router.get('/', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantContext!.tenantId as string;
  const projectId = req.params.projectId;
  if (!(await requireProjectWideAnalyticsAccess(req, res, projectId))) return;

  const period = typeof req.query.period === 'string' ? req.query.period : '7d';

  try {
    const cache = await GovernanceCache.create();
    const statusService = new GovernanceStatusService(cache);
    const status = await statusService.getStatus(tenantId, projectId, period);

    const enabledPolicies = await GovernancePolicy.find({
      tenantId,
      projectId,
      status: 'enabled',
    }).lean();

    const days = periodToDays(period);
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [overrideCount, versionCount] = await Promise.all([
      GovernanceOverride.countDocuments({ tenantId, projectId, createdAt: { $gte: periodStart } }),
      GovernancePolicyVersion.countDocuments({ tenantId, projectId }),
    ]);

    const hasAuditEvents = status.agents.some((a) => a.rules.some((r) => r.status === 'FAIL'));

    const data = evaluateAll({
      status,
      overrideCount,
      enabledPolicies: enabledPolicies as any,
      versionCount,
      hasAuditEvents,
    });

    res.json({ success: true, data });
  } catch (err) {
    log.error('Failed to get frameworks', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      success: false,
      error: { code: 'GOVERNANCE_DATA_UNAVAILABLE', message: 'Frameworks data unavailable' },
    });
  }
});

export default router;
