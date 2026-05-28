/**
 * Pipeline Trigger Node Constants
 *
 * Shared constants and types for the visual-only trigger node
 * on the pipeline graph canvas. The trigger node is a UI construct
 * that is never persisted to the backend PipelineNode[] schema.
 */

import type { SelectedTrigger } from '../../store/pipeline-editor-store';

export const TRIGGER_NODE_ID = '__trigger__';
export const TRIGGER_NODE_WIDTH = 220;
export const TRIGGER_NODE_HEIGHT = 100;
export const TRIGGER_EDGE_ID_PREFIX = 'e-trigger-';
export const TRIGGER_POSITION_OFFSET_Y = -180;

export interface TriggerNodeData extends Record<string, unknown> {
  label: 'Trigger';
  triggerCount: number;
  triggerSummary: string;
}

interface TriggerDef {
  id: string;
  type: string;
}

/**
 * Build a human-readable summary string from selected triggers.
 * e.g. "Kafka, Manual" or "Not configured".
 */
export function buildTriggerSummary(
  selectedTriggers: SelectedTrigger[],
  triggerDefs: TriggerDef[],
): string {
  if (selectedTriggers.length === 0) return 'Not configured';
  return selectedTriggers
    .map((t) => triggerDefs.find((d) => d.id === t.triggerId)?.type ?? 'unknown')
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(', ');
}
