/**
 * Unit tests for standalone helper functions exported from flow-step-executor.ts
 *
 * Tests: detectIntent, detectCorrection, checkGatherComplete,
 *        buildGatherPrompt, validateField, evaluateOnInput
 *
 * All functions under test are pure (no I/O, no mocks needed).
 */
import { describe, it, expect } from 'vitest';
import {
  detectIntent,
  detectCorrection,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from '../../services/execution/flow-step-executor.js';

// =============================================================================
// detectIntent
// =============================================================================

describe('detectIntent', () => {
  it('should match explicit KEYWORDS for a semantic intent id', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];
    const result = detectIntent('I want to cancel my order', intents, {});
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should match any KEYWORDS entry in declaration order', () => {
    const intents = [
      { intent: 'help_request', keywords: ['help', 'support', 'assistance'] } as any,
    ];
    const result = detectIntent('I need support please', intents, {});
    expect(result).toEqual({ intent: 'help_request', matched: 'support' });
  });

  it('should be case insensitive for KEYWORDS and user message', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];
    const result = detectIntent('CANCEL THIS NOW', intents, {});
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should trim whitespace from the user message before KEYWORDS matching', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];
    const result = detectIntent('  cancel  ', intents, {});
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should NOT match a KEYWORDS entry as a substring of another word', () => {
    const intents = [{ intent: 'booking_request', keywords: ['book'] } as any];
    const result = detectIntent('I would like to rebook', intents, {});
    expect(result).toBeNull();
  });

  it('should match a KEYWORDS entry at a word boundary', () => {
    const intents = [{ intent: 'booking_request', keywords: ['book'] } as any];
    const result = detectIntent('I would like to book a room', intents, {});
    expect(result).toEqual({ intent: 'booking_request', matched: 'book' });
  });

  it('should match a multi-word KEYWORDS phrase', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel order'] } as any];
    const result = detectIntent('please cancel order', intents, {});
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel order' });
  });

  it('should not match a multi-word KEYWORDS phrase when words are separated', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel order'] } as any];
    const result = detectIntent('cancel my order', intents, {});
    expect(result).toBeNull();
  });

  it('should return null when no KEYWORDS entries match', () => {
    const intents = [
      { intent: 'cancel_request', keywords: ['cancel'] },
      { intent: 'help_request', keywords: ['help'] },
    ] as any;
    const result = detectIntent('where is my order', intents, {});
    expect(result).toBeNull();
  });

  it('should return null for empty intents array', () => {
    const result = detectIntent('cancel', [], {});
    expect(result).toBeNull();
  });

  it('should return null for empty user message', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];
    const result = detectIntent('', intents, {});
    expect(result).toBeNull();
  });

  it('should return null for whitespace-only user message', () => {
    const intents = [{ intent: 'cancel_request', keywords: ['cancel'] } as any];
    const result = detectIntent('   ', intents, {});
    expect(result).toBeNull();
  });

  it('should use declaration order as the tiebreaker within lexical matches', () => {
    const intents = [
      { intent: 'cancel_request', keywords: ['cancel'] },
      { intent: 'refund_request', keywords: ['cancel'] },
    ] as any;
    const result = detectIntent('cancel and refund', intents, {});
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should skip a candidate when its condition evaluates to false', () => {
    const intents = [
      { intent: 'cancel_request', keywords: ['cancel'], condition: 'status == "active"' },
    ] as any;
    const result = detectIntent('cancel', intents, { status: 'closed' });
    expect(result).toBeNull();
  });

  it('should match a candidate when its KEYWORDS entry matches and its condition is true', () => {
    const intents = [
      { intent: 'cancel_request', keywords: ['cancel'], condition: 'status == "active"' },
    ] as any;
    const result = detectIntent('cancel order', intents, { status: 'active' });
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should continue to the next lexical candidate when the first condition fails', () => {
    const intents = [
      { intent: 'premium_cancel_request', keywords: ['cancel'], condition: 'tier == "premium"' },
      { intent: 'cancel_request', keywords: ['cancel'] },
    ] as any;
    const result = detectIntent('cancel my subscription', intents, { tier: 'basic' });
    expect(result).toEqual({ intent: 'cancel_request', matched: 'cancel' });
  });

  it('should not tokenize semantic INTENT ids when KEYWORDS are omitted', () => {
    const intents = [{ intent: 'help support assistance' } as any];
    const result = detectIntent('I need help please', intents, {});
    expect(result).toBeNull();
  });

  it('should treat whitespace-only semantic INTENT ids as non-matchable without KEYWORDS', () => {
    const intents = [{ intent: '   ' } as any];
    const result = detectIntent('anything', intents, {});
    expect(result).toBeNull();
  });
});

// =============================================================================
// detectCorrection
// =============================================================================

