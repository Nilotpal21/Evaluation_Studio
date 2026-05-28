/**
 * Tests for pipeline config Zod schemas and validation.
 *
 * Verifies:
 *   - Each schema produces valid defaults from parse({})
 *   - Invalid values are rejected
 *   - parseAndValidateConfig() round-trips correctly per pipeline type
 */
import { describe, test, expect } from 'vitest';
import {
  SentimentConfigSchema,
  IntentConfigSchema,
  QualityConfigSchema,
  LLMEvaluationConfigSchema,
  StatisticalConfigSchema,
  SharedPipelineConfigSchema,
  PIPELINE_CONFIG_SCHEMAS,
  buildZodSchema,
  parseAndValidateConfig,
} from '../pipeline/config-schemas.js';

// ---------------------------------------------------------------------------
// Default production from parse({})
// ---------------------------------------------------------------------------

describe('Config schemas — defaults from parse({})', () => {
  test('SharedPipelineConfigSchema produces valid defaults', () => {
    const result = SharedPipelineConfigSchema.parse({});
    expect(result.samplingRate).toBe(1.0);
    expect(result.stepOverrides).toEqual({});
    expect(result.timeoutOverrides).toEqual({});
    expect(result.model).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  test('SentimentConfigSchema produces valid defaults', () => {
    const result = SentimentConfigSchema.parse({});
    expect(result.shiftThreshold).toBe(0.3);
    expect(result.frustrationThreshold).toBe(-0.3);
    expect(result.defaultConfidence).toBe(0.85);
    expect(result.samplingRate).toBe(1.0);
  });

  test('IntentConfigSchema produces valid defaults', () => {
    const result = IntentConfigSchema.parse({});
    expect(result.taxonomy).toEqual([]);
    expect(result.confidenceThreshold).toBe(0.6);
    expect(result.inputMessageStrategy).toBe('first_n_user');
    expect(result.inputMessageCount).toBe(3);
    expect(result.unknownIntentLabel).toBe('unknown');
    expect(result.classificationPrompt).toBeUndefined();
  });

  test('QualityConfigSchema produces valid defaults', () => {
    const result = QualityConfigSchema.parse({});
    expect(result.flagThreshold).toBe(2.5);
    expect(result.dimensions).toBeUndefined();
    expect(result.domainContext).toBeUndefined();
  });

  test('LLMEvaluationConfigSchema produces valid defaults', () => {
    const result = LLMEvaluationConfigSchema.parse({});
    expect(result.samplingRate).toBe(1.0);
    expect(result.flagThreshold).toBeUndefined();
    expect(result.systemPromptOverride).toBeUndefined();
  });

  test('StatisticalConfigSchema produces valid defaults', () => {
    const result = StatisticalConfigSchema.parse({});
    expect(result.lookbackDays).toBe(30);
    expect(result.metricTable).toBeUndefined();
    expect(result.metricColumn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation — invalid values rejected
// ---------------------------------------------------------------------------

describe('Config schemas — validation rejects invalid values', () => {
  test('samplingRate > 1.0 rejected', () => {
    expect(() => SharedPipelineConfigSchema.parse({ samplingRate: 2.0 })).toThrow();
  });

  test('samplingRate < 0 rejected', () => {
    expect(() => SharedPipelineConfigSchema.parse({ samplingRate: -0.5 })).toThrow();
  });

  test('SentimentConfigSchema rejects shiftThreshold > 1', () => {
    expect(() => SentimentConfigSchema.parse({ shiftThreshold: 1.5 })).toThrow();
  });

  test('IntentConfigSchema rejects confidenceThreshold > 1', () => {
    expect(() => IntentConfigSchema.parse({ confidenceThreshold: 1.5 })).toThrow();
  });

  test('IntentConfigSchema rejects negative inputMessageCount', () => {
    expect(() => IntentConfigSchema.parse({ inputMessageCount: -1 })).toThrow();
  });

  test('IntentConfigSchema rejects invalid inputMessageStrategy', () => {
    expect(() => IntentConfigSchema.parse({ inputMessageStrategy: 'invalid' })).toThrow();
  });

  test('QualityConfigSchema rejects flagThreshold > 5', () => {
    expect(() => QualityConfigSchema.parse({ flagThreshold: 6.0 })).toThrow();
  });

  test('StatisticalConfigSchema rejects negative lookbackDays', () => {
    expect(() => StatisticalConfigSchema.parse({ lookbackDays: -5 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PIPELINE_CONFIG_SCHEMAS registry
// ---------------------------------------------------------------------------

describe('PIPELINE_CONFIG_SCHEMAS registry', () => {
  test('all expected pipeline types have schemas', () => {
    const expectedTypes = [
      'sentiment_analysis',
      'intent_classification',
      'quality_evaluation',
      'hallucination_detection',
      'knowledge_gap',
      'guardrail_analysis',
      'friction_detection',
      'anomaly_detection',
      'drift_detection',
      'simulation',
    ];

    for (const type of expectedTypes) {
      expect(PIPELINE_CONFIG_SCHEMAS[type]).toBeDefined();
    }
  });
});

describe('buildZodSchema()', () => {
  test('ignores non-interactive info fields', () => {
    const schema = buildZodSchema({
      fields: [
        {
          name: '__destination_clickhouse_hint',
          type: 'info',
          required: false,
          description: 'Leave table empty to use the shared table.',
        },
        {
          name: 'destination',
          type: 'enum',
          required: true,
          description: 'Target destination',
          values: ['clickhouse', 'mongodb'],
        },
      ],
    });

    const parsed = schema.parse({ destination: 'clickhouse' });
    expect(parsed).not.toHaveProperty('__destination_clickhouse_hint');
    expect(parsed.destination).toBe('clickhouse');
  });
});

// ---------------------------------------------------------------------------
// parseAndValidateConfig()
// ---------------------------------------------------------------------------

describe('parseAndValidateConfig()', () => {
  test('applies defaults for sentiment_analysis', () => {
    const result = parseAndValidateConfig('sentiment_analysis', {});
    expect(result).toHaveProperty('shiftThreshold', 0.3);
    expect(result).toHaveProperty('frustrationThreshold', -0.3);
    expect(result).toHaveProperty('defaultConfidence', 0.85);
    expect(result).toHaveProperty('samplingRate', 1.0);
  });

  test('preserves custom values for intent_classification', () => {
    const input = {
      confidenceThreshold: 0.8,
      unknownIntentLabel: 'not_recognized',
      taxonomy: [{ name: 'billing', description: 'Billing questions' }],
    };
    const result = parseAndValidateConfig('intent_classification', input);
    expect(result).toHaveProperty('confidenceThreshold', 0.8);
    expect(result).toHaveProperty('unknownIntentLabel', 'not_recognized');
    expect((result as any).taxonomy).toHaveLength(1);
    // Defaults still applied for unspecified fields
    expect(result).toHaveProperty('inputMessageCount', 3);
  });

  test('rejects invalid config for quality_evaluation', () => {
    expect(() => parseAndValidateConfig('quality_evaluation', { flagThreshold: 10 })).toThrow();
  });

  test('normalizes quality dimensions with string scale and weight values', () => {
    const result = parseAndValidateConfig('quality_evaluation', {
      dimensions: [
        {
          name: 'empathy',
          displayName: 'Empathy',
          description: 'Did the agent show empathy?',
          scale: '5',
          weight: '0.5',
        },
        {
          name: 'resolution_speed',
          displayName: 'Resolution Speed',
          description: 'How quickly did the agent resolve the request?',
          scale: '1-10',
          weight: 1,
        },
      ],
    });

    expect((result as any).dimensions).toEqual([
      {
        name: 'empathy',
        displayName: 'Empathy',
        description: 'Did the agent show empathy?',
        scale: { min: 1, max: 5 },
        weight: 0.5,
      },
      {
        name: 'resolution_speed',
        displayName: 'Resolution Speed',
        description: 'How quickly did the agent resolve the request?',
        scale: { min: 1, max: 10 },
        weight: 1,
      },
    ]);
  });

  test('passes through unknown pipeline types without validation', () => {
    const raw = { anyField: 'anyValue' };
    const result = parseAndValidateConfig('unknown_type', raw);
    expect(result).toEqual(raw);
  });

  test('round-trips correctly — parse then validate again', () => {
    const first = parseAndValidateConfig('sentiment_analysis', { shiftThreshold: 0.5 });
    const second = parseAndValidateConfig('sentiment_analysis', first);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// Anomaly / Drift — metric source allowlist validation
// ---------------------------------------------------------------------------

describe('AnomalyConfigSchema — metric source validation', () => {
  test('blank input falls back to the anomaly pipeline defaults', () => {
    const result = parseAndValidateConfig('anomaly_detection', {}) as Record<string, unknown>;
    expect(result.metricTable).toBe('abl_platform.conversation_sentiment');
    expect(result.metricColumn).toBe('avg_sentiment');
    expect(result.lookbackDays).toBe(30);
  });

  test('empty strings fall back to the anomaly pipeline defaults', () => {
    // Regression guard for the old emptyToUndefined preprocess bug — clearing
    // the inputs in the UI must not bypass the allowlist; we resolve to the
    // pipeline defaults instead.
    const result = parseAndValidateConfig('anomaly_detection', {
      metricTable: '',
      metricColumn: '',
    }) as Record<string, unknown>;
    expect(result.metricTable).toBe('abl_platform.conversation_sentiment');
    expect(result.metricColumn).toBe('avg_sentiment');
  });

  test('accepts an allowlisted (table, column) pair', () => {
    const result = parseAndValidateConfig('anomaly_detection', {
      metricTable: 'abl_platform.quality_evaluations',
      metricColumn: 'overall_score',
    }) as Record<string, unknown>;
    expect(result.metricTable).toBe('abl_platform.quality_evaluations');
    expect(result.metricColumn).toBe('overall_score');
  });

  test('rejects an unknown metric table', () => {
    expect(() =>
      parseAndValidateConfig('anomaly_detection', {
        metricTable: 'abl_platform.does_not_exist',
        metricColumn: 'avg_sentiment',
      }),
    ).toThrow();
  });

  test('rejects a column that exists but not on the selected table', () => {
    // overall_score is a real column on quality_evaluations, but not on
    // conversation_sentiment — saving this pair must fail validation rather
    // than silently writing a config that the AD query will never resolve.
    expect(() =>
      parseAndValidateConfig('anomaly_detection', {
        metricTable: 'abl_platform.conversation_sentiment',
        metricColumn: 'overall_score',
      }),
    ).toThrow();
  });
});

describe('DriftConfigSchema — metric source validation', () => {
  test('blank input falls back to the drift pipeline defaults', () => {
    const result = parseAndValidateConfig('drift_detection', {}) as Record<string, unknown>;
    expect(result.metricTable).toBe('abl_platform.quality_evaluations');
    expect(result.metricColumn).toBe('overall_score');
    expect(result.lookbackDays).toBe(60);
  });

  test('accepts an allowlisted (table, column) pair', () => {
    const result = parseAndValidateConfig('drift_detection', {
      metricTable: 'abl_platform.intent_classifications',
      metricColumn: 'confidence',
    }) as Record<string, unknown>;
    expect(result.metricTable).toBe('abl_platform.intent_classifications');
    expect(result.metricColumn).toBe('confidence');
  });

  test('rejects a stale column from a previous schema version', () => {
    expect(() =>
      parseAndValidateConfig('drift_detection', {
        metricTable: 'abl_platform.quality_evaluations',
        metricColumn: 'nonexistent_metric',
      }),
    ).toThrow();
  });
});
