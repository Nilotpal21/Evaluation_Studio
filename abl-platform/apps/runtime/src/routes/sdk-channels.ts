/**
 * SDK Channels CRUD Route (Project-Scoped)
 *
 * Manages SDK channel configurations.
 * Mounted at /api/projects/:projectId/sdk-channels
 *
 * GET    /                       List SDK channels (with pagination)
 * POST   /                       Create SDK channel
 * GET    /:channelId             Get channel details
 * PATCH  /:channelId             Update channel config
 * DELETE /:channelId             Delete channel
 * POST   /:channelId/token       Deprecated legacy route (returns 410)
 */

import { Router, type Router as RouterType } from 'express';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireConcealedProjectPermission } from '../middleware/rbac.js';
import {
  createSDKChannel,
  findSDKChannels,
  findSDKChannelById,
  updateSDKChannel,
  deleteSDKChannel,
} from '../repos/channel-repo.js';
import { createLogger } from '@abl/compiler/platform';
import {
  cleanupFailedSdkChannelCreate,
  coerceSdkChannelBody,
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

const log = createLogger('sdk-channels-route');

const router: RouterType = Router({ mergeParams: true });

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default pagination limit */
const DEFAULT_LIMIT = 50;
/** Maximum pagination limit */
const MAX_LIMIT = 200;
const LEGACY_SDK_CHANNEL_TOKEN_REMOVAL_MESSAGE =
  'Legacy SDK channel share tokens have been removed. Use Studio preview/share bootstrap artifacts or POST /api/v1/sdk/init with a public key bootstrap.';

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /api/projects/:projectId/sdk-channels
 * List SDK channels for a project with pagination.
 * Query params: ?limit=50&offset=0
 */
router.get('/', async (req, res) => {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parseInt(req.query.offset as string) || 0;

    const channels = await findSDKChannels({ projectId, tenantId });

    // Apply pagination in memory (channel list is bounded per project)
    const total = channels.length;
    const paginated = channels.slice(offset, offset + limit);
    const publicApiKeyLookup = await loadPublicApiKeyLookup(paginated, tenantId, projectId);

    res.json({
      success: true,
      channels: paginated.map((channel) => formatChannelWithApiKey(channel, publicApiKeyLookup)),
      pagination: {
        total,
        limit,
        offset,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list SDK channels', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'LIST_FAILED', message: 'Failed to list SDK channels' },
    });
  }
});

/**
 * POST /api/projects/:projectId/sdk-channels
 * Create a new SDK channel.
 * Body: { name, channelType, publicApiKeyId, deploymentId?, config?, environment?, followEnvironment? }
 */
router.post('/', async (req, res) => {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:create'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const body = coerceSdkChannelBody(req.body);
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
      projectId,
      body,
      allowImplicitDefaultPublicKey: false,
    });
    if (!prepared.ok) {
      res.status(prepared.error.statusCode).json({
        success: false,
        error: { code: prepared.error.code, message: prepared.error.message },
      });
      return;
    }

    const createInput = { ...prepared.value.channel };
    if (!createInput.deploymentId && createInput.environment && createInput.followEnvironment) {
      createInput.deploymentId = await resolveActiveDeploymentIdForEnvironment({
        projectId,
        tenantId,
        environment: createInput.environment,
      });
    }

    const channel = await createSDKChannel(createInput);
    try {
      await syncAllowedOriginsForChannel(channel, tenantId, allowedOrigins.value);
    } catch (syncError) {
      try {
        await cleanupFailedSdkChannelCreate({
          projectId,
          tenantId,
          channelId: channel.id,
        });
      } catch (rollbackError) {
        log.error('Failed to rollback SDK channel create after allowed origins sync failure', {
          channelId: channel.id,
          projectId,
          tenantId,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw syncError;
    }

    log.info('SDK channel created', { channelId: channel.id, tenantId, projectId });

    res.status(201).json({
      success: true,
      channel: await formatSingleChannel(channel, tenantId, projectId),
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
    log.error('Failed to create SDK channel', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create SDK channel' },
    });
  }
});

/**
 * GET /api/projects/:projectId/sdk-channels/:channelId
 * Get a single SDK channel.
 */
router.get('/:channelId', async (req, res) => {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { channelId } = req.params;

    const channel = await findSDKChannelById(channelId, projectId, tenantId);
    if (!channel) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    res.json({
      success: true,
      channel: await formatSingleChannel(channel, tenantId, projectId),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to get SDK channel', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'GET_FAILED', message: 'Failed to get SDK channel' },
    });
  }
});

/**
 * Shared update handler used by both PATCH and PUT (backward compat).
 */
async function handleUpdateChannel(
  req: import('express').Request,
  res: import('express').Response,
) {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { channelId } = req.params;

    const existing = await findSDKChannelById(channelId, projectId, tenantId);
    if (!existing) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
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
      projectId,
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
          projectId,
          tenantId,
          environment: updates.environment,
        });
      }
    }

    const updated = await updateSDKChannel(channelId, projectId, tenantId, updates);
    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'SDK channel not found after update' },
      });
      return;
    }

    try {
      await syncAllowedOriginsForChannel(updated, tenantId, allowedOrigins.value);
    } catch (syncError) {
      try {
        await rollbackFailedSdkChannelUpdate({
          existing,
          tenantId,
          updatePersisted: true,
        });
      } catch (rollbackError) {
        log.error('Failed to rollback SDK channel update after allowed origins sync failure', {
          channelId,
          projectId,
          tenantId,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw syncError;
    }

    log.info('SDK channel updated', { channelId, tenantId });

    res.json({
      success: true,
      channel: await formatSingleChannel(updated, tenantId, projectId),
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
    log.error('Failed to update SDK channel', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update SDK channel' },
    });
  }
}

/**
 * PATCH /api/projects/:projectId/sdk-channels/:channelId
 * Update an SDK channel (partial update).
 */
router.patch('/:channelId', handleUpdateChannel);

/**
 * DELETE /api/projects/:projectId/sdk-channels/:channelId
 * Delete an SDK channel.
 */
router.delete('/:channelId', async (req, res) => {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:delete'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { channelId } = req.params;

    const deleted = await deleteSDKChannel(channelId, projectId, tenantId);
    if (!deleted) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
      return;
    }

    log.info('SDK channel deleted', { channelId, tenantId });
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete SDK channel', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete SDK channel' },
    });
  }
});

/**
 * POST /api/projects/:projectId/sdk-channels/:channelId/token
 * Legacy route removed during SDK session bootstrap consolidation.
 */
router.post('/:channelId/token', async (req, res) => {
  try {
    if (!(await requireConcealedProjectPermission(req, res, 'channel:update'))) return;
    const { channelId } = req.params;
    log.warn('Rejected legacy SDK channel token request', {
      channelId,
      projectId: (req.params as Record<string, string>).projectId,
      tenantId: req.tenantContext!.tenantId,
    });
    res.status(410).json({
      success: false,
      error: {
        code: 'LEGACY_ROUTE_REMOVED',
        message: LEGACY_SDK_CHANNEL_TOKEN_REMOVAL_MESSAGE,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to reject legacy SDK channel token request', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'TOKEN_FAILED', message: 'Failed to reject legacy SDK token route' },
    });
  }
});

export default router;
