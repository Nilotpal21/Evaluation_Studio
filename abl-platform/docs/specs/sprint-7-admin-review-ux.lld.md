# Sprint 7: Admin Review UX — Low-Level Design

## Task T-1: Attribute Admin API

### Files to Create

- `apps/search-ai/src/routes/attributes.ts` — 7 REST endpoints for attribute management
- `apps/search-ai/src/routes/__tests__/attributes.test.ts` — Route unit tests

### Files to Modify

- `apps/search-ai/src/server.ts` — Mount attributes router at `/api/indexes`
- `apps/search-ai/src/services/reconciliation/auto-promoter.ts` — Add admin_manual guard
- `apps/search-ai/src/scheduler/index.ts` — Add discoverySource filter to auto-promotion query

### Function Signatures

```typescript
// routes/attributes.ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { IAttributeRegistry, IAttributeMergeEvent } from '@agent-platform/database/models';

const AttributeRegistry = getLazyModel<IAttributeRegistry>('AttributeRegistry');
const AttributeMergeEvent = getLazyModel<IAttributeMergeEvent>('AttributeMergeEvent');
const logger = createLogger('attribute-routes');

// Zod schemas
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

export default function createAttributesRouter(): Router;
```

### Route Implementation Details

**Express Route Ordering** (CRITICAL — static before parameterized):

```typescript
const router = Router();

// Static routes FIRST
router.get('/:indexId/attributes', handleList);
router.get('/:indexId/attributes/review-queue', handleReviewQueue);
router.get('/:indexId/attributes/stats', handleStats);
router.post('/:indexId/attributes/bulk', handleBulk);
router.post('/:indexId/attributes/merge', handleMerge);

// Parameterized route LAST
router.get('/:indexId/attributes/:id', handleGetOne);
router.patch('/:indexId/attributes/:id', handleUpdate);
```

**GET /:indexId/attributes** — List with filters + pagination

```typescript
async function handleList(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const indexId = req.params.indexId;
    if (!indexId) {
      res
        .status(400)
        .json({ success: false, error: { code: 'MISSING_PARAM', message: 'indexId required' } });
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
    if (search)
      filter.$or = [
        { attributeId: { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } },
        { aliases: { $regex: search, $options: 'i' } },
      ];

    const [data, total] = await Promise.all([
      AttributeRegistry()
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AttributeRegistry().countDocuments(filter),
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
```

**GET /:indexId/attributes/review-queue** — Items needing admin attention

```typescript
async function handleReviewQueue(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const indexId = req.params.indexId;
    if (!indexId) {
      res
        .status(400)
        .json({ success: false, error: { code: 'MISSING_PARAM', message: 'indexId required' } });
      return;
    }

    // Use configurable thresholds from reconciliation config
    const { DEFAULT_RECONCILIATION_CONFIG } = await import('../services/reconciliation/types.js');
    const config = DEFAULT_RECONCILIATION_CONFIG;

    const [placementReview, allAttrs] = await Promise.all([
      // Novel attributes ready for decision (configurable thresholds)
      AttributeRegistry()
        .find({
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
      AttributeRegistry()
        .find({ tenantId, indexId, tier: { $ne: 'discarded' } })
        .lean(),
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
```

**GET /:indexId/attributes/stats** — Tier distribution + interaction stats

```typescript
async function handleStats(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const indexId = req.params.indexId;
    if (!indexId) {
      res
        .status(400)
        .json({ success: false, error: { code: 'MISSING_PARAM', message: 'indexId required' } });
      return;
    }

    // Reuse existing InteractionAggregator
    const { InteractionAggregator } =
      await import('../services/reconciliation/interaction-aggregator.js');
    const aggregator = new InteractionAggregator();

    const [tierCounts, recentPromotions, recentDemotions, interactionStats] = await Promise.all([
      AttributeRegistry().aggregate([
        { $match: { tenantId, indexId } },
        { $group: { _id: '$tier', count: { $sum: 1 } } },
      ]),
      AttributeRegistry()
        .find({
          tenantId,
          indexId,
          tier: 'approved',
          updatedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
        })
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean(),
      AttributeRegistry()
        .find({
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
```

