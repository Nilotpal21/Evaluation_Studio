import { describe, expect, it } from 'vitest';
import { extractDatesFromText } from '../../platform/utils/date-extraction.js';

const INDIA_REFERENCE = new Date('2026-04-15T12:00:00.000Z');

describe('extractDatesFromText timezone-aware reference handling', () => {
  it('anchors today and tomorrow using the provided reference instant and timezone', () => {
    const today = extractDatesFromText('today', 'en', {
      referenceInstant: INDIA_REFERENCE,
      timezone: 'Asia/Kolkata',
    });
    const tomorrow = extractDatesFromText('tomorrow', 'en', {
      referenceInstant: INDIA_REFERENCE,
      timezone: 'Asia/Kolkata',
    });

    expect(today[0]?.value).toBe('2026-04-15');
    expect(tomorrow[0]?.value).toBe('2026-04-16');
  });

  it('handles "a week from tomorrow" as a deterministic relative date', () => {
    const result = extractDatesFromText('Departure is a week from tomorrow', 'en', {
      referenceInstant: INDIA_REFERENCE,
      timezone: 'Asia/Kolkata',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'a week from tomorrow',
      value: '2026-04-23',
    });
  });

  it('formats date-only results using the target timezone instead of the host timezone', () => {
    const referenceInstant = new Date('2026-04-15T23:30:00.000Z');

    const losAngeles = extractDatesFromText('today', 'en', {
      referenceInstant,
      timezone: 'America/Los_Angeles',
    });
    const kolkata = extractDatesFromText('today', 'en', {
      referenceInstant,
      timezone: 'Asia/Kolkata',
    });

    expect(losAngeles[0]?.value).toBe('2026-04-15');
    expect(kolkata[0]?.value).toBe('2026-04-16');
  });

  it('resolves weekday phrases near timezone boundaries deterministically', () => {
    const result = extractDatesFromText('next Monday', 'en', {
      referenceInstant: INDIA_REFERENCE,
      timezone: 'Asia/Kolkata',
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe('2026-04-20');
  });
});
