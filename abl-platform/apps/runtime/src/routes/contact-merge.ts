/**
 * Contact Merge, Self-Merge & GDPR Cascade Routes
 *
 * POST   /merge             Merge two contacts (admin)
 * POST   /:id/self-merge    Self-merge from SDK session
 * DELETE /:id/gdpr          GDPR cascade hard-delete (admin)
 *
 * Created via factory function that receives injected use case dependencies.
 * Auth is enforced via tenantContext presence check in middleware.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// DEPS INTERFACE
// =============================================================================

/** Use case interfaces (duck-typed to avoid coupling to concrete classes). */
export interface ContactMergeRouterDeps {
  executeMerge: {
    execute(
      tenantId: string,
      primaryContactId: string,
      secondaryContactId: string,
      mergedBy: string,
    ): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }>;
  };
  selfMerge: {
    execute(
      tenantId: string,
      currentContactId: string,
      identityType: string,
      identityValue: string,
    ): Promise<{
      success: boolean;
      contact: unknown;
      merged: boolean;
      error?: { code: string; message: string };
    }>;
  };
  cascadeDelete: {
    execute(
      tenantId: string,
      contactId: string,
    ): Promise<{ success: boolean; error?: { code: string; message: string } }>;
  };
}

// =============================================================================
// FACTORY
// =============================================================================

export function createContactMergeRouter(deps: ContactMergeRouterDeps): Router {
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
  // POST /merge — Merge two contacts (admin)
  // ---------------------------------------------------------------------------
  router.post('/merge', async (req: Request, res: Response) => {
    try {
      const { primaryContactId, secondaryContactId } = req.body;
      const { tenantId, userId } = (req as any).tenantContext;

      if (!primaryContactId || !secondaryContactId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'primaryContactId and secondaryContactId are required',
          },
        });
        return;
      }

      const result = await deps.executeMerge.execute(
        tenantId,
        primaryContactId,
        secondaryContactId,
        userId ?? 'unknown',
      );

      if (!result.success) {
        res.status(422).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: result.data });
    } catch (error) {
      console.error('[Contact Merge] POST /merge error:', error);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to merge contacts' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /:id/self-merge — Self-merge from SDK session
  // ---------------------------------------------------------------------------
  router.post('/:id/self-merge', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { identityType, identityValue } = req.body;
      const { tenantId } = (req as any).tenantContext;

      if (!identityType || !identityValue) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'identityType and identityValue are required' },
        });
        return;
      }

      const result = await deps.selfMerge.execute(tenantId, id, identityType, identityValue);

      if (!result.success) {
        res.status(422).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, contact: result.contact, merged: result.merged });
    } catch (error) {
      console.error('[Contact Merge] POST /:id/self-merge error:', error);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to self-merge contact' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id/gdpr — GDPR cascade hard-delete (admin)
  // ---------------------------------------------------------------------------
  router.delete('/:id/gdpr', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { tenantId } = (req as any).tenantContext;

      const result = await deps.cascadeDelete.execute(tenantId, id);

      if (!result.success) {
        res.status(422).json({ success: false, error: result.error });
        return;
      }

      res
        .status(200)
        .json({ success: true, message: 'Contact and all associated data permanently deleted' });
    } catch (error) {
      console.error('[Contact Merge] DELETE /:id/gdpr error:', error);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete contact data' },
      });
    }
  });

  return router;
}