**GET /:indexId/attributes/:id** — Single attribute detail (by MongoDB \_id)

```typescript
async function handleGetOne(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const { indexId, id } = req.params;
    if (!indexId || !id) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'indexId and id required' },
      });
      return;
    }
    const attr = await AttributeRegistry().findOne({ _id: id, tenantId, indexId }).lean();
    if (!attr) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Attribute not found' } });
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
```

**PATCH /:indexId/attributes/:id** — Update (sets discoverySource on tier change)

```typescript
async function handleUpdate(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
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

    const attr = await AttributeRegistry()
      .findOneAndUpdate({ _id: id, tenantId, indexId }, { $set: updateFields }, { new: true })
      .lean();
    if (!attr) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Attribute not found' } });
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
```

**POST /:indexId/attributes/bulk** — Bulk approve/discard/changeTier

```typescript
async function handleBulk(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const indexId = req.params.indexId;
    if (!indexId) {
      res
        .status(400)
        .json({ success: false, error: { code: 'MISSING_PARAM', message: 'indexId required' } });
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

    const result = await AttributeRegistry().updateMany(
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
```

**POST /:indexId/attributes/merge** — Merge two attributes + ClickHouse mutation

```typescript
async function handleMerge(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.tenantContext;
    const indexId = req.params.indexId;
    if (!indexId) {
      res
        .status(400)
        .json({ success: false, error: { code: 'MISSING_PARAM', message: 'indexId required' } });
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
      AttributeRegistry().findOne({ _id: sourceId, tenantId, indexId }).lean(),
      AttributeRegistry().findOne({ _id: targetId, tenantId, indexId }).lean(),
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
    await AttributeRegistry().updateOne(
      { _id: primary._id, tenantId },
      {
        $set: {
          aliases: mergedAliases,
          discoverySource: 'admin_manual',
          documentCount: (primary.documentCount ?? 0) + (secondary.documentCount ?? 0),
        },
      },
    );

    // Mark secondary as discarded
    await AttributeRegistry().updateOne(
      { _id: secondary._id, tenantId },
      {
        $set: { tier: 'discarded', discoverySource: 'admin_manual' },
      },
    );

    // Create merge audit event
    await AttributeMergeEvent().create({
      tenantId,
      indexId,
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
    } catch (error) {
      logger.error('ClickHouse merge mutation failed (non-blocking)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const updated = await AttributeRegistry().findOne({ _id: primary._id, tenantId }).lean();
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
```

### Auto-Promoter Guard Changes

**File: `auto-promoter.ts`** — Insert as the FIRST check in `evaluatePromotion()`, immediately after the `base` declaration at line 41, before the `discarded` check at line 42:

```typescript
// Admin-set tiers are never auto-promoted/demoted
if (attr.discoverySource === 'admin_manual') {
  return {
    ...base,
    action: 'keep',
    reason: 'Admin-managed attribute (discoverySource=admin_manual)',
  };
}
```

**File: `scheduler/index.ts`** — Uses direct `AttributeRegistry` import (not `getLazyModel`) via dynamic import at line 80. Modify line 92 and line 111-114:

```typescript
// Line 92: aggregate filter — add discoverySource exclusion
{ $match: { tier: { $in: ['beta', 'approved'] }, discoverySource: { $ne: 'admin_manual' } } },

// Lines 111-114: find filter — add discoverySource exclusion
// NOTE: scheduler uses direct model: `const { AttributeRegistry } = await import('@agent-platform/database/models');`
const attributes = await AttributeRegistry.find({
  tenantId, indexId,
  tier: { $in: ['beta', 'approved'] },
  discoverySource: { $ne: 'admin_manual' },
}).lean();
```

### Server.ts Mounting

Add after line 161 (`app.use('/api/indexes', vocabularyRouter);`):

