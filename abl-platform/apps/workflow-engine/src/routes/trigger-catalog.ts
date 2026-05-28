/**
 * Trigger Catalog Router — returns connectors that have workflow triggers,
 * queried from the live ConnectorRegistry via ConnectorListingService.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ConnectorRegistry } from '@agent-platform/connectors';
import { ConnectorListingService } from '@agent-platform/connectors/services';

export interface TriggerCatalogRouteDeps {
  registry: ConnectorRegistry;
}

export function createTriggerCatalogRouter(deps: TriggerCatalogRouteDeps): Router {
  const router = Router();
  const svc = new ConnectorListingService(deps.registry);

  router.get('/', (_req: Request, res: Response) => {
    try {
      const all = svc.listConnectors();
      // Only include connectors that have at least one trigger
      const withTriggers = all.filter((c) => c.triggers.length > 0);

      return res.json({
        success: true,
        data: withTriggers.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          description: c.description,
          auth: c.auth,
          triggers: c.triggers.map((t) => ({
            name: t.name,
            displayName: t.displayName,
            description: t.description,
            triggerType: t.triggerType,
            props: Array.isArray(t.props) ? t.props : [],
            sampleData: t.sampleData,
          })),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        success: false,
        error: { code: 'TRIGGER_CATALOG_FAILED', message },
      });
    }
  });

  return router;
}
