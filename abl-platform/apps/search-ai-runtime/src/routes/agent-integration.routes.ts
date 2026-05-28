/**
 * Agent Integration API Routes - API-7, API-8
 *
 * REST endpoints for agents to download context for local query processing.
 * Implements the download-first pattern for LLM cost optimization.
 *
 * **Routes:**
 * - GET  /projects/:projectId/kb/:kbId/query-types          - Download query classification examples (API-7)
 * - GET  /projects/:projectId/kb/:kbId/vocabulary-context   - Download vocabulary + schema (API-8)
 */

import { Router, type Request, type Response, type IRouter } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import type { IDomainVocabulary, ICanonicalSchema } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { requireProjectKbAccess } from './project-kb-access.js';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
import { QUERY_TYPE_EXAMPLES } from '../services/query-type-classifier/query-type-examples.js';

const logger = createLogger('AgentIntegrationRoutes');
const router: IRouter = Router();
router.use(authMiddleware);

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Standard error response
 */
function errorResponse(res: Response, error: unknown, defaultStatus = 500) {
  if (error instanceof Error) {
    const message = error.message;

    if (message.startsWith('VOCABULARY_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'VOCABULARY_NOT_FOUND',
          message: 'No vocabulary exists for this knowledge base',
        },
      });
    }

    if (message.startsWith('SCHEMA_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SCHEMA_NOT_FOUND',
          message: 'No canonical schema exists for this knowledge base',
        },
      });
    }

    if (message.startsWith('NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Knowledge base not found',
        },
      });
    }

    if (message.startsWith('VALIDATION_ERROR')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: message.replace('VALIDATION_ERROR: ', ''),
        },
      });
    }

    if (message.startsWith('UNAUTHORIZED')) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: message.replace('UNAUTHORIZED: ', ''),
        },
      });
    }
  }

  logger.error('Unhandled error in agent integration routes', {
    error: error instanceof Error ? error.message : String(error),
  });

  return res.status(defaultStatus).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

// ─── API-7: Get Classification Examples ─────────────────────────────────

/**
 * API-7: Get query classification examples
 * GET /projects/:projectId/kb/:kbId/query-types
 *
 * Returns few-shot learning examples for query type classification.
 * Agents download these once and use them for local classification.
 */
