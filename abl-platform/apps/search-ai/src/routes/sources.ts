/**
 * Source Management Routes
 *
 * Manage data sources connected to search indexes.
 * Mounted under /api/indexes (shares prefix with indexes router).
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';

import { createLogger } from '@abl/compiler/platform';
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal/canonical';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import { escapeRegex } from '../utils/query-helpers.js';
import type {
  ISearchSource,
  ISearchIndex,
  IConnectorConfig,
  ISearchDocument,
  ISearchChunk,
  IKnowledgeBase,
  ISourceConfigState,
  ISourceUrlBucket,
} from '@agent-platform/database/models';
import { SOURCE_URL_BUCKET_SIZE } from '@agent-platform/database/models';

const logger = createLogger('sources');

// Models bound to correct databases (platform vs content)
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig'); // → abl_platform
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase'); // → abl_platform
const SourceConfigState = getLazyModel<ISourceConfigState>('SourceConfigState'); // → search_ai
const SourceUrlBucket = getLazyModel<ISourceUrlBucket>('SourceUrlBucket'); // → search_ai
const router: RouterType = Router();

/**
 * GET /:indexId/sources/summary - Grouped counts by sourceType
 * MUST be before /:sourceId routes to avoid Express capture
 */
router.get('/:indexId/sources/summary', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Verify index ownership
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const summary = await SearchSource.aggregate([
      { $match: { indexId, tenantId } },
      { $group: { _id: '$sourceType', count: { $sum: 1 }, totalDocs: { $sum: '$documentCount' } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      summary,
      total: summary.reduce((s: number, g: { count: number }) => s + g.count, 0),
    });
  } catch (error) {
    logger.error('Failed to get source summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get source summary' });
  }
});

/**
 * GET /:indexId/sources - List sources for an index
 * Supports pagination (limit/offset), search, and sourceType filter.
 */
router.get('/:indexId/sources', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Verify index exists and belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Pagination params
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // Build filter
    const filter: Record<string, unknown> = { indexId, tenantId };

    // Search by name
    const search = req.query.search;
    if (search && typeof search === 'string') {
      filter.name = { $regex: escapeRegex(search), $options: 'i' };
    }

    // Filter by sourceType
    const sourceType = req.query.sourceType;
    if (sourceType && typeof sourceType === 'string') {
      filter.sourceType = sourceType;
    }

    // Run query and count in parallel
    const [sources, total] = await Promise.all([
      SearchSource.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      SearchSource.countDocuments(filter),
    ]);

    res.json({
      sources,
      total,
      pagination: {
        limit,
        offset,
        hasMore: offset + sources.length < total,
      },
    });
  } catch (error) {
    logger.error('Failed to list sources', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

/**
 * POST /:indexId/sources - Add a source to an index
 */
router.post('/:indexId/sources', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { name, sourceType, sourceConfig, extractionConfig, enrichmentConfig, syncSchedule } =
      req.body;

    // Verify index exists and belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    if (!name || !sourceType) {
      res.status(400).json({ error: 'name and sourceType are required' });
      return;
    }

    // Normalize 'file' → 'manual', then validate against canonical types
    const normalizedSourceType = sourceType === 'file' ? 'manual' : sourceType;
    const ALLOWED_SOURCE_TYPES = ['manual', 'web', 'database', 'api', 'sharepoint'];
    if (!ALLOWED_SOURCE_TYPES.includes(normalizedSourceType)) {
      res.status(400).json({
        error: `Invalid sourceType. Allowed: file, ${ALLOWED_SOURCE_TYPES.join(', ')}`,
      });
      return;
    }

    // Web sources start as 'configuring' with a crawlConfig subdocument
    const isWebSource = normalizedSourceType === 'web';
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const source = await SearchSource.create({
      tenantId,
      indexId,
      name,
      sourceType: normalizedSourceType,
      sourceConfig: sourceConfig || null,
      extractionConfig: extractionConfig || null,
      enrichmentConfig: enrichmentConfig || null,
      syncSchedule: syncSchedule || null,
      status: isWebSource ? 'configuring' : 'pending',
      createdBy: req.tenantContext!.userId,
      ...(isWebSource
        ? {
            crawlConfig: {
              wizardStep: 'profiling',
              strategy: null,
              profile: null,
              sections: null,
              settings: null,
              auth: null,
              groupStrategies: null,
              configVersion: 1,
              crawlJobId: null,
              configExpiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
            },
          }
        : {}),
    });

    // Auto-create ConnectorConfig for manual sources (universal connectorId)
    // Idempotent: unique index on { tenantId, sourceId } prevents duplicates
    if (normalizedSourceType === 'manual') {
      const existingConfig = await ConnectorConfig.findOne({
        tenantId,
        sourceId: source._id.toString(),
      }).lean();

      if (!existingConfig) {
        await ConnectorConfig.create({
          tenantId,
          sourceId: source._id.toString(),
          connectorType: 'file_upload',
          connectionConfig: {},
          configurationSource: 'manual',
        });
      }
    }

    // Increment source count on the index
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      { $inc: { sourceCount: 1 } },
    );

    res.status(201).json({ source });
  } catch (error) {
    logger.error('Failed to add source', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to add source' });
  }
});

