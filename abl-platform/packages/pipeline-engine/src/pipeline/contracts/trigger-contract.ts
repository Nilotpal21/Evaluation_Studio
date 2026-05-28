/**
 * TriggerContract — typed contract that declares what a pipeline trigger emits.
 *
 * Source of truth for:
 *   - trigger picker metadata
 *   - test-drawer example payloads
 *   - trigger↔node compatibility checks (cross-referenced by NodeContract.inputRequirements.fromTrigger)
 */

export type TriggerType = 'kafka' | 'manual' | 'schedule';

export type TriggerCategory = 'session' | 'message' | 'manual' | 'schedule' | 'other';

export interface TriggerContract {
  id: string;
  type: TriggerType;
  kafkaTopic?: string;
  category: TriggerCategory;
  label: string;
  description: string;
  /** Shape a pipelineInput is guaranteed to have when this trigger fires. */
  outputSchema: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  /** Realistic payload used by the test drawer and dataflow preview. */
  exampleOutput: Record<string, unknown>;
}

const TRIGGER_TYPES: readonly TriggerType[] = ['kafka', 'manual', 'schedule'];
const TRIGGER_CATEGORIES: readonly TriggerCategory[] = [
  'session',
  'message',
  'manual',
  'schedule',
  'other',
];

export function isValidTriggerContract(value: unknown): value is TriggerContract {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.type !== 'string' || !TRIGGER_TYPES.includes(v.type as TriggerType)) return false;
  if (v.kafkaTopic !== undefined && typeof v.kafkaTopic !== 'string') return false;
  if (typeof v.category !== 'string' || !TRIGGER_CATEGORIES.includes(v.category as TriggerCategory))
    return false;
  if (typeof v.label !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  const out = v.outputSchema as Record<string, unknown> | undefined;
  if (!out || typeof out !== 'object') return false;
  if (!Array.isArray(out.required)) return false;
  if (!out.properties || typeof out.properties !== 'object') return false;
  if (!v.exampleOutput || typeof v.exampleOutput !== 'object') return false;
  return true;
}
