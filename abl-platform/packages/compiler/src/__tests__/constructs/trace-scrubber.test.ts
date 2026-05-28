/**
 * Trace Scrubber Tests
 *
 * Verifies that sensitive data is redacted from tool call trace events.
 */

import { describe, it, expect } from 'vitest';
import {
  scrubToolCallData,
  scrubTraceEvent,
  redactEndpoint,
} from '../../platform/constructs/executors/trace-scrubber.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';

describe('Trace Scrubber', () => {
  describe('scrubToolCallData', () => {
    it('should redact Authorization header values', () => {
      const data = {
        headers: {
          Authorization: 'Bearer sk-abc123xyz',
          'Content-Type': 'application/json',
        },
      };
      const scrubbed = scrubToolCallData(data);
      expect((scrubbed.headers as any).Authorization).toBe('[REDACTED]');
      expect((scrubbed.headers as any)['Content-Type']).toBe('application/json');
    });

    it('should redact X-API-Key header values', () => {
      const data = {
        headers: {
          'X-API-Key': 'secret-key-value',
        },
      };
      const scrubbed = scrubToolCallData(data);
      expect((scrubbed.headers as any)['X-API-Key']).toBe('[REDACTED]');
    });

    it('should redact Bearer token patterns in any field', () => {
      const data = {
        token: 'Bearer eyJhbGciOiJIUzI1NiJ9.test',
        name: 'John',
      };
      const scrubbed = scrubToolCallData(data);
      expect(scrubbed.token).toBe('[REDACTED]');
      expect(scrubbed.name).toBe('John');
    });

    it('should redact secrets placeholders', () => {
      const data = {
        apiKey: '{{secrets.MY_KEY}}',
        endpoint: 'https://api.example.com',
      };
      const scrubbed = scrubToolCallData(data);
      expect(scrubbed.apiKey).toBe('[REDACTED]');
      expect(scrubbed.endpoint).toBe('https://api.example.com');
    });

    it('should handle nested objects', () => {
      const data = {
        config: {
          auth: {
            Authorization: 'Bearer token123',
          },
          url: 'https://api.example.com',
        },
      };
      const scrubbed = scrubToolCallData(data);
      expect((scrubbed.config as any).auth.Authorization).toBe('[REDACTED]');
      expect((scrubbed.config as any).url).toBe('https://api.example.com');
    });

    it('should handle arrays', () => {
      const data = {
        items: ['normal', 'Bearer secret-token', 'also normal'],
      };
      const scrubbed = scrubToolCallData(data);
      expect((scrubbed.items as any)[0]).toBe('normal');
      expect((scrubbed.items as any)[1]).toBe('[REDACTED]');
      expect((scrubbed.items as any)[2]).toBe('also normal');
    });

    it('should not modify non-string values', () => {
      const data = {
        count: 42,
        active: true,
        items: null,
      };
      const scrubbed = scrubToolCallData(data);
      expect(scrubbed.count).toBe(42);
      expect(scrubbed.active).toBe(true);
      expect(scrubbed.items).toBeNull();
    });

    it('should detect and redact email PII', () => {
      const data = {
        message: 'Contact user at john@example.com for details',
      };
      const scrubbed = scrubToolCallData(data);
      expect(scrubbed.message).not.toContain('john@example.com');
      expect(scrubbed.message).toContain('[REDACTED_EMAIL]');
    });
  });

  describe('scrubTraceEvent', () => {
    it('should scrub Bearer token mid-string (FR-3)', () => {
      const data = { headers: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.headers).toContain('Authorization:');
      expect(scrubbed.headers).toContain('[REDACTED]');
      expect(scrubbed.headers).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('should detect API key assignment pattern (FR-4)', () => {
      const data = { config: 'api_key=AKIAIOSFODNN7EXAMPLE1234' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.config).not.toContain('AKIAIOSFODNN7EXAMPLE1234');
      expect(scrubbed.config).toContain('[REDACTED]');
    });

    it('should detect sk- prefix (FR-5)', () => {
      const data = { key: 'sk-1234567890abcdefghijklmnop' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.key).toBe('[REDACTED]');
    });

    it('should detect pk_live_ prefix (FR-5)', () => {
      const data = { stripe: 'pk_live_abcdefghijklmnop123456' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.stripe).toBe('[REDACTED]');
    });

    it('should detect ghp_ prefix (FR-5)', () => {
      const data = { githubToken: 'ghp_abc123def456ghi789jkl012mno' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.githubToken).toBe('[REDACTED]');
    });

    it('should detect abl_ prefix (FR-5)', () => {
      const data = { platformKey: 'abl_sk1234567890abcdefghij' };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.platformKey).toBe('[REDACTED]');
    });

    it('should redact values for secret key names (FR-6)', () => {
      const data = {
        password: 'mySecret123',
        api_secret: 'abc',
        token: 'xyz',
        username: 'john',
      };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.password).toBe('[REDACTED]');
      expect(scrubbed.api_secret).toBe('[REDACTED]');
      expect(scrubbed.token).toBe('[REDACTED]');
      expect(scrubbed.username).toBe('john');
    });

    it('should traverse nested objects with secret key names (FR-6)', () => {
      const data = {
        level1: { level2: { secret_key: 'hidden', safe: 'visible' } },
      };
      const scrubbed = scrubTraceEvent(data);
      const nested = (scrubbed.level1 as any).level2;
      expect(nested.secret_key).toBe('[REDACTED]');
      expect(nested.safe).toBe('visible');
    });

    it('should traverse arrays with secret key names (FR-6)', () => {
      const data = {
        items: [{ password: 'a' }, { password: 'b' }, { name: 'c' }],
      };
      const scrubbed = scrubTraceEvent(data);
      const items = scrubbed.items as any[];
      expect(items[0].password).toBe('[REDACTED]');
      expect(items[1].password).toBe('[REDACTED]');
      expect(items[2].name).toBe('c');
    });

    it('should be idempotent — already-redacted values unchanged (FR-9)', () => {
      const data = {
        email: '[REDACTED_EMAIL]',
        bearerStr: 'Bearer [REDACTED]',
        card: '[REDACTED_CARD]',
      };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.email).toBe('[REDACTED_EMAIL]');
      expect(scrubbed.bearerStr).toBe('Bearer [REDACTED]');
      expect(scrubbed.card).toBe('[REDACTED_CARD]');
    });

    it('should handle null, undefined, and empty input gracefully (FR-8)', () => {
      const empty = scrubTraceEvent({});
      expect(empty).toEqual({});

      const withNull = scrubTraceEvent({ data: null } as any);
      expect(withNull.data).toBeNull();

      const withEmpty = scrubTraceEvent({ data: '' });
      expect(withEmpty.data).toBe('');
    });

    it('should scrub custom project patterns when a recognizer registry is supplied', () => {
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

      const scrubbed = scrubTraceEvent(
        {
          contractId: '780b4d1c-1166-487e-ae7a-27eedd12905b',
        },
        { piiRecognizerRegistry: registry },
      );

      expect(scrubbed.contractId).toBe('[REDACTED_CONTRACT_ID]');
    });

    it('should complete in <1ms for typical trace event (FR-10)', () => {
      const data: Record<string, unknown> = {
        type: 'decision',
        decisionKind: 'model_selection',
        reasoning: 'Selected gpt-4 for complexity',
        config: {
          model: 'gpt-4',
          temperature: 0.7,
          provider: { name: 'openai', region: 'us-east' },
        },
        context: {
          sessionId: 'abc-123',
          turnCount: 5,
          history: ['msg1', 'msg2', 'msg3'],
        },
        metadata: { timestamp: '2026-01-01', version: '1.0' },
      };
      const warmupIterations = 100;
      const measuredIterations = 1000;

      for (let i = 0; i < warmupIterations; i++) {
        scrubTraceEvent(data);
      }

      const start = performance.now();
      for (let i = 0; i < measuredIterations; i++) {
        scrubTraceEvent(data);
      }
      const elapsed = (performance.now() - start) / measuredIterations;
      expect(elapsed).toBeLessThan(1); // <1ms per call
    });
  });

  describe('redactEndpoint', () => {
    it('should strip query parameters from URL', () => {
      const url = 'https://api.example.com/search?api_key=secret&q=test';
      expect(redactEndpoint(url)).toBe('https://api.example.com/search?[QUERY_REDACTED]');
    });

    it('should preserve URL without query params', () => {
      const url = 'https://api.example.com/items/123';
      expect(redactEndpoint(url)).toBe('https://api.example.com/items/123');
    });

    it('should handle invalid URLs gracefully', () => {
      expect(redactEndpoint('not-a-url')).toBe('not-a-url');
    });
  });
});