```typescript
import attributesRouter from './routes/attributes.js';
// ...
app.use('/api/indexes', attributesRouter);
```

### Subtasks (execution order)

1. ST-1.1: Create `routes/attributes.ts` with Zod schemas + 7 route handlers
2. ST-1.2: Mount router in `server.ts`
3. ST-1.3: Add admin_manual guard to `auto-promoter.ts` (line 42)
4. ST-1.4: Add discoverySource filter to `scheduler/index.ts` (lines 92, 111-114)
5. ST-1.5: Write unit tests (`routes/__tests__/attributes.test.ts`)
6. ST-1.6: Run `pnpm build --filter=search-ai` to verify types

### Acceptance Criteria

- AC-1.1: `GET /attributes?tier=novel` returns only novel tier attributes scoped to tenantId + indexId
  - Verify: `pnpm vitest run apps/search-ai/src/routes/__tests__/attributes.test.ts`
  - Expected: 200 with `{ data: [...], total, page, limit }`
- AC-1.2: `PATCH /attributes/:id { tier: 'approved' }` sets `discoverySource: 'admin_manual'`
  - Verify: Check mock updateOne call includes `discoverySource: 'admin_manual'`
- AC-1.3: `evaluatePromotion()` returns `action: 'keep'` for `discoverySource === 'admin_manual'` attributes
  - Verify: Unit test with `discoverySource: 'admin_manual'` attribute
- AC-1.4: Static routes `/review-queue`, `/stats`, `/bulk`, `/merge` are not captured by `/:id`
  - Verify: GET `/attributes/review-queue` returns 200, not 404
- AC-1.5: Cross-tenant access returns 404
  - Verify: Query with wrong tenantId returns 404

---

## Task T-2: Studio Proxy + Hooks

### Files to Create

**Attribute Proxy Routes:**

- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/route.ts` — GET (list)
- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/review-queue/route.ts` — GET
- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/stats/route.ts` — GET
- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/bulk/route.ts` — POST
- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/merge/route.ts` — POST
- `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/[attrId]/route.ts` — GET, PATCH

**Browse Runtime Proxy Routes:**

- `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/taxonomy/route.ts` — GET
- `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/facets/route.ts` — GET
- `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/facet-counts/route.ts` — POST
- `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/facets/[attributeType]/documents/route.ts` — GET
- `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/interactions/route.ts` — POST

**Hooks + API Functions:**

- `apps/studio/src/hooks/useAttributes.ts` — 4 SWR hooks

### Files to Modify

- `apps/studio/src/api/search-ai.ts` — Add 12 new API functions (7 attribute + 5 browse) + types

### Proxy Route Pattern (follow vocabulary/route.ts exactly)

```typescript
// Example: apps/studio/src/app/api/search-ai/indexes/[id]/attributes/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchEngine } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id } = await params;
  const qs = request.nextUrl.search; // preserve query params
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}/attributes${qs}`, {
    tenantId: user.tenantId,
  });
}
```

```typescript
// Example: apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/taxonomy/route.ts
import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToSearchRuntime } from '@/lib/search-ai-proxy';

type Ctx = { params: Promise<{ indexId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { indexId } = await params;
  const qs = request.nextUrl.search;
  return proxyToSearchRuntime(
    request,
    `/api/search/${encodeURIComponent(indexId)}/browse/taxonomy${qs}`,
    {
      tenantId: user.tenantId,
    },
  );
}
```

### API Functions (in search-ai.ts)

