/**
 * NodeContract — strict typed contract per node type.
 *
 * Source of truth for:
 *   - node palette filtering by active trigger
 *   - save-time trigger↔node validation
 *   - expression autocomplete (upstream outputSchema lookups)
 *   - expression reference validation
 *   - dataflow-preview eligibility (via sideEffectClass)
 */

import type { NodeCategory, ConfigField } from '../types.js';

export type SideEffectClass = 'pure' | 'read' | 'write' | 'external';

export interface NodeContract {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;

  /** What the node reads. */
  inputRequirements: {
    /** Keys consumed directly from pipelineInput (i.e. from the trigger). */
    fromTrigger: string[];
    /** Upstream step output fields read by convention; placeholder key maps to field list. */
    fromPreviousSteps?: Record<string, string[]>;
  };

  /** Config schema (keeps the existing shape). */
  configSchema: {
    required: string[];
    properties: Record<string, ConfigField | { type: string; description?: string }>;
  };

  /** Output schema — powers expression autocomplete for downstream nodes. */
  outputSchema: {
    properties: Record<string, { type: string; description?: string }>;
  };

  /** Trigger allowlist. '*' means "works with any trigger." */
  compatibleTriggers: string[] | '*';

  /** Tells the dataflow-preview engine what is safe to re-execute. */
  sideEffectClass: SideEffectClass;

  /** Bumped whenever the contract tightens. Pipelines stamp this at save time. */
  contractVersion: number;

  defaultTimeout?: number;
  defaultRetries?: number;
}

const SIDE_EFFECT_CLASSES: readonly SideEffectClass[] = ['pure', 'read', 'write', 'external'];

export function isValidNodeContract(value: unknown): value is NodeContract {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || v.type.length === 0) return false;
  if (typeof v.category !== 'string') return false;
  if (typeof v.label !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  const input = v.inputRequirements as Record<string, unknown> | undefined;
  if (!input || !Array.isArray(input.fromTrigger)) return false;
  const cfg = v.configSchema as Record<string, unknown> | undefined;
  if (
    !cfg ||
    !Array.isArray(cfg.required) ||
    !cfg.properties ||
    typeof cfg.properties !== 'object'
  ) {
    return false;
  }
  const out = v.outputSchema as Record<string, unknown> | undefined;
  if (!out || !out.properties || typeof out.properties !== 'object') return false;
  if (v.compatibleTriggers !== '*' && !Array.isArray(v.compatibleTriggers)) return false;
  if (
    typeof v.sideEffectClass !== 'string' ||
    !SIDE_EFFECT_CLASSES.includes(v.sideEffectClass as SideEffectClass)
  ) {
    return false;
  }
  if (typeof v.contractVersion !== 'number' || v.contractVersion < 1) return false;
  return true;
}
