/**
 * Unit tests for the one-shot dispatcher.
 * Tests the pure decision logic without any mocks.
 */

import { describe, expect, test } from 'vitest';
import { decideNextEvent, MAX_DISPATCH_ITERATIONS } from '../dispatcher.js';
import type { ArchSession } from '../types/index.js';

const SPEC_TEXT = 'Project: Test\n\nDescription: A test project';

function makeSession(
  overrides: Partial<ArchSession> & { metadata?: Partial<ArchSession['metadata']> },
): ArchSession {
  const base: ArchSession = {
    id: 'session-123',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: 'Test Project',
        description: 'A test project',
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      messages: [],
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
    },
  } as ArchSession;
}

describe('oneshot-dispatcher: decideNextEvent', () => {
  test('MAX_DISPATCH_ITERATIONS is exported and has a reasonable value', () => {
    expect(MAX_DISPATCH_ITERATIONS).toBeGreaterThanOrEqual(20);
    expect(MAX_DISPATCH_ITERATIONS).toBeLessThanOrEqual(50);
  });

  describe('terminal states', () => {
    test('returns done when session state is COMPLETE', () => {
      const session = makeSession({ state: 'COMPLETE' });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ type: 'done' });
    });

    test('returns done when session state is ARCHIVED', () => {
      const session = makeSession({ state: 'ARCHIVED' });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ type: 'done' });
    });
  });

  describe('INTERVIEW phase', () => {
    test('sends continue when in INTERVIEW phase with IDLE state', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: { phase: 'INTERVIEW' },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'continue' });
    });

    test('sends continue when in INTERVIEW phase with ACTIVE state', () => {
      const session = makeSession({
        state: 'ACTIVE',
        metadata: { phase: 'INTERVIEW' },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'continue' });
    });
  });

  describe('BLUEPRINT phase', () => {
    test('sends message when no topology and IDLE', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: { phase: 'BLUEPRINT', topology: undefined, topologyApproved: false },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toHaveProperty('type', 'message');
      expect((result as { text: string }).text).toContain('specification');
    });

    test('auto-accepts topology_approval gate', () => {
      const session = makeSession({
        state: 'GATE_PENDING',
        metadata: {
          phase: 'BLUEPRINT',
          topologyApproved: false,
          pendingInteraction: {
            kind: 'gate',
            id: 'gate-1',
            payload: { gateType: 'topology_approval' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({
        sessionId: 'session-123',
        type: 'gate_response',
        action: 'accept',
      });
    });

    test('sends continue when topology approved and IDLE', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BLUEPRINT',
          topology: { agents: [], edges: [], entryPoint: 'main' },
          topologyApproved: true,
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'continue' });
    });

    test('answers widget to continue flow', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BLUEPRINT',
          topology: undefined,
          topologyApproved: false,
          pendingInteraction: {
            kind: 'widget',
            id: 'widget-1',
            payload: { question: 'What channels?' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toHaveProperty('type', 'tool_answer');
      expect((result as { toolCallId: string }).toolCallId).toBe('widget-1');
    });

    test('auto-accepts topology approval widgets', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BLUEPRINT',
          topologyApproved: false,
          pendingInteraction: {
            kind: 'widget',
            id: 'topology-approval-1',
            payload: { widgetType: 'TopologyApproval' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({
        sessionId: 'session-123',
        type: 'tool_answer',
        toolCallId: 'topology-approval-1',
        answer: 'accept',
      });
    });
  });

  describe('BUILD phase', () => {
    test('sends message when agents are missing', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          files: {},
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toHaveProperty('type', 'message');
    });

    test('auto-answers BuildComplete widget with create', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          files: { 'agent-1': { path: 'agents/agent-1.abl.yaml', content: 'GOAL: test' } },
          pendingInteraction: {
            kind: 'widget',
            id: 'build-complete-1',
            payload: { widgetType: 'BuildComplete' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({
        sessionId: 'session-123',
        type: 'tool_answer',
        toolCallId: 'build-complete-1',
        answer: 'create',
      });
    });

    test('auto-answers BuildComplete before direct create when build stage is complete', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          files: { 'agent-1': { path: 'agents/agent-1.abl.yaml', content: 'GOAL: test' } },
          buildProgress: {
            stage: 'complete',
            agentStatuses: { 'agent-1': 'compiled' },
            toolStatuses: {},
          },
          pendingInteraction: {
            kind: 'widget',
            id: 'build-complete-1',
            payload: { widgetType: 'BuildComplete' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({
        sessionId: 'session-123',
        type: 'tool_answer',
        toolCallId: 'build-complete-1',
        answer: 'create',
      });
    });

    test('auto-accepts agent_review gate', () => {
      const session = makeSession({
        state: 'GATE_PENDING',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          pendingInteraction: {
            kind: 'gate',
            id: 'gate-1',
            payload: { gateType: 'agent_review', agentName: 'agent-1' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({
        sessionId: 'session-123',
        type: 'gate_response',
        action: 'accept',
      });
    });

    test('sends continue when all agents generated but stage not complete', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          files: { 'agent-1': { path: 'agents/agent-1.abl.yaml', content: 'GOAL: test' } },
          buildProgress: {
            stage: 'agents_complete',
            agentStatuses: { 'agent-1': 'compiled' },
            toolStatuses: {},
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'continue' });
    });

    test('sends create when buildProgress.stage is complete', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'BUILD',
          topology: { agents: [{ name: 'agent-1' }], edges: [], entryPoint: 'agent-1' },
          topologyApproved: true,
          files: { 'agent-1': { path: 'agents/agent-1.abl.yaml', content: 'GOAL: test' } },
          buildProgress: {
            stage: 'complete',
            agentStatuses: { 'agent-1': 'compiled' },
            toolStatuses: {},
          },
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'create' });
    });
  });

  describe('CREATE phase', () => {
    test('returns done when projectId is set', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'CREATE',
          projectId: 'project-123',
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ type: 'done' });
    });

    test('sends create when projectId is not set and IDLE', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: {
          phase: 'CREATE',
          projectId: undefined,
        },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toEqual({ sessionId: 'session-123', type: 'create' });
    });
  });

  describe('error cases', () => {
    test('returns error for unexpected state', () => {
      const session = makeSession({
        state: 'IDLE',
        metadata: { phase: 'BUILD', topology: undefined },
      });
      const result = decideNextEvent(session, SPEC_TEXT);
      expect(result).toHaveProperty('type', 'error');
    });
  });
});