describe('detectCorrection', () => {
  // --- default patterns ---
  it('should detect "actually" correction for string field', () => {
    const result = detectCorrection('actually Paris', { destination: 'London' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('destination');
    expect(result!.newValue).toBe('paris');
  });

  it('should detect "actually" with comma', () => {
    const result = detectCorrection('actually, Berlin', { city: 'Munich' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('city');
    expect(result!.newValue).toBe('berlin');
  });

  it('should detect "no, <value>" correction', () => {
    const result = detectCorrection('no, Tokyo', { destination: 'Osaka' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('destination');
    expect(result!.newValue).toBe('tokyo');
  });

  it('should detect "no it\'s" correction', () => {
    const result = detectCorrection("no it's Rome", { city: 'Milan' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('rome');
  });

  it('should detect "I meant" correction', () => {
    const result = detectCorrection('I meant Seattle', { destination: 'Portland' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('seattle');
  });

  it('should detect "change to" correction', () => {
    const result = detectCorrection('change to Miami', { destination: 'Dallas' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('miami');
  });

  it('should detect "change it to" correction', () => {
    const result = detectCorrection('change it to Chicago', { destination: 'NYC' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('chicago');
  });

  it('should detect "make it" correction', () => {
    const result = detectCorrection('make it Boston', { city: 'NYC' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('boston');
  });

  it('should detect "no make it" correction', () => {
    const result = detectCorrection('no make it Denver', { city: 'Seattle' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('denver');
  });

  it('should detect "no change to" correction', () => {
    const result = detectCorrection('no change to Portland', { city: 'Seattle' });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('portland');
  });

  it('should detect numeric correction for number field', () => {
    const result = detectCorrection('actually 5', { guests: 3 });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('guests');
    expect(result!.newValue).toBe('5');
  });

  it('should detect "not X, Y" correction', () => {
    const result = detectCorrection('not 3, 5', { guests: 3 });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('5');
  });

  // --- no match ---
  it('should return null when no correction pattern matches', () => {
    const result = detectCorrection('book a hotel in Paris', { destination: 'London' });
    expect(result).toBeNull();
  });

  it('should return null with empty message', () => {
    const result = detectCorrection('', { destination: 'London' });
    expect(result).toBeNull();
  });

  it('should return null for regular question', () => {
    const result = detectCorrection('what hotels are available', { destination: 'London' });
    expect(result).toBeNull();
  });

  // --- generic correction ---
  it('should return _correction field when no field type matches', () => {
    // No collected data to match against
    const result = detectCorrection('actually something', {});
    expect(result).not.toBeNull();
    expect(result!.field).toBe('_correction');
    expect(result!.newValue).toBe('something');
  });

  it('should return _correction when collected data has only internal fields', () => {
    const result = detectCorrection('actually different', { _internal: 'value' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('_correction');
  });

  // --- skips internal fields ---
  it('should skip fields starting with underscore', () => {
    const result = detectCorrection('actually 10', { _internal: 5, guests: 3 });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('guests');
  });

  it('should skip multiple underscore-prefixed fields', () => {
    const result = detectCorrection('actually NYC', { _id: '123', _meta: 'test', city: 'Boston' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('city');
  });

  // --- custom patterns ---
  it('should use custom patterns when provided', () => {
    const customPatterns = ['^oops[,]?\\s+(.+)$'];
    const result = detectCorrection('oops, Denver', { city: 'Boulder' }, customPatterns);
    expect(result).not.toBeNull();
    expect(result!.field).toBe('city');
    expect(result!.newValue).toBe('denver');
  });

  it('should not match default patterns when custom patterns provided', () => {
    const customPatterns = ['^oops[,]?\\s+(.+)$'];
    const result = detectCorrection('actually Boston', { city: 'NYC' }, customPatterns);
    expect(result).toBeNull();
  });

  it('should handle multiple custom patterns', () => {
    const customPatterns = ['^oops[,]?\\s+(.+)$', '^correction:\\s+(.+)$'];
    const result = detectCorrection('correction: Phoenix', { city: 'Tempe' }, customPatterns);
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe('phoenix');
  });

  // --- field type matching priority ---
  it('should match number field when new value starts with digit', () => {
    // If we have both a number and a string field, numeric value should match number field
    const result = detectCorrection('actually 7', { count: 3, name: 'test' });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('count');
    expect(result!.newValue).toBe('7');
  });

  it('should match string field when new value is non-numeric', () => {
    const result = detectCorrection('actually Boston', { count: 3, city: 'NYC' });
    expect(result).not.toBeNull();
    // It iterates through entries - first matching type wins
    // 'Boston' is non-numeric and 'city' is a string value
    expect(result!.field).toBe('city');
    expect(result!.newValue).toBe('boston');
  });

  it('should prefer number field for numeric correction even with string fields first', () => {
    // When numeric value is detected, it matches the first number-typed field
    const result = detectCorrection('actually 4', { destination: 'Paris', nights: 2 });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('nights');
    expect(result!.newValue).toBe('4');
  });

  it('should handle collected data with boolean values', () => {
    // Boolean is not string or number, so correction goes to _correction
    const result = detectCorrection('actually something', { confirmed: true });
    expect(result).not.toBeNull();
    expect(result!.field).toBe('_correction');
  });
});

// =============================================================================
// checkGatherComplete
// =============================================================================

describe('checkGatherComplete', () => {
  // --- all required fields collected ---
  it('should return complete when all required fields are collected', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'checkin', required: true },
      ],
    };
    const collected = { destination: 'Paris', checkin: '2025-06-01' };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should return complete when required fields have values and optional are missing', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'notes', required: false },
      ],
    };
    const collected = { destination: 'Paris' };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should return complete when extra fields exist beyond what gather defines', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const collected = { destination: 'Paris', extra_field: 'bonus', another: 42 };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- missing fields ---
  it('should identify missing required fields', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'checkin', required: true },
        { name: 'checkout', required: true },
      ],
    };
    const collected = { destination: 'Paris' };
    const result = checkGatherComplete(gather, collected);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['checkin', 'checkout']);
  });

  it('should treat fields without explicit required as required', () => {
    const gather = {
      fields: [
        { name: 'destination' }, // no required key => defaults to true
        { name: 'checkin' },
      ],
    };
    const collected = { destination: 'Paris' };
    const result = checkGatherComplete(gather, collected);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['checkin']);
  });

  it('should report all fields as missing when none collected', () => {
    const gather = {
      fields: [
        { name: 'a', required: true },
        { name: 'b', required: true },
        { name: 'c', required: true },
      ],
    };
    const result = checkGatherComplete(gather, {});
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['a', 'b', 'c']);
  });

  // --- empty/null/undefined values ---
  it('should treat undefined value as missing', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const collected = { destination: undefined };
    const result = checkGatherComplete(gather, collected as Record<string, unknown>);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['destination']);
  });

  it('should treat null value as missing', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const collected = { destination: null };
    const result = checkGatherComplete(gather, collected as Record<string, unknown>);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['destination']);
  });

  it('should treat empty string as missing', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const collected = { destination: '' };
    const result = checkGatherComplete(gather, collected);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['destination']);
  });

  it('should treat zero as a valid value (not missing)', () => {
    const gather = {
      fields: [{ name: 'count', required: true }],
    };
    const collected = { count: 0 };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should treat false as a valid value (not missing)', () => {
    const gather = {
      fields: [{ name: 'confirmed', required: true }],
    };
    const collected = { confirmed: false };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should treat an array as a valid value', () => {
    const gather = {
      fields: [{ name: 'items', required: true }],
    };
    const collected = { items: [] };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should treat an object as a valid value', () => {
    const gather = {
      fields: [{ name: 'meta', required: true }],
    };
    const collected = { meta: {} };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- default values ---
  it('should treat required field with default as not missing', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'guests', required: true, default: 1 },
      ],
    };
    const collected = { destination: 'Paris' };
    const result = checkGatherComplete(gather, collected);
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should not treat required field without default as complete if missing', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const result = checkGatherComplete(gather, {});
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['destination']);
  });

  it('should treat field with default of 0 as having a default', () => {
    const gather = {
      fields: [{ name: 'discount', required: true, default: 0 }],
    };
    const result = checkGatherComplete(gather, {});
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should treat field with default of empty string as having a default', () => {
    const gather = {
      fields: [{ name: 'notes', required: true, default: '' }],
    };
    const result = checkGatherComplete(gather, {});
    // default is '' which is not undefined, so it counts as having a default
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should treat field with default of false as having a default', () => {
    const gather = {
      fields: [{ name: 'subscribe', required: true, default: false }],
    };
    const result = checkGatherComplete(gather, {});
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- completeWhen condition ---
  it('should return complete when completeWhen evaluates to true', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'checkin', required: true },
      ],
    };
    const collected = { destination: 'Paris' };
    // Even though checkin is missing, the completeWhen short-circuits
    const result = checkGatherComplete(gather, collected, 'destination IS SET');
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should fall through to field checking when completeWhen evaluates to false', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'checkin', required: true },
      ],
    };
    const collected = { destination: 'Paris' };
    const result = checkGatherComplete(gather, collected, 'checkin IS SET');
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['checkin']);
  });

  it('should fall through to field checking when completeWhen throws', () => {
    const gather = {
      fields: [{ name: 'destination', required: true }],
    };
    const collected = { destination: 'Paris' };
    // Invalid condition expression that might throw
    const result = checkGatherComplete(gather, collected, '>>>invalid<<<');
    // Falls through to field check - destination is collected
    expect(result).toEqual({ complete: true, missing: [] });
  });

  it('should use completeWhen even when all fields are collected', () => {
    const gather = {
      fields: [
        { name: 'a', required: true },
        { name: 'b', required: true },
      ],
    };
    const collected = { a: 'x', b: 'y' };
    // completeWhen is true, so it short-circuits before field checking
    const result = checkGatherComplete(gather, collected, 'a IS SET');
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- empty fields ---
  it('should return complete immediately when there are no fields', () => {
    const gather = { fields: [] };
    const result = checkGatherComplete(gather, {});
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- all optional ---
  it('should return complete when all fields are optional', () => {
    const gather = {
      fields: [
        { name: 'notes', required: false },
        { name: 'preference', required: false },
      ],
    };
    const result = checkGatherComplete(gather, {});
    expect(result).toEqual({ complete: true, missing: [] });
  });

  // --- mixed required/optional/default ---
  it('should handle mix of required, optional, and default fields', () => {
    const gather = {
      fields: [
        { name: 'name', required: true },
        { name: 'email', required: true },
        { name: 'phone', required: false },
        { name: 'country', required: true, default: 'US' },
      ],
    };
    const collected = { name: 'John' };
    const result = checkGatherComplete(gather, collected);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['email']);
  });
});

// =============================================================================
// buildGatherPrompt
// =============================================================================

describe('buildGatherPrompt', () => {
  // --- custom gather prompt ---
  it('should use custom gather prompt with interpolation', () => {
    const gather = {
      fields: [
        { name: 'destination', prompt: 'Where are you going?' },
        { name: 'checkin', prompt: 'When do you check in?' },
      ],
      prompt: 'I still need: {{_missingList}}. Your destination is {{destination}}.',
    };
    const missing = ['checkin'];
    const collected = { destination: 'Paris' };
    const result = buildGatherPrompt(gather, missing, collected);
    expect(result).toBe('I still need: checkin. Your destination is Paris.');
  });

  it('should pass _missing array and _missingList to custom prompt', () => {
    const gather = {
      fields: [{ name: 'a' }, { name: 'b' }],
      prompt: 'Missing: {{_missingList}}',
    };
    const result = buildGatherPrompt(gather, ['a', 'b'], {});
    expect(result).toBe('Missing: a, b');
  });

  it('should interpolate multiple collected values in custom prompt', () => {
    const gather = {
      fields: [{ name: 'name' }, { name: 'email' }, { name: 'phone' }],
      prompt: 'Hi {{name}}, I have your email as {{email}}. What is your phone?',
    };
    const result = buildGatherPrompt(gather, ['phone'], { name: 'Alice', email: 'alice@test.com' });
    expect(result).toBe('Hi Alice, I have your email as alice@test.com. What is your phone?');
  });

  // --- individual field prompts ---
  it('should build prompt from individual field prompts', () => {
    const gather = {
      fields: [
        { name: 'destination', prompt: 'Where are you going?' },
        { name: 'checkin', prompt: 'When do you check in?' },
      ],
    };
    const missing = ['destination', 'checkin'];
    const result = buildGatherPrompt(gather, missing, {});
    expect(result).toBe('Where are you going?\nWhen do you check in?');
  });

  it('should only include prompts for missing fields', () => {
    const gather = {
      fields: [
        { name: 'destination', prompt: 'Where are you going?' },
        { name: 'checkin', prompt: 'When do you check in?' },
      ],
    };
    const missing = ['checkin'];
    const result = buildGatherPrompt(gather, missing, { destination: 'Paris' });
    expect(result).toBe('When do you check in?');
  });

  it('should skip fields without prompts in individual mode', () => {
    const gather = {
      fields: [{ name: 'destination' }, { name: 'checkin', prompt: 'Check-in date?' }],
    };
    const missing = ['destination', 'checkin'];
    const result = buildGatherPrompt(gather, missing, {});
    expect(result).toBe('Check-in date?');
  });

  it('should return single field prompt when only one missing field has prompt', () => {
    const gather = {
      fields: [{ name: 'name', prompt: 'What is your name?' }],
    };
    const result = buildGatherPrompt(gather, ['name'], {});
    expect(result).toBe('What is your name?');
  });

  // --- default prompt ---
  it('should generate default prompt when no custom prompts exist', () => {
    const gather = {
      fields: [{ name: 'destination' }, { name: 'checkin' }],
    };
    const missing = ['destination', 'checkin'];
    const result = buildGatherPrompt(gather, missing, {});
    expect(result).toBe('Please provide: destination, checkin');
  });

  it('should generate default prompt for single missing field', () => {
    const gather = {
      fields: [{ name: 'email' }],
    };
    const result = buildGatherPrompt(gather, ['email'], {});
    expect(result).toBe('Please provide: email');
  });

  it('should fall back to default when all missing fields lack prompts', () => {
    const gather = {
      fields: [{ name: 'x' }, { name: 'y' }],
    };
    const result = buildGatherPrompt(gather, ['x', 'y'], {});
    expect(result).toBe('Please provide: x, y');
  });

  // --- custom gather prompt takes priority ---
  it('should use gather.prompt even when field prompts exist', () => {
    const gather = {
      fields: [{ name: 'destination', prompt: 'Where?' }],
      prompt: 'Custom: {{_missingList}}',
    };
    const result = buildGatherPrompt(gather, ['destination'], {});
    expect(result).toBe('Custom: destination');
  });

  // --- edge cases ---
  it('should handle empty missing fields array', () => {
    const gather = {
      fields: [{ name: 'destination' }],
    };
    const result = buildGatherPrompt(gather, [], {});
    expect(result).toBe('');
  });

  it('should handle missing field not found in gather fields', () => {
    const gather = {
      fields: [{ name: 'destination' }],
    };
    // 'unknown' field is in missing but not in gather.fields
    const result = buildGatherPrompt(gather, ['unknown'], {});
    // No field prompt found, falls through to default
    expect(result).toBe('Please provide: unknown');
  });

  it('should handle gather with no fields and no prompt', () => {
    const gather = { fields: [] };
    const result = buildGatherPrompt(gather, ['something'], {});
    expect(result).toBe('Please provide: something');
  });
});

// =============================================================================
// validateField
// =============================================================================

describe('validateField', () => {
  // --- pattern validation ---
  it('should return null for valid pattern match', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^[a-z]+$',
      error_message: 'Must be lowercase letters',
    };
    expect(validateField('hello', validation)).toBeNull();
  });

  it('should return error message for pattern mismatch', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^[a-z]+$',
      error_message: 'Must be lowercase letters',
    };
    expect(validateField('Hello123', validation)).toBe('Must be lowercase letters');
  });

  it('should return error message when value is not a string for pattern', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^\\d+$',
      error_message: 'Must be a number string',
    };
    expect(validateField(123, validation)).toBe('Must be a number string');
  });

  it('should return error for invalid regex pattern', () => {
    const validation = { type: 'pattern' as const, rule: '[invalid', error_message: 'Bad pattern' };
    expect(validateField('test', validation)).toBe('Invalid validation pattern');
  });

  it('should validate email pattern', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^[^@]+@[^@]+\\.[^@]+$',
      error_message: 'Invalid email',
    };
    expect(validateField('user@example.com', validation)).toBeNull();
    expect(validateField('not-an-email', validation)).toBe('Invalid email');
  });

  it('should validate phone number pattern', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^\\+?\\d{10,15}$',
      error_message: 'Invalid phone',
    };
    expect(validateField('+12025551234', validation)).toBeNull();
    expect(validateField('abc', validation)).toBe('Invalid phone');
  });

  it('should validate date pattern', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^\\d{4}-\\d{2}-\\d{2}$',
      error_message: 'Use YYYY-MM-DD',
    };
    expect(validateField('2025-06-15', validation)).toBeNull();
    expect(validateField('June 15', validation)).toBe('Use YYYY-MM-DD');
  });

  it('should handle empty string with pattern that requires content', () => {
    const validation = {
      type: 'pattern' as const,
      rule: '^.+$',
      error_message: 'Must not be empty',
    };
    expect(validateField('', validation)).toBe('Must not be empty');
  });

  // --- range validation ---
  it('should return null for value within range', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(5, validation)).toBeNull();
  });

  it('should return null for value at range boundaries', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(1, validation)).toBeNull();
    expect(validateField(10, validation)).toBeNull();
  });

  it('should return error for value below range', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(0, validation)).toBe('Must be 1-10');
  });

  it('should return error for value above range', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(11, validation)).toBe('Must be 1-10');
  });

  it('should parse string value as number for range validation', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField('5', validation)).toBeNull();
    expect(validateField('15', validation)).toBe('Must be 1-10');
  });

  it('should return error for non-numeric value in range validation', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField('abc', validation)).toBe('Must be 1-10');
  });

  it('should handle range with large numbers', () => {
    const validation = { type: 'range' as const, rule: '0-100', error_message: 'Must be 0-100' };
    expect(validateField(50, validation)).toBeNull();
    expect(validateField(-1, validation)).toBe('Must be 0-100');
    expect(validateField(101, validation)).toBe('Must be 0-100');
  });

  it('should handle decimal values in range', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(5.5, validation)).toBeNull();
    expect(validateField(0.5, validation)).toBe('Must be 1-10');
    expect(validateField(10.5, validation)).toBe('Must be 1-10');
  });

  it('should handle string decimal values in range', () => {
    const validation = { type: 'range' as const, rule: '0-100', error_message: 'Must be 0-100' };
    expect(validateField('99.9', validation)).toBeNull();
    expect(validateField('100.1', validation)).toBe('Must be 0-100');
  });

  // --- enum validation ---
  it('should return null for value in enum', () => {
    const validation = {
      type: 'enum' as const,
      rule: 'red|green|blue',
      error_message: 'Must be a color',
    };
    expect(validateField('red', validation)).toBeNull();
    expect(validateField('green', validation)).toBeNull();
    expect(validateField('blue', validation)).toBeNull();
  });

  it('should return error for value not in enum', () => {
    const validation = {
      type: 'enum' as const,
      rule: 'red|green|blue',
      error_message: 'Must be a color',
    };
    expect(validateField('purple', validation)).toBe('Must be a color');
  });

  it('should coerce value to string for enum comparison', () => {
    const validation = {
      type: 'enum' as const,
      rule: '1|2|3',
      error_message: 'Must be 1, 2, or 3',
    };
    expect(validateField(2, validation)).toBeNull();
  });

  it('should be case sensitive for enum', () => {
    const validation = {
      type: 'enum' as const,
      rule: 'Red|Green|Blue',
      error_message: 'Must be a color',
    };
    expect(validateField('red', validation)).toBe('Must be a color');
    expect(validateField('Red', validation)).toBeNull();
  });

  it('should handle single enum value', () => {
    const validation = { type: 'enum' as const, rule: 'only', error_message: 'Only one option' };
    expect(validateField('only', validation)).toBeNull();
    expect(validateField('other', validation)).toBe('Only one option');
  });

  it('should handle enum with empty string option', () => {
    const validation = {
      type: 'enum' as const,
      rule: '|yes|no',
      error_message: 'Must be yes or no',
    };
    expect(validateField('', validation)).toBeNull();
    expect(validateField('yes', validation)).toBeNull();
  });

  it('should handle boolean coerced to string for enum', () => {
    const validation = {
      type: 'enum' as const,
      rule: 'true|false',
      error_message: 'Must be true or false',
    };
    expect(validateField(true, validation)).toBeNull();
    expect(validateField(false, validation)).toBeNull();
  });

  // --- custom validation ---
  it('should return null for custom validation type (no-op)', () => {
    const validation = {
      type: 'custom' as const,
      rule: 'some_custom_rule',
      error_message: 'Custom error',
    };
    expect(validateField('anything', validation)).toBeNull();
  });

  it('should return null for custom validation with any value', () => {
    const validation = { type: 'custom' as const, rule: 'complex_rule', error_message: 'Error' };
    expect(validateField(null, validation)).toBeNull();
    expect(validateField(undefined, validation)).toBeNull();
    expect(validateField(42, validation)).toBeNull();
  });

  // --- edge cases ---
  it('should handle undefined value for pattern validation', () => {
    const validation = { type: 'pattern' as const, rule: '^.+$', error_message: 'Required' };
    expect(validateField(undefined, validation)).toBe('Required');
  });

  it('should handle null value for pattern validation', () => {
    const validation = { type: 'pattern' as const, rule: '^.+$', error_message: 'Required' };
    expect(validateField(null, validation)).toBe('Required');
  });

  it('should handle null value for range validation', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    expect(validateField(null, validation)).toBe('Must be 1-10');
  });

  it('should handle undefined value for enum validation', () => {
    const validation = { type: 'enum' as const, rule: 'a|b', error_message: 'Pick a or b' };
    expect(validateField(undefined, validation)).toBe('Pick a or b');
  });
});

