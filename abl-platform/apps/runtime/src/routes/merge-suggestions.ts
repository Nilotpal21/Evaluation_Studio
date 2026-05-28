/**
 * Merge Suggestions API Routes
 *
 * GET    /                 List merge suggestions by tenant (optional status filter)
 * PUT    /:id              Accept or reject a merge suggestion
 *
 * Created via factory function that receives a MergeSuggestionStore port.
 * The MongoDB implementation will be wired in Task 27.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  MergeSuggestion,
  MergeSuggestionStatus,
} from '../contexts/contact/domain/merge-suggestion.js';

// =============================================================================
// PORT INTERFACE
// =============================================================================

/** Port interface for merge suggestion persistence. Implemented by MongoDB adapter (Task 27). */
export interface MergeSuggestionStore {
  findByTenant(tenantId: string, status?: MergeSuggestionStatus): Promise<MergeSuggestion[]>;
  findById(tenantId: string, suggestionId: string): Promise<MergeSuggestion | null>;
  updateStatus(
    tenantId: string,
    suggestionId: string,
    status: MergeSuggestionStatus,
    resolvedBy: string,
  ): Promise<MergeSuggestion | null>;
}

// =============================================================================
// DEPS INTERFACE
// =============================================================================

export interface MergeSuggestionsRouterDeps {
  store: MergeSuggestionStore;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Only these statuses are valid for manual resolution via the PUT endpoint. */
const VALID_RESOLUTION_STATUSES = new Set<MergeSuggestionStatus>(['accepted', 'rejected']);

// =============================================================================
// FACTORY
// =============================================================================

export function createMergeSuggestionsRouter(deps: MergeSuggestionsRouterDeps): Router {
  const router = Router();

  // Auth middleware — require tenantContext on every request
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).tenantContext?.tenantId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // GET / — List merge suggestions for tenant
  // ---------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { tenantId } = (req as any).tenantContext;
      const status = req.query.status as MergeSuggestionStatus | undefined;

      const suggestions = await deps.store.findByTenant(tenantId, status || undefined);

      res.status(200).json({ success: true, data: suggestions });
    } catch (error) {
      console.error('[Merge Suggestions] GET / error:', error);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list merge suggestions' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /:id — Accept or reject a merge suggestion
  // ---------------------------------------------------------------------------
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const { tenantId, userId } = (req as any).tenantContext;

      if (!status || !VALID_RESOLUTION_STATUSES.has(status)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'status must be "accepted" or "rejected"',
          },
        });
        return;
      }

      const updated = await deps.store.updateStatus(tenantId, id, status, userId ?? 'unknown');

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Merge suggestion not found' },
        });
        return;
      }

      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      console.error('[Merge Suggestions] PUT /:id error:', error);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update merge suggestion' },
      });
    }
  });

  return router;
}
