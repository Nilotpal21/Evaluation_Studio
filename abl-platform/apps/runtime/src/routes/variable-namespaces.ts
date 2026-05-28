/**
 * Namespace CRUD Route
 *
 * Manages variable namespaces (organizational grouping for env/config variables).
 * Each project gets a "default" namespace automatically; users can create up to 25.
 *
 * Mounted at /api/projects/:projectId/namespaces
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger, MAX_VARIABLE_NAMESPACES_PER_PROJECT } from '@abl/compiler/platform';
import {
  DEFAULT_VARIABLE_NAMESPACE_NAME,
  DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME,
} from '@abl/compiler/platform';
import { findProjectByIdAndTenant } from '../repos/project-repo.js';
import {
  createVariableNamespace,
  findVariableNamespaces,
  findVariableNamespaceById,
  findDefaultVariableNamespace,
  updateVariableNamespace,
  deleteVariableNamespace,
  countVariableNamespaces,
  reorderVariableNamespaces,
  getVariableNamespaceMemberCounts,
} from '../repos/variable-namespace-repo.js';
import {
  findMembershipsByVariableNamespace,
  findVariableNamespaceMembershipsByVariable,
  addVariableNamespaceMemberships,
  deleteAllMembershipsForVariableNamespace,
} from '../repos/variable-namespace-membership-repo.js';

const log = createLogger('variable-namespaces-route');

const router: RouterType = Router({ mergeParams: true });

// All namespace routes require authentication + project scope + rate limiting
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

/** Valid namespace name: lowercase letters, digits, hyphens; must start with a letter */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// =============================================================================
// GET / — List namespaces for a project
// =============================================================================
router.get('/', async (req: any, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId } = req.params;

    // Validate project exists before doing anything
    const project = await findProjectByIdAndTenant(projectId, tenantId);
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    let namespaces = await findVariableNamespaces(tenantId, projectId);

    // Auto-provision default variable namespace for projects that don't have one yet
    if (namespaces.length === 0) {
      try {
        await createVariableNamespace({
          tenantId,
          projectId,
          name: DEFAULT_VARIABLE_NAMESPACE_NAME,
          displayName: DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME,
          isDefault: true,
          order: 0,
          createdBy: 'system:auto-provision',
        });
        namespaces = await findVariableNamespaces(tenantId, projectId);
      } catch (provisionErr: unknown) {
        // Race condition: another request may have created it
        log.debug('Default variable namespace auto-provision failed (may already exist)', {
          error: provisionErr instanceof Error ? provisionErr.message : String(provisionErr),
        });
        namespaces = await findVariableNamespaces(tenantId, projectId);
      }
    }

    // Enrich with member counts
    const nsIds = namespaces.map((ns: any) => String(ns._id));
    const counts =
      nsIds.length > 0 ? await getVariableNamespaceMemberCounts(tenantId, projectId, nsIds) : {};

    const enriched = namespaces.map((ns: any) => ({
      ...ns,
      memberCounts: counts[String(ns._id)] || { env: 0, config: 0 },
    }));

    res.json({ success: true, namespaces: enriched });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list variable namespaces', { error: message });
    res.status(500).json({ success: false, error: 'Failed to list variable namespaces' });
  }
});

// =============================================================================
// POST / — Create a new namespace
// =============================================================================
router.post('/', async (req: any, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:create'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const { projectId } = req.params;
    const { name, displayName, description, icon, color } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }
    if (!displayName || typeof displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required' });
      return;
    }

    // Validate name format
    if (name.length < 1 || name.length > 50 || !NAME_PATTERN.test(name)) {
      res.status(400).json({
        success: false,
        error: 'name must be 1-50 lowercase chars, start with a letter, and contain only [a-z0-9-]',
      });
      return;
    }

    // Validate displayName length
    if (displayName.length < 1 || displayName.length > 100) {
      res.status(400).json({
        success: false,
        error: 'displayName must be 1-100 characters',
      });
      return;
    }

    // Cannot create a variable namespace called 'default'
    if (name === 'default') {
      res.status(400).json({
        success: false,
        error: "Cannot create a variable namespace named 'default'; it is reserved",
      });
      return;
    }

    // Color is validated by the VariableNamespace Mongoose schema; no inline check.

    // Check variable namespace count limit
    const count = await countVariableNamespaces(tenantId, projectId);
    if (count >= MAX_VARIABLE_NAMESPACES_PER_PROJECT) {
      res.status(400).json({
        success: false,
        error: `Maximum of ${MAX_VARIABLE_NAMESPACES_PER_PROJECT} variable namespaces per project reached`,
      });
      return;
    }

    const namespace = await createVariableNamespace({
      tenantId,
      projectId,
      name,
      displayName,
      description: description ?? null,
      icon: icon ?? null,
      color: color ?? null,
      order: count,
      isDefault: false,
      createdBy: userId!,
    });

    log.info('Variable namespace created', { name, projectId, tenantId });

    res.status(201).json({ success: true, namespace });
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        error: `A namespace named '${req.body.name}' already exists in this project`,
      });
      return;
    }
    if (err instanceof Error && err.name === 'ValidationError') {
      const fieldErrors = (err as any).errors as Record<string, { message: string }> | undefined;
      const message = fieldErrors
        ? (Object.values(fieldErrors)[0]?.message ?? err.message)
        : err.message;
      res.status(400).json({ success: false, error: message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to create variable namespace', { error: message });
    res.status(500).json({ success: false, error: 'Failed to create variable namespace' });
  }
});

