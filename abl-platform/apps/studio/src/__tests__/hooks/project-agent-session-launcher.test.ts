import { describe, expect, test, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TestContextPayload } from '../../types/test-context';
import { useProjectAgentSessionLauncher } from '../../hooks/useProjectAgentSessionLauncher';
import { useSessionStore } from '../../store/session-store';
import { useObservatoryStore } from '../../store/observatory-store';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAgentResponse(name: string, agentPath = `${name}.agent` as string) {
  return {
    agent: {
      id: `${name}-id`,
      name,
      agentPath,
      description: null,
      dslContent: null,
      activeVersions: {},
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:00.000Z',
    },
  };
}

describe('useProjectAgentSessionLauncher', () => {
  beforeEach(() => {
    useSessionStore.getState().clearSession();
    useSessionStore.getState().setLoading(false);
    useSessionStore.getState().setError(null);
    useSessionStore.getState().setStatusMessage(null);
    useObservatoryStore.getState().clearEvents();
    useObservatoryStore.getState().clearFlow();
    useObservatoryStore.getState().resetMetrics();
  });

  test('loads only the latest fresh-chat request when overlapping launches resolve out of order', async () => {
    const firstFetch = createDeferred<ReturnType<typeof makeAgentResponse>>();
    const secondFetch = createDeferred<ReturnType<typeof makeAgentResponse>>();
    const fetchAgent = vi
      .fn()
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise);
    const loadAgent = vi.fn();
    const loadAgentWithContext = vi.fn();

    const { result } = renderHook(() =>
      useProjectAgentSessionLauncher({
        isConnected: true,
        fetchAgent,
        loadAgent,
        loadAgentWithContext,
      }),
    );

    const firstPromise = result.current.startProjectAgentSession({
      agentName: 'support-agent',
      projectId: 'proj-1',
    });
    const secondPromise = result.current.startProjectAgentSession({
      agentName: 'support-agent',
      projectId: 'proj-1',
    });

    expect(useSessionStore.getState().isLoading).toBe(true);

    await act(async () => {
      firstFetch.resolve(makeAgentResponse('stale-agent'));
      await firstPromise;
    });

    expect(loadAgent).not.toHaveBeenCalled();
    expect(useSessionStore.getState().isLoading).toBe(true);

    await act(async () => {
      secondFetch.resolve(makeAgentResponse('fresh-agent'));
      await secondPromise;
    });

    expect(loadAgent).toHaveBeenCalledTimes(1);
    expect(loadAgent).toHaveBeenCalledWith('fresh-agent.agent', 'proj-1');
    expect(loadAgentWithContext).not.toHaveBeenCalled();
  });

  test('uses loadAgentWithContext when context is provided', async () => {
    const fetchAgent = vi.fn().mockResolvedValue(makeAgentResponse('context-agent'));
    const loadAgent = vi.fn();
    const loadAgentWithContext = vi.fn();
    const context: TestContextPayload = {
      gatherValues: { issue_summary: 'VPN outage' },
      sessionVariables: { support_mode: 'guided' },
      toolMocks: [],
    };

    const { result } = renderHook(() =>
      useProjectAgentSessionLauncher({
        isConnected: true,
        fetchAgent,
        loadAgent,
        loadAgentWithContext,
      }),
    );

    await act(async () => {
      await result.current.startProjectAgentSession({
        agentName: 'context-agent',
        projectId: 'proj-ctx',
        context,
      });
    });

    expect(loadAgent).not.toHaveBeenCalled();
    expect(loadAgentWithContext).toHaveBeenCalledTimes(1);
    expect(loadAgentWithContext).toHaveBeenCalledWith('context-agent.agent', 'proj-ctx', context);
  });

  test('surfaces a not-found error and clears loading when fetch fails', async () => {
    const fetchAgent = vi.fn().mockRejectedValue(new Error('missing'));
    const loadAgent = vi.fn();
    const loadAgentWithContext = vi.fn();

    const { result } = renderHook(() =>
      useProjectAgentSessionLauncher({
        isConnected: true,
        fetchAgent,
        loadAgent,
        loadAgentWithContext,
      }),
    );

    await act(async () => {
      const started = await result.current.startProjectAgentSession({
        agentName: 'missing-agent',
        projectId: 'proj-404',
      });
      expect(started).toBe(false);
    });

    expect(loadAgent).not.toHaveBeenCalled();
    expect(loadAgentWithContext).not.toHaveBeenCalled();
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().error).toBe('Agent "missing-agent" not found');
  });

  test('surfaces a connection error while the runtime is still disconnected', async () => {
    const fetchAgent = vi.fn();
    const loadAgent = vi.fn();
    const loadAgentWithContext = vi.fn();

    const { result } = renderHook(() =>
      useProjectAgentSessionLauncher({
        isConnected: false,
        fetchAgent,
        loadAgent,
        loadAgentWithContext,
      }),
    );

    await act(async () => {
      const started = await result.current.startProjectAgentSession({
        agentName: 'support-agent',
        projectId: 'proj-1',
      });
      expect(started).toBe(false);
    });

    expect(fetchAgent).not.toHaveBeenCalled();
    expect(loadAgent).not.toHaveBeenCalled();
    expect(loadAgentWithContext).not.toHaveBeenCalled();
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().error).toBe(
      'Runtime is still connecting. Try again in a moment.',
    );
  });

  test('clears stale observatory events and token metrics before fetching the next project agent', async () => {
    const fetchAgentDeferred = createDeferred<ReturnType<typeof makeAgentResponse>>();
    const fetchAgent = vi.fn().mockReturnValue(fetchAgentDeferred.promise);
    const loadAgent = vi.fn();
    const loadAgentWithContext = vi.fn();

    useObservatoryStore.setState({
      events: [
        {
          id: 'old-event',
          type: 'llm_call',
          traceId: 'trace-old',
          sessionId: 'session-old',
          timestamp: new Date(),
          data: {},
        } as never,
      ],
      totalTokensIn: 42,
      totalTokensOut: 24,
      totalLLMCalls: 1,
    });

    const { result } = renderHook(() =>
      useProjectAgentSessionLauncher({
        isConnected: true,
        fetchAgent,
        loadAgent,
        loadAgentWithContext,
      }),
    );

    const launchPromise = result.current.startProjectAgentSession({
      agentName: 'next-agent',
      projectId: 'project-next',
    });

    expect(fetchAgent).toHaveBeenCalledWith('project-next', 'next-agent');
    expect(useObservatoryStore.getState().events).toEqual([]);
    expect(useObservatoryStore.getState().totalTokensIn).toBe(0);
    expect(useObservatoryStore.getState().totalTokensOut).toBe(0);
    expect(useObservatoryStore.getState().totalLLMCalls).toBe(0);

    await act(async () => {
      fetchAgentDeferred.resolve(makeAgentResponse('next-agent'));
      await launchPromise;
    });
  });
});
