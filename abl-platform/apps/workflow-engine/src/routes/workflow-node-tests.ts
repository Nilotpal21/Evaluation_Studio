/**
 * Workflow node test routes
 *
 * POST /workflows/:workflowId/nodes/:nodeId/test-action — run the integration
 * node's action with provided params and persist sampleOutput on the node.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';
import {
  ActionTestConfigError,
  ActionTestNotFoundError,
  type ActionTestService,
} from '../services/action-test-service.js';
import type { TriggerAuditEvent } from '../services/trigger-engine.js';

const log = createLogger('workflow-node-tests');

export interface WorkflowNodeTestsRouteDeps {
  actionTestService: ActionTestService;
  auditEmitter?: (event: TriggerAuditEvent) => void | Promise<void>;
}

export function createWorkflowNodeTestsRouter(deps: WorkflowNodeTestsRouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/:workflowId/nodes/:nodeId/test-action',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, {
        requireParams: ['workflowId', 'nodeId'],
      });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, nodeId } = ctx;
      const body = (req.body ?? {}) as {
        params?: Record<string, unknown>;
        connectionId?: string;
      };
      const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<
        string,
        unknown
      >;
      const connectionId =
        typeof body.connectionId === 'string' && body.connectionId.length > 0
          ? body.connectionId
          : undefined;

      // Read userId from the authenticated principal (set by unified-auth
      // middleware on req.tenantContext) — NEVER trust a userId from the
      // request body. The ConnectionResolver uses this to pick user-scoped
      // OAuth grants; a user-supplied userId would let one project member
      // probe another user's connections.
      const userId = (req as Request & { tenantContext?: { userId?: string } }).tenantContext
        ?.userId;

      try {
        const result = await deps.actionTestService.testAction({
          workflowId,
          nodeId,
          tenantId,
          projectId,
          userId,
          params,
          connectionId,
        });
        deps.auditEmitter?.({
          action: 'trigger.test_action',
          registrationId: nodeId,
          tenantId,
          projectId,
          outcome: 'success',
          metadata: { workflowId, nodeId },
        });
        return res.json({ success: true, data: result });
      } catch (err) {
        // Map typed service errors to user-actionable HTTP responses. Unknown
        // errors (most likely from action.run() inside the connector piece)
        // get a generic public message — their raw text may include provider
        // API echoes that could leak tokens/PII. The full error is kept in
        // server logs for diagnosis.
        const rawMessage = err instanceof Error ? err.message : String(err);
        log.error('Test action failed', { workflowId, nodeId, error: rawMessage });
        deps.auditEmitter?.({
          action: 'trigger.test_action',
          registrationId: nodeId,
          tenantId,
          projectId,
          outcome: 'error',
          metadata: { workflowId, nodeId, error: rawMessage },
        });

        if (err instanceof ActionTestNotFoundError) {
          return res.status(404).json({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        if (err instanceof ActionTestConfigError) {
          return res.status(400).json({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        // Unknown — sanitize message before returning.
        return res.status(500).json({
          success: false,
          error: {
            code: 'TEST_ACTION_FAILED',
            message:
              'The connector action failed during test execution. Check server logs for details.',
          },
        });
      }
    }),
  );

  return router;
}
