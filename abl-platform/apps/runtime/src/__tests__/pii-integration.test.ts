/**
 * PII Phase 2 Integration Tests
 *
 * Tests the wired integration points in reasoning-executor:
 * - Output PII tokenization (reversible) and redaction (destructive fallback)
 * - Streaming chunk PII filtering
 * - Transient field cleanup on session end
 * - PIIVault lifecycle (init, clear)
 * - Per-tool PII access levels
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { PIIVault } from '@abl/compiler/platform/security/pii-vault.js';
import { filterOutputPII } from '../services/execution/output-pii-filter.js';
import { cleanupTransientFields } from '../services/execution/transient-cleanup.js';
import type { GatherField } from '@abl/compiler';

describe('PII Integration — Output Path', () => {
  let vault: PIIVault;
  const enabledConfig = { enabled: true, redactInput: true, redactOutput: true };
  const disabledConfig = { enabled: false, redactInput: false, redactOutput: false };

  beforeEach(() => {
    vault = new PIIVault();
  });

  test('reversible tokenization: history stores tokens, user sees masked', () => {
    const response = 'Your account is under user@example.com, phone 555-123-4567';

    // Tokenize for history
    const tokenized = vault.tokenize(response);
    expect(tokenized.tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokenized.text).not.toContain('user@example.com');
    expect(tokenized.text).toContain('{{PII:');

    // Render for user (masked)
    const userView = vault.renderForConsumer(tokenized.text, 'user');
    expect(userView).not.toContain('user@example.com');
    expect(userView).not.toContain('555-123-4567');
    expect(userView).not.toContain('{{PII:');
    expect(userView).toMatch(/\w\*{3}@example\.com/); // masked email
    expect(userView).toMatch(/\*{3}-\*{3}-\d{4}/); // masked phone

    // Render for logs (redacted)
    const logView = vault.renderForConsumer(tokenized.text, 'logs');
    expect(logView).toContain('[REDACTED_EMAIL]');
    expect(logView).toContain('[REDACTED_PHONE]');

    // Render for tools (safe redacted default)
    const toolView = vault.renderForConsumer(tokenized.text, 'tools');
    expect(toolView).toContain('[REDACTED_EMAIL]');
    expect(toolView).toContain('[REDACTED_PHONE]');
    expect(toolView).not.toContain('user@example.com');
    expect(toolView).not.toContain('555-123-4567');

    // Detokenize recovers original
    const restored = vault.detokenize(tokenized.text);
    expect(restored).toBe(response);
  });

  test('destructive fallback when vault not available', () => {
    const response = 'Your email is test@foo.com';
    const result = filterOutputPII(response, enabledConfig);
    expect(result.filtered).toBe(true);
    expect(result.text).not.toContain('test@foo.com');
    expect(result.text).toContain('[REDACTED_EMAIL]');
  });

  test('no filtering when config disabled', () => {
    const response = 'Your email is test@foo.com';
    const result = filterOutputPII(response, disabledConfig);
    expect(result.filtered).toBe(false);
    expect(result.text).toBe(response);
  });

  test('no filtering when response has no PII', () => {
    const response = 'Hello, how can I help you today?';
    const tokenized = vault.tokenize(response);
    expect(tokenized.tokens).toHaveLength(0);
    expect(tokenized.text).toBe(response);
  });
});

describe('PII Integration — Streaming Chunks', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  test('streaming chunk with PII is filtered via vault', () => {
    const chunk = 'I see your number is 555-987-6543';
    const tokenized = vault.tokenize(chunk);
    if (tokenized.tokens.length > 0) {
      const filtered = vault.renderForConsumer(tokenized.text, 'user');
      expect(filtered).not.toContain('555-987-6543');
      expect(filtered).toMatch(/\*{3}-\*{3}-\d{4}/);
    }
  });

  test('streaming chunk without PII passes through', () => {
    const chunk = 'Let me check that for you.';
    const tokenized = vault.tokenize(chunk);
    expect(tokenized.tokens).toHaveLength(0);
    expect(tokenized.text).toBe(chunk);
  });

  test('multiple chunks accumulate tokens in vault', () => {
    vault.tokenize('Email: a@b.com');
    vault.tokenize('Phone: 555-111-2222');
    expect(vault.getTokenCount()).toBeGreaterThanOrEqual(2);
  });
});

describe('PII Integration — Transient Cleanup', () => {
  test('transient fields removed on gather completion', () => {
    const data: Record<string, unknown> = {
      phone: '555-123-4567',
      cvv: '123',
      otp: '456789',
      name: 'John',
    };

    const fields: GatherField[] = [
      { name: 'phone', type: 'string', prompt: 'Phone?' },
      { name: 'cvv', type: 'string', prompt: 'CVV?', transient: true },
      { name: 'otp', type: 'string', prompt: 'OTP?', transient: true },
      { name: 'name', type: 'string', prompt: 'Name?' },
    ];

    const removed = cleanupTransientFields(data, fields);
    expect(removed).toContain('cvv');
    expect(removed).toContain('otp');
    expect(data.cvv).toBeUndefined();
    expect(data.otp).toBeUndefined();
    expect(data.phone).toBe('555-123-4567');
    expect(data.name).toBe('John');
  });

  test('no-op when no transient fields', () => {
    const data: Record<string, unknown> = { phone: '555-123-4567' };
    const fields: GatherField[] = [{ name: 'phone', type: 'string', prompt: 'Phone?' }];
    const removed = cleanupTransientFields(data, fields);
    expect(removed).toHaveLength(0);
    expect(data.phone).toBe('555-123-4567');
  });
});

describe('PII Integration — Vault Lifecycle', () => {
  test('vault initialized empty, populated after tokenize, cleared on complete', () => {
    const vault = new PIIVault();
    expect(vault.getTokenCount()).toBe(0);

    vault.tokenize('SSN: 123-45-6789');
    expect(vault.getTokenCount()).toBeGreaterThan(0);

    vault.clear();
    expect(vault.getTokenCount()).toBe(0);
  });

  test('detokenize returns tokens unchanged after clear', () => {
    const vault = new PIIVault();
    const result = vault.tokenize('Email: user@test.com');
    const tokenizedText = result.text;

    vault.clear();
    // After clear, detokenize cannot restore — returns token strings as-is
    const afterClear = vault.detokenize(tokenizedText);
    expect(afterClear).toBe(tokenizedText);
    expect(afterClear).toContain('{{PII:');
  });
});

describe('PII Integration — Per-Tool Access', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  test('tools consumer sees safe redacted values by default', () => {
    const { text } = vault.tokenize('Card: 4111-1111-1111-1111');
    const view = vault.renderForConsumer(text, 'tools');
    expect(view).toContain('[REDACTED_CARD]');
    expect(view).not.toContain('4111-1111-1111-1111');
  });

  test('user consumer sees masked values', () => {
    const { text } = vault.tokenize('Card: 4111-1111-1111-1111');
    const view = vault.renderForConsumer(text, 'user');
    expect(view).toContain('****-****-****-1111');
  });

  test('logs consumer sees redacted labels', () => {
    const { text } = vault.tokenize('Card: 4111-1111-1111-1111');
    const view = vault.renderForConsumer(text, 'logs');
    expect(view).toContain('[REDACTED_CARD]');
  });

  test('llm consumer sees tokens', () => {
    const { text } = vault.tokenize('Card: 4111-1111-1111-1111');
    const view = vault.renderForConsumer(text, 'llm');
    expect(view).toContain('{{PII:credit_card:');
  });

  test('restricted tool gets masked context vars', () => {
    // Simulate: session value has tokenized PII, tool has pii_access='user'
    const { text: tokenizedEmail } = vault.tokenize('user@example.com');

    // Tool with pii_access='user' should see masked
    const userView = vault.renderForConsumer(tokenizedEmail, 'user');
    expect(userView).not.toContain('user@example.com');
    expect(userView).toMatch(/\w?\*{3}@example\.com/);

    // Tool with pii_access='logs' should see redacted
    const logView = vault.renderForConsumer(tokenizedEmail, 'logs');
    expect(logView).toContain('[REDACTED_EMAIL]');

    // Default tool (pii_access='tools') should see the safe redacted view
    const toolView = vault.renderForConsumer(tokenizedEmail, 'tools');
    expect(toolView).toContain('[REDACTED_EMAIL]');
    expect(toolView).not.toContain('user@example.com');
  });
});
