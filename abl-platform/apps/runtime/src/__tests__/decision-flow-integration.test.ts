/**
 * Decision Kind Flow Integration Tests
 *
 * Tests the emitDecision flow from TraceEmitter through to EventStore:
 * - emitDecision produces correct event shapes
 * - All 11 decision kinds are accepted
 * - Verbosity gating works per-kind
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockAddEvent = vi.fn();
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({ addEvent: mockAddEvent }),
}));

const mockEventStoreEmit = vi.fn();
vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: () => ({
    emitter: { emit: mockEventStoreEmit },
  }),
}));

vi.mock('@abl/compiler', () => ({
  scrubToolCallData: vi.fn((data: Record<string, unknown>) => data),
  redactPII: vi.fn((text: string) => text),
  scrubSecrets: vi.fn((data: Record<string, unknown>) => data),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-observability/sti', () => ({
  tracePath: vi.fn(),
  getSharedSTRBuffer: vi.fn(),
}));

import { createTraceEmitter } from '../services/trace-emitter.js';
import type { DecisionKind } from '../services/execution/trace-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs(open = true) {
  return {
    readyState: open ? 1 : 3,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as import('ws').WebSocket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitDecision flow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emitDecision with handoff kind produces correct event shape', () => {
    const ws = createMockWs();
    const emitter = createTraceEmitter({
      sessionId: 'sess-1',
      ws,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      verbosity: 'standard',
    });

    const result = emitter.emitDecision('handoff', {
      toAgent: 'billing',
      reason: 'user requested billing info',
    });

    expect(result).toBeDefined();
    expect(result!.type).toBe('decision');
    expect(result!.sessionId).toBe('sess-1');
    expect((result!.data as Record<string, unknown>).decisionKind).toBe('handoff');
    expect((result!.data as Record<string, unknown>).toAgent).toBe('billing');
    expect((result!.data as Record<string, unknown>).reason).toBe('user requested billing info');
  });

  it('emitDecision sends to TraceStore', () => {
    const ws = createMockWs();
    const emitter = createTraceEmitter({
      sessionId: 'sess-2',
      ws,
      tenantId: 'tenant-1',
      verbosity: 'standard',
    });

    emitter.emitDecision('escalation', { priority: 'high', reason: 'angry customer' });

    expect(mockAddEvent).toHaveBeenCalledWith(
      'sess-2',
      expect.objectContaining({
        type: 'decision',
        sessionId: 'sess-2',
      }),
    );
  });

  it('emitDecision sends to WebSocket when open', () => {
    const ws = createMockWs(true);
    const emitter = createTraceEmitter({
      sessionId: 'sess-3',
      ws,
      tenantId: 'tenant-1',
      verbosity: 'standard',
    });

    emitter.emitDecision('completion', { outcome: 'task_done' });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.type).toBe('trace_event');
    expect(sent.event.type).toBe('decision');
  });

  it('emitDecision writes to EventStore when tenantId present', () => {
    const ws = createMockWs();
    const emitter = createTraceEmitter({
      sessionId: 'sess-4',
      ws,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      verbosity: 'standard',
    });

    emitter.emitDecision('delegation', { targetAgent: 'sub-agent' });

    expect(mockEventStoreEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        project_id: 'proj-1',
        session_id: 'sess-4',
      }),
    );
  });

  describe('all 11 decision kinds accepted', () => {
    const ALL_KINDS: DecisionKind[] = [
      'handoff',
      'delegation',
      'flow_transition',
      'field_validation',
      'escalation',
      'completion',
      'constraint_check',
      'guardrail_check',
      'gather_extraction',
      'correction',
      'data_mutation',
    ];

    it.each(ALL_KINDS)('accepts decision kind: %s', (kind) => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: `sess-kind-${kind}`,
        ws,
        tenantId: 'tenant-1',
        verbosity: 'debug', // debug emits everything
      });

      const result = emitter.emitDecision(kind, { test: true });

      expect(result).toBeDefined();
      expect(result!.type).toBe('decision');
      expect((result!.data as Record<string, unknown>).decisionKind).toBe(kind);
    });
  });

  describe('verbosity gating', () => {
    it('standard verbosity emits standard-tier kinds', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v1',
        ws,
        tenantId: 'tenant-1',
        verbosity: 'standard',
      });

      const result = emitter.emitDecision('handoff', { toAgent: 'billing' });
      expect(result).toBeDefined();
    });

    it('standard verbosity blocks verbose-tier kinds', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v2',
        ws,
        tenantId: 'tenant-1',
        verbosity: 'standard',
      });

      const result = emitter.emitDecision('gather_extraction', { field: 'email' });
      expect(result).toBeUndefined();
    });

    it('minimal verbosity blocks all kinds', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v3',
        ws,
        tenantId: 'tenant-1',
        verbosity: 'minimal',
      });

      expect(emitter.emitDecision('handoff', {})).toBeUndefined();
      expect(emitter.emitDecision('escalation', {})).toBeUndefined();
      expect(emitter.emitDecision('gather_extraction', {})).toBeUndefined();
    });

    it('verbose verbosity emits all kinds', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v4',
        ws,
        tenantId: 'tenant-1',
        verbosity: 'verbose',
      });

      expect(emitter.emitDecision('handoff', {})).toBeDefined();
      expect(emitter.emitDecision('gather_extraction', {})).toBeDefined();
      expect(emitter.emitDecision('correction', {})).toBeDefined();
      expect(emitter.emitDecision('data_mutation', {})).toBeDefined();
    });

    it('debug verbosity emits all kinds', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v5',
        ws,
        tenantId: 'tenant-1',
        verbosity: 'debug',
      });

      expect(emitter.emitDecision('data_mutation', {})).toBeDefined();
      expect(emitter.emitDecision('handoff', {})).toBeDefined();
    });

    it('defaults to standard verbosity when not specified', () => {
      const ws = createMockWs();
      const emitter = createTraceEmitter({
        sessionId: 'sess-v6',
        ws,
        tenantId: 'tenant-1',
        // no verbosity specified
      });

      // Standard-tier → emitted
      expect(emitter.emitDecision('handoff', {})).toBeDefined();
      // Verbose-tier → blocked
      expect(emitter.emitDecision('gather_extraction', {})).toBeUndefined();
    });
  });
});
