/**
 * Model Router
 *
 * Routes NLU tasks to the appropriate model layer (fast vs balanced).
 * Handles fallback logic between layers.
 */

import type { NLUEngineConfig, NLUModelLayerConfig, NLUTask, NLULayer } from './types.js';

// =============================================================================
// TASK-TO-LAYER MAPPING
// =============================================================================

/**
 * Default task-to-layer mapping.
 * Fast tier: simple classification tasks.
 * Balanced tier: nuanced understanding tasks.
 */
const TASK_LAYER_DEFAULTS: Record<NLUTask, NLULayer> = {
  intent_detection: 'fast',
  sub_intent_detection: 'balanced',
  category_classification: 'fast',
  entity_extraction: 'fast',
  correction_detection: 'fast',
  digression_detection: 'balanced',
  language_detection: 'fast',
  combined_analysis: 'fast',
};

// =============================================================================
// MODEL ROUTER
// =============================================================================

export class ModelRouter {
  private config: NLUEngineConfig;

  constructor(config: NLUEngineConfig) {
    this.config = config;
  }

  /**
   * Get the model layer config for a given NLU task.
   * Returns the primary layer and optional fallback.
   */
  getLayerForTask(task: NLUTask): {
    primary: NLUModelLayerConfig;
    primaryLayer: NLULayer;
    fallback?: NLUModelLayerConfig;
    fallbackLayer?: NLULayer;
  } {
    const preferredLayer = TASK_LAYER_DEFAULTS[task];

    if (preferredLayer === 'balanced' && this.config.layers.balanced) {
      return {
        primary: this.config.layers.balanced,
        primaryLayer: 'balanced',
        fallback: this.config.layers.fast,
        fallbackLayer: 'fast',
      };
    }

    // Default to fast layer
    return {
      primary: this.config.layers.fast,
      primaryLayer: 'fast',
      fallback: this.config.layers.balanced,
      fallbackLayer: this.config.layers.balanced ? 'balanced' : undefined,
    };
  }

  /**
   * Get the confidence threshold for deciding if a result is good enough
   */
  getConfidenceThreshold(): number {
    return this.config.confidenceThreshold ?? 0.7;
  }

  /**
   * Check if fallback regex/keyword layer is enabled
   */
  isFallbackEnabled(): boolean {
    return this.config.enableFallbacks !== false;
  }

  /**
   * Select layer for A/B testing — randomly assigns to fast or balanced
   */
  selectABVariant(): { layer: NLUModelLayerConfig; variant: string } {
    if (!this.config.layers.balanced) {
      return { layer: this.config.layers.fast, variant: 'fast' };
    }

    const variant = Math.random() < 0.5 ? 'fast' : 'balanced';
    return {
      layer: variant === 'fast' ? this.config.layers.fast : this.config.layers.balanced!,
      variant,
    };
  }
}
