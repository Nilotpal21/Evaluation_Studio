/**
 * Trace Scrubber — Event-Type Integration Tests
 *
 * Verifies scrubTraceEvent() correctly scrubs realistic payloads for each
 * trace event type: decision, error, tool_call, agent_enter, agent_exit,
 * constraint_check, handoff, and custom events.
 *
 * These tests exercise the scrubbing logic with production-shaped data,
 * covering INT-1 through INT-7 from the test spec. The storage/WebSocket
 * verification (TraceStore → MongoDB, WebSocket delivery) requires a running
 * Runtime + MongoDB + Redis stack and is deferred to runtime integration tests.
 *
 * Covers: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-9
 */

import { describe, it, expect } from 'vitest';
import { scrubTraceEvent } from '../../platform/constructs/executors/trace-scrubber.js';

describe('scrubTraceEvent — event-type scenarios', () => {
  // =========================================================================
  // INT-1: Decision event with API key is scrubbed
  // =========================================================================
  describe('INT-1: decision event with API key', () => {
    it('scrubs API key from decision reasoning', () => {
      const data = {
        type: 'model_selection',
        decisionKind: 'model_selection',
        reasoning: 'Using api_key=sk-test1234567890abcdef for auth',
        outcome: 'gpt-4',
        agentName: 'support',
      };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.reasoning).not.toContain('sk-test1234567890abcdef');
      expect(scrubbed.reasoning).toContain('[REDACTED]');
      // Non-sensitive fields preserved
      expect(scrubbed.outcome).toBe('gpt-4');
      expect(scrubbed.agentName).toBe('support');
      expect(scrubbed.decisionKind).toBe('model_selection');
    });

    it('scrubs nested credentials in decision config', () => {
      const data = {
        decisionKind: 'provider_selection',
        config: {
          provider: {
            apiKey: 'sk-abcdefghijklmnopqrstuvwxyz1234',
            name: 'openai',
          },
        },
        metadata: {
          tokens: ['ghp_abc123def456ghi789jkl012mno', 'pk_live_abcdef1234567890123456'],
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const config = scrubbed.config as Record<string, unknown>;
      const provider = config.provider as Record<string, unknown>;
      expect(provider.apiKey).toBe('[REDACTED]');
      expect(provider.name).toBe('openai');
      const metadata = scrubbed.metadata as Record<string, unknown>;
      const tokens = metadata.tokens as string[];
      expect(tokens[0]).toBe('[REDACTED]');
      expect(tokens[1]).toBe('[REDACTED]');
    });
  });

  // =========================================================================
  // INT-2: Error event with email and Bearer token is scrubbed
  // =========================================================================
  describe('INT-2: error event with email and Bearer token', () => {
    it('scrubs email and Bearer token from error details', () => {
      const data = {
        errorType: 'auth_failure',
        message:
          'Authentication failed for user@example.com with token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
        stack: 'Error: auth failed\n  at auth.ts:42',
      };
      const scrubbed = scrubTraceEvent(data);
      const msg = scrubbed.message as string;
      expect(msg).not.toContain('user@example.com');
      expect(msg).toContain('[REDACTED_EMAIL]');
      expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(msg).toContain('[REDACTED]');
      // Error metadata preserved
      expect(scrubbed.errorType).toBe('auth_failure');
    });

    it('scrubs SSN from error message', () => {
      const data = {
        errorType: 'validation',
        message: 'Invalid SSN format: 123-45-6789 provided by customer',
      };
      const scrubbed = scrubTraceEvent(data);
      expect(scrubbed.message).not.toContain('123-45-6789');
      expect(scrubbed.message).toContain('[REDACTED_SSN]');
    });
  });

  // =========================================================================
  // INT-3: scrubPII=false skips scrubbing (tested at TraceEmitter level)
  // This test verifies that scrubTraceEvent itself ALWAYS scrubs — the
  // scrubPII flag is checked by emit(), not by scrubTraceEvent.
  // =========================================================================
  describe('INT-3: scrubTraceEvent always scrubs (flag is in emit())', () => {
    it('scrubTraceEvent scrubs regardless — flag is external', () => {
      const data = {
        errorType: 'auth_failure',
        message: 'Failed for user@example.com',
      };
      const scrubbed = scrubTraceEvent(data);
      // scrubTraceEvent always scrubs — the scrubPII check is in emit()
      expect(scrubbed.message).not.toContain('user@example.com');
      expect(scrubbed.message).toContain('[REDACTED_EMAIL]');
    });
  });

  // =========================================================================
  // INT-4: Double-scrubbing is idempotent for tool_call events
  // =========================================================================
  describe('INT-4: idempotent double-scrubbing for tool_call', () => {
    it('produces same result when scrubbed twice', () => {
      const data = {
        toolName: 'lookup',
        input: { email: 'a@b.com', query: 'find user' },
        output: { result: 'found', details: 'Bearer eyJhbGciOiJIUzI1NiJ9.token' },
        success: true,
        latencyMs: 10,
      };
      const firstPass = scrubTraceEvent(data);
      const secondPass = scrubTraceEvent(firstPass as Record<string, unknown>);

      // Both passes produce identical output
      expect(secondPass).toEqual(firstPass);

      // Verify actual redaction happened
      const input = firstPass.input as Record<string, unknown>;
      expect(input.email).not.toContain('a@b.com');
      expect(input.email).toContain('[REDACTED_EMAIL]');
      const output = firstPass.output as Record<string, unknown>;
      expect(output.details).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('does not produce double-encoded patterns', () => {
      const alreadyScrubbed = {
        email: '[REDACTED_EMAIL]',
        // 'token' is a secret key name → entire value is redacted
        token: 'Bearer [REDACTED]',
        card: '[REDACTED_CARD]',
        ssn: '[REDACTED_SSN]',
        password: '[REDACTED]',
        // Use a non-secret key name to test Bearer idempotency
        headerValue: 'Bearer [REDACTED]',
      };
      const result = scrubTraceEvent(alreadyScrubbed);
      // password and token are secret key names → full [REDACTED]
      expect(result.password).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.email).toBe('[REDACTED_EMAIL]');
      // headerValue is NOT a secret key name, so Bearer [REDACTED] passes through
      expect(result.headerValue).toBe('Bearer [REDACTED]');
      expect(result.card).toBe('[REDACTED_CARD]');
      expect(result.ssn).toBe('[REDACTED_SSN]');
      // No double-encoding like [REDACTED_[REDACTED_EMAIL]]
      const json = JSON.stringify(result);
      expect(json).not.toContain('[REDACTED_[');
      expect(json).not.toContain('REDACTED][REDACTED');
    });
  });

  // =========================================================================
  // INT-5: Key prefix patterns detected across nested objects
  // =========================================================================
  describe('INT-5: key prefix patterns in nested objects', () => {
    it('scrubs sk-, ghp_, pk_live_ at all nesting levels', () => {
      const data = {
        config: {
          provider: {
            apiKey: 'sk-abcdefghijklmnopqrstuvwxyz1234',
            name: 'openai',
          },
        },
        metadata: {
          tokens: ['ghp_abc123def456ghi789jkl012mno', 'pk_live_abcdef1234567890123456'],
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const config = scrubbed.config as Record<string, Record<string, unknown>>;
      expect(config.provider.apiKey).toBe('[REDACTED]');
      expect(config.provider.name).toBe('openai');
      const metadata = scrubbed.metadata as Record<string, string[]>;
      expect(metadata.tokens[0]).toBe('[REDACTED]');
      expect(metadata.tokens[1]).toBe('[REDACTED]');
    });

    it('scrubs abl_ and AKIA prefixes in deeply nested structures', () => {
      const data = {
        level1: {
          level2: {
            level3: {
              platformKey: 'abl_sk1234567890abcdefghij',
              awsKey: 'AKIAIOSFODNN7EXAMPLE1',
              safeValue: 'hello world',
            },
          },
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const l3 = ((scrubbed.level1 as Record<string, unknown>).level2 as Record<string, unknown>)
        .level3 as Record<string, unknown>;
      expect(l3.platformKey).toBe('[REDACTED]');
      expect(l3.awsKey).toContain('[REDACTED]');
      expect(l3.safeValue).toBe('hello world');
    });

    it('scrubs gho_ (GitHub OAuth) tokens', () => {
      const data = {
        auth: {
          githubOAuth: 'gho_abc123def456ghi789jkl012mno',
          provider: 'github',
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const auth = scrubbed.auth as Record<string, unknown>;
      expect(auth.githubOAuth).toBe('[REDACTED]');
      expect(auth.provider).toBe('github');
    });
  });

  // =========================================================================
  // INT-6: Agent enter/exit events are scrubbed
  // =========================================================================
  describe('INT-6: agent_enter and agent_exit events', () => {
    it('scrubs phone number from agent_enter context', () => {
      const data = {
        agentName: 'support',
        context: {
          userPhone: '+1-555-123-4567',
          sessionId: 'abc-123',
          issue: 'billing question',
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const ctx = scrubbed.context as Record<string, unknown>;
      expect(ctx.userPhone).not.toContain('555-123-4567');
      expect(ctx.userPhone).toContain('[REDACTED');
      // Non-PII preserved
      expect(ctx.sessionId).toBe('abc-123');
      expect(ctx.issue).toBe('billing question');
      expect(scrubbed.agentName).toBe('support');
    });

    it('scrubs email from agent_exit result', () => {
      const data = {
        agentName: 'support',
        result: {
          summary: 'Helped user at user@corp.com with password reset',
          resolved: true,
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const result = scrubbed.result as Record<string, unknown>;
      expect(result.summary).not.toContain('user@corp.com');
      expect(result.summary).toContain('[REDACTED_EMAIL]');
      expect(result.resolved).toBe(true);
    });

    it('scrubs credentials from agent context', () => {
      const data = {
        agentName: 'api-caller',
        context: {
          credentials: {
            token: 'Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig',
            api_secret: 'super-secret-value-12345678',
          },
          targetService: 'payment-api',
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const ctx = scrubbed.context as Record<string, Record<string, unknown>>;
      // 'token' is a secret key name → redacted
      expect(ctx.credentials.token).toBe('[REDACTED]');
      // 'api_secret' is a secret key name → redacted
      expect(ctx.credentials.api_secret).toBe('[REDACTED]');
      expect(ctx.targetService).toBe('payment-api');
    });
  });

  // =========================================================================
  // INT-7: Constraint check events with sensitive rule data
  // =========================================================================
  describe('INT-7: constraint_check events', () => {
    it('scrubs SSN and credit card from constraint input', () => {
      const data = {
        constraint: 'pii_guard',
        input: 'My SSN is 123-45-6789 and card is 4111111111111111',
        passed: false,
        details: { matched: ['ssn', 'credit_card'] },
      };
      const scrubbed = scrubTraceEvent(data);
      const input = scrubbed.input as string;
      expect(input).not.toContain('123-45-6789');
      expect(input).toContain('[REDACTED_SSN]');
      expect(input).not.toContain('4111111111111111');
      expect(input).toContain('[REDACTED_CARD]');
      // Constraint metadata preserved
      expect(scrubbed.constraint).toBe('pii_guard');
      expect(scrubbed.passed).toBe(false);
    });

    it('scrubs Bearer token from guardrail evaluation', () => {
      const data = {
        constraint: 'auth_leak_guard',
        input: 'The API returns Authorization: Bearer sk-proj-abc123def456ghi789jkl',
        passed: false,
        violation: 'credential_leak',
      };
      const scrubbed = scrubTraceEvent(data);
      const input = scrubbed.input as string;
      expect(input).not.toContain('sk-proj-abc123def456ghi789jkl');
      expect(input).toContain('[REDACTED]');
      expect(scrubbed.violation).toBe('credential_leak');
    });
  });

  // =========================================================================
  // Additional: handoff events (E2E-6 scenario at unit level)
  // =========================================================================
  describe('handoff events with sensitive context', () => {
    it('scrubs SSN from handoff context', () => {
      const data = {
        fromAgent: 'intake',
        toAgent: 'specialist',
        reason: 'escalation',
        context: {
          patientInfo: 'patient SSN: 123-45-6789',
          caseId: 'CASE-001',
        },
      };
      const scrubbed = scrubTraceEvent(data);
      const ctx = scrubbed.context as Record<string, unknown>;
      expect(ctx.patientInfo).not.toContain('123-45-6789');
      expect(ctx.patientInfo).toContain('[REDACTED_SSN]');
      expect(ctx.caseId).toBe('CASE-001');
      expect(scrubbed.fromAgent).toBe('intake');
      expect(scrubbed.toAgent).toBe('specialist');
    });
  });

  // =========================================================================
  // Additional: custom events
  // =========================================================================
  describe('custom events with mixed sensitive data', () => {
    it('scrubs mixed PII and secrets from custom event payload', () => {
      const data = {
        customField: 'User john@example.com called API with key sk-abcdefghij1234567890',
        metadata: {
          password: 'supersecret',
          username: 'john',
          client_secret: 'cs_live_abc123',
          requestId: 'req-123',
        },
      };
      const scrubbed = scrubTraceEvent(data);
      // Email scrubbed
      expect(scrubbed.customField).not.toContain('john@example.com');
      // SK key scrubbed
      expect(scrubbed.customField).not.toContain('sk-abcdefghij1234567890');
      // Secret key names scrubbed
      const meta = scrubbed.metadata as Record<string, unknown>;
      expect(meta.password).toBe('[REDACTED]');
      expect(meta.client_secret).toBe('[REDACTED]');
      // Non-sensitive preserved
      expect(meta.username).toBe('john');
      expect(meta.requestId).toBe('req-123');
    });

    it('scrubs Luhn-valid credit cards but not arbitrary digit sequences (FR-7)', () => {
      const data = {
        userInput: 'My card is 1234 5678 9012 3456',
        reference: 'Valid Visa: 4111 1111 1111 1111',
      };
      const scrubbed = scrubTraceEvent(data);
      // 1234567890123456 fails Luhn — preserved (could be order ID, tracking number)
      expect(scrubbed.userInput).toContain('1234 5678 9012 3456');
      // 4111111111111111 passes Luhn — redacted
      expect(scrubbed.reference).not.toContain('4111 1111 1111 1111');
    });
  });
});
