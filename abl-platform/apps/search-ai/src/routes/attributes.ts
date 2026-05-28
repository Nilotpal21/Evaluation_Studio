/**
 * Attribute Admin API Routes
 *
 * GET    /:indexId/attributes               — List with filters + pagination
 * GET    /:indexId/attributes/review-queue   — Items needing admin attention
 * GET    /:indexId/attributes/stats          — Tier distribution + interaction stats
 * GET    /:indexId/attributes/:id            — Single attribute detail
 * PATCH  /:indexId/attributes/:id            — Update tier/name/aliases
 * POST   /:indexId/attributes/bulk           — Bulk approve/discard/changeTier
 * POST   /:indexId/attributes/merge          — Merge two attributes + ClickHouse mutation
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import { escapeRegex } from '../utils/query-helpers.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { IAttributeRegistry, IAttributeMergeEvent } from '@agent-platform/database/models';
import { requireSearchIndexAccessFromParams } from './searchai-route-ownership.js';

const AttributeRegistry = getLazyModel<IAttributeRegistry>('AttributeRegistry');
const AttributeMergeEvent = getLazyModel<IAttributeMergeEvent>('AttributeMergeEvent');
const logger = createLogger('attribute-routes');

// ─── Zod Schemas ──────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  tier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
  product: z.string().min(1).max(256).optional(),
  dataType: z.string().min(1).max(256).optional(),
  search: z.string().max(256).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateSchema = z.object({
  tier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
  displayName: z.string().min(1).max(256).optional(),
  aliases: z.array(z.string().min(1).max(256)).max(20).optional(),
  definition: z.string().max(2000).optional(),
});

const bulkSchema = z.object({
  action: z.enum(['approve', 'discard', 'changeTier']),
  attributeIds: z.array(z.string().min(1)).min(1).max(100),
  targetTier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
});

const mergeSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  primaryId: z.string().min(1),
});

// ─── Route Handlers ───────────────────────────────────────────────────────

async function handleList(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId required' },
      });
      return;
    }
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }
    const { tier, product, dataType, search, page, limit } = parsed.data;

    const filter: Record<string, unknown> = { tenantId, indexId };
    if (tier) filter.tier = tier;
    if (product) filter.productScope = product;
    if (dataType) filter.dataType = dataType;
    if (search) {
      const escaped = escapeRegex(search);
      filter.$or = [
        { attributeId: { $regex: escaped, $options: 'i' } },
        { displayName: { $regex: escaped, $options: 'i' } },
        { aliases: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      AttributeRegistry.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AttributeRegistry.countDocuments(filter),
    ]);
    res.json({ data, total, page, limit });
  } catch (error) {
    logger.error('Failed to list attributes', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list attributes' },
    });
  }
}

async function handleReviewQueue(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId required' },
      });
      return;
    }

    // Use configurable thresholds from reconciliation config
    const { DEFAULT_RECONCILIATION_CONFIG } = await import('../services/reconciliation/types.js');
    const config = DEFAULT_RECONCILIATION_CONFIG;

    const [placementReview, allAttrs] = await Promise.all([
      // Novel attributes ready for decision (configurable thresholds)
      AttributeRegistry.find({
        tenantId,
        indexId,
        tier: 'novel',
        documentCount: { $gte: config.promotionDocCountMin },
        confidence: { $gte: config.promotionConfidenceMin },
      })
        .sort({ documentCount: -1 })
        .limit(50)
        .lean(),
      // All attributes for conflict detection
      AttributeRegistry.find({ tenantId, indexId, tier: { $ne: 'discarded' } }).lean(),
    ]);

    // Detect merge conflicts: same attributeId, different productScope, divergent names
    const byAttrId = new Map<string, IAttributeRegistry[]>();
    for (const attr of allAttrs) {
      const existing = byAttrId.get(attr.attributeId) || [];
      existing.push(attr);
      byAttrId.set(attr.attributeId, existing);
    }
    const mergeConflicts = [...byAttrId.entries()]
      .filter(([, attrs]) => attrs.length > 1 && new Set(attrs.map((a) => a.displayName)).size > 1)
      .map(([attributeId, attrs]) => ({ attributeId, attributes: attrs }));

    // Detect type conflicts: same attributeId, different dataType
    const typeConflicts = [...byAttrId.entries()]
      .filter(([, attrs]) => attrs.length > 1 && new Set(attrs.map((a) => a.dataType)).size > 1)
      .map(([attributeId, attrs]) => ({ attributeId, attributes: attrs }));

    res.json({
      mergeConflicts,
      placementReview,
      typeConflicts,
      total: mergeConflicts.length + placementReview.length + typeConflicts.length,
    });
  } catch (error) {
    logger.error('Failed to get review queue', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get review queue' },
    });
  }
}

async function handleStats(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId required' },
      });
      return;
    }

    // Reuse existing InteractionAggregator
    const { InteractionAggregator } =
      await import('../services/reconciliation/interaction-aggregator.js');
    const aggregator = new InteractionAggregator();

    const [tierCounts, recentPromotions, recentDemotions, interactionStats] = await Promise.all([
      AttributeRegistry.aggregate([
        { $match: { tenantId, indexId } },
        { $group: { _id: '$tier', count: { $sum: 1 } } },
      ]),
      AttributeRegistry.find({
        tenantId,
        indexId,
        tier: 'approved',
        updatedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean(),
      AttributeRegistry.find({
        tenantId,
        indexId,
        tier: 'beta',
        updatedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean(),
      aggregator.aggregateInteractions(tenantId, indexId, 14),
    ]);

    const byTier: Record<string, number> = {};
    for (const row of tierCounts) byTier[row._id] = row.count;

    res.json({
      byTier,
      recentPromotions,
      recentDemotions,
      interactionStats: Object.fromEntries(interactionStats),
    });
  } catch (error) {
    logger.error('Failed to get attribute stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get attribute stats' },
    });
  }
}

async function handleGetOne(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const { indexId, id } = req.params;
    if (!indexId || !id) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId and id required' },
      });
      return;
    }
    const attr = await AttributeRegistry.findOne({ _id: id, tenantId, indexId }).lean();
    if (!attr) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Attribute not found' },
      });
      return;
    }
    res.json({ data: attr });
  } catch (error) {
    logger.error('Failed to get attribute', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get attribute' },
    });
  }
}

async function handleUpdate(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const { indexId, id } = req.params;
    if (!indexId || !id) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId and id required' },
      });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const updateFields: Record<string, unknown> = { ...parsed.data };
    // Mark admin-managed to protect from auto-promotion cron override
    if (parsed.data.tier) {
      updateFields.discoverySource = 'admin_manual';
    }

    const attr = await AttributeRegistry.findOneAndUpdate(
      { _id: id, tenantId, indexId },
      { $set: updateFields },
      { new: true },
    ).lean();
    if (!attr) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Attribute not found' },
      });
      return;
    }
    res.json({ data: attr });
  } catch (error) {
    logger.error('Failed to update attribute', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update attribute' },
    });
  }
}

async function handleBulk(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId required' },
      });
      return;
    }
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { action, attributeIds, targetTier } = parsed.data;
    let newTier: string;
    if (action === 'approve') newTier = 'approved';
    else if (action === 'discard') newTier = 'discarded';
    else if (action === 'changeTier' && targetTier) newTier = targetTier;
    else {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_TARGET_TIER', message: 'targetTier required for changeTier' },
      });
      return;
    }

    const result = await AttributeRegistry.updateMany(
      { _id: { $in: attributeIds }, tenantId, indexId },
      { $set: { tier: newTier, discoverySource: 'admin_manual' } },
    );
    res.json({ updated: result.modifiedCount, errors: [] });
  } catch (error) {
    logger.error('Failed to bulk update attributes', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk update attributes' },
    });
  }
}

async function handleMerge(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext!;
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId required' },
      });
      return;
    }
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { sourceId, targetId, primaryId } = parsed.data;
    const [source, target] = await Promise.all([
      AttributeRegistry.findOne({ _id: sourceId, tenantId, indexId }).lean(),
      AttributeRegistry.findOne({ _id: targetId, tenantId, indexId }).lean(),
    ]);
    if (!source || !target) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Source or target not found' },
      });
      return;
    }

    const primary = primaryId === sourceId ? source : target;
    const secondary = primaryId === sourceId ? target : source;

    // Merge aliases
    const mergedAliases = [
      ...new Set([...(primary.aliases || []), ...(secondary.aliases || []), secondary.attributeId]),
    ];

    // Update primary: merge aliases, keep primary's tier
    await AttributeRegistry.updateOne(
      { _id: primary._id, tenantId, indexId },
      {
        $set: {
          aliases: mergedAliases,
          discoverySource: 'admin_manual',
          documentCount: (primary.documentCount ?? 0) + (secondary.documentCount ?? 0),
        },
      },
    );

    // Mark secondary as discarded
    await AttributeRegistry.updateOne(
      { _id: secondary._id, tenantId, indexId },
      {
        $set: { tier: 'discarded', discoverySource: 'admin_manual' },
      },
    );

    // Create merge audit event
    await AttributeMergeEvent.create({
      tenantId,
      indexId,
      productScope: primary.productScope,
      timestamp: new Date(),
      sourceAttributeIds: [secondary.attributeId],
      targetAttributeId: primary.attributeId,
      mergeScore: 1.0,
      mergeMethod: 'admin_manual',
      reversible: true,
      metadata: { reason: 'Admin merge via UI' },
    });

    // Async ClickHouse mutation: update entity_instances attribute_type
    let clickhouseMutationPending = false;
    try {
      const ch = getClickHouseClient();
      await ch.command({
        query: `ALTER TABLE abl_platform.entity_instances UPDATE attribute_type = {target:String} WHERE attribute_type = {source:String} AND tenant_id = {tenantId:String} AND index_id = {indexId:String}`,
        query_params: {
          target: primary.attributeId,
          source: secondary.attributeId,
          tenantId,
          indexId,
        },
      });
      clickhouseMutationPending = true;
    } catch (chError) {
      logger.error('ClickHouse merge mutation failed (non-blocking)', {
        error: chError instanceof Error ? chError.message : String(chError),
      });
    }

    const updated = await AttributeRegistry.findOne({ _id: primary._id, tenantId, indexId }).lean();
    res.json({ data: updated, meta: { clickhouseMutationPending } });
  } catch (error) {
    logger.error('Failed to merge attributes', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to merge attributes' },
    });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────

export default function createAttributesRouter(): Router {
  const router = Router();
  router.use('/:indexId/attributes', requireSearchIndexAccessFromParams());

  // Static routes FIRST
  router.get('/:indexId/attributes', handleList);
  router.get('/:indexId/attributes/review-queue', handleReviewQueue);
  router.get('/:indexId/attributes/stats', handleStats);
  router.post('/:indexId/attributes/bulk', handleBulk);
  router.post('/:indexId/attributes/merge', handleMerge);

  // Parameterized route LAST
  router.get('/:indexId/attributes/:id', handleGetOne);
  router.patch('/:indexId/attributes/:id', handleUpdate);

  return router;
}
