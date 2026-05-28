/**
 * Connector Discovery & Recommendation Routes
 *
 * Endpoints for auto-discovering resources, generating recommendations,
 * accepting/rejecting recommendations, and one-click quick setup.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { getLazyModel } from '../db/index.js';
import type {
  IConnectorConfig,
  IConnectorDiscovery,
  IConnectorRecommendation,
} from '@agent-platform/database/models';
import {
  triggerDiscovery,
  generateRecommendations,
  acceptRecommendation,
} from '../services/setup/quick-setup-orchestrator.js';
import { createQueue } from '../workers/shared.js';
import { QUEUE_CONNECTOR_DISCOVERY } from '../workers/connector-discovery-worker.js';
import { createLogger } from '@abl/compiler/platform';
import { requireConnectorAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-discovery');

// Models bound to platform database
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
const ConnectorRecommendation = getLazyModel<IConnectorRecommendation>('ConnectorRecommendation');

const router: RouterType = Router();
router.use('/connectors/:connectorId', requireConnectorAccessFromParams());

// ─── Discovery ──────────────────────────────────────────────────────────

/**
 * POST /connectors/:connectorId/discover — Trigger resource discovery
 *
 * Body: { mode?: 'discover_only' | 'discover_and_profile' | 'quick_setup', sampleSize?: number }
 */
router.post('/connectors/:connectorId/discover', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { mode = 'discover_and_profile', sampleSize } = req.body;

    // Validate mode
    const validModes = ['discover_only', 'discover_and_profile', 'quick_setup'];
    if (!validModes.includes(mode)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_MODE', message: `mode must be one of: ${validModes.join(', ')}` },
      });
      return;
    }

    // Load connector
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    // Verify authentication
    if (!connector.oauthTokenId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NOT_AUTHENTICATED',
          message: 'Connector must be authenticated before discovery',
        },
      });
      return;
    }

    const result = await triggerDiscovery(
      connectorId,
      tenantId,
      connector.connectorType,
      mode,
      sampleSize,
    );

    res.json({
      success: true,
      data: {
        discoveryId: result.discoveryId,
        jobId: result.jobId,
        status: 'pending',
        message: 'Discovery job queued',
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to trigger discovery', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'DISCOVERY_FAILED', message: errMsg },
    });
  }
});

/**
 * GET /connectors/:connectorId/discovery — Get latest discovery results
 */
router.get('/connectors/:connectorId/discovery', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const discovery = await ConnectorDiscovery.findOne({ connectorId, tenantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!discovery) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No discovery found for this connector' },
      });
      return;
    }

    res.json({ success: true, data: discovery });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get discovery', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
    });
  }
});

/**
 * GET /connectors/:connectorId/discovered-sites — Get discovered sites with search
 *
 * Query params: { search?: string, page?: number, limit?: number }
 */
router.get('/connectors/:connectorId/discovered-sites', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { search = '', page = '1', limit = '50' } = req.query;

    // Parse pagination
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // Get latest discovery
    const discovery = await ConnectorDiscovery.findOne({ connectorId, tenantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!discovery) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No discovery found for this connector' },
      });
      return;
    }

    // Filter sites (resourceType === 'site' for SharePoint)
    let sites = discovery.resources.filter((r) => r.resourceType === 'site');

    // Apply search filter if provided
    if (search) {
      const searchLower = (search as string).toLowerCase();
      sites = sites.filter(
        (site) =>
          site.name.toLowerCase().includes(searchLower) ||
          site.displayName.toLowerCase().includes(searchLower) ||
          site.url.toLowerCase().includes(searchLower),
      );
    }

    // Sort by name
    sites.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Apply pagination
    const total = sites.length;
    const paginatedSites = sites.slice(skip, skip + limitNum);

    // Enrich with profile data if available
    const enrichedSites = paginatedSites.map((site) => {
      const profile = discovery.profiles.find((p) => p.resourceId === site.id);
      return {
        id: site.id,
        name: site.name,
        displayName: site.displayName,
        url: site.url,
        metadata: site.metadata,
        profile: profile
          ? {
              totalDocuments: profile.totalDocuments,
              totalSizeBytes: profile.totalSizeBytes,
              fileTypeDistribution: profile.fileTypeDistribution,
              updateFrequency: profile.updateFrequency,
              lastActivityDate: profile.dateRange.latest,
            }
          : null,
      };
    });

    res.json({
      success: true,
      data: {
        sites: enrichedSites,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get discovered sites', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
    });
  }
});

/**
 * GET /connectors/:connectorId/discovery/:discoveryId — Get specific discovery
 */
router.get(
  '/connectors/:connectorId/discovery/:discoveryId',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, discoveryId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const discovery = await ConnectorDiscovery.findOne({
        _id: discoveryId,
        connectorId,
        tenantId,
      }).lean();

      if (!discovery) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Discovery not found' },
        });
        return;
      }

      res.json({ success: true, data: discovery });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get discovery', { error: errMsg });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: errMsg },
      });
    }
  },
);

/**
 * GET /connectors/:connectorId/selected-sites — Get current site selection config
 */
router.get('/connectors/:connectorId/selected-sites', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Load connector
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const scopeConfig = (connector.filterConfig?.scope || {}) as Record<string, any>;
    const siteMode = scopeConfig.siteMode || 'all';
    const siteIds = scopeConfig.siteIds || [];

    res.json({
      success: true,
      data: {
        mode: siteMode,
        siteIds,
        selectedCount: siteMode === 'all' ? 0 : siteIds.length,
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get selected sites', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
    });
  }
});

