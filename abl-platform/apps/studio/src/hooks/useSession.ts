/**
 * Session Hook
 *
 * Provides convenient access to session state and actions
 */

import { useSessionStore } from '../store/session-store';

export function useSession() {
  const {
    sessionId,
    agent,
    messages,
    state,
    lastAction,
    isStreaming,
    streamingContent,
    isLoading,
    error,
    clearSession,
  } = useSessionStore();

  const hasSession = !!sessionId;
  const hasAgent = !!agent;

  // Computed values
  const gatherFields = agent?.gatherFieldCount ?? 0;
  const toolCount = agent?.toolCount ?? 0;
  const isComplete = lastAction?.type === 'complete';
  const isEscalated = lastAction?.type === 'escalate';
  const isHandedOff = lastAction?.type === 'handoff';

  // Gather progress
  const gatherProgress = state?.gatherProgress ?? {};
  const gatheredCount = Object.keys(gatherProgress).length;
  const gatherPercentage = gatherFields > 0 ? Math.round((gatheredCount / gatherFields) * 100) : 0;

  // Conversation phase
  const phase = state?.conversationPhase ?? 'start';

  return {
    // State
    sessionId,
    agent,
    messages,
    state,
    lastAction,
    isStreaming,
    streamingContent,
    isLoading,
    error,

    // Computed
    hasSession,
    hasAgent,
    gatherFields,
    toolCount,
    isComplete,
    isEscalated,
    isHandedOff,
    gatherProgress,
    gatheredCount,
    gatherPercentage,
    phase,

    // Actions
    clearSession,
  };
}
