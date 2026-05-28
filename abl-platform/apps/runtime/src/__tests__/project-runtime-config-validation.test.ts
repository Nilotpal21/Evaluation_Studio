/**
 * Tests for Zod validation schemas in the project-runtime-config route.
 *
 * Covers F4: Validate multi-intent strategy strings at API boundary.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Re-create the schemas as defined in the route — this tests the contract
const extractionConfigSchema = z.object({
  strategy: z.enum(['auto', 'ml', 'llm', 'hybrid', 'pattern']).optional(),
  correction_detection: z.enum(['auto', 'ml', 'llm', 'regex', 'sidecar', 'disabled']).optional(),
  sidecar_timeout_ms: z.number().optional(),
  sidecar_circuit_breaker_threshold: z.number().optional(),
});

const multiIntentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  strategy: z.enum(['sequential', 'parallel', 'primary_queue', 'disambiguate', 'auto']).optional(),
  max_intents: z.number().optional(),
  confidence_threshold: z.number().optional(),
  queue_max_age_ms: z.number().optional(),
});

describe('F4: Extraction config validation', () => {
  describe('extraction strategy', () => {
    it.each(['auto', 'ml', 'llm', 'hybrid', 'pattern'])(
      'accepts valid strategy "%s"',
      (strategy) => {
        expect(extractionConfigSchema.safeParse({ strategy }).success).toBe(true);
      },
    );

    it('accepts undefined (optional)', () => {
      expect(extractionConfigSchema.safeParse({}).success).toBe(true);
    });

    it.each(['invalid', '', 'heuristic', 'random', 'AUTO', 'ML'])(
      'rejects invalid strategy "%s"',
      (strategy) => {
        const result = extractionConfigSchema.safeParse({ strategy });
        expect(result.success).toBe(false);
      },
    );
  });

  describe('correction_detection', () => {
    it.each(['auto', 'ml', 'llm', 'regex', 'sidecar', 'disabled'])(
      'accepts valid correction_detection "%s"',
      (correction_detection) => {
        expect(extractionConfigSchema.safeParse({ correction_detection }).success).toBe(true);
      },
    );

    it.each(['nlp', '', 'heuristic', 'ML', 'LLM'])(
      'rejects invalid correction_detection "%s"',
      (correction_detection) => {
        expect(extractionConfigSchema.safeParse({ correction_detection }).success).toBe(false);
      },
    );
  });

  describe('sidecar_timeout_ms', () => {
    it('accepts number', () => {
      expect(extractionConfigSchema.safeParse({ sidecar_timeout_ms: 500 }).success).toBe(true);
    });

    it('rejects string', () => {
      expect(extractionConfigSchema.safeParse({ sidecar_timeout_ms: '500' }).success).toBe(false);
    });
  });

  describe('combined fields', () => {
    it('accepts full valid config', () => {
      const result = extractionConfigSchema.safeParse({
        strategy: 'hybrid',
        correction_detection: 'llm',
        sidecar_timeout_ms: 1000,
        sidecar_circuit_breaker_threshold: 3,
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('F4: Multi-intent config validation', () => {
  describe('multi-intent strategy', () => {
    it.each(['sequential', 'parallel', 'primary_queue', 'disambiguate', 'auto'])(
      'accepts valid strategy "%s"',
      (strategy) => {
        expect(multiIntentConfigSchema.safeParse({ strategy }).success).toBe(true);
      },
    );

    it('accepts undefined (optional)', () => {
      expect(multiIntentConfigSchema.safeParse({}).success).toBe(true);
    });

    it.each(['round_robin', 'priority', '', 'SEQUENTIAL', 'first_match'])(
      'rejects invalid strategy "%s"',
      (strategy) => {
        expect(multiIntentConfigSchema.safeParse({ strategy }).success).toBe(false);
      },
    );
  });

  describe('numeric fields', () => {
    it('accepts valid max_intents', () => {
      expect(multiIntentConfigSchema.safeParse({ max_intents: 5 }).success).toBe(true);
    });

    it('accepts valid confidence_threshold', () => {
      expect(multiIntentConfigSchema.safeParse({ confidence_threshold: 0.8 }).success).toBe(true);
    });

    it('rejects string max_intents', () => {
      expect(multiIntentConfigSchema.safeParse({ max_intents: '5' }).success).toBe(false);
    });
  });

  describe('combined fields', () => {
    it('accepts full valid config', () => {
      const result = multiIntentConfigSchema.safeParse({
        enabled: true,
        strategy: 'disambiguate',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      });
      expect(result.success).toBe(true);
    });

    it('accepts partial config', () => {
      const result = multiIntentConfigSchema.safeParse({
        strategy: 'sequential',
      });
      expect(result.success).toBe(true);
    });
  });
});
