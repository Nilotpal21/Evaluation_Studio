/**
 * PII Guard Hook Tests
 *
 * Tests the beforeExecute hook that redacts PII from user messages
 * before LLM processing.
 */
import { describe, test, expect } from 'vitest';
import { createPIIGuardHook } from '../../platform/nlu/enterprise/pii-guard.js';
import type { NLUConfig } from '../../platform/nlu/config.js';
import type { NLUContext } from '../../platform/nlu/types.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(overrides?: Partial<NLUConfig['piiRedaction']>): NLUConfig {
  return {
    fastModel: 'default',
    confidenceThreshold: 0.7,
    enableFallbacks: true,
    environment: 'production',
    cache: { enabled: false, ttlMs: 60_000, intentTtlMs: 60_000, entityTtlMs: 30_000 },
    piiRedaction: { enabled: true, redactInput: true, redactOutput: false, ...overrides },
    circuitBreaker: { enabled: false, failureThreshold: 5, resetTimeoutMs: 30_000 },
    audit: { enabled: false, logPredictions: false },
    rateLimiting: { enabled: false, maxCallsPerMinute: 1000 },
  };
}

function makeCtx(overrides?: Partial<NLUContext>): NLUContext {
  return {
    userMessage: 'Hello, I need help',
    conversationHistory: [],
    turnNumber: 1,
    conversationPhase: 'collecting',
    agentGoal: 'Help the user',
    collectedData: { name: 'John' },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createPIIGuardHook', () => {
  // =========================================================================
  // DISABLED
  // =========================================================================

  describe('disabled', () => {
    test('returns original context when piiRedaction.enabled = false', async () => {
      const hook = createPIIGuardHook(makeConfig({ enabled: false }));
      const ctx = makeCtx({ userMessage: 'My email is user@example.com' });
      const result = await hook(ctx, 'intent_detection');
      expect(result).toBe(ctx); // same reference
      expect(result.userMessage).toBe('My email is user@example.com');
    });

    test('returns original context when piiRedaction.redactInput = false', async () => {
      const hook = createPIIGuardHook(makeConfig({ enabled: true, redactInput: false }));
      const ctx = makeCtx({ userMessage: 'Call me at 555-123-4567' });
      const result = await hook(ctx, 'intent_detection');
      expect(result).toBe(ctx);
      expect(result.userMessage).toBe('Call me at 555-123-4567');
    });
  });

  // =========================================================================
  // REDACTION
  // =========================================================================

  describe('redaction', () => {
    test('redacts email in userMessage', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({ userMessage: 'My email is test@example.com' });
      const result = await hook(ctx, 'intent_detection');
      expect(result.userMessage).not.toContain('test@example.com');
      expect(result.userMessage).toContain('[REDACTED_EMAIL]');
    });

    test('redacts phone number in userMessage', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({ userMessage: 'Call me at 555-123-4567' });
      const result = await hook(ctx, 'intent_detection');
      expect(result.userMessage).not.toContain('555-123-4567');
      expect(result.userMessage).toContain('[REDACTED_PHONE]');
    });

    test('returns same context object when no PII found', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({ userMessage: 'I want to book a flight to Paris' });
      const result = await hook(ctx, 'intent_detection');
      expect(result).toBe(ctx); // same reference — no copy made
    });

    test('returns new context object when PII found', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({ userMessage: 'Email me at user@test.com' });
      const result = await hook(ctx, 'intent_detection');
      expect(result).not.toBe(ctx); // different reference
    });
  });

  // =========================================================================
  // CONTEXT PRESERVATION
  // =========================================================================

  describe('context preservation', () => {
    test('non-message fields are unchanged after redaction', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'My SSN is 123-45-6789',
        agentGoal: 'Verify identity',
        collectedData: { name: 'John', age: 30 },
        currentStep: 'verify',
        conversationPhase: 'collecting',
      });

      const result = await hook(ctx, 'intent_detection');

      // userMessage should be redacted
      expect(result.userMessage).not.toContain('123-45-6789');

      // All other fields should be identical
      expect(result.agentGoal).toBe('Verify identity');
      expect(result.collectedData).toEqual({ name: 'John', age: 30 });
      expect(result.currentStep).toBe('verify');
      expect(result.conversationPhase).toBe('collecting');
      expect(result.conversationHistory).toBe(ctx.conversationHistory);
    });
  });

  // =========================================================================
  // CONTEXT-AWARE EXEMPTIONS
  // =========================================================================

  describe('context-aware exemptions', () => {
    test('does not redact phone when missingFields includes a phone-type field', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'My phone is 555-123-4567',
        missingFields: ['phone_number'],
        declaredEntities: [{ name: 'phone_number', type: 'pattern', sensitive: true }],
      });
      const result = await hook(ctx, 'entity_extraction');
      expect(result.userMessage).toContain('555-123-4567');
    });

    test('redacts SSN even when gathering phone', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'Phone 555-123-4567, SSN 123-45-6789',
        missingFields: ['phone_number'],
        declaredEntities: [{ name: 'phone_number', type: 'pattern', sensitive: true }],
      });
      const result = await hook(ctx, 'entity_extraction');
      expect(result.userMessage).toContain('555-123-4567');
      expect(result.userMessage).toContain('[REDACTED_SSN]');
    });

    test('does not redact email when missingFields includes email-type field', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'My email is user@example.com',
        missingFields: ['contact_email'],
        declaredEntities: [{ name: 'contact_email', type: 'pattern', sensitive: true }],
      });
      const result = await hook(ctx, 'entity_extraction');
      expect(result.userMessage).toContain('user@example.com');
    });

    test('still redacts everything when no missingFields', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'My phone is 555-123-4567',
      });
      const result = await hook(ctx, 'entity_extraction');
      expect(result.userMessage).toContain('[REDACTED_PHONE]');
    });

    test('still redacts when missingFields is empty', async () => {
      const hook = createPIIGuardHook(makeConfig());
      const ctx = makeCtx({
        userMessage: 'My phone is 555-123-4567',
        missingFields: [],
      });
      const result = await hook(ctx, 'entity_extraction');
      expect(result.userMessage).toContain('[REDACTED_PHONE]');
    });
  });

  describe('custom recognizer registry', () => {
    test('redacts custom project patterns when a recognizer registry is supplied', async () => {
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-id',
          ['ContractID'],
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
          'ContractID',
          undefined,
          'custom',
        ),
      );

      const hook = createPIIGuardHook(makeConfig(), { recognizerRegistry: registry });
      const ctx = makeCtx({
        userMessage: 'Contract 780b4d1c-1166-487e-ae7a-27eedd12905b',
      });
      const result = await hook(ctx, 'intent_detection');

      expect(result.userMessage).toContain('[REDACTED_CONTRACT_ID]');
      expect(result.userMessage).not.toContain('780b4d1c-1166-487e-ae7a-27eedd12905b');
    });
  });
});