// =============================================================================
// PUT /reorder — Reorder namespaces (must be before /:namespaceId)
// =============================================================================
router.put('/reorder', async (req: any, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId } = req.params;
    const { order } = req.body;

    if (!Array.isArray(order)) {
      res.status(400).json({ success: false, error: 'order must be an array' });
      return;
    }

    for (const item of order) {
      if (!item.namespaceId || typeof item.order !== 'number') {
        res.status(400).json({
          success: false,
          error: 'Each item must have namespaceId (string) and order (number)',
        });
        return;
      }
    }

    await reorderVariableNamespaces(tenantId, projectId, order);

    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to reorder variable namespaces', { error: message });
    res.status(500).json({ success: false, error: 'Failed to reorder variable namespaces' });
  }
});

// =============================================================================
// PUT /:variableNamespaceId — Update a variable namespace
// =============================================================================
router.put('/:variableNamespaceId', async (req: any, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const { variableNamespaceId } = req.params;
    const { displayName, description, icon, color } = req.body;

    const existing = await findVariableNamespaceById(variableNamespaceId, tenantId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Variable namespace not found' });
      return;
    }

    // Default variable namespace: cannot update displayName or name
    if (existing.isDefault && displayName !== undefined) {
      res.status(400).json({
        success: false,
        error: 'Cannot update displayName of the default variable namespace',
      });
      return;
    }

    // Color is validated by the VariableNamespace Mongoose schema; no inline check.

    // Validate displayName length if provided
    if (
      displayName !== undefined &&
      (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 100)
    ) {
      res.status(400).json({ success: false, error: 'displayName must be 1-100 characters' });
      return;
    }

    const updateData: Record<string, any> = { updatedBy: userId };
    if (displayName !== undefined) updateData.displayName = displayName;
    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (color !== undefined) updateData.color = color;

    const namespace = await updateVariableNamespace(variableNamespaceId, tenantId, updateData);

    res.json({ success: true, namespace });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ValidationError') {
      const fieldErrors = (err as any).errors as Record<string, { message: string }> | undefined;
      const message = fieldErrors
        ? (Object.values(fieldErrors)[0]?.message ?? err.message)
        : err.message;
      res.status(400).json({ success: false, error: message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update variable namespace', { error: message });
    res.status(500).json({ success: false, error: 'Failed to update variable namespace' });
  }
});

// =============================================================================
// DELETE /:variableNamespaceId — Delete a variable namespace (moves orphaned variables to default)
// =============================================================================
router.delete('/:variableNamespaceId', async (req: any, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'namespace:delete'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { projectId, variableNamespaceId } = req.params;

    const existing = await findVariableNamespaceById(variableNamespaceId, tenantId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Variable namespace not found' });
      return;
    }

    if (existing.isDefault) {
      res
        .status(400)
        .json({ success: false, error: 'Cannot delete the default variable namespace' });
      return;
    }

    const defaultNs = await findDefaultVariableNamespace(tenantId, projectId);
    if (!defaultNs) {
      res.status(500).json({ success: false, error: 'Default variable namespace not found' });
      return;
    }

    let movedToDefault = 0;

    // 1. Find all memberships for this variable namespace
    const memberships = await findMembershipsByVariableNamespace(
      tenantId,
      projectId,
      variableNamespaceId,
    );

    // 2. For each member, check if it has other memberships; if orphaned, move to default
    for (const membership of memberships) {
      const allMemberships = await findVariableNamespaceMembershipsByVariable(
        tenantId,
        membership.variableId,
        membership.variableType,
      );
      const otherMemberships = allMemberships.filter(
        (m: any) => String(m.namespaceId) !== variableNamespaceId,
      );
      if (otherMemberships.length === 0) {
        await addVariableNamespaceMemberships(tenantId, projectId, String(defaultNs._id), [
          { variableId: membership.variableId, variableType: membership.variableType },
        ]);
        movedToDefault++;
      }
    }

    // 3. Delete all memberships for this variable namespace
    await deleteAllMembershipsForVariableNamespace(variableNamespaceId);

    // 4. Delete the variable namespace
    await deleteVariableNamespace(variableNamespaceId, tenantId);

    log.info('Variable namespace deleted', {
      variableNamespaceId,
      projectId,
      tenantId,
      movedToDefault,
    });

    res.json({ success: true, movedToDefault });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete variable namespace', { error: message });
    res.status(500).json({ success: false, error: 'Failed to delete variable namespace' });
  }
});

export default router;
