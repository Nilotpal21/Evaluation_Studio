/**
 * Repetition Detector Factory
 *
 * Creates the appropriate repetition detector based on environment variable.
 * Allows easy switching between normalized, semantic, and hybrid implementations.
 *
 * Environment Variable:
 * - REPETITION_DETECTOR_TYPE=normalized (default) - Fast string similarity
 * - REPETITION_DETECTOR_TYPE=semantic - ML-based embeddings (future)
 * - REPETITION_DETECTOR_TYPE=hybrid - Combined approach (future)
 */

import type { IRepetitionDetector } from './repetition-detector.js';
import { NormalizedRepetitionDetector } from './normalized-repetition-detector.js';
import { SemanticRepetitionDetector } from './semantic-repetition-detector.js';
import { HybridRepetitionDetector } from './hybrid-repetition-detector.js';

export type RepetitionDetectorType = 'normalized' | 'semantic' | 'hybrid';

export class RepetitionDetectorFactory {
  private static instance?: IRepetitionDetector;

  /**
   * Get the configured repetition detector (singleton)
   */
  static getDetector(): IRepetitionDetector {
    if (!this.instance) {
      this.instance = this.createDetector();
    }
    return this.instance;
  }

  /**
   * Create a new detector instance based on environment variable
   */
  private static createDetector(): IRepetitionDetector {
    const detectorType = this.getDetectorType();

    switch (detectorType) {
      case 'normalized':
        return new NormalizedRepetitionDetector();

      case 'semantic':
        console.warn(
          'SemanticRepetitionDetector is not yet implemented. Falling back to normalized.',
        );
        return new SemanticRepetitionDetector();

      case 'hybrid':
        console.warn(
          'HybridRepetitionDetector is not yet implemented. Falling back to normalized.',
        );
        return new HybridRepetitionDetector();

      default:
        console.warn(
          `Unknown REPETITION_DETECTOR_TYPE: ${detectorType}. Falling back to normalized.`,
        );
        return new NormalizedRepetitionDetector();
    }
  }

  /**
   * Get detector type from environment variable
   */
  private static getDetectorType(): RepetitionDetectorType {
    const envValue = process.env.REPETITION_DETECTOR_TYPE?.toLowerCase();

    if (envValue === 'normalized' || envValue === 'semantic' || envValue === 'hybrid') {
      return envValue;
    }

    // Default to normalized
    return 'normalized';
  }

  /**
   * Reset singleton (useful for testing)
   */
  static reset(): void {
    this.instance = undefined;
  }

  /**
   * Create a specific detector type (useful for testing)
   */
  static createSpecific(type: RepetitionDetectorType): IRepetitionDetector {
    switch (type) {
      case 'normalized':
        return new NormalizedRepetitionDetector();
      case 'semantic':
        return new SemanticRepetitionDetector();
      case 'hybrid':
        return new HybridRepetitionDetector();
    }
  }
}
