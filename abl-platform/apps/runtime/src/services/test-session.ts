/**
 * Test Session Service
 *
 * Manages test sessions with state tracking and execution.
 */

import crypto from 'crypto';
import type {
  TestSession,
  SessionMessage,
  AgentDetails,
  TraceEventWithId,
  AgentState,
  TraceEvent,
} from '../types/index.js';
import {
  RUNTIME_TEST_SESSION_MAX_SESSIONS,
  RUNTIME_TEST_SESSION_TTL_MS,
} from '@agent-platform/config/constants';

// =============================================================================
// SESSION STORE
// =============================================================================

const sessions = new Map<string, TestSession>();

function evictExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActivityAt.getTime() > RUNTIME_TEST_SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function evictOldestSessions(): void {
  while (sessions.size > RUNTIME_TEST_SESSION_MAX_SESSIONS) {
    let oldestId: string | null = null;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of sessions) {
      const lastActivity = session.lastActivityAt.getTime();
      if (lastActivity < oldestActivity) {
        oldestActivity = lastActivity;
        oldestId = sessionId;
      }
    }
    if (!oldestId) {
      return;
    }
    sessions.delete(oldestId);
  }
}

function enforceSessionBounds(): void {
  evictExpiredSessions();
  evictOldestSessions();
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

/**
 * Create a new test session for an agent
 */
export function createSession(agent: AgentDetails): TestSession {
  enforceSessionBounds();

  const session: TestSession = {
    id: crypto.randomUUID(),
    agent,
    state: createInitialState(),
    messages: [],
    traceEvents: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  sessions.set(session.id, session);
  evictOldestSessions();
  return session;
}

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): TestSession | undefined {
  evictExpiredSessions();
  return sessions.get(sessionId);
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/**
 * List all active sessions
 */
export function listSessions(): TestSession[] {
  evictExpiredSessions();
  return Array.from(sessions.values());
}

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

/**
 * Add a user message to the session
 */
export function addUserMessage(sessionId: string, text: string): SessionMessage | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const message: SessionMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: text,
    timestamp: new Date(),
    traceIds: [],
  };

  session.messages.push(message);
  session.lastActivityAt = new Date();

  return message;
}

/**
 * Add an assistant message to the session
 */
export function addAssistantMessage(
  sessionId: string,
  text: string,
  metadata?: SessionMessage['metadata'],
): SessionMessage | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const message: SessionMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    timestamp: new Date(),
    traceIds: [],
    metadata,
  };

  session.messages.push(message);
  session.lastActivityAt = new Date();

  return message;
}

/**
 * Add a system message to the session
 */
export function addSystemMessage(sessionId: string, text: string): SessionMessage | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const message: SessionMessage = {
    id: crypto.randomUUID(),
    role: 'system',
    content: text,
    timestamp: new Date(),
    traceIds: [],
  };

  session.messages.push(message);
  session.lastActivityAt = new Date();

  return message;
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/**
 * Create initial agent state
 */
function createInitialState(): AgentState {
  return {
    context: {},
    conversationPhase: 'start',
    gatherProgress: {},
    constraintResults: {},
    lastToolResults: {},
    memory: {
      session: {},
      persistentCache: {},
      pendingRemembers: [],
    },
  };
}

/**
 * Update session state
 */
export function updateState(
  sessionId: string,
  updates: Partial<AgentState>,
): AgentState | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.state = mergeState(session.state, updates);
  session.lastActivityAt = new Date();

  return session.state;
}

/**
 * Merge state updates into current state
 */
function mergeState(current: AgentState, updates: Partial<AgentState>): AgentState {
  return {
    ...current,
    context: { ...current.context, ...updates.context },
    conversationPhase: updates.conversationPhase ?? current.conversationPhase,
    gatherProgress: { ...current.gatherProgress, ...updates.gatherProgress },
    constraintResults: { ...current.constraintResults, ...updates.constraintResults },
    lastToolResults: { ...current.lastToolResults, ...updates.lastToolResults },
    memory: {
      session: { ...current.memory.session, ...updates.memory?.session },
      persistentCache: { ...current.memory.persistentCache, ...updates.memory?.persistentCache },
      pendingRemembers: [
        ...current.memory.pendingRemembers,
        ...(updates.memory?.pendingRemembers || []),
      ],
    },
    flowState: updates.flowState ?? current.flowState,
    errorState: updates.errorState ?? current.errorState,
  };
}

// =============================================================================
// TRACE MANAGEMENT
// =============================================================================

/**
 * Add a trace event to the session
 */
export function addTraceEvent(sessionId: string, event: TraceEvent): TraceEventWithId | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const eventWithId: TraceEventWithId = {
    ...event,
    id: crypto.randomUUID(),
    sessionId,
  };

  session.traceEvents.push(eventWithId);
  session.lastActivityAt = new Date();

  // Associate with last message if applicable
  if (session.messages.length > 0) {
    const lastMessage = session.messages[session.messages.length - 1];
    lastMessage.traceIds.push(eventWithId.id);
  }

  return eventWithId;
}

/**
 * Get all trace events for a session
 */
export function getTraceEvents(sessionId: string): TraceEvent[] {
  const session = sessions.get(sessionId);
  return session?.traceEvents || [];
}

// =============================================================================
// EXPORTS
// =============================================================================

export const TestSessionService = {
  createSession,
  getSession,
  deleteSession,
  listSessions,
  addUserMessage,
  addAssistantMessage,
  addSystemMessage,
  updateState,
  addTraceEvent,
  getTraceEvents,
};