```typescript
// ── Attribute Types ──────────────────────────────────────────────
export type AttributeTier = 'permanent' | 'approved' | 'beta' | 'novel' | 'discarded';

export interface AttributeRegistryItem {
  _id: string;
  tenantId: string;
  indexId: string;
  attributeId: string;
  productScope: string;
  tier: AttributeTier;
  displayName: string;
  dataType: string;
  aliases: string[];
  extractionPatterns: string[];
  definition?: string;
  confidence?: number;
  documentCount?: number;
  discoverySource?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  uniqueUsers?: number;
  totalInteractions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeFilters {
  tier?: AttributeTier;
  product?: string;
  dataType?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ReviewQueueResult {
  mergeConflicts: Array<{ attributeId: string; attributes: AttributeRegistryItem[] }>;
  placementReview: AttributeRegistryItem[];
  typeConflicts: Array<{ attributeId: string; attributes: AttributeRegistryItem[] }>;
  total: number;
}

export interface AttributeStatsResult {
  byTier: Record<string, number>;
  recentPromotions: AttributeRegistryItem[];
  recentDemotions: AttributeRegistryItem[];
  interactionStats: Record<
    string,
    { impressions: number; clicks: number; uniqueUsers: number; clickRate: number }
  >;
}

// ── Attribute API Functions ──────────────────────────────────────
export async function getAttributes(indexId: string, filters?: AttributeFilters) {
  const params = new URLSearchParams();
  if (filters?.tier) params.set('tier', filters.tier);
  if (filters?.product) params.set('product', filters.product);
  if (filters?.dataType) params.set('dataType', filters.dataType);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.page) params.set('page', String(filters.page));
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes${qs}`)).then(handleResponse);
}

export async function getAttributeDetail(indexId: string, id: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/${id}`)).then(handleResponse);
}

export async function updateAttribute(
  indexId: string,
  id: string,
  data: Partial<{
    tier: AttributeTier;
    displayName: string;
    aliases: string[];
    definition: string;
  }>,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function getReviewQueue(indexId: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/review-queue`)).then(handleResponse);
}

export async function getAttributeStats(indexId: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/stats`)).then(handleResponse);
}

export async function bulkAttributeAction(
  indexId: string,
  action: 'approve' | 'discard' | 'changeTier',
  attributeIds: string[],
  targetTier?: AttributeTier,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/bulk`), {
    method: 'POST',
    body: JSON.stringify({ action, attributeIds, targetTier }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function mergeAttributes(
  indexId: string,
  sourceId: string,
  targetId: string,
  primaryId: string,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/merge`), {
    method: 'POST',
    body: JSON.stringify({ sourceId, targetId, primaryId }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

// ── Browse API Functions ──────────────────────────────────────
export async function getBrowseTaxonomy(indexId: string, includeBeta = true) {
  return apiFetch(
    runtimeUrl(`/search/${indexId}/browse/taxonomy?include_beta=${includeBeta}`),
  ).then(handleResponse);
}

export async function getBrowseFacets(
  indexId: string,
  attribute: string,
  product?: string,
  limit = 50,
) {
  const params = new URLSearchParams({ attribute, limit: String(limit) });
  if (product) params.set('product', product);
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/facets?${params}`)).then(handleResponse);
}