/**
 * GET /:indexId/upload-hints - Get upload field hints for manual file uploads
 * Returns recently-used fields and their last values for sticky form UX.
 */
router.get('/:indexId/upload-hints', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Find all file_upload ConnectorConfigs for sources in this index
    const sources = await SearchSource.find({ indexId, tenantId }).select('_id').lean();
    const sourceIds = sources.map((s) => s._id.toString());

    const configs = await ConnectorConfig.find({
      tenantId,
      sourceId: { $in: sourceIds },
      connectorType: 'file_upload',
    })
      .select('uploadFieldHints')
      .lean();

    // Merge hints from all file_upload configs (most recent wins)
    let recentFields: string[] = [];
    let lastValues: Record<string, string> = {};

    const sortedConfigs = configs
      .filter((c) => c.uploadFieldHints?.recentFields?.length)
      .sort(
        (a, b) =>
          new Date(b.uploadFieldHints!.updatedAt).getTime() -
          new Date(a.uploadFieldHints!.updatedAt).getTime(),
      );

    if (sortedConfigs.length > 0) {
      // Use most recent config's field order, merge values from all
      recentFields = sortedConfigs[0].uploadFieldHints!.recentFields;
      for (const config of sortedConfigs) {
        const vals = config.uploadFieldHints!.lastValues || {};
        for (const [key, val] of Object.entries(vals)) {
          if (!(key in lastValues)) {
            lastValues[key] = val;
          }
        }
      }
    }

    // Return only core + common fields (not custom slots) for the form
    const allFields = AVAILABLE_CANONICAL_FIELDS.filter(
      (f) => f.category === 'core' || f.category === 'common',
    );

    res.json({ recentFields, lastValues, allFields });
  } catch (error) {
    logger.error('Failed to get upload hints', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get upload hints' });
  }
});

/**
 * DELETE /:indexId/sources/:sourceId - Remove a source
 */
