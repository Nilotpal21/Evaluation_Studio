import { describe, it, expect } from 'vitest';
import {
  buildInferencePrompt,
  parseInferenceResponse,
  shouldAttemptInference,
  applyInferences,
  getInferableFields,
  DEFAULT_INFERENCE_CONFIG,
  type InferenceConfig,
  type InferableField,
  type InferenceResult,
} from '../../services/execution/field-inference.js';
import type { GatherField } from '@abl/compiler';

describe('shouldAttemptInference', () => {
  it('returns true when field has infer=true and is missing', () => {
    const field: InferableField = {
      name: 'hotel_class',
      type: 'string',
      infer: true,
      infer_confidence: 0.8,
      infer_confirm: true,
      validation: { type: 'enum', rule: 'budget|standard|premium|luxury', error_message: '' },
    };
    const collectedValues = { destination: 'Paris', guests: 2 };

    expect(shouldAttemptInference(field, collectedValues)).toBe(true);
  });

  it('returns false when field has infer=false', () => {
    const field: InferableField = {
      name: 'hotel_class',
      type: 'string',
      infer: false,
    };
    expect(shouldAttemptInference(field, {})).toBe(false);
  });

  it('returns false when field is already collected', () => {
    const field: InferableField = {
      name: 'hotel_class',
      type: 'string',
      infer: true,
    };
    const collectedValues = { hotel_class: 'premium' };

    expect(shouldAttemptInference(field, collectedValues)).toBe(false);
  });

  it('returns false when infer is undefined', () => {
    const field: InferableField = {
      name: 'hotel_class',
      type: 'string',
    };
    expect(shouldAttemptInference(field, {})).toBe(false);
  });

  it('returns true when field value is null in collected values', () => {
    const field: InferableField = {
      name: 'hotel_class',
      type: 'string',
      infer: true,
    };
    const collectedValues = { hotel_class: null };

    expect(shouldAttemptInference(field, collectedValues)).toBe(true);
  });

  it('returns false when field value is 0 (falsy but present)', () => {
    const field: InferableField = {
      name: 'guests',
      type: 'number',
      infer: true,
    };
    const collectedValues = { guests: 0 };

    expect(shouldAttemptInference(field, collectedValues)).toBe(false);
  });

  it('returns false when field value is empty string (present)', () => {
    const field: InferableField = {
      name: 'notes',
      type: 'string',
      infer: true,
    };
    const collectedValues = { notes: '' };

    expect(shouldAttemptInference(field, collectedValues)).toBe(false);
  });
});

describe('buildInferencePrompt', () => {
  it('includes collected context', () => {
    const fields: InferableField[] = [
      {
        name: 'hotel_class',
        type: 'string',
        infer: true,
        validation: { type: 'enum', rule: 'budget|standard|premium|luxury', error_message: '' },
      },
    ];
    const context = { destination: 'Paris', check_in: '2026-03-15', guests: 2 };

    const prompt = buildInferencePrompt(fields, context);

    expect(prompt).toContain('Paris');
    expect(prompt).toContain('hotel_class');
    expect(prompt).toContain('budget|standard|premium|luxury');
  });

  it('handles multiple fields', () => {
    const fields: InferableField[] = [
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
    ];
    const context = { destination: 'Paris' };

    const prompt = buildInferencePrompt(fields, context);

    expect(prompt).toContain('hotel_class');
    expect(prompt).toContain('room_type');
  });

  it('includes field type information', () => {
    const fields: InferableField[] = [{ name: 'adults', type: 'number', infer: true }];
    const context = { destination: 'Paris' };

    const prompt = buildInferencePrompt(fields, context);

    expect(prompt).toContain('(type: number)');
  });

  it('omits validation rule when not present', () => {
    const fields: InferableField[] = [{ name: 'notes', type: 'string', infer: true }];
    const context = { destination: 'Paris' };

    const prompt = buildInferencePrompt(fields, context);

    expect(prompt).toContain('- notes (type: string)');
    expect(prompt).not.toContain('[valid values:');
  });

  it('includes JSON return format instruction', () => {
    const fields: InferableField[] = [{ name: 'hotel_class', type: 'string', infer: true }];

    const prompt = buildInferencePrompt(fields, {});

    expect(prompt).toContain('"inferences"');
    expect(prompt).toContain('"confidence"');
  });
});

