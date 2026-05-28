/**
 * Trace Emitter — Masking Storage Verification Tests (INT-1 to INT-7)
 *
 * Verifies that TraceEmitter.emit() scrubs sensitive data from ALL event types
 * before storage (TraceStore) and transmission (WebSocket).
 *
 * Uses dependency injection — createTraceEmitter() accepts a WebSocket object,
 * so we provide a fake WS with a send() spy. TraceStore uses its in-memory
 * implementation (no MongoDB needed).
 *
 * Covers: INT-1 through INT-7 from the test spec.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import { createTraceEmitter } from '../services/trace-emitter';
import { getTraceStore, resetTraceStore } from '../services/trace-store';

// ---------------------------------------------------------------------------
// Fake WebSocket (DI, NOT mocking)
// ---------------------------------------------------------------------------

interface CapturedMessage {
  type: string;
  sessionId: string;
  event: {
    id: string;
    sessionId: string;
    type: string;
    data: Record<string, unknown>;
    [key: string]: unknown;
  };
}

function createFakeWebSocket() {
  const messages: CapturedMessage[] = [];

  return {
    /** Mimic ws.OPEN constant */
    OPEN: 1 as const,
    /** Must equal OPEN for send() to fire */
    readyState: 1 as number,
    /** Capture JSON messages */
    send(raw: string) {
      messages.push(JSON.parse(raw) as CapturedMessage);
    },
    /** Retrieve captured messages */
    get messages() {
      return messages;
    },
    /** Last captured message */
    get lastMessage(): CapturedMessage | undefined {
      return messages[messages.length - 1];
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('TraceEmitter — masking storage verification (INT-1 to INT-7)', () => {
  const TEST_SESSION_ID = 'test-session-masking';

  let fakeWs: ReturnType<typeof createFakeWebSocket>;
  let traceStore: ReturnType<typeof getTraceStore>;

  beforeEach(() => {
    resetTraceStore();
    fakeWs = createFakeWebSocket();
    traceStore = getTraceStore();
  });

  afterEach(() => {
    try {
      traceStore.removeSession(TEST_SESSION_ID);
    } catch {
      /* session may not exist */
    }
    resetTraceStore();
  });

  // =========================================================================
  // INT-1: emit() scrubs decision event data
  // =========================================================================
  describe('INT-1: emit() scrubs decision event data', () => {
    it('scrubs API key from decision reasoning in both TraceStore and WebSocket', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'decision',
        timestamp: new Date(),
        data: {
          decisionKind: 'model_selection',
          reasoning: 'Using api_key=sk-test1234567890abcdefghijk for auth',
          outcome: 'gpt-4',
          agentName: 'support',
        },
      });

      // Verify TraceStore
      const storedEvents = traceStore.getEvents(TEST_SESSION_ID) as Array<{
        data: Record<string, unknown>;
      }>;
      expect(storedEvents).toHaveLength(1);
      const storedData = storedEvents[0].data;
      expect(storedData.reasoning).not.toContain('sk-test1234567890abcdefghijk');
      expect(storedData.reasoning).toContain('[REDACTED]');
      expect(storedData.outcome).toBe('gpt-4');
      expect(storedData.agentName).toBe('support');

      // Verify WebSocket
      expect(fakeWs.messages).toHaveLength(1);
      const wsData = fakeWs.lastMessage!.event.data;
      expect(wsData.reasoning).not.toContain('sk-test1234567890abcdefghijk');
      expect(wsData.reasoning).toContain('[REDACTED]');
      expect(wsData.outcome).toBe('gpt-4');
    });

    it('scrubs nested credentials in decision config', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'decision',
        timestamp: new Date(),
        data: {
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
        },
      });

      // Verify WebSocket (same scrubbed data as TraceStore — single scrub point)
      const wsData = fakeWs.lastMessage!.event.data;
      const config = wsData.config as Record<string, Record<string, unknown>>;
      expect(config.provider.apiKey).toBe('[REDACTED]');
      expect(config.provider.name).toBe('openai');
      const metadata = wsData.metadata as Record<string, string[]>;
      expect(metadata.tokens[0]).toBe('[REDACTED]');
      expect(metadata.tokens[1]).toBe('[REDACTED]');

      // Verify TraceStore agrees
      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const storedConfig = stored.config as Record<string, Record<string, unknown>>;
      expect(storedConfig.provider.apiKey).toBe('[REDACTED]');
    });
  });

  // =========================================================================
  // INT-2: emit() scrubs error event data
  // =========================================================================
  describe('INT-2: emit() scrubs error event data', () => {
    it('scrubs email and Bearer token from error message', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logError({
        errorType: 'auth_failure',
        message:
          'Authentication failed for user@example.com with token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
      });

      // Verify TraceStore
      const storedEvents = traceStore.getEvents(TEST_SESSION_ID) as Array<{
        data: Record<string, unknown>;
      }>;
      expect(storedEvents).toHaveLength(1);
      const msg = storedEvents[0].data.message as string;
      expect(msg).not.toContain('user@example.com');
      expect(msg).toContain('[REDACTED_EMAIL]');
      expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(msg).toContain('[REDACTED]');
      expect(storedEvents[0].data.errorType).toBe('auth_failure');

      // Verify WebSocket
      const wsMsg = fakeWs.lastMessage!.event.data.message as string;
      expect(wsMsg).not.toContain('user@example.com');
      expect(wsMsg).toContain('[REDACTED_EMAIL]');
      expect(wsMsg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('scrubs SSN from error message', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logError({
        errorType: 'validation',
        message: 'Invalid SSN format: 123-45-6789 provided by customer',
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      expect(stored.message).not.toContain('123-45-6789');
      expect(stored.message).toContain('[REDACTED_SSN]');

      const wsMsg = fakeWs.lastMessage!.event.data.message as string;
      expect(wsMsg).not.toContain('123-45-6789');
      expect(wsMsg).toContain('[REDACTED_SSN]');
    });
  });

  // =========================================================================
  // INT-3: emit() does NOT scrub when scrubPII=false
  // =========================================================================
  describe('INT-3: emit() does not scrub when scrubPII=false', () => {
    it('preserves raw PII when scrubbing is disabled', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: false,
      });

      emitter.logError({
        errorType: 'auth_failure',
        message: 'Failed for user@example.com with Bearer eyJhbGciOiJIUzI1NiJ9.test',
      });

      // TraceStore should have raw data
      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      expect(stored.message).toContain('user@example.com');
      expect(stored.message).toContain('eyJhbGciOiJIUzI1NiJ9');

      // WebSocket should have raw data
      const wsMsg = fakeWs.lastMessage!.event.data.message as string;
      expect(wsMsg).toContain('user@example.com');
      expect(wsMsg).toContain('eyJhbGciOiJIUzI1NiJ9');
    });
  });

  // =========================================================================
  // INT-4: Double-scrubbing is idempotent for tool_call events
  // =========================================================================
  describe('INT-4: idempotent double-scrubbing for tool_call', () => {
    it('logToolCall scrubs first, then emit() scrubs again — result is identical', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logToolCall({
        toolName: 'lookup',
        input: { email: 'a@b.com', query: 'find user' },
        output: { result: 'found', details: 'Bearer eyJhbGciOiJIUzI1NiJ9.token' },
        success: true,
        latencyMs: 10,
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const input = stored.input as Record<string, unknown>;
      const output = stored.output as Record<string, unknown>;

      // Email is redacted
      expect(input.email).not.toContain('a@b.com');
      expect(input.email).toContain('[REDACTED_EMAIL]');
      // Non-sensitive preserved
      expect(input.query).toBe('find user');
      // Bearer token is redacted
      expect(output.details).not.toContain('eyJhbGciOiJIUzI1NiJ9');

      // No double-encoding
      const json = JSON.stringify(stored);
      expect(json).not.toContain('[REDACTED_[');
      expect(json).not.toContain('REDACTED][REDACTED');

      // WebSocket matches TraceStore
      const wsData = fakeWs.lastMessage!.event.data;
      const wsInput = wsData.input as Record<string, unknown>;
      expect(wsInput.email).toContain('[REDACTED_EMAIL]');
    });
  });

  it('scrubs custom project patterns when a session registry is provided', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
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

    const emitter = createTraceEmitter({
      sessionId: TEST_SESSION_ID,
      ws: fakeWs as unknown as import('ws').WebSocket,
      scrubPII: true,
      piiRecognizerRegistry: registry,
    });

    emitter.logLLMCall({
      model: 'gpt-4.1-mini',
      messagesIn: 1,
      tokensIn: 10,
      tokensOut: 8,
      latencyMs: 15,
      messages: [{ role: 'user', content: `Contract ${rawContractId}` }],
      response: `Contract ${rawContractId}`,
    });

    const stored = (
      traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
    )[0].data;
    const storedMessages = stored.messages as Array<{ content: string }>;
    expect(storedMessages[0].content).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(stored.response).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(stored)).not.toContain(rawContractId);

    const wsData = fakeWs.lastMessage!.event.data;
    expect(JSON.stringify(wsData)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(wsData)).not.toContain(rawContractId);
  });

  // =========================================================================
  // INT-5: Key prefix patterns detected across nested objects
  // =========================================================================
  describe('INT-5: key prefix patterns in nested objects via emit()', () => {
    it('scrubs sk-, ghp_, pk_live_, abl_, AKIA in deeply nested event data', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'decision',
        timestamp: new Date(),
        data: {
          config: {
            provider: {
              apiKey: 'sk-abcdefghijklmnopqrstuvwxyz1234',
              name: 'openai',
            },
          },
          metadata: {
            tokens: ['ghp_abc123def456ghi789jkl012mno', 'pk_live_abcdef1234567890123456'],
          },
          level1: {
            level2: {
              level3: {
                platformKey: 'abl_sk1234567890abcdefghij',
                awsKey: 'AKIAIOSFODNN7EXAMPLE1',
                safeValue: 'hello world',
              },
            },
          },
        },
      });

      // Verify via TraceStore
      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;

      const config = stored.config as Record<string, Record<string, unknown>>;
      expect(config.provider.apiKey).toBe('[REDACTED]');
      expect(config.provider.name).toBe('openai');

      const metadata = stored.metadata as Record<string, string[]>;
      expect(metadata.tokens[0]).toBe('[REDACTED]');
      expect(metadata.tokens[1]).toBe('[REDACTED]');

      const l1 = stored.level1 as Record<string, Record<string, Record<string, unknown>>>;
      expect(l1.level2.level3.platformKey).toBe('[REDACTED]');
      expect(l1.level2.level3.awsKey).toContain('[REDACTED]');
      expect(l1.level2.level3.safeValue).toBe('hello world');

      // Verify via WebSocket
      const wsData = fakeWs.lastMessage!.event.data;
      const wsConfig = wsData.config as Record<string, Record<string, unknown>>;
      expect(wsConfig.provider.apiKey).toBe('[REDACTED]');
    });

    it('scrubs gho_ (GitHub OAuth) tokens via emit()', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'decision',
        timestamp: new Date(),
        data: {
          auth: {
            githubOAuth: 'gho_abc123def456ghi789jkl012mno',
            provider: 'github',
          },
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const auth = stored.auth as Record<string, unknown>;
      expect(auth.githubOAuth).toBe('[REDACTED]');
      expect(auth.provider).toBe('github');
    });
  });

  // =========================================================================
  // INT-6: Agent enter/exit events are scrubbed
  // =========================================================================
  describe('INT-6: agent_enter and agent_exit events scrubbed via emit()', () => {
    it('scrubs phone number from agent_enter context', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      // Use direct emit() with agent_enter data containing PII
      emitter.emit({
        type: 'agent_enter',
        timestamp: new Date(),
        data: {
          agentName: 'support',
          context: {
            userPhone: '+1-555-123-4567',
            sessionId: 'abc-123',
            issue: 'billing question',
          },
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const ctx = stored.context as Record<string, unknown>;
      expect(ctx.userPhone).not.toContain('555-123-4567');
      expect(ctx.userPhone).toContain('[REDACTED');
      expect(ctx.sessionId).toBe('abc-123');
      expect(ctx.issue).toBe('billing question');
      expect(stored.agentName).toBe('support');

      // Verify WebSocket
      const wsCtx = fakeWs.lastMessage!.event.data.context as Record<string, unknown>;
      expect(wsCtx.userPhone).not.toContain('555-123-4567');
      expect(wsCtx.sessionId).toBe('abc-123');
    });

    it('scrubs email from agent_exit result', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'agent_exit',
        timestamp: new Date(),
        data: {
          agentName: 'support',
          result: {
            summary: 'Helped user at user@corp.com with password reset',
            resolved: true,
          },
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const result = stored.result as Record<string, unknown>;
      expect(result.summary).not.toContain('user@corp.com');
      expect(result.summary).toContain('[REDACTED_EMAIL]');
      expect(result.resolved).toBe(true);

      const wsResult = fakeWs.lastMessage!.event.data.result as Record<string, unknown>;
      expect(wsResult.summary).not.toContain('user@corp.com');
      expect(wsResult.summary).toContain('[REDACTED_EMAIL]');
    });

    it('scrubs credentials from agent context', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'agent_enter',
        timestamp: new Date(),
        data: {
          agentName: 'api-caller',
          context: {
            credentials: {
              token: 'Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig',
              api_secret: 'super-secret-value-12345678',
            },
            targetService: 'payment-api',
          },
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const ctx = stored.context as Record<string, Record<string, unknown>>;
      // 'token' is a secret key name → fully redacted
      expect(ctx.credentials.token).toBe('[REDACTED]');
      // 'api_secret' is a secret key name → fully redacted
      expect(ctx.credentials.api_secret).toBe('[REDACTED]');
      expect(ctx.targetService).toBe('payment-api');
    });
  });

  // =========================================================================
  // INT-7: Constraint check events with sensitive rule data are scrubbed
  // =========================================================================
  describe('INT-7: constraint_check events scrubbed via emit()', () => {
    it('scrubs SSN and credit card from constraint input', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logConstraintCheck({
        constraint: 'pii_guard',
        passed: false,
        context: {
          input: 'My SSN is 123-45-6789 and card is 4111111111111111',
          matched: ['ssn', 'credit_card'],
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      const ctx = stored.context as Record<string, unknown>;
      const input = ctx.input as string;
      expect(input).not.toContain('123-45-6789');
      expect(input).toContain('[REDACTED_SSN]');
      expect(input).not.toContain('4111111111111111');
      expect(input).toContain('[REDACTED_CARD]');
      // Metadata preserved
      expect(stored.constraint).toBe('pii_guard');
      expect(stored.passed).toBe(false);

      // Verify WebSocket
      const wsCtx = fakeWs.lastMessage!.event.data.context as Record<string, unknown>;
      const wsInput = wsCtx.input as string;
      expect(wsInput).not.toContain('123-45-6789');
      expect(wsInput).toContain('[REDACTED_SSN]');
    });

    it('scrubs Bearer token from guardrail evaluation via emit()', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.emit({
        type: 'constraint_check',
        timestamp: new Date(),
        data: {
          constraint: 'auth_leak_guard',
          input: 'The API returns Authorization: Bearer sk-proj-abc123def456ghi789jkl',
          passed: false,
          violation: 'credential_leak',
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      expect(stored.input).not.toContain('sk-proj-abc123def456ghi789jkl');
      expect(stored.input).toContain('[REDACTED]');
      expect(stored.violation).toBe('credential_leak');

      const wsData = fakeWs.lastMessage!.event.data;
      expect(wsData.input).not.toContain('sk-proj-abc123def456ghi789jkl');
    });
  });

  // =========================================================================
  // Additional: Handoff events with sensitive context
  // =========================================================================
  describe('Handoff events scrubbed via logHandoff()', () => {
    it('scrubs SSN from handoff context metadata', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      // logHandoff() converts context to contextMeta (key names only)
      // but the scrubbing still applies to the emitted data
      emitter.logHandoff({
        toAgent: 'specialist',
        reason: 'escalation',
        context: {
          patientInfo: 'patient SSN: 123-45-6789',
          caseId: 'CASE-001',
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      // logHandoff converts context to contextMeta containing only key names,
      // so the SSN in the value is already stripped before scrubbing
      expect(stored.toAgent).toBe('specialist');
      expect(stored.reason).toBe('escalation');

      // Verify no raw SSN anywhere in the stored event
      const json = JSON.stringify(stored);
      expect(json).not.toContain('123-45-6789');
    });
  });

  // =========================================================================
  // Additional: Custom events with mixed sensitive data
  // =========================================================================
  describe('Custom events scrubbed via logCustom()', () => {
    it('scrubs mixed PII and secrets from custom event payload', () => {
      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: fakeWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logCustom('decision', {
        customField: 'User john@example.com called API with key sk-abcdefghij1234567890',
        metadata: {
          password: 'supersecret',
          username: 'john',
          client_secret: 'cs_live_abc123',
          requestId: 'req-123',
        },
      });

      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;

      // Email and SK key scrubbed from string
      expect(stored.customField).not.toContain('john@example.com');
      expect(stored.customField).not.toContain('sk-abcdefghij1234567890');

      // Secret key names scrubbed
      const meta = stored.metadata as Record<string, unknown>;
      expect(meta.password).toBe('[REDACTED]');
      expect(meta.client_secret).toBe('[REDACTED]');

      // Non-sensitive preserved
      expect(meta.username).toBe('john');
      expect(meta.requestId).toBe('req-123');

      // Verify WebSocket matches
      const wsMeta = fakeWs.lastMessage!.event.data.metadata as Record<string, unknown>;
      expect(wsMeta.password).toBe('[REDACTED]');
      expect(wsMeta.username).toBe('john');
    });
  });

  // =========================================================================
  // Additional: WebSocket closed — TraceStore still gets scrubbed data
  // =========================================================================
  describe('Scrubbing persists even when WebSocket is closed', () => {
    it('TraceStore receives scrubbed data when WS is not OPEN', () => {
      const closedWs = createFakeWebSocket();
      closedWs.readyState = 3; // CLOSED

      const emitter = createTraceEmitter({
        sessionId: TEST_SESSION_ID,
        ws: closedWs as unknown as import('ws').WebSocket,
        scrubPII: true,
      });

      emitter.logError({
        errorType: 'auth_failure',
        message: 'Failed for user@example.com',
      });

      // WebSocket should NOT have received anything
      expect(closedWs.messages).toHaveLength(0);

      // TraceStore should still have scrubbed data
      const stored = (
        traceStore.getEvents(TEST_SESSION_ID) as Array<{ data: Record<string, unknown> }>
      )[0].data;
      expect(stored.message).not.toContain('user@example.com');
      expect(stored.message).toContain('[REDACTED_EMAIL]');
    });
  });
});
