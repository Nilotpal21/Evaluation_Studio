/**
 * Namespace Membership Route
 *
 * Manages the many-to-many relationship between variables and namespaces.
 * Lists members of a namespace, adds/removes variables, and moves variables
 * between namespaces.
 *
 * Mounted at /api/projects/:projectId/variable-namespaces/:variableNamespaceId/members
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger, MAX_VARIABLE_NAMESPACES_PER_VARIABLE } from '@abl/compiler/platform';
import {
  findVariableNamespaceById,
  findDefaultVariableNamespace,
} from '../repos/variable-namespace-repo.js';
import {
  findMembershipsByVariableNamespace,
  findVariableNamespaceMembershipsByVariable,
  findVariableNamespaceMembershipsByVariableIds,
  addVariableNamespaceMemberships,
  removeVariableNamespaceMembership,
  moveVariableNamespaceMemberships,
  countVariableNamespaceMembershipsForVariable,
} from '../repos/variable-namespace-membership-repo.js';
import { findEnvironmentVariables, findEnvironmentVariableById } from '../repos/security-repo.js';

const log = createLogger('variable-namespace-members-route');

const router: RouterType = Router({ mergeParams: true });

// All routes require authentication + project scope + rate limiting
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

/** Maximum variables per bulk add/move request */
const MAX_BULK_VARIABLES = 100;

// =============================================================================
// GET / — List members of a namespace
// =============================================================================
router.get('/', async (req: any, res: any) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId, variableNamespaceId } = req.params;

    // Validate variable namespace exists and belongs to tenant + project
    const namespace = await findVariableNamespaceById(variableNamespaceId, tenantId);
    if (!namespace || namespace.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Variable namespace not found' });
      return;
    }

    const typeFilter = req.query.type as string | undefined;
    const environment = req.query.environment as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const skip = (page - 1) * limit;

    // Find all memberships for this variable namespace
    const allMemberships = await findMembershipsByVariableNamespace(
      tenantId,
      projectId,
      variableNamespaceId,
    );

    // Separate by type
    let envMemberships = allMemberships.filter((m: any) => m.variableType === 'env');
    let configMemberships = allMemberships.filter((m: any) => m.variableType === 'config');

    if (typeFilter === 'env') {
      configMemberships = [];
    } else if (typeFilter === 'config') {
      envMemberships = [];
    }

    // Batch-fetch env vars
    let envVars: any[] = [];
    if (envMemberships.length > 0) {
      const envIds = envMemberships.map((m: any) => m.variableId);
      const filter: { tenantId: string; projectId: string; environment?: string; _id?: unknown } = {
        _id: { $in: envIds },
        tenantId,
        projectId,
      };
      if (environment) {
        filter.environment = environment;
      }
      envVars = await findEnvironmentVariables(filter as any);
    }

    // Batch-fetch config vars
    let configVars: any[] = [];
    if (configMemberships.length > 0) {
      const configIds = configMemberships.map((m: any) => m.variableId);
      const { ProjectConfigVariable } = await import('@agent-platform/database/models');
      configVars = await ProjectConfigVariable.find({
        _id: { $in: configIds },
        tenantId,
        projectId,
      }).lean();
    }

    // Enrich each variable with its full namespace list
    const allVarIds = [
      ...envVars.map((v: any) => String(v._id)),
      ...configVars.map((v: any) => String(v._id)),
    ];
    const allVarMemberships =
      allVarIds.length > 0
        ? await findVariableNamespaceMembershipsByVariableIds(tenantId, allVarIds)
        : [];

    const nsByVariable: Record<string, string[]> = {};
    for (const m of allVarMemberships) {
      const vid = String(m.variableId);
      if (!nsByVariable[vid]) nsByVariable[vid] = [];
      nsByVariable[vid].push(String(m.namespaceId));
    }

    const enrichedEnvVars = envVars.map((v: any) => ({
      ...v,
      variableNamespaceIds: nsByVariable[String(v._id)] || [],
    }));
    const enrichedConfigVars = configVars.map((v: any) => ({
      ...v,
      variableNamespaceIds: nsByVariable[String(v._id)] || [],
    }));

    // Paginate combined results
    const totalEnv = enrichedEnvVars.length;
    const totalConfig = enrichedConfigVars.length;
    const total = totalEnv + totalConfig;

    const paginatedEnvVars = enrichedEnvVars.slice(skip, skip + limit);
    const paginatedConfigVars = enrichedConfigVars.slice(
      Math.max(0, skip - totalEnv),
      Math.max(0, skip - totalEnv) + Math.max(0, limit - paginatedEnvVars.length),
    );

    res.json({
      success: true,
      envVars: paginatedEnvVars,
      configVars: paginatedConfigVars,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list variable namespace members', { error: message });
    res.status(500).json({ success: false, error: 'Failed to list variable namespace members' });
  }
});