router.delete('/:indexId/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const source = await SearchSource.findOneAndDelete({
      _id: sourceId,
      indexId,
      tenantId,
    }).lean();

    if (!source) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    // Cascade-delete transient wizard data (SourceConfigState + SourceUrlBucket)
    await Promise.all([
      SourceConfigState.deleteOne({ sourceId, tenantId }).catch((err: unknown) => {
        logger.warn('Failed to cascade-delete SourceConfigState', {
          sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
      SourceUrlBucket.deleteMany({ sourceId, tenantId }).catch((err: unknown) => {
        logger.warn('Failed to cascade-delete SourceUrlBucket', {
          sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ]);

    // Count documents before deletion
    const documentCount = await SearchDocument.countDocuments({ sourceId, tenantId });

    // Delete documents with proper vector store cleanup
    const { deleteSourceDocuments } = await import('../services/document-cleanup.service.js');
    const cleanupResult = await deleteSourceDocuments(sourceId, tenantId, indexId);

    if (!cleanupResult.success) {
      logger.warn('Some documents failed to delete during source removal', {
        sourceId,
        failures: cleanupResult.failures.length,
      });
    }

    const chunkCount = cleanupResult.chunkCount;

    // Update SearchIndex counters
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      {
        $inc: {
          sourceCount: -1,
          documentCount: -documentCount,
          chunkCount: -chunkCount,
        },
      },
    );

    // Update KnowledgeBase counters
    await KnowledgeBase.findOneAndUpdate(
      { searchIndexId: indexId, tenantId },
      {
        $inc: {
          documentCount: -documentCount,
        },
      },
    );

    // ── Field & Vocabulary cleanup ──────────────────────────────────────
    // Case 1: Source-level cleanup — remove this source's FieldMappings + orphaned vocab
    // Case 2: If documentCount reached 0, do full cleanup (fields + vocab + jsonFieldConfig)
    try {
      const { cleanupFieldsForSource, cleanupAllFieldsAndVocab } =
        await import('../services/document-cleanup.service.js');

      const updatedIndex = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      )
        .select('documentCount')
        .lean();
      const remainingDocs = (updatedIndex as any)?.documentCount ?? 0;

      if (remainingDocs <= 0) {
        // Full cleanup — no documents left at all
        await cleanupAllFieldsAndVocab(tenantId, indexId);
      } else {
        // Partial cleanup — remove this source's mappings only.
        // Resolve connectorId: JSON sources use `json-upload:${indexId}`,
        // connector sources use their ConnectorConfig._id.
        const connConfig = await ConnectorConfig.findOne({ tenantId, sourceId }).lean();
        const connectorId = connConfig ? String((connConfig as any)._id) : `json-upload:${indexId}`;
        await cleanupFieldsForSource(tenantId, indexId, connectorId);
      }
    } catch (cleanupErr) {
      // Non-fatal — source is already deleted, field/vocab cleanup is best-effort
      logger.warn('Field/vocab cleanup failed after source deletion', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        sourceId,
        indexId,
      });
    }

    res.json({ deleted: true, sourceId });
  } catch (error) {
    logger.error('Failed to remove source', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to remove source' });
  }
});

// ─── Source Rename ────────────────────────────────────────────────────────────

/**
 * PATCH /:indexId/sources/:sourceId - Update source metadata (currently: name)
 */
router.patch('/:indexId/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_NAME', message: 'name is required and must be a non-empty string' },
      });
      return;
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 200) {
      res.status(400).json({
        success: false,
        error: { code: 'NAME_TOO_LONG', message: 'name must be 200 characters or fewer' },
      });
      return;
    }

    // Verify index ownership
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' } });
      return;
    }

    const updated = await SearchSource.findOneAndUpdate(
      { _id: sourceId, indexId, tenantId },
      { $set: { name: trimmedName } },
      { new: true },
    ).lean();

    if (!updated) {
      res
        .status(404)
        .json({ success: false, error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' } });
      return;
    }

    res.json({ success: true, source: updated });
  } catch (error) {
    logger.error('Failed to rename source', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to rename source' },
    });
  }
});

// ─── Draft Elimination: Crawl Config & Discovery Endpoints ───────────────────

/**
 * PATCH /:indexId/sources/:sourceId/crawl-config - Update crawl configuration
 * OCC via configVersion. Only the source creator can modify.
 */
router.patch('/:indexId/sources/:sourceId/crawl-config', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const { configVersion, ...updates } = req.body;

    if (configVersion == null || typeof configVersion !== 'number') {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_CONFIG_VERSION', message: 'configVersion is required' },
      });
      return;
    }

    // Build $set for only the provided crawl config fields
    // No ownership guard — any project member can edit crawl config.
    // OCC (configVersion) prevents concurrent overwrites.
    const allowedFields = [
      'wizardStep',
      'strategy',
      'profile',
      'sections',
      'settings',
      'auth',
      'groupStrategies',
      'crawlJobId',
      'configExpiresAt',
    ];

    const $set: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in updates) {
        $set[`crawlConfig.${field}`] = updates[field];
      }
    }

    if (Object.keys($set).length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'NO_UPDATES', message: 'No valid crawl config fields to update' },
      });
      return;
    }

    // OCC: match on configVersion + atomic increment
    const result = await SearchSource.findOneAndUpdate(
      {
        _id: sourceId,
        indexId,
        tenantId,
        'crawlConfig.configVersion': configVersion,
      },
      {
        $set,
        $inc: { 'crawlConfig.configVersion': 1 },
      },
      { new: true },
    ).lean();

    if (!result) {
      res.status(409).json({
        success: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Source was modified by another session. Re-fetch and retry.',
        },
      });
      return;
    }

    res.json({ success: true, source: result });
  } catch (error) {
    logger.error('Failed to update crawl config', {
      error: error instanceof Error ? error.message : String(error),
      sourceId: req.params.sourceId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update crawl config' },
    });
  }
});

/**
 * PUT /:indexId/sources/:sourceId/discovery-state - Save discovery wizard state
 * Lazy-creates SourceConfigState on first call. Only the source creator can modify.
 * Accepts up to 5MB (Zod-capped in frontend; backend uses express.json limit).
 */
