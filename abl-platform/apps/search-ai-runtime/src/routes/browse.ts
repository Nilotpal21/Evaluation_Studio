/**
 * Browse SDK Router
 *
 * GET  /api/search/:indexId/browse/taxonomy — Return taxonomy tree with
 *      attribute metadata overlay from AttributeRegistry.
 * GET  /api/search/:indexId/browse/facets — Facet values for an attribute.
 * POST /api/search/:indexId/browse/facet-counts — Post-search facet counts.
 * GET  /api/search/:indexId/browse/facets/:attributeType/documents — Documents
 *      matching a facet value.
 *
 * Reads from TaxonomyCacheReader first (Redis + LRU), falls back to
 * MongoDB if cache misses.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { getTaxonomyCacheReader } from '../services/taxonomy/taxonomy-cache-reader.js';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import type { IKnowledgeGraphTaxonomy, IAttributeRegistry } from '@agent-platform/database/models';
import { FacetQueryService } from '../services/browse/facet-query.service.js';

const log = createLogger('browse-router');

const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');
const AttributeRegistryModel = getLazyModel<IAttributeRegistry>('AttributeRegistry');

/** Module-scope FacetQueryService singleton (lazy ClickHouse init inside) */
const facetQueryService = new FacetQueryService();

// --- Zod validation schemas ---