// =============================================================================
// evaluateOnInput
// =============================================================================

describe('evaluateOnInput', () => {
  // --- condition matching ---
  it('should match branch with "contains" condition', () => {
    const branches = [
      { condition: 'input contains "yes"', then: 'confirm_step' },
      { condition: 'input contains "no"', then: 'cancel_step' },
    ];
    const result = evaluateOnInput(branches, 'yes please', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('confirm_step');
  });

  it('should match second branch when first does not match', () => {
    const branches = [
      { condition: 'input contains "yes"', then: 'confirm_step' },
      { condition: 'input contains "no"', then: 'cancel_step' },
    ];
    const result = evaluateOnInput(branches, 'no thanks', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('cancel_step');
  });

  it('should match branch with equality condition', () => {
    const branches = [
      { condition: 'input == "1"', then: 'option_one' },
      { condition: 'input == "2"', then: 'option_two' },
    ];
    const result = evaluateOnInput(branches, '1', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('option_one');
  });

  it('should evaluate conditions with context variables', () => {
    const branches = [
      { condition: 'status == "confirmed"', then: 'done_step' },
      { then: 'default_step' },
    ];
    const result = evaluateOnInput(branches, 'anything', { status: 'confirmed' });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('done_step');
  });

  it('should match third branch when first two fail', () => {
    const branches = [
      { condition: 'input contains "alpha"', then: 'step_a' },
      { condition: 'input contains "beta"', then: 'step_b' },
      { condition: 'input contains "gamma"', then: 'step_c' },
    ];
    const result = evaluateOnInput(branches, 'use gamma', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('step_c');
  });

  // --- ELSE branch (no condition) ---
  it('should match ELSE branch when no conditions match', () => {
    const branches = [
      { condition: 'input contains "yes"', then: 'confirm_step' },
      { then: 'fallback_step' },
    ];
    const result = evaluateOnInput(branches, 'something else', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('fallback_step');
  });

  it('should match ELSE branch immediately when it comes first', () => {
    const branches = [
      { then: 'fallback_step' },
      { condition: 'input contains "yes"', then: 'confirm_step' },
    ];
    const result = evaluateOnInput(branches, 'yes', {});
    expect(result).not.toBeNull();
    // ELSE is first, matches immediately
    expect(result!.then).toBe('fallback_step');
  });

  it('should return the ELSE branch object with all its properties', () => {
    const branches = [
      {
        respond: 'Fallback message',
        set: { fallback: 'true' },
        call: 'log_fallback()',
        then: 'fallback_step',
      },
    ];
    const result = evaluateOnInput(branches, 'anything', {});
    expect(result).not.toBeNull();
    expect(result!.respond).toBe('Fallback message');
    expect(result!.set).toEqual({ fallback: 'true' });
    expect(result!.call).toBe('log_fallback()');
    expect(result!.then).toBe('fallback_step');
  });

  // --- no match ---
  it('should return null when no branches match', () => {
    const branches = [
      { condition: 'input contains "yes"', then: 'confirm_step' },
      { condition: 'input contains "no"', then: 'cancel_step' },
    ];
    const result = evaluateOnInput(branches, 'maybe', {});
    expect(result).toBeNull();
  });

  it('should return null for empty branches', () => {
    const result = evaluateOnInput([], 'anything', {});
    expect(result).toBeNull();
  });

  // --- response and set ---
  it('should return respond from matching branch', () => {
    const branches = [
      { condition: 'input contains "yes"', respond: 'Great, confirmed!', then: 'next_step' },
    ];
    const result = evaluateOnInput(branches, 'yes', {});
    expect(result).not.toBeNull();
    expect(result!.respond).toBe('Great, confirmed!');
    expect(result!.then).toBe('next_step');
  });

  it('should return set assignments from matching branch', () => {
    const branches = [
      {
        condition: 'input contains "yes"',
        set: { confirmed: 'true' },
        then: 'next_step',
      },
    ];
    const result = evaluateOnInput(branches, 'yes', {});
    expect(result).not.toBeNull();
    expect(result!.set).toEqual({ confirmed: 'true' });
  });

  it('should return call from matching branch', () => {
    const branches = [
      {
        condition: 'input contains "search"',
        call: 'search_api(query)',
        then: 'results_step',
      },
    ];
    const result = evaluateOnInput(branches, 'search for hotels', {});
    expect(result).not.toBeNull();
    expect(result!.call).toBe('search_api(query)');
  });

  it('should return undefined for respond/set/call when not present on branch', () => {
    const branches = [{ condition: 'input contains "go"', then: 'next' }];
    const result = evaluateOnInput(branches, 'go now', {});
    expect(result).not.toBeNull();
    expect(result!.respond).toBeUndefined();
    expect(result!.set).toBeUndefined();
    expect(result!.call).toBeUndefined();
    expect(result!.then).toBe('next');
  });

  // --- user message trimming and lowercasing ---
  it('should trim and lowercase user message for matching', () => {
    const branches = [{ condition: 'input contains "yes"', then: 'confirm' }];
    const result = evaluateOnInput(branches, '  YES  ', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('confirm');
  });

  it('should handle multi-word input with mixed case', () => {
    const branches = [{ condition: 'input contains "book hotel"', then: 'booking' }];
    const result = evaluateOnInput(branches, 'I want to BOOK HOTEL please', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('booking');
  });

  // --- trace event emission ---
  it('should emit trace event for condition match', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ condition: 'input contains "yes"', then: 'confirm' }];
    evaluateOnInput(branches, 'yes', {}, undefined, onTraceEvent);
    expect(traceEvents.length).toBe(1);
    expect(traceEvents[0].type).toBe('dsl_on_input');
    expect(traceEvents[0].data.result).toBe('CONDITION_MATCHED');
  });

  it('should emit trace event for ELSE match', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ condition: 'input contains "yes"', then: 'confirm' }, { then: 'fallback' }];
    evaluateOnInput(branches, 'nope', {}, undefined, onTraceEvent);
    expect(traceEvents.length).toBe(1);
    expect(traceEvents[0].type).toBe('dsl_on_input');
    expect(traceEvents[0].data.result).toBe('ELSE_MATCHED');
  });

  it('should emit trace event for no match', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ condition: 'input contains "yes"', then: 'confirm' }];
    evaluateOnInput(branches, 'nope', {}, undefined, onTraceEvent);
    expect(traceEvents.length).toBe(1);
    expect(traceEvents[0].type).toBe('dsl_on_input');
    expect(traceEvents[0].data.result).toBe('NO_MATCH');
  });

  it('should not emit trace event when onTraceEvent is not provided', () => {
    const branches = [{ condition: 'input contains "yes"', then: 'confirm' }];
    // Should not throw
    const result = evaluateOnInput(branches, 'yes', {});
    expect(result).not.toBeNull();
  });

  it('should not emit NO_MATCH trace when branches are empty', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    evaluateOnInput([], 'test', {}, undefined, onTraceEvent);
    // evaluations array is empty, so the NO_MATCH trace should not fire
    expect(traceEvents.length).toBe(0);
  });

  // --- trace event data structure ---
  it('should include userInput in trace event data for condition match', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ condition: 'input contains "hello"', then: 'greet', respond: 'Hi there' }];
    evaluateOnInput(branches, '  HELLO world  ', {}, undefined, onTraceEvent);
    expect(traceEvents[0].data.userInput).toBe('hello world');
    expect(traceEvents[0].data.targetStep).toBe('greet');
    expect((traceEvents[0].data.actions as Record<string, unknown>).respond).toBe('Hi there');
  });

  it('should include matchedBranch ELSE in trace for fallback', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ then: 'default' }];
    evaluateOnInput(branches, 'anything', {}, undefined, onTraceEvent);
    expect(traceEvents[0].data.matchedBranch).toBe('ELSE');
    expect(traceEvents[0].data.targetStep).toBe('default');
  });

  it('should include note in NO_MATCH trace event', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [{ condition: 'input contains "xyz"', then: 'nowhere' }];
    evaluateOnInput(branches, 'abc', {}, undefined, onTraceEvent);
    expect(traceEvents[0].data.note).toBe(
      'No ON_INPUT condition matched - will use step default THEN',
    );
  });

  // --- multiple branches evaluation tracking ---
  it('should include all evaluated conditions in trace data', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [
      { condition: 'input contains "foo"', then: 'step_foo' },
      { condition: 'input contains "bar"', then: 'step_bar' },
      { condition: 'input contains "yes"', then: 'step_yes' },
    ];
    evaluateOnInput(branches, 'yes please', {}, undefined, onTraceEvent);
    expect(traceEvents.length).toBe(1);
    const evaluations = traceEvents[0].data.evaluations as Array<unknown>;
    // First two conditions evaluated (false), third matched (true)
    expect(evaluations).toHaveLength(3);
  });

  it('should stop evaluating after first match (short-circuit)', () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };
    const branches = [
      { condition: 'input contains "yes"', then: 'first' },
      { condition: 'input contains "yes"', then: 'second' },
    ];
    evaluateOnInput(branches, 'yes', {}, undefined, onTraceEvent);
    expect(traceEvents.length).toBe(1);
    const evaluations = traceEvents[0].data.evaluations as Array<{ matched: boolean }>;
    // Should have only 1 evaluation because first match short-circuits
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].matched).toBe(true);
  });

  // --- ELSE branch with respond/set/call ---
  it('should return full branch data for ELSE including respond and set', () => {
    const branches = [
      { condition: 'input contains "yes"', then: 'confirm' },
      { respond: 'Defaulting to fallback', set: { mode: 'default' }, then: 'fallback' },
    ];
    const result = evaluateOnInput(branches, 'nope', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('fallback');
    expect(result!.respond).toBe('Defaulting to fallback');
    expect(result!.set).toEqual({ mode: 'default' });
  });

  // --- compound conditions ---
  it('should match branch with AND condition', () => {
    const branches = [
      { condition: 'input contains "book" AND status == "ready"', then: 'booking_step' },
    ];
    const result = evaluateOnInput(branches, 'book it', { status: 'ready' });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('booking_step');
  });

  it('should not match when AND condition partially fails', () => {
    const branches = [
      { condition: 'input contains "book" AND status == "ready"', then: 'booking_step' },
    ];
    const result = evaluateOnInput(branches, 'book it', { status: 'not_ready' });
    expect(result).toBeNull();
  });

  it('should match branch with OR condition', () => {
    const branches = [
      { condition: 'input contains "yes" OR input contains "ok"', then: 'confirm_step' },
    ];
    const resultYes = evaluateOnInput(branches, 'ok then', {});
    expect(resultYes).not.toBeNull();
    expect(resultYes!.then).toBe('confirm_step');
  });

  it('should match OR condition when first alternative matches', () => {
    const branches = [
      { condition: 'input contains "yes" OR input contains "ok"', then: 'confirm_step' },
    ];
    const result = evaluateOnInput(branches, 'yes definitely', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('confirm_step');
  });

  // --- voice_config passthrough ---
  it('should return voice_config from matching branch', () => {
    const voiceConfig = { speed: 1.2, pitch: 'high' };
    const branches = [
      {
        condition: 'input contains "yes"',
        voice_config: voiceConfig as any,
        then: 'next',
      },
    ];
    const result = evaluateOnInput(branches, 'yes', {});
    expect(result).not.toBeNull();
    expect(result!.voice_config).toEqual(voiceConfig);
  });

  it('should return voice_config from ELSE branch', () => {
    const voiceConfig = { speed: 0.8 };
    const branches = [
      { condition: 'input contains "impossible"', then: 'never' },
      { voice_config: voiceConfig as any, then: 'default' },
    ];
    const result = evaluateOnInput(branches, 'anything', {});
    expect(result).not.toBeNull();
    expect(result!.voice_config).toEqual(voiceConfig);
  });

  // --- IS SET condition ---
  it('should match branch with IS SET condition on context variable', () => {
    const branches = [{ condition: 'destination IS SET', then: 'next_step' }];
    const result = evaluateOnInput(branches, 'proceed', { destination: 'Paris' });
    expect(result).not.toBeNull();
    expect(result!.then).toBe('next_step');
  });

  it('should not match IS SET when variable is not set', () => {
    const branches = [{ condition: 'destination IS SET', then: 'next_step' }];
    const result = evaluateOnInput(branches, 'proceed', {});
    expect(result).toBeNull();
  });
});

