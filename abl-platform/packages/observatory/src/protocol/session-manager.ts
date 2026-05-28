/**
 * Debug Session Manager
 *
 * Manages debug sessions and flow control (pause/resume/step).
 */

import { DebugSession, DebugSessionState, AgentStackFrame } from './types.js';

/**
 * Internal session data
 */
interface InternalSession extends DebugSession {
  /** Promise resolver for pause/resume */
  pauseResolver?: () => void;

  /** Shared pause promise awaited by all paused callers */
  pausePromise?: Promise<void>;

  /** Auto-resume timeout handle */
  autoResumeTimer?: ReturnType<typeof setTimeout>;

  /** Whether stepping is active */
  stepping: boolean;

  /** Step type if stepping */
  stepType?: 'over' | 'into' | 'out';

  /** Agent call stack */
  callStack: AgentStackFrame[];

  /** Current state snapshot */
  stateSnapshot: Record<string, unknown>;
}

/**
 * Session event callback
 */
export type SessionEventCallback = (
  sessionId: string,
  event: 'created' | 'updated' | 'ended' | 'paused' | 'resumed',
) => void;

/**
 * Manages debug sessions
 */
export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private eventCallbacks: SessionEventCallback[] = [];

  /** Auto-resume timeout in milliseconds (5 minutes) */
  private autoResumeTimeout = 5 * 60 * 1000;

  /**
   * Register a session from the runtime
   */
  registerSession(id: string, name: string, initialAgent: string): DebugSession {
    const session: InternalSession = {
      id,
      name,
      currentAgent: initialAgent,
      state: 'running',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      turnCount: 0,
      debuggerAttached: false,
      stepping: false,
      callStack: [],
      stateSnapshot: {},
    };

    this.sessions.set(id, session);
    this.notifyEvent(id, 'created');
    return this.toPublicSession(session);
  }

  /**
   * Unregister a session
   */
  unregisterSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      // Ensure any paused execution is released
      this.clearAutoResumeTimer(session);
      this.resolvePause(session);
      this.sessions.delete(id);
      this.notifyEvent(id, 'ended');
    }
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): DebugSession | undefined {
    const session = this.sessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  /**
   * Get all sessions
   */
  getAllSessions(filter?: DebugSessionState): DebugSession[] {
    const sessions = Array.from(this.sessions.values());
    const filtered = filter ? sessions.filter((s) => s.state === filter) : sessions;
    return filtered.map((s) => this.toPublicSession(s));
  }

  /**
   * Attach debugger to a session
   */
  attachDebugger(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.debuggerAttached = true;
    this.notifyEvent(sessionId, 'updated');
    return true;
  }

  /**
   * Detach debugger from a session
   */
  detachDebugger(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.debuggerAttached = false;

    // Resume if paused
    if (session.state === 'paused') {
      this.resume(sessionId);
    }

    this.notifyEvent(sessionId, 'updated');
    return true;
  }

  /**
   * Update session state
   */
  updateState(
    sessionId: string,
    updates: {
      currentAgent?: string;
      state?: DebugSessionState;
      stateSnapshot?: Record<string, unknown>;
    },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (updates.currentAgent) {
      session.currentAgent = updates.currentAgent;
    }
    if (updates.state) {
      session.state = updates.state;
    }
    if (updates.stateSnapshot) {
      session.stateSnapshot = updates.stateSnapshot;
    }

    session.lastActivityAt = new Date();
    this.notifyEvent(sessionId, 'updated');
  }

  /**
   * Increment turn count
   */
  incrementTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.turnCount++;
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Push agent onto call stack
   */
  pushAgent(
    sessionId: string,
    agentName: string,
    mode: 'scripted' | 'reasoning',
    trigger: 'routing' | 'handoff' | 'delegate' | 'initial',
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.callStack.push({
      agentName,
      mode,
      enteredAt: new Date(),
      trigger,
    });
    session.currentAgent = agentName;
  }

  /**
   * Pop agent from call stack
   */
  popAgent(sessionId: string): AgentStackFrame | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const frame = session.callStack.pop();
    if (session.callStack.length > 0) {
      session.currentAgent = session.callStack[session.callStack.length - 1].agentName;
    }
    return frame;
  }

  /**
   * Update current step in call stack
   */
  updateCurrentStep(sessionId: string, stepName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.callStack.length === 0) return;

    const topFrame = session.callStack[session.callStack.length - 1];
    topFrame.currentStep = stepName;
  }

  /**
   * Get call stack
   */
  getCallStack(sessionId: string): AgentStackFrame[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.callStack] : [];
  }

  /**
   * Get current state snapshot
   */
  getStateSnapshot(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session.stateSnapshot } : {};
  }

  // ============================================
  // Flow Control
  // ============================================

  /**
   * Pause execution
   * Returns a promise that resolves when resumed
   */
  async pause(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.state === 'paused') {
      return this.getOrCreatePausePromise(sessionId, session);
    }

    session.state = 'paused';
    session.stepping = false;

    this.notifyEvent(sessionId, 'paused');

    this.armAutoResume(sessionId, session);
    return this.getOrCreatePausePromise(sessionId, session);
  }

  /**
   * Resume execution
   */
  resume(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.state !== 'paused') return; // Not paused

    session.state = 'running';
    session.stepping = false;
    this.clearAutoResumeTimer(session);
    this.resolvePause(session);

    this.notifyEvent(sessionId, 'resumed');
  }

  /**
   * Step execution
   */
  step(sessionId: string, type: 'over' | 'into' | 'out' = 'over'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.stepping = true;
    session.stepType = type;

    // Resume to allow one step
    if (session.state === 'paused') {
      session.state = 'running';
      this.clearAutoResumeTimer(session);
      this.resolvePause(session);
    }
  }

  /**
   * Check if session is stepping
   */
  isStepping(sessionId: string): { stepping: boolean; type?: 'over' | 'into' | 'out' } {
    const session = this.sessions.get(sessionId);
    if (!session) return { stepping: false };
    return { stepping: session.stepping, type: session.stepType };
  }

  /**
   * Mark step complete (should pause again after a step)
   */
  markStepComplete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stepping) return false;

    session.stepping = false;
    session.stepType = undefined;
    return true; // Should pause
  }

  /**
   * Check if execution should wait (paused)
   */
  shouldWait(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.state === 'paused';
  }

  /**
   * Wait if paused (called by runtime)
   */
  async waitIfPaused(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'paused') return;

    return this.getOrCreatePausePromise(sessionId, session);
  }

  // ============================================
  // Event Callbacks
  // ============================================

  /**
   * Register event callback
   */
  onEvent(callback: SessionEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.eventCallbacks.splice(idx, 1);
      }
    };
  }

  private notifyEvent(
    sessionId: string,
    event: 'created' | 'updated' | 'ended' | 'paused' | 'resumed',
  ): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(sessionId, event);
      } catch (e) {
        console.error('Session event callback error:', e);
      }
    }
  }

  // ============================================
  // Helpers
  // ============================================

  private toPublicSession(internal: InternalSession): DebugSession {
    return {
      id: internal.id,
      name: internal.name,
      currentAgent: internal.currentAgent,
      state: internal.state,
      startedAt: internal.startedAt,
      lastActivityAt: internal.lastActivityAt,
      turnCount: internal.turnCount,
      debuggerAttached: internal.debuggerAttached,
    };
  }

  private getOrCreatePausePromise(sessionId: string, session: InternalSession): Promise<void> {
    if (!session.pausePromise) {
      session.pausePromise = new Promise<void>((resolve) => {
        session.pauseResolver = resolve;
      });
    }

    if (!session.autoResumeTimer) {
      this.armAutoResume(sessionId, session);
    }

    return session.pausePromise;
  }

  private armAutoResume(sessionId: string, session: InternalSession): void {
    this.clearAutoResumeTimer(session);
    session.autoResumeTimer = setTimeout(() => {
      session.autoResumeTimer = undefined;
      if (session.state === 'paused') {
        this.resume(sessionId);
      }
    }, this.autoResumeTimeout);
  }

  private clearAutoResumeTimer(session: InternalSession): void {
    if (!session.autoResumeTimer) return;
    clearTimeout(session.autoResumeTimer);
    session.autoResumeTimer = undefined;
  }

  private resolvePause(session: InternalSession): void {
    const resolve = session.pauseResolver;
    session.pauseResolver = undefined;
    session.pausePromise = undefined;
    resolve?.();
  }
}
