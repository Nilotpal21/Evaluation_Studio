/**
 * ConnectorListingService
 *
 * Read-only queries against the ConnectorRegistry.
 * Returns serializable connector metadata (no functions/classes).
 */

import type { Connector, ConnectorAction, ConnectorTrigger } from '../types.js';
import type { ConnectorRegistry } from '../registry.js';

// ─── Response Types ─────────────────────────────────────────────────────────

export interface ConnectorSummary {
  name: string;
  displayName: string;
  version: string;
  description: string;
  auth: { type: string };
  triggers: TriggerSummary[];
  actions: ActionSummary[];
}

export interface TriggerSummary {
  name: string;
  displayName: string;
  description: string;
  triggerType: string;
  props: unknown;
  sampleData?: Record<string, unknown>;
}

export interface ActionSummary {
  name: string;
  displayName: string;
  description: string;
  props: unknown;
}

// ─── Mappers ────────────────────────────────────────────────────────────────

function mapTrigger(t: ConnectorTrigger): TriggerSummary {
  return {
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    triggerType: t.triggerType,
    props: t.props,
    ...(t.sampleData ? { sampleData: t.sampleData as Record<string, unknown> } : {}),
  };
}

function mapAction(a: ConnectorAction): ActionSummary {
  return {
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    props: a.props,
  };
}

function mapConnector(c: Connector): ConnectorSummary {
  return {
    name: c.name,
    displayName: c.displayName,
    version: c.version,
    description: c.description,
    auth: { type: c.auth.type },
    triggers: c.triggers.map(mapTrigger),
    actions: c.actions.map(mapAction),
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ConnectorListingService {
  constructor(private readonly registry: ConnectorRegistry) {}

  /** List all registered connectors with their triggers and actions. */
  listConnectors(): ConnectorSummary[] {
    return this.registry.listConnectors().map(mapConnector);
  }

  /** Get a single connector by name. Returns null if not found. */
  async getConnector(name: string): Promise<ConnectorSummary | null> {
    try {
      const connector = await this.registry.get(name);
      return mapConnector(connector);
    } catch {
      return null;
    }
  }
}