router.put('/:indexId/sources/:sourceId/discovery-state', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;

    const { discoveryState, discoveryStatus } = req.body;

    // Verify source exists (any project member can update discovery state)
    const source = await SearchSource.findOne({
      _id: sourceId,
      indexId,
      tenantId,
    })
      .select('_id crawlConfig')
      .lean();

    if (!source) {
      res.status(404).json({
        success: false,
        error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' },
      });
      return;
    }

    // Upsert SourceConfigState (lazy creation on first PUT)
    const configExpiresAt = source.crawlConfig?.configExpiresAt ?? null;
    const projectId = req.tenantContext!.projectId ?? '';

    await SourceConfigState.findOneAndUpdate(
      { sourceId, tenantId },
      {
        $set: {
          discoveryState: discoveryState ?? null,
          ...(discoveryStatus ? { discoveryStatus } : {}),
          configExpiresAt,
        },
        $setOnInsert: {
          tenantId,
          sourceId,
          projectId,
          createdBy: userId,
        },
      },
      { upsert: true, new: true },
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update discovery state', {
      error: error instanceof Error ? error.message : String(error),
      sourceId: req.params.sourceId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update discovery state' },
    });
  }
});

/**
 * GET /:indexId/sources/:sourceId/discovery-state - Read discovery wizard state
 * No ownership guard — any project member can view.
 */
router.get('/:indexId/sources/:sourceId/discovery-state', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Verify source exists
    const source = await SearchSource.findOne({
      _id: sourceId,
      indexId,
      tenantId,
    })
      .select('_id')
      .lean();

    if (!source) {
      res.status(404).json({
        success: false,
        error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' },
      });
      return;
    }

    const configState = await SourceConfigState.findOne({
      sourceId,
      tenantId,
    }).lean();

    res.json({
      success: true,
      data: {
        discoveryState: configState?.discoveryState ?? null,
        discoveryStatus: configState?.discoveryStatus ?? 'idle',
      },
    });
  } catch (error) {
    logger.error('Failed to get discovery state', {
      error: error instanceof Error ? error.message : String(error),
      sourceId: req.params.sourceId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get discovery state' },
    });
  }
});

/**
 * PUT /:indexId/sources/:sourceId/sections/:sectionId/urls - Store section URLs
 * Uses the bucket pattern: splits URLs into chunks of SOURCE_URL_BUCKET_SIZE (500).
 * Only the source creator can modify. Max 10,000 URLs per call.
 */
router.put(
  '/:indexId/sources/:sourceId/sections/:sectionId/urls',
  async (req: Request, res: Response) => {
    try {
      const { indexId, sourceId, sectionId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { urls } = req.body;

      if (!Array.isArray(urls)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_URLS', message: 'urls must be an array' },
        });
        return;
      }

      if (urls.length > 10_000) {
        res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_URLS', message: 'Maximum 10,000 URLs per call' },
        });
        return;
      }

      // Verify source exists (any project member can store URLs)
      const source = await SearchSource.findOne({
        _id: sourceId,
        indexId,
        tenantId,
      })
        .select('_id crawlConfig')
        .lean();

      if (!source) {
        res.status(404).json({
          success: false,
          error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' },
        });
        return;
      }

      // Delete existing buckets for this section (replace, not append)
      await SourceUrlBucket.deleteMany({ sourceId, sectionId, tenantId });

      // Split URLs into buckets of SOURCE_URL_BUCKET_SIZE
      const configExpiresAt = source.crawlConfig?.configExpiresAt ?? null;
      const buckets: Array<{
        tenantId: string;
        sourceId: string;
        sectionId: string;
        bucketIndex: number;
        urls: typeof urls;
        urlCount: number;
        configExpiresAt: Date | null;
      }> = [];

      for (let i = 0; i < urls.length; i += SOURCE_URL_BUCKET_SIZE) {
        const chunk = urls.slice(i, i + SOURCE_URL_BUCKET_SIZE);
        buckets.push({
          tenantId,
          sourceId,
          sectionId,
          bucketIndex: Math.floor(i / SOURCE_URL_BUCKET_SIZE),
          urls: chunk,
          urlCount: chunk.length,
          configExpiresAt,
        });
      }

      if (buckets.length > 0) {
        await SourceUrlBucket.insertMany(buckets);
      }

      res.json({
        success: true,
        data: {
          urlCount: urls.length,
          buckets: buckets.length,
        },
      });
    } catch (error) {
      logger.error('Failed to store section URLs', {
        error: error instanceof Error ? error.message : String(error),
        sourceId: req.params.sourceId,
        sectionId: req.params.sectionId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to store section URLs' },
      });
    }
  },
);