export async function postBrowseFacetCounts(
  indexId: string,
  documentIds: string[],
  product?: string,
) {
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/facet-counts`), {
    method: 'POST',
    body: JSON.stringify({ documentIds, product }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function getBrowseFacetDocuments(
  indexId: string,
  attributeType: string,
  value: string,
  product?: string,
  limit = 20,
) {
  const params = new URLSearchParams({ value, limit: String(limit) });
  if (product) params.set('product', product);
  return apiFetch(
    runtimeUrl(`/search/${indexId}/browse/facets/${attributeType}/documents?${params}`),
  ).then(handleResponse);
}

export async function postBrowseInteraction(
  indexId: string,
  events: Array<{
    attributeType: string;
    productType?: string;
    facetValue?: string;
    interactionType: string;
    sessionId?: string;
  }>,
) {
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/interactions`), {
    method: 'POST',
    body: JSON.stringify({ events }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}
```

### SWR Hooks (useAttributes.ts)

```typescript
import useSWR from 'swr';
import type {
  AttributeRegistryItem,
  AttributeFilters,
  ReviewQueueResult,
  AttributeStatsResult,
} from '../api/search-ai';

export function useAttributes(indexId: string | null, filters?: AttributeFilters) {
  const params = new URLSearchParams();
  if (filters?.tier) params.set('tier', filters.tier);
  if (filters?.product) params.set('product', filters.product);
  if (filters?.dataType) params.set('dataType', filters.dataType);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.page) params.set('page', String(filters.page ?? 1));
  if (filters?.limit) params.set('limit', String(filters.limit ?? 20));
  const qs = params.toString() ? `?${params}` : '';
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes${qs}` : null;
  const { data, error, isLoading, mutate } = useSWR<{
    data: AttributeRegistryItem[];
    total: number;
  }>(key, { revalidateOnFocus: false, dedupingInterval: 5000 });
  return {
    data: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}

export function useAttributeDetail(indexId: string | null, id: string | null) {
  const key = indexId && id ? `/api/search-ai/indexes/${indexId}/attributes/${id}` : null;
  const { data, error, isLoading, mutate } = useSWR<{ data: AttributeRegistryItem }>(key, {
    revalidateOnFocus: false,
  });
  return { data: data?.data ?? null, isLoading, error: error?.message ?? null, mutate };
}

export function useReviewQueue(indexId: string | null) {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes/review-queue` : null;
  const { data, error, isLoading, mutate } = useSWR<ReviewQueueResult>(key, {
    revalidateOnFocus: false,
    refreshInterval: 30000,
  });
  return {
    ...(data ?? { mergeConflicts: [], placementReview: [], typeConflicts: [], total: 0 }),
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}

export function useAttributeStats(indexId: string | null) {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes/stats` : null;
  const { data, error, isLoading, mutate } = useSWR<AttributeStatsResult>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
  });
  return { data: data ?? null, isLoading, error: error?.message ?? null, mutate };
}
```

### Subtasks

1. ST-2.1: Add types to `search-ai.ts` (AttributeRegistryItem, filters, results)
2. ST-2.2: Add 7 attribute API functions to `search-ai.ts`
3. ST-2.3: Add 5 browse API functions to `search-ai.ts`
4. ST-2.4: Create 6 attribute proxy route files
5. ST-2.5: Create 5 browse runtime proxy route files
6. ST-2.6: Create `useAttributes.ts` with 4 SWR hooks
7. ST-2.7: Run `pnpm build --filter=studio` to verify types

### Acceptance Criteria

- AC-2.1: `GET /api/search-ai/indexes/[id]/attributes` proxies to engine and returns data
- AC-2.2: `GET /api/search-ai-runtime/search/[indexId]/browse/taxonomy` proxies to runtime
- AC-2.3: `useAttributes(indexId)` returns `{ data, total, isLoading, error, mutate }`
- AC-2.4: `useReviewQueue(indexId)` polls every 30s
- AC-2.5: All proxy routes require auth (`requireAuth`) and pass tenantId

---

## Task T-3: Attribute Manager UI

### Files to Create

- `apps/studio/src/components/search-ai/attributes/AttributeManagerSection.tsx`
- `apps/studio/src/components/search-ai/attributes/AttributeTable.tsx`
- `apps/studio/src/components/search-ai/attributes/AttributeDetailPanel.tsx`
- `apps/studio/src/components/search-ai/attributes/AttributeTierBadge.tsx`

### Files to Modify

- `apps/studio/src/components/search-ai/KnowledgeGraphTab.tsx` — Add 3rd toggle + render AttributeManagerSection
- `apps/studio/src/components/search-ai/intelligence/cards/KnowledgeGraphCard.tsx` — Add attention state (uses `useReviewQueue(indexId)` to get total count, shows amber dot when total > 0)
- `apps/studio/src/store/navigation-store.ts` — Add kgView field

### Navigation Store Change

Add `kgView` to `NavigationState` interface:

```typescript
interface NavigationState {
  // ... existing fields
  kgView: 'graph' | 'statistics' | 'attributes';
  setKgView: (view: 'graph' | 'statistics' | 'attributes') => void;
}
```

Initialize with `'graph'` in the store creator. The `setKgView` action simply updates the field.

### KnowledgeGraphTab Toggle (modify lines 88, 302-328)

**FULL MIGRATION**: Replace ALL occurrences of `viewMode`/`setViewMode` with `kgView`/`setKgView` across KnowledgeGraphTab.tsx (lines 88, 305, 317, 331, 343, and conditional renders). The type expands from `'graph' | 'statistics'` to `'graph' | 'statistics' | 'attributes'`. This is a find-and-replace across ~10 references. Change `useState<'graph' | 'statistics'>` to read from navigation store:

```typescript
// Replace line 88
const kgView = useNavigationStore((s) => s.kgView);
const setKgView = useNavigationStore((s) => s.setKgView);

// Add 3rd button after Statistics button (line 327):
<button
  onClick={() => setKgView('attributes')}
  className={clsx(
    'px-4 py-2 text-sm font-medium rounded-md transition-default',
    kgView === 'attributes'
      ? 'bg-accent text-accent-foreground shadow-sm'
      : 'text-muted hover:text-foreground',
  )}
>
  <Diamond className="w-4 h-4 inline mr-2" />
  Attributes
  {reviewQueueTotal > 0 && (
    <Badge variant="warning" className="ml-2">{reviewQueueTotal}</Badge>
  )}
</button>

// Add render block after statistics view:
{kgView === 'attributes' && <AttributeManagerSection indexId={indexId} />}
```

### Component Specs

**AttributeManagerSection** — Main view with inner tabs

```typescript
interface AttributeManagerSectionProps {
  indexId: string;
}
// Uses: useAttributes, useReviewQueue, useAttributeStats
// Renders: tier stat cards, inner tabs (Review Queue | All Attributes | Stats), filter bar, AttributeTable
// State: selectedTab, filters, selectedAttributeId (opens detail panel), selectedIds (Set<string>)
// Pre-wired extension points for T-5 and T-6 (avoids file overlap):
//   - mergeCandidate state: { source, target } | null → opens AttributeMergeDialog (T-5 adds dialog)
//   - selectedIds state + toggle handlers → renders AttributeBulkBar slot above table (T-6 adds component)
//   - onMergeClick callback passed to review queue items
//   - onBulkAction callback wired to bulkAttributeAction API
```

**AttributeTable** — DataTable wrapper

```typescript
interface AttributeTableProps {
  attributes: AttributeRegistryItem[];
  onSelect: (attr: AttributeRegistryItem) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
}
// Columns: checkbox, attributeId+displayName, productScope, tier (badge), dataType, documentCount, confidence (bar), updatedAt
```

**AttributeDetailPanel** — SlidePanel wrapper

```typescript
interface AttributeDetailPanelProps {
  attributeId: string | null;
  indexId: string;
  onClose: () => void;
  onSave: () => void;
}
// Uses: useAttributeDetail(indexId, attributeId), updateAttribute()
// Sections: tier pills, displayName input, product scope, data type, aliases tags, definition textarea, discovery stats, interaction stats
// Footer: Cancel, Discard (error), Approve (accent)
```

**AttributeTierBadge** — Colored badge

```typescript
interface AttributeTierBadgeProps {
  tier: AttributeTier;
}
// Maps tier → Badge variant: permanent→success, approved→info, beta→purple, novel→warning, discarded→default
```

### Subtasks

1. ST-3.1: Add `kgView` + `setKgView` to navigation-store.ts
2. ST-3.2: Create `AttributeTierBadge.tsx`
3. ST-3.3: Create `AttributeTable.tsx`
4. ST-3.4: Create `AttributeDetailPanel.tsx` (uses SlidePanel)
5. ST-3.5: Create `AttributeManagerSection.tsx` (orchestrator)
6. ST-3.6: Modify `KnowledgeGraphTab.tsx` (3rd toggle + render)
7. ST-3.7: Modify `KnowledgeGraphCard.tsx` (attention state + navigate to attributes)

### Acceptance Criteria

- AC-3.1: KG tab shows 3-way toggle (Graph | Statistics | Attributes)
- AC-3.2: Attributes toggle shows tier stat cards with correct counts
- AC-3.3: Clicking a row opens detail panel (SlidePanel, 420px)
- AC-3.4: Tier badge colors match design system (green/cyan/purple/amber/muted)
- AC-3.5: KG Hub Card shows amber attention dot when review queue > 0

---

## Task T-4: SDK Preview Page

### Files to Create

- `apps/studio/src/app/projects/[projectId]/search-ai/[kbId]/browse-preview/page.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowsePreviewPage.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowsePreviewHeader.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowsePreviewSidebar.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowsePreviewResults.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowseAutoSuggest.tsx`
- `apps/studio/src/components/search-ai/browse-preview/BrowseDocumentCard.tsx`

### Files to Modify

- `apps/studio/src/components/search-ai/layout/KBHeader.tsx` — Add "Preview SDK ↗" button

### KBHeader Modification (line 81-93)

Add between Badge and Settings button:

```tsx
<a
  href={`/projects/${knowledgeBase.projectId}/search-ai/${knowledgeBase._id}/browse-preview`}
  target="_blank"
  rel="noopener noreferrer"
  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-background-muted border border-default hover:bg-background-elevated transition-default"
>
  <Eye className="w-3.5 h-3.5" />
  <span>{t('preview_sdk')}</span>
  <ExternalLink className="w-3 h-3 opacity-60" />
</a>
```

### Page Route (Next.js app router)

```typescript
// apps/studio/src/app/projects/[projectId]/search-ai/[kbId]/browse-preview/page.tsx
import { BrowsePreviewPage } from '@/components/search-ai/browse-preview/BrowsePreviewPage';

type Props = { params: Promise<{ projectId: string; kbId: string }> };

export default async function BrowsePreviewRoute({ params }: Props) {
  const { projectId, kbId } = await params;
  return <BrowsePreviewPage projectId={projectId} kbId={kbId} />;
}
```

### BrowsePreviewPage — Data flow orchestrator

```typescript
interface BrowsePreviewPageProps {
  projectId: string;
  kbId: string;
}
// State: searchQuery, selectedCategory, activeFacets, includeBeta, sortBy, page
// Fetches KB detail to get indexId, then:
//   1. getBrowseTaxonomy(indexId, includeBeta) → taxonomy tree + attribute metadata
//   2. getBrowseFacets(indexId, attribute, product) → facet values per attribute
//   3. On search: POST /search → results, then postBrowseFacetCounts → counts within results
//   4. On facet click: getBrowseFacetDocuments → doc IDs → filter results
```

### BrowsePreviewHeader — Admin banner + search bar + category pills

```typescript
interface BrowsePreviewHeaderProps {
  kbName: string;
  documentCount: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  categories: Array<{ id: string; name: string; active: boolean }>;
  onCategoryClick: (categoryId: string) => void;
  includeBeta: boolean;
  onToggleBeta: () => void;
}
```

### BrowsePreviewSidebar — Taxonomy tree + facets (280px)

```typescript
interface BrowsePreviewSidebarProps {
  taxonomy: TaxonomyNode[];
  facets: Array<{
    attribute: string;
    values: Array<{ value: string; count: number; active: boolean }>;
  }>;
  selectedCategory: string | null;
  onCategorySelect: (id: string) => void;
  onFacetToggle: (attribute: string, value: string) => void;
  includeBeta: boolean;
}
```

### BrowsePreviewResults — Document cards + pagination

```typescript
interface BrowsePreviewResultsProps {
  documents: Array<{
    id: string;
    title: string;
    summary: string;
    source: string;
    attributes: Array<{ key: string; value: string; tier: AttributeTier }>;
    updatedAt: string;
    sourceUrl?: string;
  }>;
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  sortBy: string;
  onSortChange: (sort: string) => void;
  activeFacets: Map<string, Set<string>>;
  includeBeta: boolean;
}
```

### Subtasks

1. ST-4.1: Add "Preview SDK ↗" button to KBHeader.tsx
2. ST-4.2: Create BrowseDocumentCard.tsx
3. ST-4.3: Create BrowseAutoSuggest.tsx (debounce 300ms)
4. ST-4.4: Create BrowsePreviewSidebar.tsx (taxonomy tree + collapsible facets)
5. ST-4.5: Create BrowsePreviewResults.tsx (cards + pagination)
6. ST-4.6: Create BrowsePreviewHeader.tsx (admin banner + search + pills)
7. ST-4.7: Create BrowsePreviewPage.tsx (orchestrator)
8. ST-4.8: Create page.tsx route file

### Acceptance Criteria

- AC-4.1: "Preview SDK ↗" button visible in KB header, opens new browser tab
- AC-4.2: Preview page loads taxonomy tree in sidebar
- AC-4.3: Search bar debounces 300ms, triggers search API
- AC-4.4: Beta toggle hides/shows beta-badged facets and attribute tags
- AC-4.5: Category pills sync bidirectionally with taxonomy tree selection
- AC-4.6: Facet checkbox updates result count (post-search facet counts)

---

## Task T-5: Merge Workflow

### Files to Create

- `apps/studio/src/components/search-ai/attributes/AttributeMergeDialog.tsx`

### Component Spec

```typescript
interface AttributeMergeDialogProps {
  source: AttributeRegistryItem;
  target: AttributeRegistryItem;
  indexId: string;
  open: boolean;
  onClose: () => void;
  onMergeComplete: () => void;
}
// Layout: side-by-side comparison (source | target)
// Shows: attributeId, product, type, docs, aliases, confidence
// Preview: "After merge" section showing merged aliases, combined doc count
// Actions: Keep Both (close), Discard Source (discard only), Merge (calls mergeAttributes API)
```

### Subtasks

1. ST-5.1: Create AttributeMergeDialog.tsx with side-by-side layout
2. ST-5.2: Wire merge API call (mergeAttributes from search-ai.ts)
3. ST-5.3: Wire into pre-built mergeCandidate slot in AttributeManagerSection (slot created in T-3 ST-3.5, no file modification needed — just render `{mergeCandidate && <AttributeMergeDialog .../>}` in the slot)

### Acceptance Criteria

- AC-5.1: Dialog shows source and target side-by-side
- AC-5.2: "Merge" button calls POST /attributes/merge and refreshes list
- AC-5.3: Merged result shows combined aliases and doc count

---

## Task T-6: Bulk Actions

### Files to Create

- `apps/studio/src/components/search-ai/attributes/AttributeBulkBar.tsx`

### Component Spec

```typescript
interface AttributeBulkBarProps {
  selectedCount: number;
  onApprove: () => void;
  onDiscard: () => void;
  onChangeTier: (tier: AttributeTier) => void;
  onClearSelection: () => void;
}
// Appears above table when checkboxes selected
// Shows: "{N} selected" + Approve Selected (accent) + Discard (error) + Change Tier dropdown
// Each action shows ConfirmDialog before executing
```

### Subtasks

1. ST-6.1: Create AttributeBulkBar.tsx with action buttons
2. ST-6.2: Wire bulk API call (bulkAttributeAction from search-ai.ts)
3. ST-6.3: Add confirmation dialogs before each action
4. ST-6.4: Wire into pre-built bulk bar slot in AttributeManagerSection (slot created in T-3 ST-3.5, renders `{selectedIds.size > 0 && <AttributeBulkBar .../>}` in the slot)

### Acceptance Criteria

- AC-6.1: Bulk bar appears when 1+ checkboxes selected
- AC-6.2: "Approve Selected" calls POST /attributes/bulk with action='approve'
- AC-6.3: Confirmation dialog shows count before executing
- AC-6.4: After action, selection clears and list refreshes