describe('parseInferenceResponse', () => {
  it('parses valid inference with confidence', () => {
    const response = {
      inferences: [
        {
          field: 'hotel_class',
          value: 'standard',
          confidence: 0.85,
          reasoning: 'Default for leisure',
        },
      ],
    };

    const result = parseInferenceResponse(response, 0.8);

    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('hotel_class');
    expect(result[0].value).toBe('standard');
    expect(result[0].accepted).toBe(true);
  });

  it('rejects inference below confidence threshold', () => {
    const response = {
      inferences: [{ field: 'hotel_class', value: 'luxury', confidence: 0.5, reasoning: 'Unsure' }],
    };

    const result = parseInferenceResponse(response, 0.8);

    expect(result).toHaveLength(1);
    expect(result[0].accepted).toBe(false);
  });

  it('handles empty inferences', () => {
    const result = parseInferenceResponse({ inferences: [] }, 0.8);
    expect(result).toHaveLength(0);
  });

  it('handles null response', () => {
    const result = parseInferenceResponse(null, 0.8);
    expect(result).toHaveLength(0);
  });

  it('handles undefined response', () => {
    const result = parseInferenceResponse(undefined, 0.8);
    expect(result).toHaveLength(0);
  });

  it('handles response without inferences key', () => {
    const result = parseInferenceResponse({ other: 'data' }, 0.8);
    expect(result).toHaveLength(0);
  });

  it('accepts inference at exact threshold', () => {
    const response = {
      inferences: [
        { field: 'hotel_class', value: 'standard', confidence: 0.8, reasoning: 'Exact threshold' },
      ],
    };

    const result = parseInferenceResponse(response, 0.8);

    expect(result).toHaveLength(1);
    expect(result[0].accepted).toBe(true);
  });

  it('handles multiple inferences with mixed acceptance', () => {
    const response = {
      inferences: [
        { field: 'hotel_class', value: 'standard', confidence: 0.9, reasoning: 'High confidence' },
        { field: 'room_type', value: 'suite', confidence: 0.3, reasoning: 'Low confidence' },
      ],
    };

    const result = parseInferenceResponse(response, 0.8);

    expect(result).toHaveLength(2);
    expect(result[0].accepted).toBe(true);
    expect(result[1].accepted).toBe(false);
  });

  it('defaults reasoning to empty string when missing', () => {
    const response = {
      inferences: [{ field: 'hotel_class', value: 'standard', confidence: 0.9 }],
    };

    const result = parseInferenceResponse(response, 0.8);

    expect(result).toHaveLength(1);
    expect(result[0].reasoning).toBe('');
  });

  it('handles non-object response', () => {
    expect(parseInferenceResponse('not an object', 0.8)).toHaveLength(0);
    expect(parseInferenceResponse(42, 0.8)).toHaveLength(0);
    expect(parseInferenceResponse(true, 0.8)).toHaveLength(0);
  });
});