const facetQuerySchema = z.object({
  attribute: z.string().min(1).max(256),
  product: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const facetDocumentsQuerySchema = z.object({
  value: z.string().min(1).max(2000),
  product: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const taxonomyQuerySchema = z.object({
  include_beta: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

const facetCountsBodySchema = z.object({
  documentIds: z.array(z.string().min(1).max(256)).min(1).max(10000),
  product: z.string().min(1).max(256).optional(),
});

export function createBrowseRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  /**
   * GET /:indexId/browse/taxonomy
   *
   * Returns taxonomy tree (domain, categories, products, attributes) with
   * attribute metadata from AttributeRegistry overlaid.
   *
   * Tier filtering: Only 'permanent' and 'approved' attributes are exposed
   * to end-users by default. 'novel' attributes are unverified suggestions
   * from the reconciliation pipeline, and 'discarded' attributes have been
   * explicitly rejected. Pass ?include_beta=true to also include 'beta'
   * tier attributes (for admin previewing). Beta attributes are marked
   * with isBeta: true in the attributeMetadata response.
   */
  router.get('/:indexId/browse/taxonomy', async (req, res) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const { indexId } = req.params;

      const queryParsed = taxonomyQuerySchema.safeParse(req.query);
      const includeBeta = queryParsed.success ? queryParsed.data.include_beta : false;

      // 1. Read taxonomy from cache (Redis + LRU), fall back to MongoDB
      let taxonomy: IKnowledgeGraphTaxonomy | null = null;
      try {
        taxonomy = await getTaxonomyCacheReader().getTaxonomy(tenantId, indexId);
      } catch (error) {
        log.warn('Taxonomy cache read failed, falling back to MongoDB', {
          tenantId,
          indexId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!taxonomy) {
        try {
          taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
        } catch (error) {
          log.error('MongoDB taxonomy fallback failed', {
            tenantId,
            indexId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 2. Fetch document counts per product from ClickHouse (in parallel with attribute metadata)
      const documentCountsPromise = facetQueryService
        .getDocumentCountsByProduct(tenantId, indexId)
        .catch((error) => {
          log.warn('Document counts fetch failed, returning empty counts', {
            tenantId,
            indexId,
            error: error instanceof Error ? error.message : String(error),
          });
          return {} as Record<string, number>;
        });

      // 3. Read attribute metadata from AttributeRegistry
      let attributeMetadata: Record<
        string,
        {
          displayName: string;
          tier: string;
          aliases: string[];
          dataType: string;
          productScope: string;
          isBeta: boolean;
        }
      > = {};
      try {
        // Only expose permanent + approved attributes — novel/discarded never visible
        const allowedTiers = ['permanent', 'approved'];
        if (includeBeta) allowedTiers.push('beta');
        const attributes = await AttributeRegistryModel.find({
          tenantId,
          indexId,
          tier: { $in: allowedTiers },
        }).lean();
        for (const attr of attributes) {
          const key = `${attr.productScope}:${attr.attributeId}`;
          attributeMetadata[key] = {
            displayName: attr.displayName,
            tier: attr.tier,
            aliases: attr.aliases ?? [],
            dataType: attr.dataType,
            productScope: attr.productScope,
            isBeta: attr.tier === 'beta',
          };
        }
      } catch (error) {
        log.warn('AttributeRegistry read failed, returning taxonomy without metadata', {
          tenantId,
          indexId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Await document counts (already running in parallel)
      const documentCounts = await documentCountsPromise;

      // 4. Merge attribute metadata onto taxonomy attributes
      const taxonomyData = taxonomy?.taxonomy ?? {
        domain: null,
        categories: [],
        products: [],
        attributes: [],
      };

      if (taxonomyData.attributes && Object.keys(attributeMetadata).length > 0) {
        taxonomyData.attributes = taxonomyData.attributes.map((attr) => {
          // Look up metadata by matching attribute name against each product scope
          const overlays: Record<string, unknown>[] = [];
          const allowedOverlayTiers = new Set(['permanent', 'approved']);
          if (includeBeta) allowedOverlayTiers.add('beta');
          for (const [key, meta] of Object.entries(attributeMetadata)) {
            // Defense-in-depth: allowlist tiers (not denylist)
            if (!allowedOverlayTiers.has(meta.tier)) continue;
            if (key.endsWith(`:${attr.name}`) || key.endsWith(`:${attr.id}`)) {
              overlays.push(meta);
            }
          }
          if (overlays.length > 0) {
            // Merge first matching overlay (product-scoped metadata)
            const primary = overlays[0];
            return {
              ...attr,
              displayName: (primary.displayName as string) ?? attr.name,
              tier: (primary.tier as string) ?? undefined,
              aliases: (primary.aliases as string[]) ?? [],
            };
          }
          return attr;
        });
      }

      res.json({
        taxonomy: {
          domain: taxonomyData.domain,
          categories: taxonomyData.categories ?? [],
          products: taxonomyData.products ?? [],
          attributes: taxonomyData.attributes ?? [],
        },
        attributeMetadata,
        documentCounts,
      });
    } catch (error) {
      log.error('Taxonomy endpoint failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /:indexId/browse/facets
   *
   * Returns distinct values for an attribute, optionally scoped to a product.
   * Query params: attribute (required), product (optional), limit (default 50, max 500), offset (default 0).
   */
  router.get('/:indexId/browse/facets', async (req, res) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const { indexId } = req.params;

      const parsed = facetQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
        return;
      }

      const { attribute, product, limit, offset } = parsed.data;
      const result = await facetQueryService.getFacetValues(
        tenantId,
        indexId,
        attribute,
        product,
        limit,
        offset,
      );

      res.json(result);
    } catch (error) {
      log.error('Facet values endpoint failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /:indexId/browse/facet-counts
   *
   * Returns facet count distribution for a set of document IDs (post-search).
   * Body: { documentIds: string[], product?: string }
   */
  router.post('/:indexId/browse/facet-counts', async (req, res) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const { indexId } = req.params;

      const parsed = facetCountsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
        return;
      }

      const { documentIds, product } = parsed.data;
      const facets = await facetQueryService.getFacetCountsForDocuments(
        tenantId,
        indexId,
        documentIds,
        product,
      );

      res.json({ facets, total: facets.length });
    } catch (error) {
      log.error('Facet counts endpoint failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /:indexId/browse/facets/:attributeType/documents
   *
   * Returns document IDs matching a specific facet value.
   * Query params: value (required), product (optional), limit (default 100, max 1000).
   *
   * IMPORTANT: This parameterized route is registered AFTER the static
   * /browse/facets and /browse/facet-counts routes to avoid capturing them.
   */
  router.get('/:indexId/browse/facets/:attributeType/documents', async (req, res) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const { indexId, attributeType } = req.params;

      const parsed = facetDocumentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
        return;
      }

      const { value, product, limit } = parsed.data;
      const result = await facetQueryService.getDocumentsByFacet(
        tenantId,
        indexId,
        attributeType,
        value,
        product,
        limit,
      );

      res.json(result);
    } catch (error) {
      log.error('Facet documents endpoint failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
