/**
 * Trigger Registry
 *
 * Loads available trigger definitions from the seed data JSON file.
 * Mirrors the NodeRegistry pattern — UI fetches these to render
 * a data-driven trigger picker. Adding a new trigger = adding a JSON entry.
 */

import definitions from './seed-data/trigger-definitions.json' with { type: 'json' };

export interface TriggerDefinition {
  id: string;
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  category: string;
  label: string;
  description: string;
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  /**
   * Realistic payload matching the trigger's inputSchema. Used by the Studio
   * test drawer to pre-fill a runnable payload. Added in ABLP-564 Phase 1.
   */
  exampleOutput?: Record<string, unknown>;
}

function loadDefinitions(): TriggerDefinition[] {
  return definitions as TriggerDefinition[];
}

/**
 * List all available trigger definitions, optionally filtered by category.
 */
export function listTriggerDefinitions(filters?: { category?: string }): TriggerDefinition[] {
  const definitions = loadDefinitions();
  if (filters?.category) {
    return definitions.filter((d) => d.category === filters.category);
  }
  return [...definitions];
}

/**
 * Get a single trigger definition by ID.
 */
export function getTriggerDefinition(id: string): TriggerDefinition | undefined {
  return loadDefinitions().find((d) => d.id === id);
}

/**
 * Get unique categories from all trigger definitions, preserving insertion order.
 */
export function getTriggerCategories(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const d of loadDefinitions()) {
    if (!seen.has(d.category)) {
      seen.add(d.category);
      result.push(d.category);
    }
  }
  return result;
}