// =============================================================================
// Integration-style tests combining helpers
// =============================================================================

describe('helper integration', () => {
  it('should detect correction after failed gather complete check', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true },
        { name: 'guests', required: true },
      ],
    };
    const collected = { destination: 'London', guests: 3 };

    // First check passes
    const check1 = checkGatherComplete(gather, collected);
    expect(check1.complete).toBe(true);

    // Then user corrects
    const correction = detectCorrection('actually Paris', collected);
    expect(correction).not.toBeNull();
    expect(correction!.field).toBe('destination');

    // Apply correction
    collected.destination = correction!.newValue;

    // Still complete
    const check2 = checkGatherComplete(gather, collected);
    expect(check2.complete).toBe(true);
  });

  it('should build prompt for missing fields from gather check', () => {
    const gather = {
      fields: [
        { name: 'destination', required: true, prompt: 'Where to?' },
        { name: 'checkin', required: true, prompt: 'Check-in date?' },
        { name: 'guests', required: true, prompt: 'How many guests?' },
      ],
    };
    const collected = { destination: 'Paris' };

    const { complete, missing } = checkGatherComplete(gather, collected);
    expect(complete).toBe(false);

    const prompt = buildGatherPrompt(gather, missing, collected);
    expect(prompt).toBe('Check-in date?\nHow many guests?');
  });

  it('should validate field then detect intent on valid input', () => {
    // Validate a selection
    const validation = { type: 'enum' as const, rule: '1|2|3', error_message: 'Pick 1-3' };
    const error = validateField('2', validation);
    expect(error).toBeNull();

    // Then detect an intent
    const intents = [{ intent: '"option 1"' }, { intent: '"option 2"' }];
    const result = detectIntent('I pick option 2', intents, {});
    expect(result).not.toBeNull();
    expect(result!.matched).toBe('option 2');
  });

  it('should use evaluateOnInput to route after checkGatherComplete', () => {
    const gather = {
      fields: [{ name: 'choice', required: true }],
    };
    const collected = { choice: 'premium' };

    const { complete } = checkGatherComplete(gather, collected);
    expect(complete).toBe(true);

    // Route based on the collected choice
    const branches = [
      { condition: 'choice == "premium"', then: 'premium_flow' },
      { condition: 'choice == "basic"', then: 'basic_flow' },
      { then: 'default_flow' },
    ];
    const result = evaluateOnInput(branches, '', collected);
    expect(result).not.toBeNull();
    expect(result!.then).toBe('premium_flow');
  });

  it('should validate then build prompt for invalid fields', () => {
    const validation = { type: 'range' as const, rule: '1-10', error_message: 'Must be 1-10' };
    const error = validateField(15, validation);
    expect(error).toBe('Must be 1-10');

    // If validation fails, we need to re-prompt
    const gather = {
      fields: [{ name: 'guests', required: true, prompt: 'How many guests? (1-10)' }],
    };
    const prompt = buildGatherPrompt(gather, ['guests'], {});
    expect(prompt).toBe('How many guests? (1-10)');
  });

  it('should detect intent with condition based on gathered data', () => {
    // Gather some data first
    const gather = {
      fields: [{ name: 'tier', required: true }],
    };
    const collected = { tier: 'gold' };
    expect(checkGatherComplete(gather, collected).complete).toBe(true);

    // Now detect intent with condition on that data
    const intents = [
      { intent: 'upgrade', condition: 'tier == "gold"' },
      { intent: 'upgrade', condition: 'tier == "silver"' },
    ];
    const result = detectIntent('I want to upgrade', intents, collected);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('upgrade');
  });
});