/**
 * GET /:indexId/sources/:sourceId/sections/:sectionId/urls - Read section URLs (paginated)
 * No ownership guard — any project member can view.
 */
router.get(
  '/:indexId/sources/:sourceId/sections/:sectionId/urls',
  async (req: Request, res: Response) => {
    try {
      const { indexId, sourceId, sectionId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

      // Verify source exists
      const source = await SearchSource.findOne({
        _id: sourceId,
        indexId,
        tenantId,
      })
        .select('_id')
        .lean();

      if (!source) {
        res.status(404).json({
          success: false,
          error: { code: 'SOURCE_NOT_FOUND', message: 'Source not found' },
        });
        return;
      }

      // Calculate which buckets we need
      const startBucket = Math.floor(offset / SOURCE_URL_BUCKET_SIZE);
      const endBucket = Math.floor((offset + limit - 1) / SOURCE_URL_BUCKET_SIZE);

      // Get total count from all buckets
      const totalAgg = await SourceUrlBucket.aggregate([
        { $match: { sourceId, sectionId, tenantId } },
        { $group: { _id: null, total: { $sum: '$urlCount' } } },
      ]);
      const total = totalAgg[0]?.total ?? 0;

      // Fetch relevant buckets
      const buckets = await SourceUrlBucket.find({
        sourceId,
        sectionId,
        tenantId,
        bucketIndex: { $gte: startBucket, $lte: endBucket },
      })
        .sort({ bucketIndex: 1 })
        .lean();

      // Extract URLs from buckets with offset/limit slicing
      const allUrls: unknown[] = [];
      for (const bucket of buckets) {
        allUrls.push(...bucket.urls);
      }

      const localOffset = offset - startBucket * SOURCE_URL_BUCKET_SIZE;
      const urls = allUrls.slice(localOffset, localOffset + limit);

      res.json({
        success: true,
        data: {
          urls,
          pagination: { offset, limit, total },
        },
      });
    } catch (error) {
      logger.error('Failed to get section URLs', {
        error: error instanceof Error ? error.message : String(error),
        sourceId: req.params.sourceId,
        sectionId: req.params.sectionId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get section URLs' },
      });
    }
  },
);

// ─── Source Stats & Status Endpoints ─────────────────────────────────────────

/**
 * MIME type → friendly display label.
 * Uses the contentType field already stored on SearchDocument (set during upload/ingestion).
 * No re-derivation from filenames needed — the DB is the source of truth.
 */
const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-excel': 'Excel',
  'text/html': 'HTML',
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'application/csv': 'CSV',
  'application/json': 'JSON',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/jpg': 'JPEG',
  'image/tiff': 'TIFF',
  'image/bmp': 'BMP',
  'image/webp': 'WebP',
};

function mimeToLabel(mime: string | null): string {
  if (!mime) return 'Unknown';
  // Strip parameters ("application/pdf; charset=utf-8" → "application/pdf")
  const base = mime.split(';')[0].trim().toLowerCase();
  return MIME_LABELS[base] ?? base.split('/').pop()?.toUpperCase() ?? 'Unknown';
}

/**
 * GET /:indexId/sources/:sourceId/stats - Aggregated analytics for a single source
 * Returns content type breakdown (from stored contentType MIME field), size stats,
 * status distribution, and recent documents.
 */
