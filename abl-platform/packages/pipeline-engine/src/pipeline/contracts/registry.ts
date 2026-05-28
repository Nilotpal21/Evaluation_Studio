/**
 * ContractRegistry — single lookup surface for TriggerContract / NodeContract /
 * DestinationContract. Hydrates from existing data sources without modifying them.
 *
 * Data sources:
 *   - seed-data/trigger-definitions.json      (existing — triggers)
 *   - seed-data/node-type-definitions.json    (existing — category/label/description)
 *   - activity-metadata.ts                    (existing — configSchema/outputSchema/defaultTimeout/defaultRetries)
 *   - contracts/node-contract-data.ts         (new — NODE_ENRICHMENT)
 *   - contracts/destination-contract.ts       (new — DESTINATION_REGISTRY)
 */

import type { NodeCategory } from '../types.js';
import { ACTIVITY_TYPES } from '../activity-metadata.js';
import triggerDefinitions from '../seed-data/trigger-definitions.json' with { type: 'json' };
import nodeTypeDefinitions from '../seed-data/node-type-definitions.json' with { type: 'json' };

import type { TriggerContract, TriggerCategory, TriggerType } from './trigger-contract.js';
import type { NodeContract } from './node-contract.js';
import {
  DESTINATION_REGISTRY,
  isDestinationId,
  type DestinationContract,
  type DestinationId,
} from './destination-contract.js';
import { NODE_ENRICHMENT } from './node-contract-data.js';

// Registry collections are bounded by construction — one entry per static
// definition file or enum. These caps exist so that accidental runtime growth
// (e.g. a corrupt JSON load) throws loudly instead of silently ballooning
// memory.
const MAX_TRIGGER_COUNT = 200;
const MAX_NODE_COUNT = 500;
const MAX_DESTINATION_COUNT = 50;

// A raw trigger definition from seed-data may omit `exampleOutput` until Task 6
// lands. Until then, we fall back to a minimal synthesized payload so the registry
// still produces a valid contract.
interface RawTriggerDefinition {
  id: string;
  type: TriggerType;
  kafkaTopic?: string;
  category: TriggerCategory | string;
  label: string;
  description: string;
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  exampleOutput?: Record<string, unknown>;
}

interface RawNodeTypeDefinition {
  _id: string;
  category: NodeCategory;
  label?: string;
  description?: string;
}

function normaliseCategory(value: string): TriggerCategory {
  if (value === 'session' || value === 'message' || value === 'manual' || value === 'schedule') {
    return value;
  }
  return 'other';
}

function synthesizeExampleOutput(required: string[]): Record<string, unknown> {
  // Minimal placeholders per commonly-required field; used only as a fallback.
  const payload: Record<string, unknown> = {};
  for (const field of required) {
    if (field === 'tenantId') payload[field] = 'tenant-dev-001';
    else if (field === 'sessionId') payload[field] = 'sess-example-001';
    else if (field === 'projectId') payload[field] = 'proj-example';
    else payload[field] = '';
  }
  return payload;
}

export class ContractRegistry {
  private readonly triggers: Map<string, TriggerContract>;
  private readonly nodes: Map<string, NodeContract>;
  private readonly destinations: Map<DestinationId, DestinationContract>;

  constructor() {
    this.triggers = new Map();
    this.nodes = new Map();
    this.destinations = new Map(
      Object.entries(DESTINATION_REGISTRY).map(([id, contract]) => [id as DestinationId, contract]),
    );
    this.hydrateTriggers();
    this.hydrateNodes();
    this.assertBounds();
  }

  getTrigger(id: string): TriggerContract | undefined {
    return this.triggers.get(id);
  }

  getNode(type: string): NodeContract | undefined {
    return this.nodes.get(type);
  }

  getDestination(id: unknown): DestinationContract | undefined {
    if (!isDestinationId(id)) return undefined;
    return this.destinations.get(id);
  }

  listTriggers(): TriggerContract[] {
    return Array.from(this.triggers.values());
  }

  listNodes(): NodeContract[] {
    return Array.from(this.nodes.values());
  }

  listDestinations(): DestinationContract[] {
    return Array.from(this.destinations.values());
  }

  private hydrateTriggers(): void {
    const defs = triggerDefinitions as RawTriggerDefinition[];
    for (const def of defs) {
      const required = def.inputSchema?.required ?? [];
      const properties = def.inputSchema?.properties ?? {};
      const contract: TriggerContract = {
        id: def.id,
        type: def.type,
        kafkaTopic: def.kafkaTopic,
        category: normaliseCategory(def.category),
        label: def.label,
        description: def.description,
        outputSchema: { required, properties },
        exampleOutput: def.exampleOutput ?? synthesizeExampleOutput(required),
      };
      this.triggers.set(contract.id, contract);
    }
  }

  private hydrateNodes(): void {
    const nodeDefsById = new Map<string, RawNodeTypeDefinition>(
      (nodeTypeDefinitions as RawNodeTypeDefinition[]).map((d) => [d._id, d]),
    );

    for (const [type, meta] of Object.entries(ACTIVITY_TYPES)) {
      const enrichment = NODE_ENRICHMENT[type];
      if (!enrichment) {
        // Safety net — a node in ACTIVITY_TYPES with no enrichment is a bug the
        // coverage test in node-contract.test.ts should catch first. Skip silently
        // here so the registry remains usable for the rest of the nodes.
        continue;
      }
      const nodeDef = nodeDefsById.get(type);
      const contract: NodeContract = {
        type,
        category: nodeDef?.category ?? 'compute',
        label: nodeDef?.label ?? meta.name,
        description: nodeDef?.description ?? meta.description,
        inputRequirements: enrichment.inputRequirements,
        configSchema: meta.configSchema,
        outputSchema: meta.outputSchema,
        compatibleTriggers: enrichment.compatibleTriggers,
        sideEffectClass: enrichment.sideEffectClass,
        contractVersion: enrichment.contractVersion,
        defaultTimeout: meta.defaultTimeout,
        defaultRetries: meta.defaultRetries,
      };
      this.nodes.set(type, contract);
    }
  }

  private assertBounds(): void {
    if (this.triggers.size > MAX_TRIGGER_COUNT) {
      throw new Error(
        `ContractRegistry trigger count (${this.triggers.size}) exceeds MAX_TRIGGER_COUNT (${MAX_TRIGGER_COUNT})`,
      );
    }
    if (this.nodes.size > MAX_NODE_COUNT) {
      throw new Error(
        `ContractRegistry node count (${this.nodes.size}) exceeds MAX_NODE_COUNT (${MAX_NODE_COUNT})`,
      );
    }
    if (this.destinations.size > MAX_DESTINATION_COUNT) {
      throw new Error(
        `ContractRegistry destination count (${this.destinations.size}) exceeds MAX_DESTINATION_COUNT (${MAX_DESTINATION_COUNT})`,
      );
    }
  }
}
