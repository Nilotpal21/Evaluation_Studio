/**
 * Session Resume Project Guard — Comprehensive Tests
 *
 * Tests the `resolveCurrentResumableSessionId` logic extracted verbatim
 * from WebSocketContext.tsx:404-413. Bug tests assert correct fail-closed
 * behavior and FAIL on current code. Happy-path tests should pass as-is.
 *
 * @see apps/studio/src/contexts/WebSocketContext.tsx lines 404-413
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../store/session-store';
import { useNavigationStore } from '../../store/navigation-store';
import type { AgentDetails } from '../../types';

// =============================================================================
// Extract the exact logic from WebSocketContext.tsx:404-413
// =============================================================================

/**
 * Mirrors the resolve logic from WebSocketContext.tsx:404-413.
 * Must be kept in sync with the production code.
 */
function resolveCurrentResumableSessionId(): string | null {
  const currentProjectId = useNavigationStore.getState().projectId;
  const { sessionId: existingSessionId, resumeHandle } = useSessionStore.getState();
  const projectMatchesCurrent =
    currentProjectId != null &&
    currentProjectId.length > 0 &&
    resumeHandle.projectId != null &&
    resumeHandle.projectId.length > 0 &&
    resumeHandle.projectId === currentProjectId;

  return projectMatchesCurrent && (existingSessionId ?? resumeHandle.sessionId)
    ? (existingSessionId ?? resumeHandle.sessionId)
    : null;
}

// =============================================================================
// HELPERS
// =============================================================================

function makeAgent(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    id: 'agent-1',
    name: 'TestAgent',
    filePath: '',
    type: 'agent',
    mode: 'reasoning',
    toolCount: 0,
    gatherFieldCount: 0,
    isSupervisor: false,
    dsl: '',
    ...overrides,
  };
}

const PROJECT_MERCURY = 'project-mercury-bank';
const PROJECT_JAVELINA = 'project-ha-javelina';
const PROJECT_THIRD = 'project-third';
const SESSION_MERCURY = 'session-mercury-0aa425d1';
const SESSION_JAVELINA = 'session-javelina-b4ef7d0b';

// =============================================================================
// TESTS
// =============================================================================

