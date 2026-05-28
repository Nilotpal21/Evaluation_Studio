/**
 * Connector Listing Routes
 *
 * Thin Express wrapper around the shared ConnectorListingService +
 * DropdownOptionsService.
 *
 * GET  /                                                              — List all available connectors
 * GET  /:connectorName                                                  — Get a specific connector
 * GET  /:connectorName/actions                                          — Get action schemas for a connector
 * POST /:connectorName/actions/:actionName/props/:propName/options      — Resolve dynamic dropdown options for an action
 * POST /:connectorName/triggers/:triggerName/props/:propName/options    — Resolve dynamic dropdown options for a trigger
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ConnectorRegistry } from '@agent-platform/connectors';
import {
  ConnectorListingService,
  DropdownOptionsService,
  DropdownOptionsServiceError,
  type ResolveActionDynamicPropsInput,
  type ResolveTriggerDynamicPropsInput,
} from '@agent-platform/connectors/services';
import type { ConnectionResolver } from '@agent-platform/connectors/auth';

export interface ConnectorRouteDeps {
  registry: ConnectorRegistry;
  /**
   * Optional — enables the dynamic dropdown options endpoint. Left optional
   * so lightweight callers (e.g. read-only catalog tests) can mount the
   * router without wiring a full connection resolver.
   */
  connectionResolver?: ConnectionResolver;
}

const resolveOptionsBodySchema = z.object({
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
  propsValue: z.record(z.string(), z.unknown()).optional(),
  searchValue: z.string().optional(),
});

function errorCodeToStatus(code: string): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'CONNECTOR_NOT_FOUND':
    case 'ACTION_NOT_FOUND':
    case 'TRIGGER_NOT_FOUND':
    case 'PROP_NOT_DYNAMIC':
    case 'PROP_NOT_DYNAMIC_PROPERTIES':
    case 'CONNECTION_NOT_FOUND':
      return 404;
    case 'RESOLVE_FAILED':
      return 502;
    default:
      return 500;
  }
}