describe('applyInferences', () => {
  it('applies accepted inferences and marks them as inferred', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'standard',
        confidence: 0.9,
        reasoning: 'Default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = { destination: 'Paris' };

    const { applied, confirmationMessage } = applyInferences(results, values, true);

    expect(applied).toEqual({ hotel_class: 'standard' });
    expect(confirmationMessage).toContain('hotel class');
    expect(confirmationMessage).toContain('standard');
    expect(values._inferred).toBeDefined();
    const inferred = values._inferred as Record<string, { confidence: number; reasoning: string }>;
    expect(inferred.hotel_class.confidence).toBe(0.9);
  });

  it('skips rejected inferences', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'luxury',
        confidence: 0.5,
        reasoning: 'Unsure',
        accepted: false,
      },
    ];
    const values: Record<string, unknown> = {};

    const { applied, confirmationMessage } = applyInferences(results, values, true);

    expect(applied).toEqual({});
    expect(confirmationMessage).toBeNull();
  });

  it('skips confirmation when confirm=false', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'standard',
        confidence: 0.9,
        reasoning: 'Default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};

    const { applied, confirmationMessage } = applyInferences(results, values, false);

    expect(applied).toEqual({ hotel_class: 'standard' });
    expect(confirmationMessage).toBeNull();
  });

  it('merges with existing _inferred metadata', () => {
    const results: InferenceResult[] = [
      {
        field: 'room_type',
        value: 'double',
        confidence: 0.85,
        reasoning: 'Two guests',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {
      _inferred: { hotel_class: { confidence: 0.9, reasoning: 'Default' } },
    };

    applyInferences(results, values, false);

    const inferred = values._inferred as Record<string, { confidence: number; reasoning: string }>;
    expect(inferred.hotel_class).toBeDefined();
    expect(inferred.room_type).toBeDefined();
    expect(inferred.room_type.confidence).toBe(0.85);
  });

  it('handles multiple accepted inferences', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'standard',
        confidence: 0.9,
        reasoning: 'Default',
        accepted: true,
      },
      {
        field: 'room_type',
        value: 'double',
        confidence: 0.85,
        reasoning: 'Two guests',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};

    const { applied, confirmationMessage } = applyInferences(results, values, true);

    expect(Object.keys(applied)).toHaveLength(2);
    expect(confirmationMessage).toContain('hotel class');
    expect(confirmationMessage).toContain('room type');
  });

  it('handles empty results array', () => {
    const values: Record<string, unknown> = {};
    const { applied, confirmationMessage } = applyInferences([], values, true);

    expect(applied).toEqual({});
    expect(confirmationMessage).toBeNull();
    expect(values._inferred).toBeUndefined();
  });

  it('masks sensitive field values with redact mode in confirmation', () => {
    const results: InferenceResult[] = [
      {
        field: 'ssn',
        value: '123-45-6789',
        confidence: 0.95,
        reasoning: 'From context',
        accepted: true,
      },
    ];
    const gatherFields: GatherField[] = [
      {
        name: 'ssn',
        prompt: 'SSN?',
        type: 'string',
        required: true,
        sensitive: true,
        sensitive_display: 'redact',
      },
    ];
    const values: Record<string, unknown> = {};

    const { confirmationMessage } = applyInferences(results, values, true, gatherFields);

    expect(confirmationMessage).toContain('[REDACTED]');
    expect(confirmationMessage).not.toContain('123-45-6789');
  });

  it('masks sensitive field values with mask mode in confirmation', () => {
    const results: InferenceResult[] = [
      {
        field: 'card_number',
        value: '4111111111111111',
        confidence: 0.9,
        reasoning: 'Mentioned in context',
        accepted: true,
      },
    ];
    const gatherFields: GatherField[] = [
      {
        name: 'card_number',
        prompt: 'Card?',
        type: 'string',
        required: true,
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 0, show_last: 4, char: '*' },
      },
    ];
    const values: Record<string, unknown> = {};

    const { confirmationMessage } = applyInferences(results, values, true, gatherFields);

    expect(confirmationMessage).toContain('************1111');
    expect(confirmationMessage).not.toContain('4111111111111111');
  });

  it('masks sensitive field values with replace mode in confirmation', () => {
    const results: InferenceResult[] = [
      {
        field: 'api_key',
        value: 'sk-secret123',
        confidence: 0.88,
        reasoning: 'From env',
        accepted: true,
      },
    ];
    const gatherFields: GatherField[] = [
      {
        name: 'api_key',
        prompt: 'Key?',
        type: 'string',
        required: true,
        sensitive: true,
        sensitive_display: 'replace',
      },
    ];
    const values: Record<string, unknown> = {};

    const { confirmationMessage } = applyInferences(results, values, true, gatherFields);

    expect(confirmationMessage).toContain('[API_KEY]');
    expect(confirmationMessage).not.toContain('sk-secret123');
  });

  it('displays non-sensitive fields normally when gatherFields provided', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'premium',
        confidence: 0.9,
        reasoning: 'Default',
        accepted: true,
      },
    ];
    const gatherFields: GatherField[] = [
      { name: 'hotel_class', prompt: 'Class?', type: 'string', required: true },
    ];
    const values: Record<string, unknown> = {};

    const { confirmationMessage } = applyInferences(results, values, true, gatherFields);

    expect(confirmationMessage).toContain('"premium"');
  });

  it('backward compatible without gatherFields parameter', () => {
    const results: InferenceResult[] = [
      {
        field: 'hotel_class',
        value: 'standard',
        confidence: 0.9,
        reasoning: 'Default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};

    const { confirmationMessage } = applyInferences(results, values, true);

    expect(confirmationMessage).toContain('"standard"');
  });
});

describe('getInferableFields', () => {
  it('filters to only inferable missing fields', () => {
    const gatherFields = [
      { name: 'destination', type: 'string' },
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
      { name: 'guests', type: 'number' },
    ];
    const collectedValues = { destination: 'Paris', guests: 2 };

    const result = getInferableFields(gatherFields, collectedValues, 3);

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.name)).toEqual(['hotel_class', 'room_type']);
  });

  it('respects maxFields limit', () => {
    const gatherFields = [
      { name: 'field1', type: 'string', infer: true },
      { name: 'field2', type: 'string', infer: true },
      { name: 'field3', type: 'string', infer: true },
    ];

    const result = getInferableFields(gatherFields, {}, 2);

    expect(result).toHaveLength(2);
  });

  it('excludes already collected fields', () => {
    const gatherFields = [
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
    ];
    const collectedValues = { hotel_class: 'premium' };

    const result = getInferableFields(gatherFields, collectedValues, 3);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('room_type');
  });

  it('returns empty array when no fields are inferable', () => {
    const gatherFields = [
      { name: 'destination', type: 'string' },
      { name: 'guests', type: 'number' },
    ];

    const result = getInferableFields(gatherFields, {}, 3);

    expect(result).toHaveLength(0);
  });

  it('defaults field type to string when not specified', () => {
    const gatherFields = [{ name: 'hotel_class', infer: true }];

    const result = getInferableFields(gatherFields, {}, 3);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('string');
  });
});

describe('DEFAULT_INFERENCE_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_INFERENCE_CONFIG.confidence).toBe(0.8);
    expect(DEFAULT_INFERENCE_CONFIG.confirm).toBe(true);
    expect(DEFAULT_INFERENCE_CONFIG.model_tier).toBe('fast');
    expect(DEFAULT_INFERENCE_CONFIG.max_fields_per_pass).toBe(3);
  });
});
