/**
 * Tenant SDK Channels Admin Route
 *
 * Tenant-scoped management of SDK channels across all projects.
 * Used by the Studio admin panel (Connectors page).
 *
 * This is a thin admin layer. The project-scoped route (sdk-channels.ts)
 * is the canonical CRUD route with full validation, pagination, and
 * token generation. This route exists solely so the admin UI can
 * list/create/update/delete channels without knowing the projectId upfront.
 *
 * Mount: /api/tenants/:tenantId/sdk-channels
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { createLogger } from '@abl/compiler/platform';
import {
  findSDKChannelsByTenant,
  findSDKChannelByIdForTenant,
  createSDKChannel,
  updateSDKChannel,
  deleteSDKChannel,
  type SDKChannelDoc,
} from '../repos/channel-repo.js';
import {
  cleanupFailedSdkChannelCreate,
  coerceSdkChannelBody,
  ensureDedicatedPublicApiKeyForAllowedOrigins,
  formatChannelWithApiKey,
  parseAllowedOriginsUpdate,
  prepareSdkChannelCreateInput,
  prepareSdkChannelUpdateInput,
  rollbackFailedSdkChannelUpdate,
  resolveSdkChannelMutationError,
  resolveActiveDeploymentIdForEnvironment,
  formatSingleChannel,
  syncAllowedOriginsForChannel,
  loadPublicApiKeyLookup,
} from './sdk-channel-mutation-utils.js';
import {
  evaluateProjectPermission,
  requireConcealedProjectPermission,
} from '../middleware/rbac.js';

const log = createLogger('tenant-sdk-channels-route');

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

/**
 * GET /
 * List all SDK channels across all projects for this tenant.
 */
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const channels = await findSDKChannelsByTenant(tenantId);
    const readableProjectIds = new Set<string>();

    await Promise.all(
      [...new Set(channels.map((channel) => channel.projectId))].map(async (projectId) => {
        const access = await evaluateProjectPermission(req, 'channel:read', projectId, {
          concealNotMember: true,
        });
        if (access.allowed) {
          readableProjectIds.add(projectId);
        }
      }),
    );

    const visibleChannels = channels.filter((channel) => readableProjectIds.has(channel.projectId));
    const publicApiKeyLookup = await loadPublicApiKeyLookup(visibleChannels, tenantId);

    res.json({
      success: true,
      data: visibleChannels.map((channel) => formatChannelWithApiKey(channel, publicApiKeyLookup)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list tenant SDK channels', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'LIST_FAILED', message: 'Failed to list SDK channels' },
    });
  }
});

/**
 * POST /
 * Create a new SDK channel. Requires projectId in body.
 */
router.post('/', async (req, res) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const body = coerceSdkChannelBody(req.body);
    const projectId = body.projectId;
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PROJECT', message: 'Missing required field: projectId' },
      });
      return;
    }

    if (!(await requireConcealedProjectPermission(req, res, 'channel:create', projectId.trim()))) {
      return;
    }

    const allowedOrigins = parseAllowedOriginsUpdate(body);
    if (!allowedOrigins.ok) {
      res.status(allowedOrigins.error.statusCode).json({
        success: false,
        error: { code: allowedOrigins.error.code, message: allowedOrigins.error.message },
      });
      return;
    }

    const prepared = await prepareSdkChannelCreateInput({
      tenantId,
      projectId: projectId.trim(),
      body,
      defaultChannelType: 'web',
      allowImplicitDefaultPublicKey: true,
    });
    if (!prepared.ok) {
      res.status(prepared.error.statusCode).json({
        success: false,
        error: { code: prepared.error.code, message: prepared.error.message },
      });
      return;
    }

    let channelId: string | undefined;
    const channelInput = prepared.value.channel;
    const createdPublicApiKeyId = prepared.value.createdPublicApiKeyId;
    let channel: SDKChannelDoc | null = null;
    try {
      channel = await createSDKChannel(channelInput);
      channelId = channel.id;
      await syncAllowedOriginsForChannel(channel, tenantId, allowedOrigins.value);
    } catch (syncError) {
      try {
        await cleanupFailedSdkChannelCreate({
          projectId: channelInput.projectId,
          tenantId,
          channelId,
          createdPublicApiKeyId,
        });
      } catch (rollbackError) {
        log.error(
          'Failed to rollback tenant SDK channel create after allowed origins sync failure',
          {
            channelId,
            projectId: channelInput.projectId,
            tenantId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        );
      }
      throw syncError;
    }
    if (!channel) {
      throw new Error('Failed to create SDK channel');
    }

    log.info('SDK channel created (admin)', {
      channelId: channel.id,
      tenantId,
      projectId: channelInput.projectId,
    });

    res.status(201).json({
      success: true,
      data: await formatSingleChannel(channel, tenantId),
      ...(prepared.value.generatedServerSecret
        ? { serverSecret: prepared.value.generatedServerSecret }
        : {}),
    });
  } catch (err: unknown) {
    const routeError = resolveSdkChannelMutationError(err);
    if (routeError) {
      res.status(routeError.statusCode).json({
        success: false,
        error: { code: routeError.code, message: routeError.message },
      });
      return;
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_NAME',
          message: 'A channel with this name already exists in this project',
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to create SDK channel (admin)', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create SDK channel' },
    });
  }
});

