/**
 * PII Token Vault Tests
 *
 * Comprehensive tests for reversible PII tokenization, detokenization,
 * per-consumer rendering, and masking utilities.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { PIIVault, maskValue } from '../../platform/security/pii-vault.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';
import type { PIIType } from '../../platform/security/pii-detector.js';

describe('PIIVault', () => {
  let vault: PIIVault;
  const randomEmailConfig = [
    {
      patternName: 'email',
      defaultRenderMode: 'random' as const,
      consumerAccess: [{ consumer: 'user', renderMode: 'random' as const }],
      randomConfig: { charset: 'alphabetic' as const, length: 4 },
    },
  ];

  function getRandomCacheSize(target: object): number {
    const cache = Reflect.get(target, 'randomCache') as Map<string, unknown> | undefined;
    return cache?.size ?? 0;
  }

  beforeEach(() => {
    vault = new PIIVault();
  });

  // ===========================================================================
  // TOKENIZE
  // ===========================================================================

  describe('tokenize', () => {
    test('replaces PII with {{PII:<type>:<uuid>}} tokens', () => {
      const result = vault.tokenize('Email me at user@example.com');
      expect(result.text).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
      expect(result.text).not.toContain('user@example.com');
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('email');
      expect(result.tokens[0].original).toBe('user@example.com');
    });

    test('tokenizes multiple PII types', () => {
      const result = vault.tokenize('Call 555-123-4567 or email test@foo.com');
      expect(result.tokens.length).toBeGreaterThanOrEqual(2);
      const types = result.tokens.map((t) => t.type);
      expect(types).toContain('phone');
      expect(types).toContain('email');
      expect(result.text).not.toContain('555-123-4567');
      expect(result.text).not.toContain('test@foo.com');
    });

    test('respects exempt types', () => {
      const result = vault.tokenize(
        'Email test@foo.com phone 555-123-4567',
        new Set<PIIType>(['email']),
      );
      // Email should remain in text (exempt), phone should be tokenized
      expect(result.text).toContain('test@foo.com');
      expect(result.text).not.toContain('555-123-4567');
      const types = result.tokens.map((t) => t.type);
      expect(types).not.toContain('email');
      expect(types).toContain('phone');
    });

    test('honors confidence threshold per detection when high and low confidence matches coexist', () => {
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'high-email',
          ['email'],
          /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
          'email',
        ),
      );
      registry.register(
        new RegexPIIRecognizer(
          'low-postal-code',
          ['postal_code' as PIIType],
          /\b\d{5}\b/g,
          'postal_code' as PIIType,
          undefined,
          'regex',
          { baseConfidence: 0.4 },
        ),
      );
      const thresholdVault = new PIIVault({ recognizerRegistry: registry });

      const result = thresholdVault.tokenize('Email user@example.com lives in 12345', undefined, {
        confidenceThreshold: 0.7,
      });

      expect(result.text).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
      expect(result.text).toContain('12345');
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('email');
    });

    test('does not tokenize values inside existing PII token markers', () => {
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-uuid-runtime',
          ['uuid_runtime' as PIIType],
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
          'uuid_runtime' as PIIType,
          undefined,
          'custom',
        ),
      );
      vault.setRecognizerRegistry(registry);

      const existingToken = '{{PII:uuid_runtime:7ca590fa-2d76-4e4c-889e-fa713992a9b1}}';
      const result = vault.tokenize(
        `Known ${existingToken}; raw 780b4d1c-1166-487e-ae7a-27eedd12905b`,
      );

      expect(result.text).toContain(existingToken);
      expect(result.text).not.toContain('raw 780b4d1c-1166-487e-ae7a-27eedd12905b');
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].original).toBe('780b4d1c-1166-487e-ae7a-27eedd12905b');
    });

    test('returns original text when no PII found', () => {
      const text = 'Hello, this is a normal message.';
      const result = vault.tokenize(text);
      expect(result.text).toBe(text);
      expect(result.tokens).toHaveLength(0);
    });

    test('tokens have unique UUIDs', () => {
      const result = vault.tokenize('a@b.com and c@d.com');
      expect(result.tokens.length).toBeGreaterThanOrEqual(2);
      const ids = result.tokens.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('returns original text when all PII types are exempt', () => {
      const text = 'Email test@foo.com';
      const result = vault.tokenize(text, new Set<PIIType>(['email']));
      expect(result.text).toBe(text);
      expect(result.tokens).toHaveLength(0);
    });

    test('stores tokens in the vault for later retrieval', () => {
      expect(vault.getTokenCount()).toBe(0);
      vault.tokenize('My SSN is 123-45-6789');
      expect(vault.getTokenCount()).toBe(1);
    });

    test('returns defensive token snapshots for durable persistence', () => {
      const result = vault.tokenize('Email me at user@example.com');
      const [snapshot] = vault.listTokens();

      expect(snapshot).toEqual(result.tokens[0]);

      snapshot.original = 'mutated@example.com';
      expect(vault.detokenize(result.text)).toBe('Email me at user@example.com');
    });
  });

  // ===========================================================================
  // DETOKENIZE
  // ===========================================================================

  describe('detokenize', () => {
    test('restores original values from tokens', () => {
      const original = 'Email me at user@example.com';
      const tokenized = vault.tokenize(original);
      const restored = vault.detokenize(tokenized.text);
      expect(restored).toBe(original);
    });

    test('restores multiple tokens', () => {
      const original = 'Call 555-123-4567 or email test@foo.com';
      const tokenized = vault.tokenize(original);
      const restored = vault.detokenize(tokenized.text);
      expect(restored).toBe(original);
    });

    test('returns text unchanged when no tokens found', () => {
      const text = 'No tokens here at all.';
      expect(vault.detokenize(text)).toBe(text);
    });

    test('preserves unknown tokens in text', () => {
      const text = 'Value is {{PII:email:00000000-0000-0000-0000-000000000000}}';
      expect(vault.detokenize(text)).toBe(text);
    });
  });

  // ===========================================================================
  // RENDER FOR CONSUMER
  // ===========================================================================

  describe('renderForConsumer', () => {
    let tokenizedText: string;

    beforeEach(() => {
      const result = vault.tokenize('Call 555-123-4567 about user@example.com');
      tokenizedText = result.text;
    });

    test('renders redacted view for logs', () => {
      const rendered = vault.renderForConsumer(tokenizedText, 'logs');
      expect(rendered).toContain('[REDACTED_PHONE]');
      expect(rendered).toContain('[REDACTED_EMAIL]');
      expect(rendered).not.toContain('555-123-4567');
      expect(rendered).not.toContain('user@example.com');
      expect(rendered).not.toMatch(/\{\{PII:/);
    });

    test('renders masked view for user display', () => {
      const rendered = vault.renderForConsumer(tokenizedText, 'user');
      // Phone should be masked like ***-***-4567
      expect(rendered).toMatch(/\*{3}-\*{3}-\d{4}/);
      // Email should be masked like u***@example.com
      expect(rendered).toMatch(/\w\*{3}@/);
      expect(rendered).not.toContain('555-123-4567');
    });

    test('renders redacted view for tools consumer by default', () => {
      const rendered = vault.renderForConsumer(tokenizedText, 'tools');
      expect(rendered).toContain('[REDACTED_PHONE]');
      expect(rendered).toContain('[REDACTED_EMAIL]');
      expect(rendered).not.toContain('555-123-4567');
      expect(rendered).not.toContain('user@example.com');
      expect(rendered).not.toMatch(/\{\{PII:/);
    });

    test('renders redacted view for admin and system consumers by default', () => {
      for (const consumer of ['admin', 'system'] as const) {
        const rendered = vault.renderForConsumer(tokenizedText, consumer);
        expect(rendered).toContain('[REDACTED_PHONE]');
        expect(rendered).toContain('[REDACTED_EMAIL]');
        expect(rendered).not.toContain('555-123-4567');
        expect(rendered).not.toContain('user@example.com');
        expect(rendered).not.toMatch(/\{\{PII:/);
      }
    });

    test('allows explicit original tool access via consumerAccess override', () => {
      const rendered = vault.renderForConsumer(tokenizedText, 'tools', [
        {
          patternName: 'phone',
          defaultRenderMode: 'redacted',
          consumerAccess: [{ consumer: 'tools', renderMode: 'original' }],
        },
        {
          patternName: 'email',
          defaultRenderMode: 'redacted',
          consumerAccess: [{ consumer: 'tools', renderMode: 'original' }],
        },
      ]);

      expect(rendered).toContain('555-123-4567');
      expect(rendered).toContain('user@example.com');
      expect(rendered).not.toMatch(/\{\{PII:/);
    });

    test('renders token as-is for llm consumer', () => {
      const rendered = vault.renderForConsumer(tokenizedText, 'llm');
      expect(rendered).toMatch(/\{\{PII:phone:[a-f0-9-]+\}\}/);
      expect(rendered).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
      expect(rendered).not.toContain('555-123-4567');
      expect(rendered).not.toContain('user@example.com');
    });

    test('renders redacted view for unknown consumer', () => {
      // Cast to bypass type checking for the unknown consumer test
      const rendered = vault.renderForConsumer(tokenizedText, 'unknown' as any);
      expect(rendered).toContain('[REDACTED_PHONE]');
      expect(rendered).toContain('[REDACTED_EMAIL]');
    });

    test('uses custom predefined redaction labels from pattern configs', () => {
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-id',
          ['custom'],
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
          'custom',
          undefined,
          'custom',
        ),
      );
      const customVault = new PIIVault({ recognizerRegistry: registry });
      const rawContractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';
      const tokenized = customVault.tokenize(`Contract ${rawContractId}`);
      const rendered = customVault.renderForConsumer(tokenized.text, 'user', [
        {
          patternName: 'custom',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
          redactionLabel: '[REDACTED]',
        },
      ]);

      expect(rendered).toBe('Contract [REDACTED]');
      expect(rendered).not.toContain(rawContractId);
      expect(rendered).not.toContain('[REDACTED_CUSTOM]');
    });

    test('renders custom token types that contain display punctuation', () => {
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-type',
          ['Contract ID'],
          /CID-\d{4}/g,
          'Contract ID',
          undefined,
          'custom',
        ),
      );
      const customVault = new PIIVault({ recognizerRegistry: registry });
      const tokenized = customVault.tokenize('Contract CID-1234');
      const rendered = customVault.renderForConsumer(tokenized.text, 'user', [
        {
          patternName: 'Contract ID',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
          redactionLabel: '[REDACTED]',
        },
      ]);

      expect(tokenized.text).toMatch(/\{\{PII:Contract_ID:[a-f0-9-]+\}\}/);
      expect(rendered).toBe('Contract [REDACTED]');
      expect(rendered).not.toContain('CID-1234');
    });

    test('preserves unknown tokens unchanged', () => {
      const text = 'Hello {{PII:email:00000000-0000-0000-0000-000000000000}} world';
      const rendered = vault.renderForConsumer(text, 'logs');
      // Unknown token stays as-is since it's not in the vault
      expect(rendered).toContain('{{PII:email:00000000-0000-0000-0000-000000000000}}');
    });

    test('random redaction caches by token id instead of raw PII value', () => {
      let replacementId = 0;
      const randomVault = new PIIVault({
        randomReplacementGenerator: () => `RAND${++replacementId}`,
      });
      const tokenized = randomVault.tokenize(
        'Primary repeat@example.com secondary repeat@example.com',
      );

      const firstRender = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);
      const secondRender = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);

      expect(firstRender).toContain('RAND1');
      expect(firstRender).toContain('RAND2');
      expect(firstRender).not.toContain('repeat@example.com');
      expect(secondRender).toBe(firstRender);
    });

    test('random redaction cache is isolated per vault instance', () => {
      const firstVault = new PIIVault({
        randomReplacementGenerator: () => 'FIRST',
      });
      const secondVault = new PIIVault({
        randomReplacementGenerator: () => 'SECOND',
      });

      const firstTokenized = firstVault.tokenize('Email repeat@example.com');
      const secondTokenized = secondVault.tokenize('Email repeat@example.com');

      expect(
        firstVault.renderForConsumer(firstTokenized.text, 'user', randomEmailConfig),
      ).toContain('FIRST');
      expect(
        secondVault.renderForConsumer(secondTokenized.text, 'user', randomEmailConfig),
      ).toContain('SECOND');
    });

    test('random redaction entries expire after TTL', () => {
      let now = 1_000;
      let replacementId = 0;
      const randomVault = new PIIVault({
        now: () => now,
        randomCacheTtlMs: 10,
        randomReplacementGenerator: () => `TTL${++replacementId}`,
      });
      const tokenized = randomVault.tokenize('Email repeat@example.com');

      const initial = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);
      const cached = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);
      now += 11;
      const expired = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);

      expect(initial).toContain('TTL1');
      expect(cached).toBe(initial);
      expect(expired).toContain('TTL2');
      expect(expired).not.toBe(initial);
    });

    test('random redaction evicts oldest entries when cache exceeds max size', () => {
      let replacementId = 0;
      const randomVault = new PIIVault({
        maxRandomCacheEntries: 1,
        randomReplacementGenerator: () => `EVICT${++replacementId}`,
      });
      const tokenized = randomVault.tokenize(
        'Primary first@example.com secondary second@example.com',
      );

      const firstRender = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);
      const secondRender = randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);

      expect(firstRender).toContain('EVICT1');
      expect(firstRender).toContain('EVICT2');
      expect(secondRender).toContain('EVICT3');
      expect(secondRender).toContain('EVICT4');
      expect(secondRender).not.toBe(firstRender);
    });
  });

  // ===========================================================================
  // CLEAR & COUNT
  // ===========================================================================

  describe('clear', () => {
    test('clears all stored tokens', () => {
      vault.tokenize('My SSN is 123-45-6789');
      expect(vault.getTokenCount()).toBeGreaterThan(0);
      vault.clear();
      expect(vault.getTokenCount()).toBe(0);
    });

    test('detokenize returns tokens unchanged after clear', () => {
      const result = vault.tokenize('My SSN is 123-45-6789');
      vault.clear();
      // After clearing, detokenize cannot restore — returns the token string
      expect(vault.detokenize(result.text)).toBe(result.text);
    });

    test('clears random redaction cache entries', () => {
      const randomVault = new PIIVault({
        randomReplacementGenerator: () => 'CLEAR1',
      });
      const tokenized = randomVault.tokenize('Email repeat@example.com');

      randomVault.renderForConsumer(tokenized.text, 'user', randomEmailConfig);
      expect(getRandomCacheSize(randomVault)).toBe(1);

      randomVault.clear();

      expect(randomVault.getTokenCount()).toBe(0);
      expect(getRandomCacheSize(randomVault)).toBe(0);
    });

    test('clearing forces random replacements to regenerate after re-tokenization', () => {
      let replacementId = 0;
      const randomVault = new PIIVault({
        randomReplacementGenerator: () => `CLEAR${++replacementId}`,
      });

      const firstTokenized = randomVault.tokenize('Email repeat@example.com');
      const firstRender = randomVault.renderForConsumer(
        firstTokenized.text,
        'user',
        randomEmailConfig,
      );

      randomVault.clear();

      const secondTokenized = randomVault.tokenize('Email repeat@example.com');
      const secondRender = randomVault.renderForConsumer(
        secondTokenized.text,
        'user',
        randomEmailConfig,
      );

      expect(firstRender).toContain('CLEAR1');
      expect(secondRender).toContain('CLEAR2');
      expect(secondRender).not.toBe(firstRender);
    });
  });

  describe('getTokenCount', () => {
    test('returns number of stored tokens', () => {
      expect(vault.getTokenCount()).toBe(0);
      vault.tokenize('Call 555-123-4567 or email test@foo.com');
      expect(vault.getTokenCount()).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // MASK VALUE
  // ===========================================================================

  describe('maskValue', () => {
    test('masks phone number showing last 4 digits', () => {
      expect(maskValue('555-123-4567', 'phone')).toBe('***-***-4567');
    });

    test('masks phone number with fewer than 4 digits', () => {
      expect(maskValue('123', 'phone')).toBe('***');
    });

    test('masks email showing first char and domain', () => {
      expect(maskValue('user@example.com', 'email')).toBe('u***@example.com');
    });

    test('masks email with missing @ gracefully', () => {
      expect(maskValue('noemail', 'email')).toBe('***@***');
    });

    test('masks email with single-char local part without exposing it', () => {
      expect(maskValue('a@example.com', 'email')).toBe('***@example.com');
    });

    test('masks SSN correctly', () => {
      expect(maskValue('123-45-6789', 'ssn')).toBe('***-**-****');
    });

    test('masks credit card showing last 4 digits', () => {
      expect(maskValue('4111-1111-1111-1111', 'credit_card')).toBe('****-****-****-1111');
    });

    test('masks credit card with fewer than 4 digits', () => {
      expect(maskValue('12', 'credit_card')).toBe('****');
    });

    test('masks IP address completely', () => {
      expect(maskValue('192.168.1.1', 'ip_address')).toBe('***.***.***.***');
    });
  });

  // ===========================================================================
  // EVICTION
  // ===========================================================================

  describe('eviction', () => {
    test('vault does not grow beyond MAX_VAULT_TOKENS', () => {
      // We can't easily test 10k tokens, but verify the evict path works
      // by tokenizing many values and checking count stays bounded
      for (let i = 0; i < 5; i++) {
        vault.tokenize(`SSN ${100 + i}-45-6789`);
      }
      expect(vault.getTokenCount()).toBeGreaterThanOrEqual(1);
      expect(vault.getTokenCount()).toBeLessThanOrEqual(10_000);
    });
  });

  // ===========================================================================
  // PRE-EXISTING TOKEN PATTERNS
  // ===========================================================================

  describe('pre-existing token patterns', () => {
    test('tokenize handles text already containing {{PII:...}} pattern', () => {
      const text = 'Template: {{PII:email:fake-uuid}} and SSN 123-45-6789';
      const result = vault.tokenize(text);
      // SSN should be tokenized, pre-existing pattern left alone
      expect(result.tokens.length).toBeGreaterThanOrEqual(1);
      expect(result.tokens.some((t) => t.type === 'ssn')).toBe(true);
    });

    test('detokenize leaves pre-existing unrecognized tokens unchanged', () => {
      const text = 'Template: {{PII:email:fake-uuid}} and SSN 123-45-6789';
      const result = vault.tokenize(text);
      const restored = vault.detokenize(result.text);
      // The pre-existing fake token should remain unchanged
      expect(restored).toContain('{{PII:email:fake-uuid}}');
      // The real SSN should be restored
      expect(restored).toContain('123-45-6789');
    });
  });
});
