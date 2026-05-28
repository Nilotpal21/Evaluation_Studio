/**
 * Parser Tests: Enhanced Error Handling in FLOW Steps
 *
 * Tests that the parser correctly handles the new ON_ERROR DSL within FLOW step
 * definitions, including TYPE/SUBTYPE matching, retry backoff strategies, and
 * backtrack targets.
 *
 * Most tests are expected to FAIL until the parser is updated to support the new
 * error handling fields (subtypes, retryBackoff, backtrackTo) within FLOW steps.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('Parser: Enhanced Error Handling in FLOW Steps', () => {
  test('should parse ON_ERROR block with TYPE, SUBTYPE, and retry backoff in a FLOW step', () => {
    const dsl = `
AGENT: PaymentAgent
GOAL: "Process payments"

FLOW:
  steps:
      REASONING: false
    - collect_payment
    - confirm

  collect_payment:
      REASONING: false
    CALL: process_payment
    ON_ERROR:
        REASONING: false
      - TYPE: tool_failure
        SUBTYPE: credit_card_declined
        RESPOND: "Payment declined."
        THEN: collect_payment
      - TYPE: tool_timeout
        RETRY: 2
        RETRY_DELAY: 2000
        RETRY_BACKOFF: exponential
        THEN: continue

  confirm:
      REASONING: false
    RESPOND: "Payment confirmed."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.flow).toBeDefined();

    const collectStep = doc.flow!.definitions['collect_payment'];
    expect(collectStep).toBeDefined();
    expect(collectStep.onError).toBeDefined();
    expect(collectStep.onError).toHaveLength(2);

    // First error handler: tool_failure with subtype
    const handler1 = collectStep.onError![0];
    expect(handler1.type).toBe('tool_failure');
    expect(handler1.subtypes).toEqual(['credit_card_declined']);
    expect(handler1.respond).toBe('Payment declined.');
    expect(handler1.then).toBe('collect_payment');

    // Second error handler: tool_timeout with retry backoff
    const handler2 = collectStep.onError![1];
    expect(handler2.type).toBe('tool_timeout');
    expect(handler2.retry).toBe(2);
    expect(handler2.retryDelay).toBe(2000);
    expect(handler2.retryBackoff).toBe('exponential');
    expect(handler2.then).toBe('continue');
  });

  test('should parse BACKTRACK_TO in error handler', () => {
    const dsl = `
AGENT: SearchAgent
GOAL: "Search and book"

FLOW:
  steps:
      REASONING: false
    - search_step
    - book_step

  search_step:
      REASONING: false
    CALL: search_hotels
    RESPOND: "Here are the results."
    THEN: book_step

  book_step:
      REASONING: false
    CALL: book_hotel
    ON_ERROR:
        REASONING: false
      - TYPE: tool_failure
        THEN: backtrack
        BACKTRACK_TO: search_step
        RESPOND: "Booking failed. Let me search again."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    const bookStep = doc.flow!.definitions['book_step'];
    expect(bookStep).toBeDefined();
    expect(bookStep.onError).toBeDefined();
    expect(bookStep.onError).toHaveLength(1);

    const handler = bookStep.onError![0];
    expect(handler.type).toBe('tool_failure');
    expect(handler.then).toBe('backtrack');
    expect(handler.backtrackTo).toBe('search_step');
    expect(handler.respond).toBe('Booking failed. Let me search again.');
  });

  test('backward compat: existing agent-level ON_ERROR still works', () => {
    const dsl = `
AGENT: BasicAgent
GOAL: "Help users"

ON_ERROR:
  tool_timeout:
    RESPOND: "The service is slow. Please try again."
    RETRY: 3
    RETRY_DELAY: 1000
    THEN: continue
  invalid_input:
    RESPOND: "That input was not valid."
    THEN: continue
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.onError).toBeDefined();
    expect(doc.onError).toHaveLength(2);

    const timeoutHandler = doc.onError.find((h) => h.type === 'tool_timeout');
    expect(timeoutHandler).toBeDefined();
    expect(timeoutHandler!.respond).toBe('The service is slow. Please try again.');
    expect(timeoutHandler!.retry).toBe(3);
    expect(timeoutHandler!.retryDelay).toBe(1000);
    expect(timeoutHandler!.then).toBe('continue');

    const inputHandler = doc.onError.find((h) => h.type === 'invalid_input');
    expect(inputHandler).toBeDefined();
    expect(inputHandler!.respond).toBe('That input was not valid.');
  });
});