router.get('/:indexId/sources/:sourceId/stats', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // Verify source ownership
    const source = await SearchSource.findOne({ _id: sourceId, indexId, tenantId }).lean();
    if (!source) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    const matchStage = { indexId, tenantId, sourceId };

    // Run all aggregations in parallel — all use existing indexed fields
    const [contentTypeAgg, statusAgg, sizeAgg, recentDocs, chunkAgg, totalPages] =
      await Promise.all([
        // Content type breakdown — group by the stored contentType (MIME) field
        SearchDocument.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: { $ifNull: ['$contentType', 'unknown'] },
              count: { $sum: 1 },
              totalSize: { $sum: '$contentSizeBytes' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]),
        // Document status distribution
        SearchDocument.aggregate([
          { $match: matchStage },
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        // Size statistics
        SearchDocument.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: null,
              totalSize: { $sum: '$contentSizeBytes' },
              avgSize: { $avg: '$contentSizeBytes' },
              maxSize: { $max: '$contentSizeBytes' },
              minSize: { $min: '$contentSizeBytes' },
              count: { $sum: 1 },
            },
          },
        ]),
        // Recent documents (last 5)
        SearchDocument.find(matchStage)
          .sort({ createdAt: -1 })
          .limit(5)
          .select('_id originalReference contentSizeBytes status createdAt contentType')
          .lean(),
        // Total chunks — sum chunkCount from SearchDocument (chunks don't have sourceId)
        SearchDocument.aggregate([
          { $match: matchStage },
          { $group: { _id: null, totalChunks: { $sum: '$chunkCount' } } },
        ]),
        // Total pages (sum of pageCount across paginated documents only: PDF, Word, PowerPoint)
        // Exclude CSV, JSON, TXT, HTML — they aren't paginated and "page count" doesn't apply
        SearchDocument.aggregate([
          {
            $match: {
              ...matchStage,
              pageCount: { $exists: true, $gt: 0 },
              contentType: {
                $in: [
                  'application/pdf',
                  'application/msword', // .doc
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
                  'application/vnd.ms-powerpoint', // .ppt
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
                ],
              },
            },
          },
          { $group: { _id: null, totalPages: { $sum: '$pageCount' } } },
        ]),
      ]);

    const sizeStats = sizeAgg[0] || {
      totalSize: 0,
      avgSize: 0,
      maxSize: 0,
      minSize: 0,
      count: 0,
    };
    const totalDocCount = sizeStats.count;

    // Merge MIME variants into friendly labels (e.g. msword + docx → "Word")
    const labelMap = new Map<string, { count: number; totalSize: number; mime: string }>();
    for (const ft of contentTypeAgg as Array<{
      _id: string;
      count: number;
      totalSize: number;
    }>) {
      const label = mimeToLabel(ft._id);
      const existing = labelMap.get(label);
      if (existing) {
        existing.count += ft.count;
        existing.totalSize += ft.totalSize;
      } else {
        labelMap.set(label, { count: ft.count, totalSize: ft.totalSize, mime: ft._id });
      }
    }

    const byFileType = Array.from(labelMap.entries())
      .map(([label, data]) => ({
        type: label,
        mime: data.mime,
        count: data.count,
        totalSize: data.totalSize,
        percentage: totalDocCount > 0 ? Math.round((data.count / totalDocCount) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Compute status counts
    const byStatus = statusAgg.map((s: { _id: string; count: number }) => ({
      status: s._id,
      count: s.count,
    }));

    // Find largest document name
    let largestDocName: string | null = null;
    if (sizeStats.maxSize > 0) {
      const largest = await SearchDocument.findOne({
        ...matchStage,
        contentSizeBytes: sizeStats.maxSize,
      })
        .select('originalReference')
        .lean();
      largestDocName = largest?.originalReference ?? null;
    }

    res.json({
      sourceId,
      documentCount: totalDocCount,
      totalChunks: chunkAgg[0]?.totalChunks ?? 0,
      totalPages: totalPages[0]?.totalPages ?? 0,
      size: {
        total: sizeStats.totalSize,
        average: Math.round(sizeStats.avgSize || 0),
        largest: sizeStats.maxSize,
        largestDocName,
        smallest: sizeStats.minSize,
      },
      byFileType,
      byStatus,
      recentDocuments: recentDocs.map((d: any) => ({
        _id: d._id,
        name: d.originalReference,
        size: d.contentSizeBytes,
        status: d.status,
        createdAt: d.createdAt,
        contentType: d.contentType,
      })),
    });
  } catch (error) {
    logger.error('Failed to get source stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get source stats' });
  }
});

/**
 * GET /:indexId/sources/:sourceId/status - Get ingestion status for a source
 */
router.get('/:indexId/sources/:sourceId/status', async (req: Request, res: Response) => {
  try {
    const { indexId, sourceId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const source = await SearchSource.findOne({
      _id: sourceId,
      indexId,
      tenantId,
    }).lean();

    if (!source) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    res.json({
      sourceId: source._id,
      status: source.status,
      documentCount: source.documentCount,
      lastSyncAt: source.lastSyncAt,
      syncError: source.syncError,
    });
  } catch (error) {
    logger.error('Failed to get source status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get source status' });
  }
});

export default router;