router.get('/projects/:projectId/kb/:kbId/query-types', async (req: Request, res: Response) => {
  try {
    await requireProjectKbAccess(req);
    const { connectorType, includeGeneric } = req.query;

    // Get connector-specific examples
    const connector = (connectorType as string) || 'generic';
    const examples = QUERY_TYPE_EXAMPLES[connector] || QUERY_TYPE_EXAMPLES.generic;

    // Build response
    const queryTypes: Record<string, any> = {};

    // Structured examples
    queryTypes.structured = {
      description: 'Queries with field filters, no semantic concepts',
      keywords: ['show', 'list', 'find', 'get', 'filter', 'where'],
      examples: examples.structured.examples.map((ex) => ({
        query: ex.query,
        reasoning: ex.reasoning,
        confidence: ex.confidence,
        expectedFilters: [], // Simplified for download
        expectedConcepts: [],
      })),
    };

    // Semantic examples
    queryTypes.semantic = {
      description: 'Queries about concepts, requires vector search',
      keywords: ['about', 'related to', 'regarding', 'concerning'],
      examples: examples.semantic.examples.map((ex) => ({
        query: ex.query,
        reasoning: ex.reasoning,
        confidence: ex.confidence,
        expectedFilters: [],
        expectedConcepts: [], // Will be filled during actual classification
      })),
    };

    // Hybrid examples
    queryTypes.hybrid = {
      description: 'Queries combining structured filters and semantic concepts',
      keywords: ['show', 'about', 'related'],
      examples: examples.hybrid.examples.map((ex) => ({
        query: ex.query,
        reasoning: ex.reasoning,
        confidence: ex.confidence,
        expectedFilters: [],
        expectedConcepts: [],
      })),
    };

    // Aggregation examples
    queryTypes.aggregation = {
      description: 'Queries with grouping, counting, or statistical operations',
      keywords: ['count', 'total', 'sum', 'average', 'by', 'per', 'group'],
      examples: examples.aggregation.examples.map((ex) => ({
        query: ex.query,
        reasoning: ex.reasoning,
        confidence: ex.confidence,
        expectedAggregation: null, // Will be filled during actual classification
      })),
    };

    // Add generic examples if requested
    if (includeGeneric === 'true' && connector !== 'generic') {
      const genericExamples = QUERY_TYPE_EXAMPLES.generic;
      // Merge generic examples with connector-specific ones
      for (const type of ['structured', 'semantic', 'hybrid', 'aggregation'] as const) {
        queryTypes[type].examples = [
          ...queryTypes[type].examples,
          ...genericExamples[type].examples.map((ex) => ({
            query: ex.query,
            reasoning: ex.reasoning,
            confidence: ex.confidence,
          })),
        ];
      }
    }

    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.json({
      success: true,
      data: {
        queryTypes,
        metadata: {
          connectorType: connector,
          lastUpdated: new Date().toISOString(),
          version: '1.0',
        },
      },
    });

    logger.info('Query type examples downloaded', {
      connectorType: connector,
      includeGeneric: includeGeneric === 'true',
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-8: Get Vocabulary Context ───────────────────────────────────────

/**
 * API-8: Get vocabulary context
 * GET /projects/:projectId/kb/:kbId/vocabulary-context
 *
 * Returns complete vocabulary + schema for agent rephrasing.
 * Agents download this once and use it for local vocabulary resolution.
 */
router.get(
  '/projects/:projectId/kb/:kbId/vocabulary-context',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, kbId } = await requireProjectKbAccess(req);
      const {
        includeSchema = 'true',
        includeCapabilities = 'true',
        includeExamples = 'false',
      } = req.query;

      // Load vocabulary
      const vocab = await DomainVocabulary.findOne({
        projectKnowledgeBaseId: kbId,
        tenantId,
        status: 'active',
      }).lean();

      if (!vocab) {
        throw new Error('VOCABULARY_NOT_FOUND');
      }

      // Build vocabulary response
      const vocabulary = vocab.entries
        .filter((entry: any) => entry.enabled)
        .map((entry: any) => ({
          term: entry.term,
          canonicalField: entry.fieldRef,
          aliases: entry.aliases,
          description: entry.description,
          capabilities: {
            filter: entry.capabilities.canFilter,
            display: entry.capabilities.canDisplay,
            aggregate: entry.capabilities.canAggregate,
            sort: entry.capabilities.canSort,
          },
          relatedFields: entry.relatedFields,
        }));

      const responseData: any = {
        vocabulary,
        metadata: {
          vocabularyVersion: vocab.version,
          lastUpdated: vocab.updatedAt.toISOString(),
          totalEntries: vocab.entries.length,
          activeEntries: vocab.entries.filter((e: any) => e.enabled).length,
        },
      };

      // Include schema if requested
      if (includeSchema === 'true') {
        const schema = await CanonicalSchema.findOne({
          knowledgeBaseId: kbId,
          tenantId,
        }).lean();

        if (schema) {
          responseData.schema = {
            fields: schema.fields.map((field: any) => ({
              name: field.name,
              label: field.label,
              type: field.type,
              filterable: field.filterable,
              aggregatable: field.aggregatable,
              indexed: field.indexed,
              enumValues: field.enumValues,
              description: field.description,
            })),
          };
        }
      }

      // Include capabilities if requested
      if (includeCapabilities === 'true') {
        responseData.capabilities = {
          aggregationFunctions: [
            {
              name: 'count',
              description: 'Count number of items',
              supportedFieldTypes: ['any'],
            },
            {
              name: 'sum',
              description: 'Sum numeric values',
              supportedFieldTypes: ['number'],
            },
            {
              name: 'avg',
              description: 'Average numeric values',
              supportedFieldTypes: ['number'],
            },
            {
              name: 'min',
              description: 'Minimum value',
              supportedFieldTypes: ['number', 'date'],
            },
            {
              name: 'max',
              description: 'Maximum value',
              supportedFieldTypes: ['number', 'date'],
            },
          ],
          filterOperators: [
            {
              name: 'equals',
              description: 'Exact match',
              supportedFieldTypes: ['string', 'number', 'boolean'],
            },
            {
              name: 'in',
              description: 'Match any value in list',
              supportedFieldTypes: ['string', 'number'],
            },
            {
              name: 'contains',
              description: 'Partial text match',
              supportedFieldTypes: ['string'],
            },
            {
              name: 'greater_than',
              description: 'Greater than comparison',
              supportedFieldTypes: ['number', 'date'],
            },
            {
              name: 'less_than',
              description: 'Less than comparison',
              supportedFieldTypes: ['number', 'date'],
            },
          ],
        };
      }

      res.set('Cache-Control', 'public, max-age=300'); // 5 minute cache
      res.json({ success: true, data: responseData });

      logger.info('Vocabulary context downloaded', {
        kbId,
        vocabularyEntries: vocabulary.length,
        includeSchema: includeSchema === 'true',
        includeCapabilities: includeCapabilities === 'true',
      });
    } catch (error) {
      errorResponse(res, error);
    }
  },
);

// ─── Export ──────────────────────────────────────────────────────────────

export default router;
