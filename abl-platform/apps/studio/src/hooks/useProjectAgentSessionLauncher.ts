import { useCallback, useEffect, useRef } from 'react';
import { fetchRuntimeAgent, type RuntimeAgentDetailResponse } from '../api/runtime-agents';
import { useSessionStore } from '../store/session-store';
import { useObservatoryStore } from '../store/observatory-store';
import type { TestContextPayload } from '../types/test-context';

interface StartProjectAgentSessionArgs {
  agentName: string | null;
  projectId: string | null;
  context?: TestContextPayload;
  callerData?: Record<string, unknown>;
}

interface UseProjectAgentSessionLauncherArgs {
  isConnected: boolean;
  loadAgent: (agentPath: string, projectId: string, callerData?: Record<string, unknown>) => void;
  loadAgentWithContext: (agentPath: string, projectId: string, context: TestContextPayload) => void;
  fetchAgent?: (projectId: string, agentName: string) => Promise<RuntimeAgentDetailResponse>;
}

interface UseProjectAgentSessionLauncherResult {
  startProjectAgentSession: (args: StartProjectAgentSessionArgs) => Promise<boolean>;
}

/**
 * Coordinates "fresh chat" launches so only the latest fetch result can create
 * a runtime session. This prevents rapid repeat clicks from replaying stale
 * fetch responses into multiple `load_agent` messages.
 */
export function useProjectAgentSessionLauncher({
  isConnected,
  loadAgent,
  loadAgentWithContext,
  fetchAgent = fetchRuntimeAgent,
}: UseProjectAgentSessionLauncherArgs): UseProjectAgentSessionLauncherResult {
  const requestSequenceRef = useRef(0);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    return () => {
      requestSequenceRef.current += 1;
    };
  }, []);

  const startProjectAgentSession = useCallback(
    async ({
      agentName,
      projectId,
      context,
      callerData,
    }: StartProjectAgentSessionArgs): Promise<boolean> => {
      if (!agentName || !projectId) {
        return false;
      }

      if (!isConnectedRef.current) {
        const store = useSessionStore.getState();
        store.setLoading(false);
        store.setError('Runtime is still connecting. Try again in a moment.');
        return false;
      }

      const currentRequest = ++requestSequenceRef.current;
      const sessionStore = useSessionStore.getState();
      const observatoryStore = useObservatoryStore.getState();
      sessionStore.clearSession();
      observatoryStore.clearEvents();
      observatoryStore.clearFlow();
      observatoryStore.resetMetrics();
      sessionStore.setLoading(true);
      sessionStore.setError(null);

      try {
        const { agent } = await fetchAgent(projectId, agentName);
        if (currentRequest !== requestSequenceRef.current) {
          return false;
        }

        if (!isConnectedRef.current) {
          useSessionStore.getState().setLoading(false);
          useSessionStore.getState().setError('Runtime disconnected before chat could start');
          return false;
        }

        const agentPath = agent.agentPath || agent.name;
        if (context) {
          loadAgentWithContext(agentPath, projectId, context);
        } else if (callerData && Object.keys(callerData).length > 0) {
          loadAgent(agentPath, projectId, callerData);
        } else {
          loadAgent(agentPath, projectId);
        }

        return true;
      } catch {
        if (currentRequest !== requestSequenceRef.current) {
          return false;
        }

        const store = useSessionStore.getState();
        store.setLoading(false);
        store.setError(`Agent "${agentName}" not found`);
        return false;
      }
    },
    [fetchAgent, loadAgent, loadAgentWithContext],
  );

  return { startProjectAgentSession };
}
