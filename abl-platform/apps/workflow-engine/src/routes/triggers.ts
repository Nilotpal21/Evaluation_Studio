/**
 * Trigger Routes
 *
 * Registration, deregistration, pause, resume, and fire endpoints for
 * workflow triggers. Delegates to the TriggerEngine for scheduling
 * and lifecycle management.
 *
 * GET    /                              List trigger registrations
 * POST   /                              Register a new trigger
 * PUT    /:registrationId               Update a trigger
 * DELETE /:registrationId               Deregister a trigger
 * POST   /:registrationId/pause         Pause a trigger
 * POST   /:registrationId/resume        Resume a paused trigger
 * POST   /:registrationId/fire          Fire a webhook trigger
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';
import type { TriggerAuditEvent } from '../services/trigger-engine.js';

const log = createLogger('workflow-engine:triggers');

export interface TriggerRouteDeps {
  triggerEngine: {
    list(
      tenantId: string,
      projectId: string,
      workflowId?: string,
    ): Promise<Record<string, unknown>[]>;
    register(registration: unknown): Promise<{ registrationId: string }>;
    updateTrigger(
      registrationId: string,
      config: Record<string, unknown>,
      tenantId: string,
      projectId?: string,
    ): Promise<void>;
    deregister(registrationId: string, tenantId: string, projectId?: string): Promise<void>;
    pause(registrationId: string, tenantId: string, projectId?: string): Promise<void>;
    resume(registrationId: string, tenantId: string, projectId?: string): Promise<void>;
    fireWebhookTrigger(
      registrationId: string,
      payload: Record<string, unknown>,
      tenantId: string,
      projectId?: string,
    ): Promise<{ executionId: string }>;
    getLastFirePayload(
      registrationId: string,
      tenantId: string,
      projectId?: string,
    ): Promise<Record<string, unknown> | null>;
    testSample(
      registrationId: string,
      tenantId: string,
      projectId: string,
    ): Promise<{ sample: Record<string, unknown>; itemCount: number }>;
  };
  auditEmitter?: (event: TriggerAuditEvent) => void | Promise<void>;
}

const registerTriggerSchema = z.object({
  workflowId: z.string().min(1),
  triggerType: z.enum(['webhook', 'cron', 'event']),
  config: z.record(z.string(), z.unknown()).default({}),
  environment: z.string().min(1).optional(),
  // Version-first binding: callers that want a trigger pinned to a specific
  // workflow version (e.g. "Activate v0.1.0 and register a webhook against
  // it") supply `workflowVersionId` at registration time. `TriggerEngine.
  // register()` already persists both fields — the schema must accept them
  // too or the route handler's `parsed.data` spread strips them silently.
  workflowVersionId: z.string().min(1).optional(),
  workflowVersion: z.string().min(1).optional(),
});

const updateTriggerSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export function createTriggerRouter(deps: TriggerRouteDeps): Router {
  const router = Router({ mergeParams: true });

  // GET / — List trigger registrations for a project (optionally filter by workflowId)
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;
      const { workflowId } = req.query;

      try {
        const registrations = await deps.triggerEngine.list(
          tenantId,
          projectId,
          workflowId as string | undefined,
        );
        return res.json({ success: true, data: registrations });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to list trigger registrations', { error: message });
        return res.status(500).json({ success: false, error: message });
      }
    }),
  );

  // POST / — Register a new trigger
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;
      try {
        const parsed = registerTriggerSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: parsed.error.issues.map((i) => i.message).join(', '),
            },
          });
        }
        const result = await deps.triggerEngine.register({
          ...parsed.data,
          tenantId,
          projectId,
        });
        return res.status(201).json({ success: true, data: result });
      } catch (err) {
        log.error('Failed to register trigger', {
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to register trigger' },
        });
      }
    }),
  );

  // PUT /:registrationId — Update a trigger's config.
  // Cron triggers reschedule immediately when active.
  router.put(
    '/:registrationId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        const parsed = updateTriggerSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: parsed.error.issues.map((i) => i.message).join(', '),
            },
          });
        }
        await deps.triggerEngine.updateTrigger(
          registrationId,
          parsed.data.config,
          tenantId,
          projectId,
        );
        return res.json({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        const isNotFound = lower.includes('not found');
        const isConnectorUnavailable = message === 'CONNECTOR_RUNTIME_UNAVAILABLE';
        // Surface schedule/preset parsing errors as client validation failures.
        const isValidationError =
          lower.includes('invalid time format') ||
          lower.includes('invalid cron expression') ||
          lower.includes('unknown preset') ||
          lower.includes('cronexpression is required') ||
          lower.includes('datetime is required') ||
          lower.includes('datetime must be a valid');

        const status = isNotFound
          ? 404
          : isConnectorUnavailable
            ? 503
            : isValidationError
              ? 400
              : 500;
        log.error('Failed to update trigger', { registrationId, error: message });
        return res.status(status).json({
          success: false,
          error: {
            code: isNotFound
              ? 'TRIGGER_NOT_FOUND'
              : isConnectorUnavailable
                ? 'CONNECTOR_RUNTIME_UNAVAILABLE'
                : isValidationError
                  ? 'VALIDATION_ERROR'
                  : 'TRIGGER_UPDATE_FAILED',
            message: isNotFound
              ? 'Trigger not found'
              : isConnectorUnavailable
                ? 'Connector runtime unavailable'
                : isValidationError
                  ? message
                  : 'Failed to update trigger',
          },
        });
      }
    }),
  );

  // DELETE /:registrationId — Deregister a trigger
  router.delete(
    '/:registrationId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        await deps.triggerEngine.deregister(registrationId, tenantId, projectId);
        return res.json({ success: true });
      } catch (err) {
        log.error('Failed to deregister trigger', {
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          success: false,
          error: {
            code: 'TRIGGER_DEREGISTER_FAILED',
            message: 'Failed to deregister trigger',
          },
        });
      }
    }),
  );

  // POST /:registrationId/pause — Pause a trigger
  router.post(
    '/:registrationId/pause',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        await deps.triggerEngine.pause(registrationId, tenantId, projectId);
        return res.json({ success: true });
      } catch (err) {
        log.error('Failed to pause trigger', {
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          success: false,
          error: {
            code: 'TRIGGER_PAUSE_FAILED',
            message: 'Failed to pause trigger',
          },
        });
      }
    }),
  );

  // POST /:registrationId/resume — Resume a paused trigger
  router.post(
    '/:registrationId/resume',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        await deps.triggerEngine.resume(registrationId, tenantId, projectId);
        return res.json({ success: true });
      } catch (err) {
        log.error('Failed to resume trigger', {
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          success: false,
          error: {
            code: 'TRIGGER_RESUME_FAILED',
            message: 'Failed to resume trigger',
          },
        });
      }
    }),
  );

  // POST /:registrationId/fire — Fire a webhook trigger
  const firePayloadSchema = z.record(z.string(), z.unknown()).default({});

  router.post(
    '/:registrationId/fire',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        const parsedPayload = firePayloadSchema.safeParse(req.body);
        if (!parsedPayload.success) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Payload must be a JSON object',
            },
          });
        }
        const result = await deps.triggerEngine.fireWebhookTrigger(
          registrationId,
          parsedPayload.data,
          tenantId,
          projectId,
        );
        return res.status(202).json({ success: true, data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Trigger fire failed', {
          registrationId,
          error: msg,
        });
        const isNotFound = err instanceof Error && err.message.includes('not found');
        return res.status(isNotFound ? 404 : 500).json({
          success: false,
          error: {
            code: 'TRIGGER_FIRE_FAILED',
            message: isNotFound ? 'Trigger not found' : 'Failed to fire trigger',
          },
        });
      }
    }),
  );

  // POST /:registrationId/test-sample — Run the connector trigger's run() with
  // stored credentials to fetch live sample data. Persists the result as
  // samplePayload on the registration so subsequent sample-payload GETs serve it.
  router.post(
    '/:registrationId/test-sample',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        const result = await deps.triggerEngine.testSample(registrationId, tenantId, projectId);
        deps.auditEmitter?.({
          action: 'trigger.test_sample',
          registrationId,
          tenantId,
          projectId,
          outcome: 'success',
          metadata: { itemCount: result.itemCount },
        });
        return res.json({ success: true, data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Trigger test-sample failed', { registrationId, error: msg });
        deps.auditEmitter?.({
          action: 'trigger.test_sample',
          registrationId,
          tenantId,
          projectId,
          outcome: 'error',
          metadata: { error: msg },
        });
        const isNotFound = msg.includes('not found');
        return res.status(isNotFound ? 404 : 500).json({
          success: false,
          error: {
            code: 'TEST_SAMPLE_FAILED',
            message: isNotFound ? 'Trigger not found' : 'Failed to fetch trigger sample',
          },
        });
      }
    }),
  );

  // GET /:registrationId/sample-payload — Return the last triggerPayload this
  // trigger received, so the Fire Now UI can pre-populate its editor. A null
  // `data.payload` means the trigger has no execution history yet — clients
  // should fall back to an empty `{}` default.
  router.get(
    '/:registrationId/sample-payload',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['registrationId'] });
      if (!ctx) return;
      const { tenantId, projectId, registrationId } = ctx;
      try {
        const payload = await deps.triggerEngine.getLastFirePayload(
          registrationId,
          tenantId,
          projectId,
        );
        return res.json({ success: true, data: { payload } });
      } catch (err) {
        log.error('Sample payload lookup failed', {
          registrationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          success: false,
          error: {
            code: 'SAMPLE_PAYLOAD_LOOKUP_FAILED',
            message: 'Failed to load sample payload',
          },
        });
      }
    }),
  );

  return router;
}
