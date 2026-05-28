/**
 * Resolve trigger selections into full supportedTriggers definitions.
 *
 * The client sends lightweight trigger selections (ID + optional schedule).
 * This helper hydrates them from the trigger registry so the full definition
 * (kafkaTopic, inputSchema, etc.) is stored server-side — the client never
 * needs to send catalog metadata.
 */
import { getTriggerDefinition } from '@agent-platform/pipeline-engine/triggers';

interface TriggerSelection {
  triggerId: string;
  schedule?: string;
}

interface ResolvedTrigger {
  id: string;
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  strategy: string;
  label: string;
  description: string;
  schedule?: string;
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  /** Realistic payload used by the Studio test drawer (ABLP-564 Phase 3). */
  exampleOutput?: Record<string, unknown>;
}

/**
 * Given an array of trigger selections from the client, resolve them
 * into full trigger entries suitable for storage in the pipeline definition.
 *
 * Returns `{ supportedTriggers, defaultTriggerIds }` or `undefined` if
 * no selections were provided.
 */
export async function resolveTriggerSelections(
  selections: TriggerSelection[] | undefined,
): Promise<{ supportedTriggers: ResolvedTrigger[]; defaultTriggerIds: string[] } | undefined> {
  if (!selections || selections.length === 0) return undefined;
  const supportedTriggers: ResolvedTrigger[] = [];

  for (const sel of selections) {
    const def = getTriggerDefinition(sel.triggerId);
    if (!def) continue;

    supportedTriggers.push({
      id: def.id,
      type: def.type,
      kafkaTopic: def.kafkaTopic,
      strategy: 'default',
      label: def.label,
      description: def.description,
      schedule: sel.schedule,
      inputSchema: def.inputSchema,
      exampleOutput: def.exampleOutput,
    });
  }

  const defaultTriggerIds = supportedTriggers.map((t) => t.id);
  return { supportedTriggers, defaultTriggerIds };
}
