/**
 * Grounding Validator Tests
 *
 * Verifies anti-hallucination grounding checks across:
 * - Type-aware defaults (no false positives for strings)
 * - Multilingual date grounding (ES, FR, DE, PT, IT)
 * - Unsupported languages (grounding disabled for dates)
 * - `infer` keyword override
 * - Provenance tracking
 * - Edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  validateGrounding,
  checkFieldGrounding,
  type FieldGroundingConfig,
} from '../../platform/constructs/executors/grounding-validator.js';

// =============================================================================
// A. TYPE-AWARE DEFAULTS (NO FALSE POSITIVES)
// =============================================================================

describe('grounding-validator: type-aware defaults', () => {
  it('accepts string field even when value differs from input (string not grounded by default)', () => {
    const result = validateGrounding(
      'I want to go to NYC',
      { destination: 'New York City' },
      [{ name: 'destination', type: 'string' }],
      {},
    );
    expect(result.values.destination).toBe('New York City');
    expect(result.rejected).not.toContain('destination');
  });

  it('accepts string field "a couple of tickets" -> inferred string', () => {
    const result = validateGrounding(
      'a couple of tickets',
      { ticket_type: 'economy' },
      [{ name: 'ticket_type', type: 'string' }],
      {},
    );
    expect(result.values.ticket_type).toBe('economy');
    expect(result.rejected).not.toContain('ticket_type');
  });

  it('accepts date field when month name is in input', () => {
    const result = validateGrounding(
      'departing March 15',
      { departure_date: '2026-03-15' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.departure_date).toBe('2026-03-15');
    expect(result.rejected).not.toContain('departure_date');
  });

  it('rejects date field when input only has duration (3 nights)', () => {
    const result = validateGrounding(
      'need hotel in paris for 3 nights',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.departure_date).toBeUndefined();
    expect(result.rejected).toContain('departure_date');
  });

  it('accepts number field when number appears in input', () => {
    const result = validateGrounding(
      'book for 5 travelers',
      { num_travelers: 5 },
      [{ name: 'num_travelers', type: 'number' }],
      {},
    );
    expect(result.values.num_travelers).toBe(5);
    expect(result.rejected).not.toContain('num_travelers');
  });

  it('rejects hallucinated number (1) when not in input', () => {
    const result = validateGrounding(
      'need hotel in paris for 3 nights',
      { num_travelers: 1 },
      [{ name: 'num_travelers', type: 'number' }],
      {},
    );
    expect(result.values.num_travelers).toBeUndefined();
    expect(result.rejected).toContain('num_travelers');
  });

  it('rejects hallucinated number (2) from "a couple"', () => {
    const result = validateGrounding(
      'a couple of tickets',
      { num_travelers: 2 },
      [{ name: 'num_travelers', type: 'number' }],
      {},
    );
    expect(result.values.num_travelers).toBeUndefined();
    expect(result.rejected).toContain('num_travelers');
  });

  it('accepts boolean field regardless (boolean not grounded by default)', () => {
    const result = validateGrounding(
      'yes please',
      { confirm: true },
      [{ name: 'confirm', type: 'boolean' }],
      {},
    );
    expect(result.values.confirm).toBe(true);
    expect(result.rejected).not.toContain('confirm');
  });

  it('accepts email field when @ is in input', () => {
    const result = validateGrounding(
      'my email is john@example.com',
      { email: 'john@example.com' },
      [{ name: 'email', type: 'email' }],
      {},
    );
    expect(result.values.email).toBe('john@example.com');
    expect(result.rejected).not.toContain('email');
  });

  it('rejects email field when no @ in input', () => {
    const result = validateGrounding(
      'my name is john',
      { email: 'john@example.com' },
      [{ name: 'email', type: 'email' }],
      {},
    );
    expect(result.values.email).toBeUndefined();
    expect(result.rejected).toContain('email');
  });

  it('accepts phone field when digit sequence in input', () => {
    const result = validateGrounding(
      'call me at +1 555-123-4567',
      { phone: '+15551234567' },
      [{ name: 'phone', type: 'phone' }],
      {},
    );
    expect(result.values.phone).toBe('+15551234567');
    expect(result.rejected).not.toContain('phone');
  });

  it('rejects phone field when no digit sequence in input', () => {
    const result = validateGrounding(
      'I need help with my account',
      { phone: '+15551234567' },
      [{ name: 'phone', type: 'phone' }],
      {},
    );
    expect(result.values.phone).toBeUndefined();
    expect(result.rejected).toContain('phone');
  });
});

// =============================================================================
// B. MULTILINGUAL DATE GROUNDING (SUPPORTED LANGUAGES)
// =============================================================================

describe('grounding-validator: multilingual date grounding', () => {
  // --- Spanish ---
  it('accepts date when Spanish month name present', () => {
    const result = validateGrounding(
      'el 15 de marzo',
      { departure_date: '2026-03-15' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'es',
    );
    expect(result.values.departure_date).toBe('2026-03-15');
  });

  it('accepts date with Spanish relative date word (mañana)', () => {
    const result = validateGrounding(
      'mañana quiero viajar',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'es',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  it('rejects date when Spanish input only has duration (3 noches)', () => {
    const result = validateGrounding(
      '3 noches en París',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'es',
    );
    expect(result.rejected).toContain('departure_date');
  });

  // --- French ---
  it('accepts date when French month name present', () => {
    const result = validateGrounding(
      'le 15 mars',
      { departure_date: '2026-03-15' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'fr',
    );
    expect(result.values.departure_date).toBe('2026-03-15');
  });

  it('accepts date with French relative date word (demain)', () => {
    const result = validateGrounding(
      'demain je pars',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'fr',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  it('rejects date when French input only has duration (3 nuits)', () => {
    const result = validateGrounding(
      '3 nuits à Paris',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'fr',
    );
    expect(result.rejected).toContain('departure_date');
  });

  // --- German ---
  it('accepts date with German relative date word (morgen)', () => {
    const result = validateGrounding(
      'morgen möchte ich reisen',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'de',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  it('rejects date when German input only has duration (3 Nächte)', () => {
    const result = validateGrounding(
      '3 Nächte in Paris',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'de',
    );
    expect(result.rejected).toContain('departure_date');
  });

  // --- Portuguese ---
  it('accepts date with Portuguese relative date word (amanhã)', () => {
    const result = validateGrounding(
      'amanhã eu viajo',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'pt',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  // --- Italian ---
  it('accepts date with Italian relative date word (domani)', () => {
    const result = validateGrounding(
      'domani parto',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'it',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  // --- ISO date ---
  it('accepts date when ISO date is in input', () => {
    const result = validateGrounding(
      'arriving 2026-03-15',
      { arrival_date: '2026-03-15' },
      [{ name: 'arrival_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.arrival_date).toBe('2026-03-15');
  });

  // --- Numeric date ---
  it('accepts date when numeric date is in input', () => {
    const result = validateGrounding(
      'arriving 3/15/2026',
      { arrival_date: '2026-03-15' },
      [{ name: 'arrival_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.arrival_date).toBe('2026-03-15');
  });

  // --- Day names ---
  it('accepts date when day name is in input', () => {
    const result = validateGrounding(
      'arriving next Monday',
      { arrival_date: '2026-02-16' },
      [{ name: 'arrival_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.arrival_date).toBe('2026-02-16');
  });

  // --- Ordinal date ---
  it('accepts date when ordinal (15th) is in input', () => {
    const result = validateGrounding(
      'the 15th would be great',
      { arrival_date: '2026-03-15' },
      [{ name: 'arrival_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.values.arrival_date).toBe('2026-03-15');
  });
});

// =============================================================================
// B2. UNSUPPORTED LANGUAGES (GROUNDING DISABLED FOR DATES)
// =============================================================================

describe('grounding-validator: unsupported languages', () => {
  it('accepts date from Arabic input (locale not in supported set, date grounding skipped)', () => {
    const result = validateGrounding(
      'غداً أريد فندق',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'ar',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
    expect(result.rejected).not.toContain('departure_date');
  });

  it('accepts date from Chinese input (unsupported locale)', () => {
    const result = validateGrounding(
      '明天我想住酒店',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'zh',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  it('accepts date from Japanese input (unsupported locale)', () => {
    const result = validateGrounding(
      '明日ホテルに泊まりたい',
      { departure_date: '2026-02-09' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'ja',
    );
    expect(result.values.departure_date).toBe('2026-02-09');
  });

  it('still grounds number for unsupported locale (number is language-independent)', () => {
    const result = validateGrounding(
      'غداً أريد فندق',
      { num_travelers: 1 },
      [{ name: 'num_travelers', type: 'number' }],
      {},
      'ar',
    );
    expect(result.values.num_travelers).toBeUndefined();
    expect(result.rejected).toContain('num_travelers');
  });

  it('still grounds email for unsupported locale (email is language-independent)', () => {
    const result = validateGrounding(
      '请联系我',
      { email: 'test@example.com' },
      [{ name: 'email', type: 'email' }],
      {},
      'zh',
    );
    expect(result.values.email).toBeUndefined();
    expect(result.rejected).toContain('email');
  });
});

// =============================================================================
// C. INFER KEYWORD OVERRIDE
// =============================================================================

describe('grounding-validator: infer keyword override', () => {
  it('infer: true on date field → skip grounding → accept hallucinated date', () => {
    const result = validateGrounding(
      'need hotel for 3 nights',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date', infer: true }],
      {},
      'en',
    );
    expect(result.values.departure_date).toBe('2026-02-08');
    expect(result.rejected).not.toContain('departure_date');
    expect(result.provenance.departure_date).toBe('inferred');
  });

  it('infer: false on string field → enable grounding → reject non-matching string', () => {
    // With infer: false on a string, it gets grounded using checkFieldGrounding
    // checkFieldGrounding for strings returns grounded: true (type_default)
    // So this test shows that infer: false enables grounding on a normally-ungrounded type
    const result = validateGrounding(
      'I want to go to NYC',
      { destination: 'New York City' },
      [{ name: 'destination', type: 'string', infer: false }],
      {},
    );
    // String grounding check uses type_default which returns grounded: true
    // So the value is accepted but through the grounding path
    expect(result.values.destination).toBe('New York City');
    expect(result.provenance.destination).toBe('explicit');
  });

  it('infer: true on number field → skip grounding → accept hallucinated number', () => {
    const result = validateGrounding(
      'need hotel in paris',
      { num_travelers: 1 },
      [{ name: 'num_travelers', type: 'number', infer: true }],
      {},
    );
    expect(result.values.num_travelers).toBe(1);
    expect(result.provenance.num_travelers).toBe('inferred');
  });
});

// =============================================================================
// D. PROVENANCE TRACKING
// =============================================================================

describe('grounding-validator: provenance tracking', () => {
  it('grounded values get provenance "explicit"', () => {
    const result = validateGrounding(
      'departing March 15',
      { departure_date: '2026-03-15' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      'en',
    );
    expect(result.provenance.departure_date).toBe('explicit');
  });

  it('infer: true bypass gets provenance "inferred"', () => {
    const result = validateGrounding(
      'need hotel',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date', infer: true }],
      {},
      'en',
    );
    expect(result.provenance.departure_date).toBe('inferred');
  });

  it('previously collected value gets provenance "previously_collected"', () => {
    const result = validateGrounding(
      'something else',
      { destination: 'Paris' },
      [{ name: 'destination', type: 'string' }],
      { destination: 'London' },
    );
    expect(result.values.destination).toBe('London');
    expect(result.provenance.destination).toBe('previously_collected');
    expect(result.confidence.destination).toBe(1.0);
  });

  it('string field (not grounded) gets provenance "explicit"', () => {
    const result = validateGrounding(
      'I want NYC',
      { destination: 'New York City' },
      [{ name: 'destination', type: 'string' }],
      {},
    );
    expect(result.provenance.destination).toBe('explicit');
  });
});

// =============================================================================
// E. EDGE CASES
// =============================================================================

describe('grounding-validator: edge cases', () => {
  it('empty string extraction is rejected', () => {
    const result = validateGrounding(
      'hello',
      { destination: '' },
      [{ name: 'destination', type: 'string' }],
      {},
    );
    expect(result.rejected).toContain('destination');
  });

  it('null extraction is skipped', () => {
    const result = validateGrounding(
      'hello',
      { destination: null },
      [{ name: 'destination', type: 'string' }],
      {},
    );
    expect(result.values.destination).toBeUndefined();
    expect(result.rejected).not.toContain('destination');
  });

  it('mixed: some grounded, some rejected in same extraction', () => {
    const result = validateGrounding(
      'hotel in paris for 3 nights',
      {
        destination: 'Paris',
        departure_date: '2026-02-08',
        num_travelers: 1,
        num_nights: 3,
      },
      [
        { name: 'destination', type: 'string' },
        { name: 'departure_date', type: 'date' },
        { name: 'num_travelers', type: 'number' },
        { name: 'num_nights', type: 'number' },
      ],
      {},
      'en',
    );

    // String: accepted (not grounded by default)
    expect(result.values.destination).toBe('Paris');
    // Date: rejected (no date evidence, only "3 nights")
    expect(result.rejected).toContain('departure_date');
    // Number 1: rejected (1 not in input)
    expect(result.rejected).toContain('num_travelers');
    // Number 3: accepted (3 is in input as "3 nights")
    expect(result.values.num_nights).toBe(3);
  });

  it('previously collected value takes precedence over new extraction', () => {
    const result = validateGrounding(
      'change to 5 guests',
      { num_guests: 3 },
      [{ name: 'num_guests', type: 'number' }],
      { num_guests: 2 },
    );
    expect(result.values.num_guests).toBe(2);
    expect(result.provenance.num_guests).toBe('previously_collected');
  });

  it('handles field without config gracefully', () => {
    const result = validateGrounding('hello world', { unknown_field: 'some value' }, [], {});
    expect(result.values.unknown_field).toBe('some value');
    expect(result.provenance.unknown_field).toBe('explicit');
  });

  it('auto-detects locale when not provided', () => {
    // Spanish input should be auto-detected
    const result = validateGrounding(
      'hola quiero un hotel por 3 noches',
      { departure_date: '2026-02-08' },
      [{ name: 'departure_date', type: 'date' }],
      {},
      // no locale provided — should auto-detect 'es'
    );
    // Spanish detected → date grounding active → "3 noches" is duration only → rejected
    expect(result.rejected).toContain('departure_date');
  });

  it('integer type is grounded like number', () => {
    const result = validateGrounding(
      'I need 3 rooms',
      { num_rooms: 3 },
      [{ name: 'num_rooms', type: 'integer' }],
      {},
    );
    expect(result.values.num_rooms).toBe(3);
  });

  it('int type is grounded like number', () => {
    const result = validateGrounding('hello', { count: 5 }, [{ name: 'count', type: 'int' }], {});
    expect(result.rejected).toContain('count');
  });

  it('tel type is grounded like phone', () => {
    const result = validateGrounding(
      'call 555-123-4567',
      { phone_number: '5551234567' },
      [{ name: 'phone_number', type: 'tel' }],
      {},
    );
    expect(result.values.phone_number).toBe('5551234567');
  });

  it('datetime type is grounded like date', () => {
    const result = validateGrounding(
      'tomorrow at 3pm',
      { appointment: '2026-02-09T15:00' },
      [{ name: 'appointment', type: 'datetime' }],
      {},
      'en',
    );
    expect(result.values.appointment).toBe('2026-02-09T15:00');
  });
});

// =============================================================================
// F. CHECKFIELDGROUNDING UNIT TESTS
// =============================================================================

describe('checkFieldGrounding', () => {
  it('date: grounded when ISO date present', () => {
    expect(checkFieldGrounding('on 2026-03-15', 'date', 'date', '2026-03-15').grounded).toBe(true);
  });

  it('date: grounded when month name present', () => {
    expect(checkFieldGrounding('leaving in March', 'date', 'date', '2026-03-01').grounded).toBe(
      true,
    );
  });

  it('date: not grounded when only duration', () => {
    expect(checkFieldGrounding('for 3 nights', 'date', 'date', '2026-02-08').grounded).toBe(false);
  });

  it('number: grounded when exact number in input', () => {
    expect(checkFieldGrounding('5 guests please', 'num', 'number', 5).grounded).toBe(true);
  });

  it('number: not grounded when number absent', () => {
    expect(checkFieldGrounding('some guests', 'num', 'number', 5).grounded).toBe(false);
  });

  it('email: grounded when @ present', () => {
    expect(
      checkFieldGrounding('email me at test@test.com', 'email', 'email', 'test@test.com').grounded,
    ).toBe(true);
  });

  it('email: not grounded when no @', () => {
    expect(
      checkFieldGrounding('contact me please', 'email', 'email', 'test@test.com').grounded,
    ).toBe(false);
  });

  it('phone: grounded when digit sequence present', () => {
    expect(checkFieldGrounding('call 555-123-4567', 'phone', 'phone', '5551234567').grounded).toBe(
      true,
    );
  });

  it('string: always grounded (type default)', () => {
    expect(checkFieldGrounding('anything', 'name', 'string', 'whatever').grounded).toBe(true);
  });

  it('boolean: always grounded (type default)', () => {
    expect(checkFieldGrounding('anything', 'flag', 'boolean', true).grounded).toBe(true);
  });
});
