/**
 * Session Store
 *
 * Manages active debug sessions and their states.
 */

import type { DebugSession, AgentDetails, AgentState, DecisionLogEntry } from '../types.js';

export class SessionStore {
  private sessions: Map<string, DebugSession> = new Map();
  private activeSessionId: string | null = null;

  /**
   * Create a new session
   */
  createSession(sessionId: string, agentId: string, agentDetails?: AgentDetails): DebugSession {
    const session: DebugSession = {
      id: sessionId,
      agentId,
      agentDetails,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): DebugSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the active session
   */
  getActiveSession(): DebugSession | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Set active session
   */
  setActiveSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }

  /**
   * Get active session ID
   */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /**
   * Update session state
   */
  updateState(sessionId: string, state: AgentState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = state;
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Update session agent details
   */
  updateAgentDetails(sessionId: string, agentDetails: AgentDetails): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agentDetails = agentDetails;
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Touch session (update last activity)
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    return this.sessions.delete(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): DebugSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
    this.activeSessionId = null;
  }

  /**
   * Get session count
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get decision log entries from session state
   */
  getDecisionLog(sessionId: string): DecisionLogEntry[] {
    const session = this.sessions.get(sessionId);
    return session?.state?.decisionLog ?? [];
  }
}
