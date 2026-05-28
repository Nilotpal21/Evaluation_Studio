import { describe, it, expect } from 'vitest';
import {
  shouldAttemptInference,
  buildInferencePrompt,
  parseInferenceResponse,
  applyInferences,
  type InferableField,
} from '../services/execution/field-inference.js';
import { prepareInferableFields } from '../services/execution/flow-step-executor.js';

describe('prepareInferableFields', () => {
  it('selects only missing inferable fields', () => {
    const fields = [
      { name: 'destination', type: 'string', infer: false },
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
      { name: 'guests', type: 'number', infer: true },
    ];
    const collected = { destination: 'Paris', guests: 2 };
    const result = prepareInferableFields(fields, collected, 10);
    // destination: infer=false, skip
    // hotel_class: infer=true, not collected, eligible
    // room_type: infer=true, not collected, eligible
    // guests: infer=true, already collected, skip
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.name)).toEqual(['hotel_class', 'room_type']);
  });

  it('respects maxFieldsPerPass', () => {
    const fields = [
      { name: 'field1', type: 'string', infer: true },
      { name: 'field2', type: 'string', infer: true },
      { name: 'field3', type: 'string', infer: true },
      { name: 'field4', type: 'string', infer: true },
    ];
    const result = prepareInferableFields(fields, {}, 3);
    expect(result).toHaveLength(3);
    expect(result.map((f) => f.name)).toEqual(['field1', 'field2', 'field3']);
  });

  it('returns empty array when no fields are inferable', () => {
    const fields = [
      { name: 'name', type: 'string', infer: false },
      { name: 'email', type: 'string' },
    ];
    const result = prepareInferableFields(fields, {}, 10);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when all inferable fields are already collected', () => {
    const fields = [
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
    ];
    const collected = { hotel_class: 'standard', room_type: 'double' };
    const result = prepareInferableFields(fields, collected, 10);
    expect(result).toHaveLength(0);
  });

  it('preserves validation metadata on returned fields', () => {
    const fields = [
      {
        name: 'hotel_class',
        type: 'string',
        infer: true,
        infer_confidence: 0.9,
        infer_confirm: false,
        validation: {
          type: 'enum',
          rule: 'budget|standard|premium|luxury',
          error_message: 'Invalid class',
        },
      },
    ];
    const result = prepareInferableFields(fields, {}, 10);
    expect(result).toHaveLength(1);
    expect(result[0].validation?.rule).toBe('budget|standard|premium|luxury');
    expect(result[0].infer_confidence).toBe(0.9);
    expect(result[0].infer_confirm).toBe(false);
  });

  it('skips fields with null collected values', () => {
    const fields = [{ name: 'hotel_class', type: 'string', infer: true }];
    // null explicitly set means "not yet collected" per shouldAttemptInference
    const collected = { hotel_class: null };
    const result = prepareInferableFields(fields, collected, 10);
    expect(result).toHaveLength(1);
  });
});

describe('buildInferencePrompt', () => {
  it('builds prompt with correct context', () => {
    const fields: InferableField[] = [
      {
        name: 'hotel_class',
        type: 'string',
        infer: true,
        validation: {
          type: 'enum',
          rule: 'budget|standard|premium|luxury',
          error_message: '',
        },
      },
    ];
    const context = { destination: 'Paris', guests: 2 };
    const prompt = buildInferencePrompt(fields, context);
    expect(prompt).toContain('Paris');
    expect(prompt).toContain('hotel_class');
    expect(prompt).toContain('budget|standard|premium|luxury');
    expect(prompt).toContain('guests');
  });

  it('includes multiple fields in prompt', () => {
    const fields: InferableField[] = [
      { name: 'hotel_class', type: 'string', infer: true },
      { name: 'room_type', type: 'string', infer: true },
    ];
    const prompt = buildInferencePrompt(fields, { city: 'London' });
    expect(prompt).toContain('hotel_class');
    expect(prompt).toContain('room_type');
    expect(prompt).toContain('London');
  });
});

