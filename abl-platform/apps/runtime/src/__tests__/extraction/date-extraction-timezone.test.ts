import { describe, expect, it } from 'vitest';
import type { EntityDefinitionIR } from '@abl/compiler';
import { extractWithJSLibs } from '../../services/execution/js-extraction.js';
import {
  normalizeDate,
  validateExtractedBatch,
} from '../../services/execution/extraction-validation.js';
import { extractEntityObservations } from '../../services/execution/entity-pipeline.js';

const INDIA_REFERENCE = new Date('2026-04-15T12:00:00.000Z');

describe('runtime date extraction timezone propagation', () => {
  it('normalizeDate forwards locale-aware options to the shared date helper', () => {
    const result = normalizeDate('mañana', {
      locale: 'es',
      referenceInstant: new Date('2026-04-15T12:00:00.000Z'),
      timezone: 'America/Mexico_City',
    });

    expect(result).toBe('2026-04-16');
  });

  it('validateExtractedBatch normalizes relative dates with explicit reference options', () => {
    const result = validateExtractedBatch(
      [{ name: 'departure', type: 'date' }],
      { departure: 'a week from tomorrow' },
      {
        locale: 'en',
        referenceInstant: INDIA_REFERENCE,
        timezone: 'Asia/Kolkata',
      },
    );

    expect(result.invalid).toEqual({});
    expect(result.valid.departure).toBe('2026-04-23');
  });

  it('extractWithJSLibs uses the same reference instant and timezone for Tier 1 date extraction', () => {
    const result = extractWithJSLibs(
      'a week from tomorrow',
      [{ name: 'departure', type: 'date' }],
      'en',
      {
        referenceInstant: INDIA_REFERENCE,
        timezone: 'Asia/Kolkata',
      },
    );

    expect(result.departure).toBe('2026-04-23');
  });

  it('entity observations inherit the same timezone-aware date context', () => {
    const entities: EntityDefinitionIR[] = [
      {
        name: 'departure',
        type: 'date',
        source: 'explicit',
      },
    ];

    const observations = extractEntityObservations('a week from tomorrow', entities, 'en', 1, {
      referenceInstant: INDIA_REFERENCE,
      timezone: 'Asia/Kolkata',
    });

    expect(observations.entities.departure?.[0]?.value).toBe('2026-04-23');
  });

  it('date-only normalization changes with the target timezone, not the host timezone', () => {
    const referenceInstant = new Date('2026-04-15T23:30:00.000Z');

    const losAngeles = normalizeDate('today', {
      locale: 'en',
      referenceInstant,
      timezone: 'America/Los_Angeles',
    });
    const kolkata = normalizeDate('today', {
      locale: 'en',
      referenceInstant,
      timezone: 'Asia/Kolkata',
    });

    expect(losAngeles).toBe('2026-04-15');
    expect(kolkata).toBe('2026-04-16');
  });
});
