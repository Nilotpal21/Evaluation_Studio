/**
 * V2 Pipeline Edge Styles
 *
 * Custom edge style factory using design tokens for stage-type color coding.
 * Uses CSS variable references from the design token system for theme-awareness.
 */

import type React from 'react';
import { pipelineStageIntent, getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';

// =============================================================================
// STAGE TYPE → INTENT OVERRIDES
// =============================================================================

/**
 * Stage types not covered by the default pipelineStageIntent mapping.
 * Mirrors the overrides from the existing PipelineCanvas.
 */
const STAGE_INTENT_OVERRIDES: Record<string, SemanticIntent> = {
  chunking: 'info',
  'knowledge-graph': 'accent',
  'content-intelligence': 'warning',
  'visual-analysis': 'purple',
  multimodal: 'purple',
  embedding: 'success',
  'field-mapping': 'accent',
  'api-webhook': 'orange',
  'llm-stage': 'warning',
};

/**
 * Resolve a stage type to its semantic intent, with local overrides.
 */
export function resolveStageIntent(stageType: string): SemanticIntent {
  return STAGE_INTENT_OVERRIDES[stageType] ?? pipelineStageIntent(stageType);
}

// =============================================================================
// CSS VARIABLE MAP — intent → CSS custom property for stroke
// =============================================================================

/**
 * Maps semantic intents to CSS variable references for SVG stroke colors.
 * These match the variables defined in globals.css that back the design tokens.
 */
const INTENT_STROKE_MAP: Record<SemanticIntent, string> = {
  accent: 'hsl(var(--accent))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  error: 'hsl(var(--error))',
  info: 'hsl(var(--info))',
  purple: 'hsl(var(--purple))',
  orange: 'hsl(var(--orange))',
  muted: 'hsl(var(--border))',
  neutral: 'hsl(var(--border))',
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get React Flow edge style based on the connected stage type.
 * Returns CSS properties for stroke color, width, and optional glow.
 *
 * @param stageType - Pipeline stage type (extraction, chunking, etc.)
 *                    If omitted, returns a neutral/default edge style.
 */
export function getEdgeStyle(stageType?: string): React.CSSProperties {
  if (!stageType) {
    return {
      stroke: 'hsl(var(--foreground-muted))',
      strokeWidth: 2,
      opacity: 0.5,
    };
  }

  const intent = resolveStageIntent(stageType);
  const strokeColor = INTENT_STROKE_MAP[intent];

  return {
    stroke: strokeColor,
    strokeWidth: 2,
  };
}

/**
 * Get the Tailwind class set for a stage type node.
 * Convenience wrapper around design token resolution.
 */
export function getStageNodeStyles(stageType: string) {
  const intent = resolveStageIntent(stageType);
  return getIntentStyles(intent);
}
