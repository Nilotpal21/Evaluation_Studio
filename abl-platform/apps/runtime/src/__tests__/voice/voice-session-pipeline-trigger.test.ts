/**
 * Voice Session Pipeline Trigger Tests
 *
 * Verifies that emitVoiceSessionEnded correctly emits session.ended
 * to the EventBus — which is what triggers analytics pipelines
 * (intent, sentiment, quality, etc.) for voice sessions.
 *
 * Tests the pure helper directly (no infrastructure mocks needed).
 * The helper is called by both korevg-session.ts and korevg-router.ts
 * after each voice session's DB write succeeds.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type {
  AnyPlatformEvent,
  EventBus,
  SessionEndedPayload,
  PlatformEvent,
} from '../../services/event-bus/types.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../../services/event-bus/runtime-bus-accessor.js';
import {
  emitVoiceSessionEnded,
  emitVoiceMessage,
  type VoiceSessionEndedParams,
  type VoiceMessageParams,
} from '../../services/voice/korevg/voice-session-event.js';
import type { EventPIIContext } from '../../services/event-bus/pii-event-boundary.js';

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;
type MessageUserEvent = PlatformEvent<
  'message.user',
  { messageId: string; content: string; messageIndex: number }
>;
type MessageAgentEvent = PlatformEvent<
  'message.agent',
  { messageId: string; content: string; messageIndex: number }
>;

function makeCollectorBus(events: AnyPlatformEvent[]): EventBus {
  return {
    emit(event) {
      events.push(event);
    },
    subscribe() {},
    unsubscribe() {},
    async shutdown() {},
  };
}

const MINIMAL_PII_CONTEXT = {} as EventPIIContext;

const BASE_MESSAGE_PARAMS: VoiceMessageParams = {
  tenantId: 'tenant-abc',
  projectId: 'proj-xyz',
  sessionId: 'sess-001',
  agentName: 'SupportAgent',
  content: 'Hello, I need help with my account.',
  messageIndex: 3,
  piiContext: MINIMAL_PII_CONTEXT,
};

const BASE_PARAMS: VoiceSessionEndedParams = {
  tenantId: 'tenant-abc',
  projectId: 'proj-xyz',
  sessionId: 'sess-001',
  agentName: 'SupportAgent',
  sessionOutcome: 'completed',
  durationMs: 45_000,
  turnCount: 7,
};

describe('emitVoiceSessionEnded', () => {
  let capturedEvents: AnyPlatformEvent[] = [];
  let bus: EventBus;
  let previousBus: EventBus | null = null;

  beforeEach(() => {
    capturedEvents = [];
    bus = makeCollectorBus(capturedEvents);
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(bus);
  });

  afterEach(() => {
    setRuntimeEventBus(previousBus);
  });

  // ── Event shape ──────────────────────────────────────────────────────────

  test('emits an event with type session.ended', () => {
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].type).toBe('session.ended');
  });

  test('sets channel to voice', () => {
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    expect(capturedEvents[0].channel).toBe('voice');
  });

  test('propagates tenantId, projectId, sessionId, agentName correctly', () => {
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    const event = capturedEvents[0];
    expect(event.tenantId).toBe('tenant-abc');
    expect(event.projectId).toBe('proj-xyz');
    expect(event.sessionId).toBe('sess-001');
    expect(event.agentName).toBe('SupportAgent');
  });

  test('propagates durationMs and turnCount in payload', () => {
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    const payload = capturedEvents[0].payload as SessionEndedPayload;
    expect(payload.durationMs).toBe(45_000);
    expect(payload.turnCount).toBe(7);
  });

  test('generates a unique eventId for each emission', () => {
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    expect(capturedEvents[0].eventId).not.toBe(capturedEvents[1].eventId);
  });

  // ── Reason mapping ───────────────────────────────────────────────────────

  test('maps completed outcome to reason completed', () => {
    emitVoiceSessionEnded(bus, { ...BASE_PARAMS, sessionOutcome: 'completed' });
    const payload = capturedEvents[0].payload as SessionEndedPayload;
    expect(payload.reason).toBe('completed');
  });

  test('maps escalated outcome to reason user_exit (agent transfer)', () => {
    emitVoiceSessionEnded(bus, { ...BASE_PARAMS, sessionOutcome: 'escalated' });
    const payload = capturedEvents[0].payload as SessionEndedPayload;
    expect(payload.reason).toBe('user_exit');
  });

  test('maps abandoned outcome to reason user_left (caller hung up)', () => {
    emitVoiceSessionEnded(bus, { ...BASE_PARAMS, sessionOutcome: 'abandoned' });
    const payload = capturedEvents[0].payload as SessionEndedPayload;
    expect(payload.reason).toBe('user_left');
  });

  test('maps pending outcome to reason user_left (fallback)', () => {
    emitVoiceSessionEnded(bus, { ...BASE_PARAMS, sessionOutcome: 'pending' });
    const payload = capturedEvents[0].payload as SessionEndedPayload;
    expect(payload.reason).toBe('user_left');
  });

  // ── Safety ───────────────────────────────────────────────────────────────

  test('does not throw when bus.emit throws', () => {
    const throwingBus: EventBus = {
      emit() {
        throw new Error('bus failure');
      },
      subscribe() {},
      unsubscribe() {},
      async shutdown() {},
    };
    expect(() => emitVoiceSessionEnded(throwingBus, BASE_PARAMS)).not.toThrow();
  });

  test('emitted event is captured by getRuntimeEventBus collector', () => {
    const bus = getRuntimeEventBus()!;
    emitVoiceSessionEnded(bus, BASE_PARAMS);
    const event = capturedEvents.find((e): e is SessionEndedEvent => e.type === 'session.ended');
    expect(event).toBeDefined();
    expect(event!.channel).toBe('voice');
  });
});

describe('emitVoiceMessage', () => {
  let capturedEvents: AnyPlatformEvent[] = [];
  let bus: EventBus;

  beforeEach(() => {
    capturedEvents = [];
    bus = makeCollectorBus(capturedEvents);
  });

  // ── Event type ───────────────────────────────────────────────────────────

  test('emits message.user for user role', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].type).toBe('message.user');
  });

  test('emits message.agent for assistant role', () => {
    emitVoiceMessage(bus, 'assistant', BASE_MESSAGE_PARAMS);
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].type).toBe('message.agent');
  });

  // ── Envelope fields ──────────────────────────────────────────────────────

  test('sets channel to voice', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    expect(capturedEvents[0].channel).toBe('voice');
  });

  test('propagates tenantId, projectId, sessionId, agentName', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    const event = capturedEvents[0];
    expect(event.tenantId).toBe('tenant-abc');
    expect(event.projectId).toBe('proj-xyz');
    expect(event.sessionId).toBe('sess-001');
    expect(event.agentName).toBe('SupportAgent');
  });

  test('sets a valid ISO timestamp', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    expect(() => new Date(capturedEvents[0].timestamp)).not.toThrow();
    expect(new Date(capturedEvents[0].timestamp).getTime()).toBeGreaterThan(0);
  });

  // ── Payload fields ───────────────────────────────────────────────────────

  test('payload carries content and messageIndex', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    const payload = capturedEvents[0].payload as MessageUserEvent['payload'];
    expect(payload.content).toBe('Hello, I need help with my account.');
    expect(payload.messageIndex).toBe(3);
  });

  test('payload carries a non-empty messageId', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    const payload = capturedEvents[0].payload as MessageUserEvent['payload'];
    expect(typeof payload.messageId).toBe('string');
    expect(payload.messageId.length).toBeGreaterThan(0);
  });

  test('generates unique eventId and messageId across emissions', () => {
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    emitVoiceMessage(bus, 'user', BASE_MESSAGE_PARAMS);
    const [a, b] = capturedEvents;
    expect(a.eventId).not.toBe(b.eventId);
    const payloadA = a.payload as MessageUserEvent['payload'];
    const payloadB = b.payload as MessageUserEvent['payload'];
    expect(payloadA.messageId).not.toBe(payloadB.messageId);
  });

  test('messageIndex in payload matches the value passed in params', () => {
    emitVoiceMessage(bus, 'assistant', { ...BASE_MESSAGE_PARAMS, messageIndex: 7 });
    const payload = capturedEvents[0].payload as MessageAgentEvent['payload'];
    expect(payload.messageIndex).toBe(7);
  });

  // ── Safety ───────────────────────────────────────────────────────────────

  test('does not throw when bus.emit throws', () => {
    const throwingBus: EventBus = {
      emit() {
        throw new Error('bus failure');
      },
      subscribe() {},
      unsubscribe() {},
      async shutdown() {},
    };
    expect(() => emitVoiceMessage(throwingBus, 'user', BASE_MESSAGE_PARAMS)).not.toThrow();
  });
});