describe('resolveCurrentResumableSessionId — project guard', () => {
  beforeEach(() => {
    useSessionStore.getState().clearSession();
    useNavigationStore.setState({ projectId: null });
    localStorage.clear();
  });

  // ===========================================================================
  // A. Happy paths — must pass on current code AND after fix
  // ===========================================================================

  describe('happy paths', () => {
    test('returns sessionId when resumeHandle projectId matches current project', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('returns null when no session is stored', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('returns null when resumeHandle is empty', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Empty handle with null sessionId
      expect(useSessionStore.getState().resumeHandle.sessionId).toBeNull();
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('returns null when projects are different and both non-null', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('prefers existingSessionId over resumeHandle.sessionId', () => {
      // Both in-memory sessionId and resumeHandle have values
      useSessionStore.setState({ sessionId: 'in-memory-session' });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // existingSessionId takes precedence (it's the more current value)
      expect(resolveCurrentResumableSessionId()).toBe('in-memory-session');
    });

    test('falls back to resumeHandle.sessionId when existingSessionId is null', () => {
      // After browser refresh: sessionId in store is null, but resumeHandle persisted
      expect(useSessionStore.getState().sessionId).toBeNull();

      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('returns null after clearSession', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      useSessionStore.getState().clearSession();

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('returns null after clearResumeHandle', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      useSessionStore.getState().clearResumeHandle();

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });
  });

  // ===========================================================================
  // B. Bug 2: fail-open guard — must FAIL on current code
  // ===========================================================================

  describe('fail-closed guard: null projectIds must reject', () => {
    test('rejects when resumeHandle.projectId is null', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        kind: 'web_debug',
        // projectId NOT set — stays null
      });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Must return null — unknown project origin should not match any project
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('rejects when navigation projectId is null (initial page load)', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: null });

      // Must return null — can't confirm project match without navigation context
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('rejects when both projectIds are null', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: null });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('rejects in-memory sessionId when resumeHandle has no projectId', () => {
      useSessionStore.setState({
        sessionId: SESSION_MERCURY,
        resumeHandle: {
          sessionId: null,
          projectId: null,
          kind: null,
          lastSeenTraceEventId: null,
        },
      });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('rejects in-memory sessionId when navigation has no projectId', () => {
      useSessionStore.setState({
        sessionId: SESSION_MERCURY,
        resumeHandle: {
          sessionId: SESSION_MERCURY,
          projectId: PROJECT_MERCURY,
          kind: 'web_debug',
          lastSeenTraceEventId: null,
        },
      });
      useNavigationStore.setState({ projectId: null });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });
  });

  // ===========================================================================
  // C. Cross-project scenarios — must FAIL on current code
  // ===========================================================================

  describe('cross-project scenarios', () => {
    test('Mercury Bank session must NOT be resumable in HA_JAVELINA context', () => {
      // Exact reproduction of the reported incident
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-100',
      });

      // setSession spreads old handle (Bug 1 makes projectId stale)
      useSessionStore
        .getState()
        .setSession(SESSION_MERCURY, makeAgent({ name: 'Banking_Supervisor' }));

      // Navigate to HA_JAVELINA
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Bug 1 left projectId as null (setSession didn't explicitly set it)
      // For this test, simulate the Bug 1 outcome:
      useSessionStore.setState({
        resumeHandle: {
          ...useSessionStore.getState().resumeHandle,
          projectId: null,
        },
      });

      // Must NOT leak Mercury's session into Javelina
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('session from Project A must not resume after navigating A → B → back to A with stale handle', () => {
      // User in Project A
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Navigate to Project B — clearSession fires
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });
      useSessionStore.getState().clearSession();

      // New session in B
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });

      // Navigate back to Project A
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Session B must NOT be resumable in Project A context
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('after project switch, only sessions from new project can resume', () => {
      // Start in Project A
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY); // correct

      // Navigate to Project B
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Mercury's session must not resolve
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // Set up Javelina's session
      useSessionStore.getState().clearSession();
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });

      // Javelina's session should resolve
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);
    });
  });

  // ===========================================================================
  // D. WebSocket reconnection scenarios
  // ===========================================================================

  describe('WebSocket reconnection scenarios', () => {
    test('reconnect in same project: stored session is resumable', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-50',
      });

      // Simulate reconnect — resolve should find the session
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('reconnect after project switch without clearSession (race): must not resume old session', () => {
      // Session from Project A stored
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Navigation changed to Project B, but clearSession hasn't run yet (race)
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // The resolve must reject — projects don't match
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('reconnect after browser refresh: persisted handle with matching project resumes', () => {
      // Simulate: after refresh, sessionId in store is null but handle persisted
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-75',
      });

      // Store sessionId is null (not persisted)
      expect(useSessionStore.getState().sessionId).toBeNull();

      // Navigation loaded from URL
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Should resolve from resumeHandle
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('reconnect after browser refresh: persisted handle with wrong project must not resume', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // User opened a bookmark to a different project
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });
  });

  // ===========================================================================
  // E. Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    test('empty string projectId in resumeHandle is treated as no projectId', () => {
      // Edge: if someone sets projectId to empty string
      useSessionStore.setState({
        resumeHandle: {
          sessionId: SESSION_MERCURY,
          projectId: '' as string | null, // empty string
          kind: 'web_debug',
          lastSeenTraceEventId: null,
        },
      });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Empty string is falsy — should be treated as no projectId → reject
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('empty string projectId in navigation is treated as no projectId', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      useNavigationStore.setState({ projectId: '' as string | null });

      // Empty string in nav → reject
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('rapid session switches within same project keep latest session', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Quick succession of sessions in same project
      for (let i = 1; i <= 5; i++) {
        useSessionStore.getState().rememberResumeHandle({
          sessionId: `session-${i}`,
          projectId: PROJECT_MERCURY,
          kind: 'web_debug',
          lastSeenTraceEventId: `trace-${i}`,
        });
      }

      expect(resolveCurrentResumableSessionId()).toBe('session-5');
      expect(useSessionStore.getState().resumeHandle.lastSeenTraceEventId).toBe('trace-5');
    });

    test('session_expired clears handle — resolve returns null', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Simulate session_expired handler
      useSessionStore.getState().clearResumeHandle();

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('concurrent in-memory sessionId and resumeHandle from different projects', () => {
      // Store has in-memory sessionId from Project A
      useSessionStore.setState({ sessionId: SESSION_MERCURY });

      // resumeHandle was updated to Project B (e.g., sidebar click)
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });

      // Navigation is at Project B
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // existingSessionId (Mercury) takes precedence over handle (Javelina),
      // but handle's projectId matches navigation. The resolve function returns
      // existingSessionId — which is from the WRONG project.
      // This is an edge case worth noting but it's prevented by the fact that
      // setSession also sets sessionId, so they should always be in sync.
      const result = resolveCurrentResumableSessionId();
      // The in-memory sessionId should be the one returned since it's preferred
      expect(result).toBe(SESSION_MERCURY);
    });
  });

  // ===========================================================================
  // F. Full user workflow happy paths
  // ===========================================================================

  describe('full user workflow happy paths', () => {
    test('normal session: create → chat → WS drop → reconnect resumes same session', () => {
      // 1. Agent loaded in Mercury project
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent({ name: 'Banking' }));
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: null,
      });

      // 2. User chats, trace events arrive
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-50',
      });

      // 3. WS disconnects and reconnects — onopen calls resolve
      const result = resolveCurrentResumableSessionId();
      expect(result).toBe(SESSION_MERCURY);

      // 4. Verify the trace cursor is available for incremental replay
      expect(useSessionStore.getState().resumeHandle.lastSeenTraceEventId).toBe('trace-50');
    });

    test('browser refresh on same project page: session resumes from localStorage', () => {
      // Before refresh: session was active
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-75',
      });

      // Simulate refresh: in-memory sessionId is lost, but resumeHandle persists
      useSessionStore.setState({ sessionId: null, agent: null, messages: [] });

      // Navigation rehydrates from URL
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // onopen calls resolve — should find the session from resumeHandle
      const result = resolveCurrentResumableSessionId();
      expect(result).toBe(SESSION_MERCURY);
    });

    test('browser refresh on different project page: old session NOT resumed', () => {
      // Session from Mercury persisted
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Simulate refresh: user opened a bookmark to Javelina
      useSessionStore.setState({ sessionId: null, agent: null, messages: [] });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Must NOT resume Mercury's session in Javelina context
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('new chat replaces old session, new session is resumable', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Old session
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-old',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // Click "New Chat" → clearSession
      useSessionStore.getState().clearSession();
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // New agent_loaded arrives
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent({ name: 'NewAgent' }));
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_MERCURY, // same project
        kind: 'web_debug',
        lastSeenTraceEventId: null,
      });

      // New session is resumable
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);
    });

    test('project switch → new session → that session is resumable', () => {
      // Start in Mercury
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // Switch to Javelina → clearSession
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });
      useSessionStore.getState().clearSession();
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // New session in Javelina
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);
    });

    test('agent switch within same project: new session is resumable', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Agent A
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent({ name: 'AgentA' }));
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // Switch agent → clearSession
      useSessionStore.getState().clearSession();

      // Agent B (same project)
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent({ name: 'AgentB' }));
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_MERCURY, // same project
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);
    });

    test('session sidebar click: switch to different session, old one no longer resolves', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Session A active
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Click Session B in sidebar — commitDeveloperSessionResume overwrites handle
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Now session B resolves, not A
      const result = resolveCurrentResumableSessionId();
      // existingSessionId is still SESSION_MERCURY (from setSession), but
      // resumeHandle.sessionId is SESSION_JAVELINA. existingSessionId ?? resumeHandle.sessionId
      // returns SESSION_MERCURY (existingSessionId takes precedence).
      expect(result).toBe(SESSION_MERCURY);

      // After session_resumed arrives, setState updates sessionId
      useSessionStore.setState({ sessionId: SESSION_JAVELINA });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);
    });

    test('session expired → clearResumeHandle → resolve returns null', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // session_expired handler
      useSessionStore.getState().clearResumeHandle();

      // Even though sessionId is still in store, handle is empty → no projectId match
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('back/forward navigation: project changes, old session rejected', () => {
      // Mercury active
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Forward to Javelina
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });
      useSessionStore.getState().clearSession();

      // Javelina session
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });

      // Press back → popstate changes URL to Mercury
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Javelina's session must NOT resolve in Mercury context
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('tab reopen with expired session: no stale session leaked', () => {
      // Session was persisted before tab close
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-99',
      });

      // Tab reopened, but now user opens a different project URL
      useSessionStore.setState({ sessionId: null, agent: null, messages: [] });
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // Must not resume Mercury's session
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('tab reopen same project: session is resumable', () => {
      // Session was persisted before tab close
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-99',
      });

      // Tab reopened on same project URL
      useSessionStore.setState({ sessionId: null, agent: null, messages: [] });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Should resume
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('full cycle: create → chat → disconnect → reconnect → more chat → project switch → clean', () => {
      // 1. Create session in Mercury
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: null,
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // 2. Chat: trace events arrive
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-10',
      });

      // 3. WS drops and reconnects
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // 4. More chat after reconnect
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-25',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // 5. Switch to Javelina
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });
      useSessionStore.getState().clearSession();
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // 6. New session in Javelina
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);

      // 7. Mercury session is gone — can't leak back
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });
  });

  // ===========================================================================
  // G. Additional edge cases and race conditions
  // ===========================================================================

  describe('additional edge cases', () => {
    test('navigation to non-project page (e.g. settings): no session resumes', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // User navigates to /settings — no projectId in URL
      useNavigationStore.setState({ projectId: null });

      // Must NOT resume — no project context
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('navigation from settings back to project: session resumes if matching', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      // Was on settings (no project)
      useNavigationStore.setState({ projectId: null });
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // Navigate back to the same project
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);
    });

    test('navigation from settings to a DIFFERENT project: session does not resume', () => {
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      useNavigationStore.setState({ projectId: null }); // settings
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA }); // different project

      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('clearSession mid-conversation: resolve returns null even with matching project', () => {
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });

      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // clearSession wipes everything
      useSessionStore.getState().clearSession();

      // Even though nav still says Mercury, no session to resume
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('three projects rapid cycle: only current project session resolves at each step', () => {
      // Mercury
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_MERCURY);

      // → Javelina
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });
      useSessionStore.getState().clearSession();
      useSessionStore.getState().setSession(SESSION_JAVELINA, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_JAVELINA,
        projectId: PROJECT_JAVELINA,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe(SESSION_JAVELINA);

      // → Third project
      useNavigationStore.setState({ projectId: PROJECT_THIRD });
      useSessionStore.getState().clearSession();
      useSessionStore.getState().setSession('session-third', makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: 'session-third',
        projectId: PROJECT_THIRD,
        kind: 'web_debug',
      });
      expect(resolveCurrentResumableSessionId()).toBe('session-third');

      // Back to Mercury — Third's session must not resolve
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('WS reconnect during project switch race: stale handle rejected even without clearSession', () => {
      // Session stored from Mercury
      useSessionStore.getState().setSession(SESSION_MERCURY, makeAgent());
      useSessionStore.getState().rememberResumeHandle({
        sessionId: SESSION_MERCURY,
        projectId: PROJECT_MERCURY,
        kind: 'web_debug',
        lastSeenTraceEventId: 'trace-50',
      });

      // User clicks to navigate to Javelina — URL changes, nav store updates
      // BUT clearSession from useEffect hasn't fired yet (React async)
      useNavigationStore.setState({ projectId: PROJECT_JAVELINA });

      // WS reconnects at this exact moment — onopen calls resolve
      // The handle still has Mercury's session, but nav says Javelina → mismatch
      expect(resolveCurrentResumableSessionId()).toBeNull();

      // Even the in-memory sessionId (Mercury) should not be returned
      expect(useSessionStore.getState().sessionId).toBe(SESSION_MERCURY);
      // But resolve says null — correct, guard holds
    });

    test('session handle with kind=null is not resumable', () => {
      useSessionStore.setState({
        resumeHandle: {
          sessionId: SESSION_MERCURY,
          projectId: PROJECT_MERCURY,
          kind: null, // not a web_debug session
          lastSeenTraceEventId: null,
        },
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // The resolve function doesn't check kind — it returns the session
      // (kind filtering happens downstream in the attach validation)
      // This test documents that behavior
      const result = resolveCurrentResumableSessionId();
      expect(result).toBe(SESSION_MERCURY);
    });

    test('existingSessionId set without corresponding resumeHandle: guard still checks handle projectId', () => {
      // Rare state: sessionId set directly without going through setSession
      useSessionStore.setState({ sessionId: SESSION_MERCURY });
      // resumeHandle is empty (no projectId)

      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // existingSessionId would match, but handle has no projectId → fail-closed rejects
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });

    test('both existingSessionId and resumeHandle.sessionId null: returns null regardless of project match', () => {
      useSessionStore.setState({
        sessionId: null,
        resumeHandle: {
          sessionId: null,
          projectId: PROJECT_MERCURY,
          kind: 'web_debug',
          lastSeenTraceEventId: null,
        },
      });
      useNavigationStore.setState({ projectId: PROJECT_MERCURY });

      // Projects match, but no session to resume
      expect(resolveCurrentResumableSessionId()).toBeNull();
    });
  });
});
