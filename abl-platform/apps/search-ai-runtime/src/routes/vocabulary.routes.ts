/**
 * Vocabulary Management API Routes - API-1 to API-6
 *
 * REST endpoints for CRUD operations on vocabulary entries.
 * All routes require authentication and tenant isolation.
 *
 * **Routes:**
 * - GET    /projects/:projectId/kb/:kbId/vocabulary       - List entries (API-1)
 * - POST   /projects/:projectId/kb/:kbId/vocabulary       - Create entry (API-2)
 * - PUT    /projects/:projectId/kb/:kbId/vocabulary/:entryId - Update entry (API-3)
 * - DELETE /projects/:projectId/kb/:kbId/vocabulary/:entryId - Delete entry (API-4)
 * - PATCH  /projects/:projectId/kb/:kbId/vocabulary/:entryId/toggle - Toggle entry (API-5)
 * - POST   /projects/:projectId/kb/:kbId/vocabulary/test  - Test resolution (API-6)
 */

import { Router, type Request, type Response, type IRouter } from 'express';
import { VocabularyService } from '../services/vocabulary-management/vocabulary.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { requireProjectKbAccess } from './project-kb-access.js';

const logger = createLogger('VocabularyRoutes');
const router: IRouter = Router();
router.use(authMiddleware);

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Standard error response
 */
function errorResponse(res: Response, error: unknown, defaultStatus = 500) {
  if (error instanceof Error) {
    const message = error.message;

    // Parse error codes from message
    if (message.startsWith('VOCABULARY_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'VOCABULARY_NOT_FOUND',
          message: 'No vocabulary exists for this knowledge base',
        },
      });
    }

    if (message.startsWith('ENTRY_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ENTRY_NOT_FOUND',
          message: 'Vocabulary entry not found',
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

    if (message.startsWith('DUPLICATE_TERM')) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_TERM',
          message: message.replace('DUPLICATE_TERM: ', ''),
        },
      });
    }

    if (message.startsWith('ENTRY_IN_USE')) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ENTRY_IN_USE',
          message: message.replace('ENTRY_IN_USE: ', ''),
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

  logger.error('Unhandled error in vocabulary routes', {
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

// ─── Routes ──────────────────────────────────────────────────────────────

/**
 * API-1: List vocabulary entries
 * GET /projects/:projectId/kb/:kbId/vocabulary
 */
router.get('/projects/:projectId/kb/:kbId/vocabulary', async (req: Request, res: Response) => {
  try {
    const { tenantId, kbId } = await requireProjectKbAccess(req);
    const { status, generatedBy, search, limit, offset } = req.query;

    const service = new VocabularyService();
    const result = await service.listEntries({
      projectKbId: kbId,
      tenantId,
      status: (status as 'active' | 'inactive' | 'all') || 'active',
      generatedBy: (generatedBy as 'auto' | 'manual' | 'all') || 'all',
      search: search as string,
      limit: limit ? Math.min(Number(limit), 500) : 100,
      offset: offset ? Number(offset) : 0,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    errorResponse(res, error);
  }
});

/**
 * API-2: Create vocabulary entry
 * POST /projects/:projectId/kb/:kbId/vocabulary
 */
router.post('/projects/:projectId/kb/:kbId/vocabulary', async (req: Request, res: Response) => {
  try {
    const { tenantId, kbId } = await requireProjectKbAccess(req);
    const entry = req.body;

    // Validate required fields
    if (!entry.term || !entry.fieldRef || !entry.capabilities || !entry.generatedBy) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields: term, fieldRef, capabilities, generatedBy',
        },
      });
    }

    const service = new VocabularyService();
    const { entryId } = await service.createEntry({
      projectKbId: kbId,
      tenantId,
      entry,
    });

    res.status(201).json({
      success: true,
      data: {
        entryId,
        message: 'Vocabulary entry created successfully',
      },
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

/**
 * API-3: Update vocabulary entry
 * PUT /projects/:projectId/kb/:kbId/vocabulary/:entryId
 */
router.put(
  '/projects/:projectId/kb/:kbId/vocabulary/:entryId',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, kbId } = await requireProjectKbAccess(req);
      const { entryId } = req.params;
      const updates = req.body;

      const service = new VocabularyService();
      await service.updateEntry({
        projectKbId: kbId,
        tenantId,
        entryId,
        updates,
      });

      res.json({
        success: true,
        data: {
          message: 'Vocabulary entry updated successfully',
        },
      });
    } catch (error) {
      errorResponse(res, error);
    }
  },
);

/**
 * API-4: Delete vocabulary entry
 * DELETE /projects/:projectId/kb/:kbId/vocabulary/:entryId
 */
router.delete(
  '/projects/:projectId/kb/:kbId/vocabulary/:entryId',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, kbId } = await requireProjectKbAccess(req);
      const { entryId } = req.params;

      const service = new VocabularyService();
      await service.deleteEntry({
        projectKbId: kbId,
        tenantId,
        entryId,
      });

      res.json({
        success: true,
        data: {
          message: 'Vocabulary entry deleted successfully',
        },
      });
    } catch (error) {
      errorResponse(res, error);
    }
  },
);

/**
 * API-5: Toggle vocabulary entry
 * PATCH /projects/:projectId/kb/:kbId/vocabulary/:entryId/toggle
 */
router.patch(
  '/projects/:projectId/kb/:kbId/vocabulary/:entryId/toggle',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, kbId } = await requireProjectKbAccess(req);
      const { entryId } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'enabled field must be a boolean',
          },
        });
      }

      const service = new VocabularyService();
      await service.toggleEntry({
        projectKbId: kbId,
        tenantId,
        entryId,
        enabled,
      });

      res.json({
        success: true,
        data: {
          enabled,
          message: `Vocabulary entry ${enabled ? 'enabled' : 'disabled'} successfully`,
        },
      });
    } catch (error) {
      errorResponse(res, error);
    }
  },
);

/**
 * API-6: Test vocabulary resolution
 * POST /projects/:projectId/kb/:kbId/vocabulary/test
 */
router.post(
  '/projects/:projectId/kb/:kbId/vocabulary/test',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, kbId } = await requireProjectKbAccess(req);
      const { query, entryIds } = req.body;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'query field is required',
          },
        });
      }

      const service = new VocabularyService();
      const result = await service.testResolution({
        projectKbId: kbId,
        tenantId,
        query,
        entryIds,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      errorResponse(res, error);
    }
  },
);

// ─── Export ──────────────────────────────────────────────────────────────

export default router;
