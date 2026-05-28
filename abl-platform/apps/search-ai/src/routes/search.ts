/**
 * Search Routes (Example)
 *
 * Example implementation of permission-aware search endpoints.
 * This file demonstrates how to integrate PermissionFilterMiddleware
 * with vector database queries.
 *
 * NOTE: This is a reference implementation. Actual search routes
 * may vary based on your vector store (Qdrant/OpenSearch) implementation.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import {
  applyPermissionFilter,
  hasPermissionFilter,
  getAccessibleDocumentIds,
  type PermissionFilteredRequest,
} from '../middleware/permission-filter.middleware.js';

const router: RouterType = Router();

// ============================================================================
// Search Endpoint with Permission Filtering
// ============================================================================

/**
 * POST /search - Semantic search with permission filtering
 *
 * Example request body:
 * {
 *   "query": "financial reports Q4",
 *   "indexId": "index-123",
 *   "topK": 10,
 *   "similarityThreshold": 0.7
 * }
 *
 * The applyPermissionFilter middleware:
 * 1. Resolves accessible document IDs from MongoDB permissions
 * 2. Attaches IDs to req.accessibleDocumentIds
 * 3. Search implementation filters results by these IDs
 */
router.post('/search', applyPermissionFilter(), async (req: Request, res: Response) => {
  try {
    const { query, indexId, topK = 10, similarityThreshold = 0.7 } = req.body;

    if (!query || !indexId) {
      res.status(400).json({ error: 'query and indexId are required' });
      return;
    }

    // Get accessible document IDs from middleware
    const accessibleDocIds = getAccessibleDocumentIds(req);

    if (!accessibleDocIds) {
      res.status(500).json({ error: 'Permission filtering not applied' });
      return;
    }

    // TODO: Replace with actual vector store implementation
    // Example for Qdrant:
    // const results = await qdrantClient.search(collectionName, {
    //   vector: await embedQuery(query),
    //   filter: {
    //     must: [
    //       { key: '_id', match: { any: accessibleDocIds } }
    //     ]
    //   },
    //   limit: topK,
    //   score_threshold: similarityThreshold
    // });

    // Example for OpenSearch:
    // const results = await openSearchClient.search({
    //   index: indexId,
    //   body: {
    //     query: {
    //       bool: {
    //         must: [
    //           { knn: { embedding: { vector: await embedQuery(query), k: topK } } }
    //         ],
    //         filter: [
    //           { terms: { '_id': accessibleDocIds } }
    //         ]
    //       }
    //     },
    //     min_score: similarityThreshold
    //   }
    // });

    // Mock response for demonstration
    const mockResults = {
      results: [
        {
          documentId: accessibleDocIds[0] || 'doc-1',
          score: 0.95,
          content: 'Sample search result...',
          metadata: { title: 'Q4 Financial Report' },
        },
      ],
      total: 1,
      permissionMetadata: (req as PermissionFilteredRequest).permissionFilterMetadata,
    };

    res.json(mockResults);
  } catch (error) {
    console.error('[search] Search failed:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /search/hybrid - Hybrid search (keyword + semantic) with permission filtering
 *
 * Example request body:
 * {
 *   "query": "financial reports Q4",
 *   "indexId": "index-123",
 *   "topK": 10,
 *   "hybridWeights": { "keyword": 0.3, "semantic": 0.7 }
 * }
 */
router.post('/search/hybrid', applyPermissionFilter(), async (req: Request, res: Response) => {
  try {
    const { query, indexId, topK = 10, hybridWeights = { keyword: 0.3, semantic: 0.7 } } = req.body;

    if (!query || !indexId) {
      res.status(400).json({ error: 'query and indexId are required' });
      return;
    }

    const accessibleDocIds = getAccessibleDocumentIds(req);

    if (!accessibleDocIds) {
      res.status(500).json({ error: 'Permission filtering not applied' });
      return;
    }

    // TODO: Implement hybrid search with permission filtering
    // Combine keyword (BM25) and semantic (vector) search
    // Apply document ID filter to both search methods

    const mockResults = {
      results: [],
      total: 0,
      searchMethod: 'hybrid',
      weights: hybridWeights,
      permissionMetadata: (req as PermissionFilteredRequest).permissionFilterMetadata,
    };

    res.json(mockResults);
  } catch (error) {
    console.error('[search] Hybrid search failed:', error);
    res.status(500).json({ error: 'Hybrid search failed' });
  }
});

/**
 * GET /search/debug - Debug endpoint to inspect permission filtering
 *
 * Returns accessible document IDs for the current user without performing search.
 * Useful for testing and debugging permission filtering.
 */
router.get('/search/debug', applyPermissionFilter(), async (req: Request, res: Response) => {
  try {
    if (!hasPermissionFilter(req)) {
      res.status(500).json({ error: 'Permission filtering not applied' });
      return;
    }

    const filteredReq = req as PermissionFilteredRequest;

    res.json({
      accessibleDocuments: {
        count: filteredReq.accessibleDocumentIds?.length || 0,
        sampleIds: filteredReq.accessibleDocumentIds?.slice(0, 10) || [],
      },
      metadata: filteredReq.permissionFilterMetadata,
      user: {
        tenantId: req.tenantContext?.tenantId,
        userId: req.tenantContext?.userId,
        email: req.tenantContext?.userId, // For user auth, userId IS the email
      },
    });
  } catch (error) {
    console.error('[search] Debug endpoint failed:', error);
    res.status(500).json({ error: 'Debug endpoint failed' });
  }
});

export default router;