describe('parseInferenceResponse', () => {
  it('accepts inferences above confidence threshold', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'hotel_class',
            value: 'standard',
            confidence: 0.85,
            reasoning: 'Default for mid-range budget',
          },
        ],
      },
      0.8,
    );
    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].value).toBe('standard');
  });

  it('rejects inferences below confidence threshold', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'room_type',
            value: 'suite',
            confidence: 0.5,
            reasoning: 'Unsure',
          },
        ],
      },
      0.8,
    );
    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(false);
  });

  it('handles null/invalid response gracefully', () => {
    expect(parseInferenceResponse(null, 0.8)).toEqual([]);
    expect(parseInferenceResponse('invalid', 0.8)).toEqual([]);
    expect(parseInferenceResponse({}, 0.8)).toEqual([]);
    expect(parseInferenceResponse({ inferences: 'not-array' }, 0.8)).toEqual([]);
  });
});

describe('applyInferences', () => {
  it('applies accepted inferences to values', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'hotel_class',
            value: 'standard',
            confidence: 0.85,
            reasoning: 'Default',
          },
          {
            field: 'room_type',
            value: 'suite',
            confidence: 0.5,
            reasoning: 'Unsure',
          },
        ],
      },
      0.8,
    );
    const values: Record<string, unknown> = { destination: 'Paris' };
    const { applied, confirmationMessage } = applyInferences(results, values, true);
    expect(applied).toEqual({ hotel_class: 'standard' });
    expect(values._inferred).toBeDefined();
    const inferred = values._inferred as Record<string, { confidence: number; reasoning: string }>;
    expect(inferred.hotel_class).toBeDefined();
    expect(inferred.hotel_class.confidence).toBe(0.85);
    expect(confirmationMessage).toContain('hotel class');
  });

  it('skips confirmation when confirm=false', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'hotel_class',
            value: 'standard',
            confidence: 0.9,
            reasoning: 'Default',
          },
        ],
      },
      0.8,
    );
    const values: Record<string, unknown> = {};
    const { confirmationMessage } = applyInferences(results, values, false);
    expect(confirmationMessage).toBeNull();
  });

  it('returns empty applied when no inferences accepted', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'hotel_class',
            value: 'standard',
            confidence: 0.3,
            reasoning: 'Wild guess',
          },
        ],
      },
      0.8,
    );
    const values: Record<string, unknown> = {};
    const { applied, confirmationMessage } = applyInferences(results, values, true);
    expect(Object.keys(applied)).toHaveLength(0);
    expect(confirmationMessage).toBeNull();
  });

  it('merges with existing _inferred metadata', () => {
    const results = parseInferenceResponse(
      {
        inferences: [
          {
            field: 'room_type',
            value: 'double',
            confidence: 0.95,
            reasoning: 'Couple travel',
          },
        ],
      },
      0.8,
    );
    const values: Record<string, unknown> = {
      _inferred: { hotel_class: { confidence: 0.85, reasoning: 'Previous' } },
    };
    applyInferences(results, values, false);
    const inferred = values._inferred as Record<string, { confidence: number; reasoning: string }>;
    expect(inferred.hotel_class).toBeDefined();
    expect(inferred.room_type).toBeDefined();
    expect(inferred.room_type.confidence).toBe(0.95);
  });
});

describe('shouldAttemptInference standalone', () => {
  it('returns true for inferable uncollected field', () => {
    expect(shouldAttemptInference({ name: 'hotel_class', type: 'string', infer: true }, {})).toBe(
      true,
    );
  });

  it('returns false for non-inferable field', () => {
    expect(shouldAttemptInference({ name: 'hotel_class', type: 'string', infer: false }, {})).toBe(
      false,
    );
  });

  it('returns false for already collected field', () => {
    expect(
      shouldAttemptInference(
        { name: 'hotel_class', type: 'string', infer: true },
        { hotel_class: 'premium' },
      ),
    ).toBe(false);
  });

  it('returns true when collected value is null', () => {
    expect(
      shouldAttemptInference(
        { name: 'hotel_class', type: 'string', infer: true },
        { hotel_class: null },
      ),
    ).toBe(true);
  });
});