/**
 * GET /:channelId
 * Fetch an SDK channel (tenant-scoped lookup).
 */
router.get('/:channelId', async (req, res) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { channelId } = req.params;

    const existing = await findSDKChannelByIdForTenant(channelId, tenantId);
    if (!existing) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    if (!(await requireConcealedProjectPermission(req, res, 'channel:read', existing.projectId))) {
      return;
    }

    res.json({
      success: true,
      data: await formatSingleChannel(existing, tenantId),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to get SDK channel (admin)', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'GET_FAILED', message: 'Failed to get SDK channel' },
    });
  }
});

async function handleTenantChannelUpdate(
  req: import('express').Request,
  res: import('express').Response,
) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { channelId } = req.params;

    const existing = await findSDKChannelByIdForTenant(channelId, tenantId);
    if (!existing) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    if (
      !(await requireConcealedProjectPermission(req, res, 'channel:update', existing.projectId))
    ) {
      return;
    }

    const body = coerceSdkChannelBody(req.body);
    const allowedOrigins = parseAllowedOriginsUpdate(body);
    if (!allowedOrigins.ok) {
      res.status(allowedOrigins.error.statusCode).json({
        success: false,
        error: { code: allowedOrigins.error.code, message: allowedOrigins.error.message },
      });
      return;
    }

    const prepared = await prepareSdkChannelUpdateInput({
      tenantId,
      projectId: existing.projectId,
      body,
      existing,
    });
    if (!prepared.ok) {
      res.status(prepared.error.statusCode).json({
        success: false,
        error: { code: prepared.error.code, message: prepared.error.message },
      });
      return;
    }

    const updates = { ...prepared.value.updates };
    if (updates.environment !== undefined) {
      const effectiveFollowEnvironment = updates.followEnvironment ?? existing.followEnvironment;
      if (updates.environment !== null && effectiveFollowEnvironment) {
        updates.deploymentId = await resolveActiveDeploymentIdForEnvironment({
          projectId: existing.projectId,
          tenantId,
          environment: updates.environment,
        });
      }
    }

    let createdPublicApiKeyId: string | undefined;
    if (
      allowedOrigins.value !== undefined &&
      !Object.prototype.hasOwnProperty.call(body, 'publicApiKeyId')
    ) {
      const dedicatedKey = await ensureDedicatedPublicApiKeyForAllowedOrigins(existing, tenantId);
      if (dedicatedKey.createdPublicApiKeyId) {
        updates.publicApiKeyId = dedicatedKey.publicApiKeyId;
        createdPublicApiKeyId = dedicatedKey.createdPublicApiKeyId;
      }
    }

    let updatePersisted = false;
    let updated: SDKChannelDoc | null = null;
    try {
      updated = await updateSDKChannel(channelId, existing.projectId, tenantId, updates);
      if (!updated) {
        if (createdPublicApiKeyId) {
          await rollbackFailedSdkChannelUpdate({
            existing,
            tenantId,
            updatePersisted: false,
            createdPublicApiKeyId,
          });
        }
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'SDK channel not found after update' },
        });
        return;
      }
      updatePersisted = true;
      await syncAllowedOriginsForChannel(updated, tenantId, allowedOrigins.value);
    } catch (syncError) {
      try {
        await rollbackFailedSdkChannelUpdate({
          existing,
          tenantId,
          updatePersisted,
          createdPublicApiKeyId,
        });
      } catch (rollbackError) {
        log.error(
          'Failed to rollback tenant SDK channel update after allowed origins sync failure',
          {
            channelId,
            projectId: existing.projectId,
            tenantId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        );
      }
      throw syncError;
    }

    log.info('SDK channel updated (admin)', { channelId, tenantId });
    res.json({
      success: true,
      data: await formatSingleChannel(updated, tenantId),
      ...(prepared.value.generatedServerSecret
        ? { serverSecret: prepared.value.generatedServerSecret }
        : {}),
    });
  } catch (err: unknown) {
    const routeError = resolveSdkChannelMutationError(err);
    if (routeError) {
      res.status(routeError.statusCode).json({
        success: false,
        error: { code: routeError.code, message: routeError.message },
      });
      return;
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_NAME',
          message: 'A channel with this name already exists in this project',
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update SDK channel (admin)', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update SDK channel' },
    });
  }
}

router.put('/:channelId', handleTenantChannelUpdate);
router.patch('/:channelId', handleTenantChannelUpdate);

/**
 * DELETE /:channelId
 * Delete an SDK channel (tenant-scoped lookup).
 */
router.delete('/:channelId', async (req, res) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { channelId } = req.params;

    const existing = await findSDKChannelByIdForTenant(channelId, tenantId);
    if (!existing) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    if (
      !(await requireConcealedProjectPermission(req, res, 'channel:delete', existing.projectId))
    ) {
      return;
    }

    const deleted = await deleteSDKChannel(channelId, existing.projectId, tenantId);
    if (!deleted) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    log.info('SDK channel deleted (admin)', { channelId, tenantId });
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete SDK channel (admin)', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete SDK channel' },
    });
  }
});

export default router;
