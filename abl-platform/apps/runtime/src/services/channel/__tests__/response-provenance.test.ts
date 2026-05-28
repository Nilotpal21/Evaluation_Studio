import { describe, expect, test } from 'vitest';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
  extractLlmTraceMetrics,
} from '../response-provenance.js';

describe('response-provenance', () => {
  test('extractLlmTraceMetrics reads flat token fields', () => {
    expect(
      extractLlmTraceMetrics({
        tokensIn: 11,
        tokensOut: 22,
        cost: 0.003,
        model: 'gpt-4o-mini',
        provider: 'openai',
      }),
    ).toEqual({
      tokensIn: 11,
      tokensOut: 22,
      cost: 0.003,
      model: 'gpt-4o-mini',
      provider: 'openai',
    });
  });

  test('extractLlmTraceMetrics falls back to nested usage fields', () => {
    expect(
      extractLlmTraceMetrics({
        usage: { inputTokens: 7, outputTokens: 9 },
        cost: 0.001,
      }),
    ).toEqual({
      tokensIn: 7,
      tokensOut: 9,
      cost: 0.001,
    });
  });

  test('marks scripted responses false when no llm calls occurred', () => {
    const metadata = buildResponseMessageMetadata(createResponseProvenanceAccumulator());

    expect(metadata).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: false,
      },
    });
  });

  test('marks internal-only llm activity as scripted but internally assisted', () => {
    const accumulator = createResponseProvenanceAccumulator();

    accumulateResponseProvenance(accumulator, {
      type: 'llm_call',
      data: {
        purpose: 'field_validation',
        responseContribution: 'internal_only',
        tokensIn: 5,
        tokensOut: 3,
      },
    });

    expect(buildResponseMessageMetadata(accumulator)).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: true,
      },
    });
  });

  test('marks customer-visible llm activity as llm-generated', () => {
    const accumulator = createResponseProvenanceAccumulator();

    accumulateResponseProvenance(accumulator, {
      type: 'llm_call',
      data: {
        operationType: 'response_gen',
        responseContribution: 'customer_visible',
        tokensIn: 5,
        tokensOut: 3,
      },
    });

    expect(buildResponseMessageMetadata(accumulator)).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
  });

  test('marks turns with both visible and internal llm work as mixed', () => {
    const accumulator = createResponseProvenanceAccumulator();

    accumulateResponseProvenance(accumulator, {
      type: 'llm_call',
      data: {
        operationType: 'response_gen',
        responseContribution: 'customer_visible',
      },
    });
    accumulateResponseProvenance(accumulator, {
      type: 'llm_call',
      data: {
        operationType: 'kb_classify',
        responseContribution: 'internal_only',
      },
    });

    expect(buildResponseMessageMetadata(accumulator)).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'mixed',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
  });

  test('ignores simulated fallback llm traces for compliance provenance', () => {
    const accumulator = createResponseProvenanceAccumulator();

    accumulateResponseProvenance(accumulator, {
      type: 'llm_call',
      data: {
        model: 'fallback (no API key)',
        simulated: true,
        tokensIn: 5,
        tokensOut: 3,
      },
    });

    expect(buildResponseMessageMetadata(accumulator)).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: false,
      },
    });
  });
});
