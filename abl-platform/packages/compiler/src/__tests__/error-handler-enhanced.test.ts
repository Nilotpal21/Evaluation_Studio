/**
 * Enhanced ErrorHandler Tests
 *
 * Validates the extended ErrorHandler type which now supports:
 * - subtypes for fine-grained error matching
 * - retry_backoff strategies (fixed, exponential, linear)
 * - then='backtrack' with backtrack_to for jumping to a previous step
 * - then='retry_step' for retrying the current step
 * - retry_max_delay_ms for capping backoff growth
 * - FlowStep.on_error array for step-level error handling
 */

import { describe, test, expect } from 'vitest';
import type { ErrorHandler, FlowStep } from '../platform/ir/schema.js';

describe('ErrorHandler enhanced fields', () => {
  test('subtypes array creates a valid ErrorHandler', () => {
    const handler: ErrorHandler = {
      type: 'payment_error',
      subtypes: ['credit_card_declined', 'insufficient_funds', 'card_expired'],
      respond: 'Your payment could not be processed.',
      retry: 2,
      then: 'escalate',
    };

    expect(handler.subtypes).toEqual([
      'credit_card_declined',
      'insufficient_funds',
      'card_expired',
    ]);
    expect(handler.type).toBe('payment_error');
    expect(handler.then).toBe('escalate');
  });

  test('retry_backoff="exponential" creates a valid ErrorHandler', () => {
    const handler: ErrorHandler = {
      type: 'api_error',
      respond: 'We encountered a temporary error. Retrying...',
      retry: 3,
      retry_delay_ms: 1000,
      retry_backoff: 'exponential',
      then: 'continue',
    };

    expect(handler.retry_backoff).toBe('exponential');
    expect(handler.retry_delay_ms).toBe(1000);
    expect(handler.retry).toBe(3);
  });

  test('then="backtrack" with backtrack_to creates a valid ErrorHandler', () => {
    const handler: ErrorHandler = {
      type: 'booking_error',
      respond: 'Booking failed. Let us search for other options.',
      then: 'backtrack',
      backtrack_to: 'search_step',
    };

    expect(handler.then).toBe('backtrack');
    expect(handler.backtrack_to).toBe('search_step');
  });

  test('then="retry_step" creates a valid ErrorHandler', () => {
    const handler: ErrorHandler = {
      type: 'validation_error',
      respond: 'The information provided was invalid. Please try again.',
      then: 'retry_step',
    };

    expect(handler.then).toBe('retry_step');
  });

  test('retry_max_delay_ms caps retry delay', () => {
    const handler: ErrorHandler = {
      type: 'rate_limit',
      respond: 'Rate limited. Waiting before retry...',
      retry: 5,
      retry_delay_ms: 500,
      retry_backoff: 'exponential',
      retry_max_delay_ms: 10000,
      then: 'continue',
    };

    expect(handler.retry_max_delay_ms).toBe(10000);
    expect(handler.retry_backoff).toBe('exponential');
    expect(handler.retry_delay_ms).toBe(500);

    // Verify the cap is meaningful: with exponential backoff from 500ms,
    // attempt 5 would be 500 * 2^4 = 8000ms, which is under the 10000ms cap.
    // attempt 6 would be 500 * 2^5 = 16000ms, which exceeds the cap.
    const uncappedDelay = 500 * Math.pow(2, 5);
    const cappedDelay = Math.min(uncappedDelay, handler.retry_max_delay_ms!);
    expect(cappedDelay).toBe(10000);
  });
});

describe('FlowStep.on_error with multiple handlers', () => {
  test('on_error array with multiple handlers creates a valid FlowStep', () => {
    const step: FlowStep = {
      name: 'process_payment',
      call: 'charge_credit_card',
      then: 'confirmation_step',
      on_error: [
        {
          type: 'payment_error',
          subtypes: ['credit_card_declined'],
          respond: 'Your card was declined. Please try a different card.',
          then: 'backtrack',
          backtrack_to: 'collect_payment_info',
        },
        {
          type: 'timeout_error',
          respond: 'The payment service is not responding.',
          retry: 2,
          retry_delay_ms: 2000,
          retry_backoff: 'exponential',
          then: 'continue',
        },
        {
          type: 'unknown_error',
          respond: 'An unexpected error occurred.',
          then: 'escalate',
        },
      ],
    };

    expect(step.on_error).toHaveLength(3);
    expect(step.on_error![0].subtypes).toEqual(['credit_card_declined']);
    expect(step.on_error![0].then).toBe('backtrack');
    expect(step.on_error![0].backtrack_to).toBe('collect_payment_info');
    expect(step.on_error![1].retry_backoff).toBe('exponential');
    expect(step.on_error![2].then).toBe('escalate');
  });
});