export function createConnectorRouter(deps: ConnectorRouteDeps): Router {
  const router = Router({ mergeParams: true });
  const svc = new ConnectorListingService(deps.registry);
  const optionsSvc = deps.connectionResolver
    ? new DropdownOptionsService({
        registry: deps.registry,
        connectionResolver: deps.connectionResolver,
      })
    : undefined;

  // Connector catalog is a static, shared resource — no tenant/project isolation needed.
  // All routes are behind auth middleware (registered in index.ts).

  /** GET / — List all registered connectors */
  router.get('/', (_req: Request, res: Response) => {
    try {
      const data = svc.listConnectors();
      return res.json({ success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        success: false,
        error: { code: 'CONNECTOR_LIST_FAILED', message },
      });
    }
  });

  /** GET /:connectorName — Get a specific connector's details */
  router.get('/:connectorName', async (req: Request, res: Response) => {
    try {
      const { connectorName } = req.params;
      const data = await svc.getConnector(connectorName);

      if (!data) {
        return res.status(404).json({
          success: false,
          error: { code: 'CONNECTOR_NOT_FOUND', message: `Connector not found: ${connectorName}` },
        });
      }

      return res.json({ success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        success: false,
        error: { code: 'CONNECTOR_GET_FAILED', message },
      });
    }
  });

  /** GET /:connectorName/actions — Get action schemas (with props) for a specific connector */
  router.get('/:connectorName/actions', async (req: Request, res: Response) => {
    try {
      const { connectorName } = req.params;
      const connector = await svc.getConnector(connectorName);

      if (!connector) {
        return res.status(404).json({
          success: false,
          error: { code: 'CONNECTOR_NOT_FOUND', message: `Connector not found: ${connectorName}` },
        });
      }

      return res.json({ success: true, data: connector.actions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        success: false,
        error: { code: 'CONNECTOR_ACTIONS_FAILED', message },
      });
    }
  });

  /**
   * POST /:connectorName/actions/:actionName/props/:propName/options
   *
   * Resolve dynamic dropdown options for a prop on a connector action, using
   * credentials from the given connection. Connection lookup is
   * project-scoped via the request body (the connector catalog endpoints
   * above are not project-scoped, but dropdown resolution inherently is —
   * so projectId travels in the body rather than the URL).
   */
  router.post(
    '/:connectorName/actions/:actionName/props/:propName/options',
    async (req: Request, res: Response) => {
      if (!optionsSvc) {
        return res.status(501).json({
          success: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Dynamic dropdown resolver is not configured on this server',
          },
        });
      }

      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing tenant' } });
      }

      const parsed = resolveOptionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { connectorName, actionName, propName } = req.params;
      const userId = (req as any).tenantContext?.userId;

      try {
        const data = await optionsSvc.resolveActionProp({
          tenantId,
          projectId: parsed.data.projectId,
          connectorName,
          actionName,
          propName,
          connectionId: parsed.data.connectionId,
          userId,
          propsValue: parsed.data.propsValue,
          searchValue: parsed.data.searchValue,
        });
        return res.json({ success: true, data });
      } catch (err) {
        if (err instanceof DropdownOptionsServiceError) {
          return res
            .status(errorCodeToStatus(err.code))
            .json({ success: false, error: { code: err.code, message: err.message } });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false,
          error: { code: 'DROPDOWN_OPTIONS_FAILED', message },
        });
      }
    },
  );

  /**
   * POST /:connectorName/triggers/:triggerName/props/:propName/options
   *
   * Resolve dynamic dropdown options for a prop on a connector trigger.
   */
  router.post(
    '/:connectorName/triggers/:triggerName/props/:propName/options',
    async (req: Request, res: Response) => {
      if (!optionsSvc) {
        return res.status(501).json({
          success: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Dynamic dropdown resolver is not configured on this server',
          },
        });
      }

      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing tenant' } });
      }

      const parsed = resolveOptionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { connectorName, triggerName, propName } = req.params;
      const userId = (req as any).tenantContext?.userId;

      try {
        const data = await optionsSvc.resolveTriggerProp({
          tenantId,
          projectId: parsed.data.projectId,
          connectorName,
          triggerName,
          propName,
          connectionId: parsed.data.connectionId,
          userId,
          propsValue: parsed.data.propsValue,
          searchValue: parsed.data.searchValue,
        });
        return res.json({ success: true, data });
      } catch (err) {
        if (err instanceof DropdownOptionsServiceError) {
          return res
            .status(errorCodeToStatus(err.code))
            .json({ success: false, error: { code: err.code, message: err.message } });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false,
          error: { code: 'DROPDOWN_OPTIONS_FAILED', message },
        });
      }
    },
  );

  /**
   * POST /:connectorName/actions/:actionName/props/:propName/dynamic-fields
   *
   * Resolve the DynamicProperties field map for a prop on a connector action.
   * Returns { success: true, data: DynamicPropertiesState } where each value
   * is a DynamicSubField (type, displayName, required, options?).
   */
  router.post(
    '/:connectorName/actions/:actionName/props/:propName/dynamic-fields',
    async (req: Request, res: Response) => {
      if (!optionsSvc) {
        return res.status(501).json({
          success: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Dynamic props resolver is not configured on this server',
          },
        });
      }

      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing tenant' } });
      }

      const parsed = resolveOptionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { connectorName, actionName, propName } = req.params;
      const userId = (req as any).tenantContext?.userId;

      try {
        const data = await optionsSvc.resolveActionDynamicProps({
          tenantId,
          projectId: parsed.data.projectId,
          connectorName,
          actionName,
          propName,
          connectionId: parsed.data.connectionId,
          userId,
          propsValue: parsed.data.propsValue,
        } as ResolveActionDynamicPropsInput);
        return res.json({ success: true, data });
      } catch (err) {
        if (err instanceof DropdownOptionsServiceError) {
          return res
            .status(errorCodeToStatus(err.code))
            .json({ success: false, error: { code: err.code, message: err.message } });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false,
          error: { code: 'DYNAMIC_PROPS_FAILED', message },
        });
      }
    },
  );

  /**
   * POST /:connectorName/triggers/:triggerName/props/:propName/dynamic-fields
   *
   * Resolve the DynamicProperties field map for a prop on a connector trigger.
   */
  router.post(
    '/:connectorName/triggers/:triggerName/props/:propName/dynamic-fields',
    async (req: Request, res: Response) => {
      if (!optionsSvc) {
        return res.status(501).json({
          success: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Dynamic props resolver is not configured on this server',
          },
        });
      }

      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing tenant' } });
      }

      const parsed = resolveOptionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { connectorName, triggerName, propName } = req.params;
      const userId = (req as any).tenantContext?.userId;

      try {
        const data = await optionsSvc.resolveTriggerDynamicProps({
          tenantId,
          projectId: parsed.data.projectId,
          connectorName,
          triggerName,
          propName,
          connectionId: parsed.data.connectionId,
          userId,
          propsValue: parsed.data.propsValue,
        } as ResolveTriggerDynamicPropsInput);
        return res.json({ success: true, data });
      } catch (err) {
        if (err instanceof DropdownOptionsServiceError) {
          return res
            .status(errorCodeToStatus(err.code))
            .json({ success: false, error: { code: err.code, message: err.message } });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false,
          error: { code: 'DYNAMIC_PROPS_FAILED', message },
        });
      }
    },
  );

  return router;
}