// =============================================================================
// POST / — Add variables to a namespace
// =============================================================================
router.post('/', async (req: any, res: any) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId, variableNamespaceId } = req.params;
    const { variables } = req.body;

    // Validate variable namespace exists
    const namespace = await findVariableNamespaceById(variableNamespaceId, tenantId);
    if (!namespace || namespace.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Variable namespace not found' });
      return;
    }

    if (!Array.isArray(variables) || variables.length === 0) {
      res.status(400).json({ success: false, error: 'variables must be a non-empty array' });
      return;
    }

    if (variables.length > MAX_BULK_VARIABLES) {
      res.status(400).json({
        success: false,
        error: `Maximum of ${MAX_BULK_VARIABLES} variables per request`,
      });
      return;
    }

    let added = 0;
    let skipped = 0;
    const errors: Array<{ variableId: string; reason: string }> = [];

    for (const item of variables) {
      if (
        !item.variableId ||
        !item.variableType ||
        !['env', 'config'].includes(item.variableType)
      ) {
        errors.push({
          variableId: item.variableId || 'unknown',
          reason: 'Invalid variableId or variableType',
        });
        continue;
      }

      // Validate variable exists in same tenant+project
      let variableExists = false;
      if (item.variableType === 'env') {
        const envVar = await findEnvironmentVariableById(item.variableId, tenantId, projectId);
        variableExists = envVar !== null && envVar.projectId === projectId;
      } else {
        const { ProjectConfigVariable } = await import('@agent-platform/database/models');
        const configVar = await ProjectConfigVariable.findOne({
          _id: item.variableId,
          tenantId,
          projectId,
        }).lean();
        variableExists = configVar !== null;
      }

      if (!variableExists) {
        errors.push({ variableId: item.variableId, reason: 'Variable not found in project' });
        continue;
      }

      // Check MAX_VARIABLE_NAMESPACES_PER_VARIABLE
      const membershipCount = await countVariableNamespaceMembershipsForVariable(
        tenantId,
        item.variableId,
        item.variableType,
      );
      if (membershipCount >= MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
        errors.push({
          variableId: item.variableId,
          reason: `MAX_VARIABLE_NAMESPACES_PER_VARIABLE (${MAX_VARIABLE_NAMESPACES_PER_VARIABLE}) exceeded`,
        });
        continue;
      }

      try {
        await addVariableNamespaceMemberships(tenantId, projectId, variableNamespaceId, [
          { variableId: item.variableId, variableType: item.variableType },
        ]);
        added++;
      } catch {
        // Duplicate membership — skip silently
        skipped++;
      }
    }

    res.json({ success: true, added, skipped, errors });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to add variable namespace members', { error: message });
    res.status(500).json({ success: false, error: 'Failed to add variable namespace members' });
  }
});

// =============================================================================
// DELETE /:variableId — Remove a variable from a namespace
// =============================================================================
router.delete('/:variableId', async (req: any, res: any) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId, variableNamespaceId, variableId } = req.params;
    const variableType = req.query.type as 'env' | 'config' | undefined;

    if (!variableType || !['env', 'config'].includes(variableType)) {
      res.status(400).json({
        success: false,
        error: 'Query parameter type is required and must be "env" or "config"',
      });
      return;
    }

    // Validate variable namespace exists
    const namespace = await findVariableNamespaceById(variableNamespaceId, tenantId);
    if (!namespace || namespace.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Variable namespace not found' });
      return;
    }

    // Remove the membership
    await removeVariableNamespaceMembership(
      tenantId,
      variableNamespaceId,
      variableId,
      variableType,
    );

    // Check if this was the last variable namespace for this variable
    let movedToDefault = false;
    const remaining = await countVariableNamespaceMembershipsForVariable(
      tenantId,
      variableId,
      variableType,
    );
    if (remaining === 0) {
      // Auto-add to default variable namespace
      const defaultNs = await findDefaultVariableNamespace(tenantId, projectId);
      if (defaultNs) {
        await addVariableNamespaceMemberships(tenantId, projectId, String(defaultNs._id), [
          { variableId, variableType },
        ]);
        movedToDefault = true;
      }
    }

    res.json({ success: true, movedToDefault });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to remove variable namespace member', { error: message });
    res.status(500).json({ success: false, error: 'Failed to remove variable namespace member' });
  }
});

// =============================================================================
// POST /move — Move variables between namespaces
// =============================================================================
router.post('/move', async (req: any, res: any) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId, variableNamespaceId } = req.params;
    const { targetNamespaceId, variables } = req.body;

    if (!targetNamespaceId || typeof targetNamespaceId !== 'string') {
      res.status(400).json({ success: false, error: 'targetNamespaceId is required' });
      return;
    }

    if (variableNamespaceId === targetNamespaceId) {
      res
        .status(400)
        .json({ success: false, error: 'Source and target variable namespace must be different' });
      return;
    }

    if (!Array.isArray(variables) || variables.length === 0) {
      res.status(400).json({ success: false, error: 'variables must be a non-empty array' });
      return;
    }

    if (variables.length > MAX_BULK_VARIABLES) {
      res.status(400).json({
        success: false,
        error: `Maximum of ${MAX_BULK_VARIABLES} variables per request`,
      });
      return;
    }

    // Validate both variable namespaces exist
    const [sourceNs, targetNs] = await Promise.all([
      findVariableNamespaceById(variableNamespaceId, tenantId),
      findVariableNamespaceById(targetNamespaceId, tenantId),
    ]);

    if (!sourceNs || sourceNs.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Source variable namespace not found' });
      return;
    }
    if (!targetNs || targetNs.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Target variable namespace not found' });
      return;
    }

    // Validate variable entries
    const validVariables: Array<{ variableId: string; variableType: 'env' | 'config' }> = [];
    for (const item of variables) {
      if (
        !item.variableId ||
        !item.variableType ||
        !['env', 'config'].includes(item.variableType)
      ) {
        res.status(400).json({
          success: false,
          error: 'Each variable must have variableId and variableType (env|config)',
        });
        return;
      }
      validVariables.push({ variableId: item.variableId, variableType: item.variableType });
    }

    await moveVariableNamespaceMemberships(
      tenantId,
      projectId,
      variableNamespaceId,
      targetNamespaceId,
      validVariables,
    );

    log.info('Variables moved between variable namespaces', {
      source: variableNamespaceId,
      target: targetNamespaceId,
      moved: validVariables.length,
      projectId,
      tenantId,
    });

    res.json({ success: true, moved: validVariables.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to move variable namespace members', { error: message });
    res.status(500).json({ success: false, error: 'Failed to move variable namespace members' });
  }
});

export default router;