/**
 * POST /connectors/:connectorId/select-sites — Select specific sites for sync
 *
 * Body: { siteIds: string[], mode?: 'selected' | 'excluded' }
 */
router.post('/connectors/:connectorId/select-sites', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { siteIds, mode = 'selected' } = req.body;

    // Validate input
    if (!Array.isArray(siteIds)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'siteIds must be an array' },
      });
      return;
    }

    if (siteIds.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'At least one site must be selected' },
      });
      return;
    }

    if (!['selected', 'excluded'].includes(mode)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_MODE', message: 'mode must be "selected" or "excluded"' },
      });
      return;
    }

    // Load connector
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    // Validate site IDs against discovery results
    const discovery = await ConnectorDiscovery.findOne({ connectorId, tenantId })
      .sort({ createdAt: -1 })
      .lean();

    if (discovery) {
      const discoveredSiteIds = discovery.resources
        .filter((r) => r.resourceType === 'site')
        .map((r) => r.id);

      const invalidSiteIds = siteIds.filter((id) => !discoveredSiteIds.includes(id));
      if (invalidSiteIds.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SITE_IDS',
            message: `Site IDs not found in discovery results: ${invalidSiteIds.join(', ')}`,
          },
        });
        return;
      }
    }

    // Update connector scope config
    const existingFilterConfig = connector.filterConfig || {
      standard: {},
      scope: {},
      advancedFilters: {},
      version: 1,
    };
    const existingScopeConfig = (existingFilterConfig.scope || {}) as Record<string, any>;
    const updatedScopeConfig = {
      ...existingScopeConfig,
      siteMode: mode,
      siteIds: siteIds,
    };

    await ConnectorConfig.findOneAndUpdate(
      { _id: connectorId, tenantId },
      {
        'filterConfig.scope': updatedScopeConfig,
        'filterConfig.version': existingFilterConfig.version + 1,
      },
    );

    res.json({
      success: true,
      data: {
        selectedCount: siteIds.length,
        mode,
        message: `Site selection updated. ${siteIds.length} site(s) ${mode === 'selected' ? 'will be synced' : 'will be excluded from sync'}.`,
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to select sites', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
    });
  }
});

// ─── Recommendations ────────────────────────────────────────────────────

/**
 * POST /connectors/:connectorId/recommendations — Generate from discovery
 *
 * Body: { discoveryId: string }
 */
router.post('/connectors/:connectorId/recommendations', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { discoveryId } = req.body;

    if (!discoveryId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELD', message: 'discoveryId is required' },
      });
      return;
    }

    // Verify connector exists
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const recommendation = await generateRecommendations(connectorId, tenantId, discoveryId);

    res.json({ success: true, data: recommendation });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to generate recommendations', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'RECOMMENDATION_FAILED', message: errMsg },
    });
  }
});

/**
 * GET /connectors/:connectorId/recommendations — Get latest recommendation
 */
router.get('/connectors/:connectorId/recommendations', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const recommendation = await ConnectorRecommendation.findOne({
      connectorId,
      tenantId,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!recommendation) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No recommendation found for this connector' },
      });
      return;
    }

    res.json({ success: true, data: recommendation });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get recommendation', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
    });
  }
});

/**
 * POST /connectors/:connectorId/recommendations/:recommendationId/accept
 *
 * Accept a recommendation and apply it to the connector configuration.
 * Body: { overrides?: Record<string, unknown>, startSync?: boolean }
 */
router.post(
  '/connectors/:connectorId/recommendations/:recommendationId/accept',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, recommendationId } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const { overrides, startSync = false } = req.body;

      // Verify connector exists
      const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
      if (!connector) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        });
        return;
      }

      const result = await acceptRecommendation(
        connectorId,
        tenantId,
        recommendationId,
        overrides,
        startSync,
      );

      res.json({
        success: true,
        data: {
          connector: result.connector,
          syncJobId: result.jobId || null,
          message: result.jobId
            ? 'Recommendation accepted and sync started'
            : 'Recommendation accepted',
        },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to accept recommendation', { error: errMsg });
      res.status(500).json({
        success: false,
        error: { code: 'ACCEPT_FAILED', message: errMsg },
      });
    }
  },
);

// ─── Quick Setup ────────────────────────────────────────────────────────

/**
 * POST /connectors/:connectorId/quick-setup
 *
 * One-click: discover + profile + recommend + accept + optionally start sync.
 * Body: { startSync?: boolean }
 */
router.post('/connectors/:connectorId/quick-setup', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { startSync = false } = req.body;

    // Load connector
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    // Verify authentication
    if (!connector.oauthTokenId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NOT_AUTHENTICATED',
          message: 'Connector must be authenticated before quick setup',
        },
      });
      return;
    }

    // Trigger discovery in quick_setup mode (includes recommendation generation)
    const { discoveryId, jobId } = await triggerDiscovery(
      connectorId,
      tenantId,
      connector.connectorType,
      'quick_setup',
    );

    res.json({
      success: true,
      data: {
        discoveryId,
        jobId,
        status: 'pending',
        startSync,
        message:
          'Quick setup initiated. Discovery and recommendation generation in progress. ' +
          'Poll GET /connectors/:connectorId/discovery to check status. ' +
          'Once completed, recommendations will be available at GET /connectors/:connectorId/recommendations.',
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Quick setup failed', { error: errMsg });
    res.status(500).json({
      success: false,
      error: { code: 'QUICK_SETUP_FAILED', message: errMsg },
    });
  }
});

export default router;
