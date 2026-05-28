/**
 * WebSocket Context
 *
 * Provides a single shared WebSocket connection across all components.
 * Carries internal runtime auth in the WebSocket subprotocol when the user is logged in.
 */

import React, { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { mutate } from 'swr';
import { createInitialAgentState, useSessionStore } from '../store/session-store';
import { useObservatoryStore } from '../store/observatory-store';
import { LOGOUT_SIGNAL_EVENT, useAuthStore } from '../store/auth-store';
import { useUIStore } from '../store/ui-store';
import { useNavigationStore } from '../store/navigation-store';
import { apiFetch } from '../lib/api-client';
import { sanitizeServerError } from '../lib/sanitize-error';
import { generateStaticGraph } from '../utils/graph-generator';
import {
  formatTraceEventLog,
  hydrateSessionStoreFromDetail,
  replayTraceEventsIntoObservatory,
} from '../utils/replay-trace-events';
import { normalizeTraceEventRecord, toExtendedTraceEvent } from '../utils/trace-event-adapter';
import { ingestLiveTraceEvent } from '../utils/live-trace-event-ingestion';
import { buildSessionHealthEvents } from '../utils/session-health-events';
import { buildRuntimeChatNotice, formatQueuedRuntimeNotice } from '../lib/runtime-chat-notice';
import type {
  ClientMessage,
  ServerMessage,
  CsatData,
  ExtendedTraceEvent,
  TraceEvent,
} from '../types';
import type { TestContextPayload, ContextInjection, ToolMockConfig } from '../types/test-context';
import { deriveDefaultWsUrl } from '../utils/derive-ws-url';
import { useBatchConsentStore } from '../store/batch-consent-store';
import { buildWebDebugWSProtocols } from '@agent-platform/shared/websocket-auth';
import type { ActionSet, RichContent, VoiceConfig } from '@agent-platform/web-sdk';
import { useProjectAgentSessionLauncher } from '../hooks/useProjectAgentSessionLauncher';
import {
  fetchAppStaticGraph,
  fetchAvailableAppsList,
  type AvailableAppInfo as AppInfo,
} from '../lib/app-graph-loader';

type SessionDetailHydrationPayload = Parameters<typeof hydrateSessionStoreFromDetail>[0];
type SessionDetailResponsePayload = SessionDetailHydrationPayload & {
  traceEvents?: unknown[];
};
type DeveloperSessionAttachmentStatus = 'attached' | 'detached';
type DeveloperSessionApiResponse = {
  success?: boolean;
  data?: {
    clientAttachment?: {
      status?: DeveloperSessionAttachmentStatus;
    } | null;
    executionSession?: {
      sessionId?: string;
      projectId?: string | null;
      channel?: string;
    } | null;
    resume?: {
      canResume?: boolean;
    } | null;
  } | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
};
type ResumableDeveloperSession = {
  sessionId: string;
  projectId: string;
  attachmentStatus: DeveloperSessionAttachmentStatus;
};
type DeveloperSessionAttachmentValidation =
  | { kind: 'ready'; session: ResumableDeveloperSession }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

const RESUME_NOT_FOUND_ERROR_MESSAGE =
  'This session is no longer resumable. Click + New Chat to start a new conversation.';
const SESSION_UNAVAILABLE_ERROR_MESSAGE =
  'This session is no longer available. Click + New Chat to start a new conversation.';
const DEVELOPER_SESSION_ATTACH_ERROR_MESSAGE =
  'Failed to validate the developer session. Click + New Chat to start a new conversation.';
const SESSION_PERSIST_TIMEOUT_MS = 10_000;

/** Handler type for subscribeChatMessage — receives the raw ServerMessage */
type ChatMessageHandler = (msg: ServerMessage) => void;

type PendingSessionPersistRequest = {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

function createSessionPersistRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `persist-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface WebSocketContextValue {
  isConnected: boolean;
  isReconnecting: boolean;
  isConfigured: boolean;
  statusMessage: string | null;
  availableApps: AppInfo[];
  loadingApp: boolean;
  send: (message: ClientMessage) => void;
  ensureSessionPersisted: (sessionId: string) => Promise<void>;
  loadAgent: (agentPath: string, projectId: string, callerData?: Record<string, unknown>) => void;
  startProjectAgentSession: (
    agentName: string | null,
    projectId: string | null,
    context?: TestContextPayload,
    callerData?: Record<string, unknown>,
  ) => Promise<boolean>;
  loadApp: (domain: string) => Promise<void>;
  fetchApps: () => Promise<void>;
  sendMessage: (
    text: string,
    options?: {
      attachmentIds?: string[];
      attachmentFilenames?: string[];
      attachmentMimeTypes?: string[];
      messageId?: string;
    },
  ) => void;
  runTest: (testId: string) => void;
  switchSession: (sessionId: string) => Promise<void>;
  resumeSession: (runtimeSessionId: string) => void;
  // Test context methods
  loadAgentWithContext: (agentPath: string, projectId: string, context: TestContextPayload) => void;
  injectContext: (injection: ContextInjection) => void;
  setToolMocks: (mocks: ToolMockConfig[]) => void;
  clearToolMocks: () => void;
  /**
   * Manually trigger a reconnect attempt. Resets the attempt counter so the
   * full maxReconnectAttempts budget is available again. Use this to surface a
   * "Retry connection" button after all automatic attempts are exhausted.
   */
  reconnect: () => void;
  /**
   * Subscribe to chat-relevant server messages (response_start, response_chunk,
   * response_end, auth_challenge, status_update, status_clear, and trace_event
   * activity updates consumed by Studio chat adapters.
   * Returns an unsubscribe function.
   */
  subscribeChatMessage: (handler: ChatMessageHandler) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

function normalizeTraceEvents(
  traceEvents: unknown[] | undefined,
  options?: { fallbackSessionId?: string; fallbackTraceId?: string },
): TraceEvent[] {
  return (traceEvents || [])
    .filter(isRecord)
    .map((event) => normalizeTraceEventRecord(event, options));
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

// Events emitted only to EventStore/ClickHouse, not stored in Redis TraceStore.
// Using their IDs as the reconnect cursor breaks incremental replay: Redis
// cannot find the cursor and returns snapshotRequired:true, forcing a full reload
// from /traces — which returns only the (smaller) ClickHouse projection.
const CLICKHOUSE_ONLY_TRACE_TYPES = new Set(['channel_response_sent', 'channel.response.sent']);

function getLatestTraceEventId(
  traceEvents: Array<{ id: string; timestamp: Date | string; type?: string }>,
): string | undefined {
  if (traceEvents.length === 0) {
    return undefined;
  }

  // Use only Redis-backed events so the cursor remains valid on reconnect.
  const redisBackedEvents = traceEvents.filter(
    (e) => !CLICKHOUSE_ONLY_TRACE_TYPES.has(e.type ?? ''),
  );
  if (redisBackedEvents.length === 0) {
    return undefined;
  }

  const sorted = [...redisBackedEvents].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
  return sorted[sorted.length - 1]?.id;
}

function shouldHydrateResumedSessionFromDetail(
  currentSessionId: string | null,
  resumedSessionId: string,
  currentMessageCount: number,
  detailMessageCount: number,
  isStreaming: boolean,
): boolean {
  if (currentSessionId !== resumedSessionId || isStreaming) {
    return false;
  }

  // REST detail is the safer source for resumed history, but do not let it
  // overwrite newer live messages that may have been added after the resume
  // event and before the detail fetch completes.
  return detailMessageCount >= currentMessageCount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVoiceConfig(value: unknown): VoiceConfig | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  return isRecord(value) ? (value as VoiceConfig) : undefined;
}

function normalizeRichContent(value: unknown): RichContent | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  return isRecord(value) ? (value as RichContent) : undefined;
}

function normalizeActionSet(value: unknown): ActionSet | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  return isRecord(value) && Array.isArray(value.elements)
    ? (value as unknown as ActionSet)
    : undefined;
}

function normalizeLocalization(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  return isRecord(value) ? value : undefined;
}

function extractResumableDeveloperSession(
  payload: DeveloperSessionApiResponse,
  fallbackProjectId: string,
): ResumableDeveloperSession | null {
  if (payload.data?.resume?.canResume === false) {
    return null;
  }

  const executionSession = payload.data?.executionSession;
  if (
    !executionSession ||
    executionSession.channel !== 'web_debug' ||
    typeof executionSession.sessionId !== 'string' ||
    executionSession.sessionId.length === 0
  ) {
    return null;
  }

  const resolvedProjectId =
    typeof executionSession.projectId === 'string' && executionSession.projectId.length > 0
      ? executionSession.projectId
      : fallbackProjectId;

  return {
    sessionId: executionSession.sessionId,
    projectId: resolvedProjectId,
    attachmentStatus:
      payload.data?.clientAttachment?.status === 'attached' ? 'attached' : 'detached',
  };
}

async function readDeveloperSessionErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as DeveloperSessionApiResponse;
    const message = payload.error?.message;
    return typeof message === 'string' && message.trim().length > 0
      ? sanitizeServerError(message, DEVELOPER_SESSION_ATTACH_ERROR_MESSAGE)
      : null;
  } catch {
    return null;
  }
}

function pruneSessionDetailCacheValue(currentValue: unknown): unknown {
  if (!isRecord(currentValue)) {
    return currentValue;
  }

  const resetState = createInitialAgentState();
  if (isRecord(currentValue.session)) {
    return {
      ...currentValue,
      session: {
        ...currentValue.session,
        messages: [],
        traceEvents: [],
        messageCount: 0,
        state: resetState,
      },
    };
  }

  return {
    ...currentValue,
    messages: [],
    traceEvents: [],
    messageCount: 0,
    state: resetState,
  };
}

function pruneSessionTraceCacheValue(currentValue: unknown): unknown {
  if (!isRecord(currentValue)) {
    return currentValue;
  }

  if (isRecord(currentValue.data)) {
    return {
      ...currentValue,
      data: {
        ...currentValue.data,
        traces: [],
      },
    };
  }

  return {
    ...currentValue,
    traces: [],
  };
}

async function fetchSessionTraceEvents(
  sessionId: string,
  projectId: string,
): Promise<TraceEvent[]> {
  const response = await apiFetch(
    `/api/runtime/sessions/${encodeURIComponent(sessionId)}/traces?projectId=${encodeURIComponent(projectId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Trace fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const rawTraceEventsValue =
    payload.traces ?? (payload.data as Record<string, unknown> | undefined)?.traces;
  const rawTraceEvents = Array.isArray(rawTraceEventsValue) ? rawTraceEventsValue : [];

  return normalizeTraceEvents(rawTraceEvents, {
    fallbackSessionId: sessionId,
    fallbackTraceId: sessionId,
  });
}

interface WebSocketProviderProps {
  children: React.ReactNode;
  url?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function WebSocketProvider({
  children,
  url = deriveDefaultWsUrl(),
  reconnectInterval = 3000,
  maxReconnectAttempts = 20,
}: WebSocketProviderProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef(false);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref to doConnect so reconnect() can call it without being inside the effect.
  const doConnectRef = useRef<(() => void) | null>(null);

  // Chat message emitter — subscribers receive chat-relevant ServerMessages
  const chatMessageSubscribersRef = useRef<Set<ChatMessageHandler>>(new Set());
  const pendingSessionPersistRequestsRef = useRef<Map<string, PendingSessionPersistRequest>>(
    new Map(),
  );
  const lastSeenTraceEventIdsRef = useRef<Map<string, string>>(new Map());
  const pendingCrossSessionSnapshotHydrationRef = useRef<Set<string>>(new Set());

  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // Store actions — use individual selectors to avoid re-renders on unrelated state changes
  const setSession = useSessionStore((s) => s.setSession);
  const setState = useSessionStore((s) => s.setState);
  const updateState = useSessionStore((s) => s.updateState);
  const setLastAction = useSessionStore((s) => s.setLastAction);
  const startStreaming = useSessionStore((s) => s.startStreaming);
  const appendStreamChunk = useSessionStore((s) => s.appendStreamChunk);
  const endStreaming = useSessionStore((s) => s.endStreaming);
  const setError = useSessionStore((s) => s.setError);
  const setStoreStatusMessage = useSessionStore((s) => s.setStatusMessage);
  const addMessage = useSessionStore((s) => s.addMessage);
  const clearMessages = useSessionStore((s) => s.clearMessages);
  const replaceMessages = useSessionStore((s) => s.replaceMessages);
  const rememberResumeHandle = useSessionStore((s) => s.rememberResumeHandle);
  const clearResumeHandle = useSessionStore((s) => s.clearResumeHandle);

  const setDebugState = useObservatoryStore((s) => s.setDebugState);
  const clearObservatoryEvents = useObservatoryStore((s) => s.clearEvents);
  const clearFlow = useObservatoryStore((s) => s.clearFlow);
  const resetObservatoryMetrics = useObservatoryStore((s) => s.resetMetrics);
  const setStaticGraph = useObservatoryStore((s) => s.setStaticGraph);
  const setAppStaticGraph = useObservatoryStore((s) => s.setAppStaticGraph);
  const setGraphViewMode = useObservatoryStore((s) => s.setGraphViewMode);
  const addObservatoryEvent = useObservatoryStore((s) => s.addEvent);
  const startClientTimer = useObservatoryStore((s) => s.startClientTimer);
  const endClientTimer = useObservatoryStore((s) => s.endClientTimer);
  const addLog = useObservatoryStore((s) => s.addLog);
  const clearLogs = useObservatoryStore((s) => s.clearLogs);

  // App loading state
  const [availableApps, setAvailableApps] = useState<AppInfo[]>([]);
  const [loadingApp, setLoadingApp] = useState(false);

  const rememberLatestTraceEventId = useCallback(
    (
      sessionId: string,
      traceEvents: TraceEvent[],
      options?: {
        clearWhenEmpty?: boolean;
      },
    ) => {
      const latestTraceEventId = getLatestTraceEventId(traceEvents);
      const currentProjectId = useNavigationStore.getState().projectId;
      if (latestTraceEventId) {
        lastSeenTraceEventIdsRef.current.set(sessionId, latestTraceEventId);
        rememberResumeHandle({
          sessionId,
          ...(currentProjectId ? { projectId: currentProjectId } : {}),
          kind: 'web_debug',
          lastSeenTraceEventId: latestTraceEventId,
        });
      } else if (options?.clearWhenEmpty !== false) {
        lastSeenTraceEventIdsRef.current.delete(sessionId);
        rememberResumeHandle({
          sessionId,
          ...(currentProjectId ? { projectId: currentProjectId } : {}),
          kind: 'web_debug',
          lastSeenTraceEventId: null,
        });
      }
    },
    [rememberResumeHandle],
  );

  const resolveCurrentResumableSessionId = useCallback(() => {
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
  }, []);

  const discoverCurrentDeveloperSession = useCallback(async () => {
    const currentProjectId = useNavigationStore.getState().projectId;
    const currentUserId = useAuthStore.getState().user?.id;
    if (!currentProjectId || !currentUserId) {
      return null;
    }

    try {
      const response = await apiFetch(
        `/api/runtime/sessions/current?projectId=${encodeURIComponent(currentProjectId)}&channel=web_debug`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as DeveloperSessionApiResponse;
      const session = extractResumableDeveloperSession(payload, currentProjectId);
      if (!session) {
        return null;
      }

      return {
        sessionId: session.sessionId,
        projectId: session.projectId,
      };
    } catch {
      return null;
    }
  }, []);

  const validateDeveloperSessionAttachment = useCallback(
    async (session: {
      sessionId: string;
      projectId?: string | null;
    }): Promise<DeveloperSessionAttachmentValidation> => {
      const projectId =
        typeof session.projectId === 'string' && session.projectId.length > 0
          ? session.projectId
          : useNavigationStore.getState().projectId;
      if (!projectId) {
        return {
          kind: 'error',
          message: DEVELOPER_SESSION_ATTACH_ERROR_MESSAGE,
        };
      }

      try {
        const response = await apiFetch(
          `/api/runtime/sessions/attach?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sessionId: session.sessionId,
              channel: 'web_debug',
            }),
            cache: 'no-store',
          },
        );

        if (response.status === 404) {
          return { kind: 'not_found' };
        }

        if (!response.ok) {
          const errorMessage = await readDeveloperSessionErrorMessage(response);
          return {
            kind: 'error',
            message: errorMessage ?? DEVELOPER_SESSION_ATTACH_ERROR_MESSAGE,
          };
        }

        const payload = (await response.json()) as DeveloperSessionApiResponse;
        const validatedSession = extractResumableDeveloperSession(payload, projectId);
        if (!validatedSession) {
          return { kind: 'not_found' };
        }

        return {
          kind: 'ready',
          session: validatedSession,
        };
      } catch {
        return {
          kind: 'error',
          message: DEVELOPER_SESSION_ATTACH_ERROR_MESSAGE,
        };
      }
    },
    [],
  );

  const sendResumeMessage = useCallback((ws: WebSocket, sessionId: string) => {
    const { resumeHandle } = useSessionStore.getState();
    const lastSeenTraceEventId =
      lastSeenTraceEventIdsRef.current.get(sessionId) ??
      (resumeHandle.sessionId === sessionId
        ? (resumeHandle.lastSeenTraceEventId ?? undefined)
        : undefined);

    ws.send(
      JSON.stringify({
        type: 'resume_session',
        sessionId,
        ...(lastSeenTraceEventId ? { lastSeenTraceEventId } : {}),
      }),
    );
  }, []);

  const commitDeveloperSessionResume = useCallback(
    (ws: WebSocket, session: ResumableDeveloperSession) => {
      rememberResumeHandle({
        sessionId: session.sessionId,
        projectId: session.projectId,
        kind: 'web_debug',
      });
      sendResumeMessage(ws, session.sessionId);
    },
    [rememberResumeHandle, sendResumeMessage],
  );

  const maybeResumeDiscoveredCurrentSession = useCallback(
    async (ws: WebSocket, options?: { excludeSessionId?: string }) => {
      const discoveredSession = await discoverCurrentDeveloperSession();
      if (!discoveredSession || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (options?.excludeSessionId && discoveredSession.sessionId === options.excludeSessionId) {
        return false;
      }

      const { isLoading } = useSessionStore.getState();
      const latestResumableSessionId = resolveCurrentResumableSessionId();
      if (
        isLoading ||
        (latestResumableSessionId &&
          latestResumableSessionId !== discoveredSession.sessionId &&
          latestResumableSessionId !== options?.excludeSessionId)
      ) {
        return false;
      }

      const validation = await validateDeveloperSessionAttachment(discoveredSession);
      if (validation.kind !== 'ready' || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (options?.excludeSessionId && validation.session.sessionId === options.excludeSessionId) {
        return false;
      }

      const postValidationState = useSessionStore.getState();
      const latestValidatedResumableSessionId = resolveCurrentResumableSessionId();
      if (
        postValidationState.isLoading ||
        (latestValidatedResumableSessionId &&
          latestValidatedResumableSessionId !== validation.session.sessionId &&
          latestValidatedResumableSessionId !== options?.excludeSessionId)
      ) {
        return false;
      }

      commitDeveloperSessionResume(ws, validation.session);
      return true;
    },
    [
      commitDeveloperSessionResume,
      discoverCurrentDeveloperSession,
      resolveCurrentResumableSessionId,
      validateDeveloperSessionAttachment,
    ],
  );

  const resumeValidatedStoredSession = useCallback(
    async (ws: WebSocket, sessionId: string) => {
      const { resumeHandle } = useSessionStore.getState();
      const validation = await validateDeveloperSessionAttachment({
        sessionId,
        projectId: resumeHandle.sessionId === sessionId ? resumeHandle.projectId : null,
      });

      if (validation.kind === 'ready') {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
          return false;
        }

        const { isLoading } = useSessionStore.getState();
        const latestResumableSessionId = resolveCurrentResumableSessionId();
        if (
          isLoading ||
          (latestResumableSessionId && latestResumableSessionId !== validation.session.sessionId)
        ) {
          return false;
        }

        commitDeveloperSessionResume(ws, validation.session);
        return true;
      }

      if (validation.kind === 'not_found') {
        lastSeenTraceEventIdsRef.current.delete(sessionId);
        clearResumeHandle();
        // Hydrate ClickHouse traces for the expired session so the debug panel
        // retains history even though the runtime no longer has it in memory.
        const notFoundProjectId = useNavigationStore.getState().projectId;
        if (notFoundProjectId) {
          void hydrateTraceSnapshot(sessionId, { preserveExistingObservatory: false });
        }
        const resumedFallbackSession = await maybeResumeDiscoveredCurrentSession(ws, {
          excludeSessionId: sessionId,
        });
        if (!resumedFallbackSession) {
          setError(RESUME_NOT_FOUND_ERROR_MESSAGE);
        }
        return resumedFallbackSession;
      }

      setError(validation.message);
      return false;
    },
    [
      clearResumeHandle,
      commitDeveloperSessionResume,
      maybeResumeDiscoveredCurrentSession,
      resolveCurrentResumableSessionId,
      setError,
      validateDeveloperSessionAttachment,
    ],
  );

  const invalidateSessionCaches = useCallback((sessionId: string) => {
    const currentProjectId = useNavigationStore.getState().projectId;
    if (!currentProjectId) {
      return;
    }

    const encodedProjectId = encodeURIComponent(currentProjectId);
    const encodedSessionId = encodeURIComponent(sessionId);
    const sessionListKey = `/api/runtime/sessions?projectId=${encodedProjectId}`;
    const sessionDetailKey = `/api/runtime/sessions/${encodedSessionId}?projectId=${encodedProjectId}&includeTraces=false`;
    const sessionTracesKey = `/api/runtime/sessions/${encodedSessionId}/traces?projectId=${encodedProjectId}`;
    const sessionAgentSpecKey = `/api/runtime/sessions/${encodedSessionId}/agent-spec?projectId=${encodedProjectId}`;

    void mutate(sessionListKey);
    void mutate(sessionDetailKey, pruneSessionDetailCacheValue, {
      revalidate: false,
    });
    void mutate(sessionDetailKey);
    void mutate(sessionTracesKey, pruneSessionTraceCacheValue, {
      revalidate: false,
    });
    void mutate(sessionTracesKey);
    void mutate(sessionAgentSpecKey);
  }, []);

  const appendReplayEventsToObservatory = useCallback(
    (traceEvents: TraceEvent[], sessionId: string) => {
      const sortedEvents = [...traceEvents].sort(
        (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
      );

      for (const traceEvent of sortedEvents) {
        const extendedEvent: ExtendedTraceEvent = toExtendedTraceEvent(traceEvent, {
          fallbackSessionId: sessionId,
          fallbackTraceId: sessionId,
        });
        const accepted = addObservatoryEvent(extendedEvent) !== false;

        const logEntry = accepted ? formatTraceEventLog(traceEvent.type, extendedEvent.data) : null;
        if (logEntry) {
          addLog(logEntry.level, logEntry.message);
        }
      }
    },
    [addObservatoryEvent, addLog],
  );

  const resolveSessionTraceEvents = useCallback(
    async (
      sessionId: string,
      sessionData: SessionDetailResponsePayload,
      projectId?: string | null,
    ): Promise<TraceEvent[]> => {
      const embeddedTraceEvents = normalizeTraceEvents(sessionData.traceEvents, {
        fallbackSessionId: sessionId,
        fallbackTraceId: sessionId,
      });
      if (embeddedTraceEvents.length > 0 || !projectId) {
        return embeddedTraceEvents;
      }

      try {
        return await fetchSessionTraceEvents(sessionId, projectId);
      } catch {
        return embeddedTraceEvents;
      }
    },
    [],
  );

  const hydrateTraceSnapshot = useCallback(
    async (
      sessionId: string,
      options?: {
        fallbackTraceEvents?: TraceEvent[];
        preserveExistingObservatory?: boolean;
      },
    ) => {
      const resumeProjectId = useNavigationStore.getState().projectId;
      let traceEvents: TraceEvent[] = [];

      if (resumeProjectId) {
        try {
          traceEvents = await fetchSessionTraceEvents(sessionId, resumeProjectId);
        } catch {
          traceEvents = [];
        }
      }

      if (traceEvents.length === 0) {
        traceEvents = options?.fallbackTraceEvents ?? [];
      }

      if (traceEvents.length > 0) {
        rememberLatestTraceEventId(sessionId, traceEvents, {
          clearWhenEmpty: !options?.preserveExistingObservatory,
        });
        if (options?.preserveExistingObservatory) {
          // Debug panel already has events for this session — append only the new
          // ones (addEvent deduplicates via seenEventIds) so the panel never flashes
          // clear while the snapshot hydration is in-flight.
          appendReplayEventsToObservatory(traceEvents, sessionId);
        } else {
          replayTraceEventsIntoObservatory(traceEvents, sessionId);
        }
        return;
      }

      if (!options?.preserveExistingObservatory) {
        rememberLatestTraceEventId(sessionId, [], { clearWhenEmpty: true });
        clearObservatoryEvents();
        clearFlow();
      }
    },
    [
      appendReplayEventsToObservatory,
      clearFlow,
      clearObservatoryEvents,
      rememberLatestTraceEventId,
    ],
  );

  async function hydrateSessionDetailFromApi(
    sessionId: string,
    options?: {
      forceFetch?: boolean;
      setDetailMode?: boolean;
    },
  ): Promise<boolean> {
    try {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!options?.forceFetch && currentSessionId === sessionId) {
        if (options?.setDetailMode !== false) {
          useUIStore.getState().setSessionDetailMode(true);
        }
        return true;
      }

      useBatchConsentStore.getState().reset();

      const currentProjectId = useNavigationStore.getState().projectId;
      const sessionQuery = currentProjectId
        ? `?projectId=${encodeURIComponent(currentProjectId)}`
        : '';
      const response = await apiFetch(`/api/runtime/sessions/${sessionId}${sessionQuery}`);
      const data = await response.json();

      if (!data.success && !data.sessionId) {
        setError(sanitizeServerError(data.error, 'Failed to load session'));
        return false;
      }

      const sessionData = (data.session || data) as SessionDetailResponsePayload;
      const traceEvents = await resolveSessionTraceEvents(sessionId, sessionData, currentProjectId);
      hydrateSessionStoreFromDetail(sessionData, traceEvents);
      rememberLatestTraceEventId(sessionId, traceEvents);

      if (traceEvents.length > 0) {
        replayTraceEventsIntoObservatory(traceEvents, sessionId);
      } else {
        clearObservatoryEvents();
        clearFlow();
      }

      if (options?.setDetailMode !== false) {
        useUIStore.getState().setSessionDetailMode(true);
      }

      return true;
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[WS] Failed to hydrate session detail:', err);
      }
      setError('Failed to load session');
      return false;
    }
  }

  // Emit a chat-relevant ServerMessage to all subscribers
  const emitChatMessage = useCallback((msg: ServerMessage) => {
    for (const handler of chatMessageSubscribersRef.current) {
      try {
        handler(msg);
      } catch {
        // Subscriber errors must not break the main message pipeline
      }
    }
  }, []);

  // Handle incoming messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        // Message type: message.type

        switch (message.type) {
          case 'agent_loaded':
            useBatchConsentStore.getState().reset();
            setSession(message.sessionId, message.agent);
            lastSeenTraceEventIdsRef.current.delete(message.sessionId);
            rememberResumeHandle({
              sessionId: message.sessionId,
              ...(useNavigationStore.getState().projectId
                ? { projectId: useNavigationStore.getState().projectId }
                : {}),
              kind: 'web_debug',
              lastSeenTraceEventId: null,
            });
            clearObservatoryEvents();
            clearFlow();
            resetObservatoryMetrics();
            setDebugState('running');

            // Extract static graph from IR, or generate for non-scripted agents
            const agentIR = message.agent.ir as { flow?: { staticGraph?: unknown } } | undefined;
            if (agentIR?.flow?.staticGraph) {
              setStaticGraph(agentIR.flow.staticGraph as import('../types').StaticGraph);
            } else {
              // Generate graph for supervisors and reasoning agents
              const generatedGraph = generateStaticGraph({
                name: message.agent.name,
                type: message.agent.type,
                mode: message.agent.mode,
                isSupervisor: message.agent.isSupervisor,
                ir: message.agent.ir as Record<string, unknown>,
              });
              setStaticGraph(generatedGraph);
            }
            break;

          case 'agent_load_error':
            useSessionStore.getState().setLoading(false);
            setError(sanitizeServerError(message.error, 'Failed to create runtime session'));
            break;

          case 'response_start':
            startStreaming(message.messageId);
            emitChatMessage(message);
            break;

          case 'response_chunk':
            appendStreamChunk(message.chunk);
            emitChatMessage(message);
            break;

          case 'response_end': {
            // When a transfer is active, the user message was forwarded to the
            // human agent — suppress the response bubble so no empty message appears.
            const isTransferActive =
              Array.isArray(message.actions) &&
              message.actions.some((a: { type: string }) => a.type === 'transfer_active');
            if (isTransferActive) {
              // Silently clear streaming state — no message bubble, no error.
              // Also remove the empty thought placeholder added by startStreaming
              // so it doesn't appear as a blank bubble in the transcript.
              useSessionStore.setState((state) => ({
                isStreaming: false,
                streamingMessageId: null,
                streamingContent: '',
                expandedThoughtIds: new Set(),
                messages: state.messages.filter((m) => !(m.role === 'thought' && !m.content)),
              }));
            } else {
              endStreaming({
                fullText: message.fullText,
                voiceConfig: normalizeVoiceConfig(message.voiceConfig),
                richContent: normalizeRichContent(message.richContent),
                actions: normalizeActionSet(message.actions),
                localization: normalizeLocalization(message.localization),
                metadata: message.metadata,
              });
            }
            endClientTimer(); // Track client-side round-trip time
            setStoreStatusMessage(null); // Auto-clear filler status on response end
            emitChatMessage(message);
            break;
          }

          case 'trace_event':
            // Only update the reconnect cursor for Redis-backed event types.
            // ClickHouse-only events (channel_response_sent etc.) are not stored
            // in Redis TraceStore; pointing the cursor at their IDs causes Redis
            // to return snapshotRequired:true on reconnect, forcing a full reload.
            if (!CLICKHOUSE_ONLY_TRACE_TYPES.has(message.event.type ?? '')) {
              lastSeenTraceEventIdsRef.current.set(message.sessionId, message.event.id);
              rememberResumeHandle({
                sessionId: message.sessionId,
                ...(useNavigationStore.getState().projectId
                  ? { projectId: useNavigationStore.getState().projectId }
                  : {}),
                kind: 'web_debug',
                lastSeenTraceEventId: message.event.id,
              });
            }
            const { accepted = true, traceEvent, eventPayload } = ingestLiveTraceEvent(message);
            if (!accepted) {
              break;
            }
            // Keep trace_event errors in observability only. The runtime already
            // sends user-visible terminal failures through response_end or the
            // top-level error message type, and duplicating trace errors into
            // the transcript leaves stale bubbles behind when retries recover.

            // Merge handoff routing into the current turn's thought card,
            // or fall back to a system message when thinking is disabled.
            if (message.event.type === 'handoff' && message.event.data) {
              const handoffData = message.event.data as Record<string, unknown>;
              const isInternalCoordination =
                handoffData.visibility === 'internal' || handoffData.suppressChildOutput === true;
              if (isInternalCoordination) {
                break;
              }

              const { from, to } = handoffData as { from: string; to: string };
              const store = useSessionStore.getState();
              const msgs = store.messages;
              // Find thought in current turn (before hitting a user message)
              let turnThought: import('../types').SessionMessage | null = null;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'thought') {
                  turnThought = msgs[i];
                  break;
                }
                if (msgs[i].role === 'user') break;
              }
              if (turnThought) {
                store.updateMessage(turnThought.id, {
                  metadata: { ...turnThought.metadata, handoffFrom: from, handoffTo: to },
                });
              } else {
                addMessage({
                  id: `system-${Date.now()}`,
                  role: 'system',
                  content: `Routing from ${from} → ${to}`,
                  timestamp: new Date(message.event.timestamp),
                  traceIds: [message.event.id],
                });
              }
            }

            // Add thought message for tool_thought events.
            // Merge into the current turn's thought card (after the last user message)
            // so each user message gets exactly one bulb with all thoughts appended.
            // Also handle reasoning fallback: thought is null but reasoning exists.
            if (
              message.event.type === 'tool_thought' &&
              (message.event.data?.thought || message.event.data?.reasoning)
            ) {
              const store = useSessionStore.getState();
              const msgs = store.messages;

              // Determine display text: prefer thought, fall back to reasoning
              const isReasoningFallback =
                !message.event.data.thought && !!message.event.data.reasoning;
              const displayText = isReasoningFallback
                ? (message.event.data.reasoning as string)
                : (message.event.data.thought as string);

              // Walk backward to find a thought in the current turn (before hitting a user message)
              let currentTurnThought: import('../types').SessionMessage | null = null;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'thought') {
                  currentTurnThought = msgs[i];
                  break;
                }
                if (msgs[i].role === 'user') {
                  break; // Hit a user message — no thought yet in this turn
                }
              }

              const llmCallId = message.event.data.llmCallId as string | undefined;

              if (currentTurnThought && store.isStreaming) {
                // Append to this turn's thought card (handle empty placeholder)
                store.updateMessage(currentTurnThought.id, {
                  content: currentTurnThought.content
                    ? currentTurnThought.content + '\n' + displayText
                    : displayText,
                  metadata: {
                    ...currentTurnThought.metadata,
                    toolName: message.event.data.toolName as string,
                    agentName: (message.event.data.agentName || message.event.data.agent) as string,
                    ...(isReasoningFallback ? { isReasoningFallback: true } : {}),
                    ...(llmCallId ? { llmCallId } : {}),
                  },
                });
              } else {
                // Create new thought card for this turn
                const thoughtId = `thought-${Date.now()}-${message.event.id}`;
                addMessage({
                  id: thoughtId,
                  role: 'thought',
                  content: displayText,
                  timestamp: new Date(message.event.timestamp),
                  traceIds: [message.event.id],
                  metadata: {
                    toolName: message.event.data.toolName as string,
                    agentName: (message.event.data.agentName || message.event.data.agent) as string,
                    ...(isReasoningFallback ? { isReasoningFallback: true } : {}),
                    ...(llmCallId ? { llmCallId } : {}),
                  },
                });
                store.expandThought(thoughtId);
              }
            }

            // Handle step_thought events from scripted flow steps (ST-3.4)
            if (message.event.type === 'step_thought' && message.event.data?.summary) {
              const stepThoughtId = `step-thought-${Date.now()}-${message.event.id}`;
              addMessage({
                id: stepThoughtId,
                role: 'thought',
                content: message.event.data.summary as string,
                timestamp: new Date(message.event.timestamp),
                traceIds: [message.event.id],
                metadata: {
                  stepType: message.event.data.stepType as string,
                  stepName: message.event.data.stepName as string,
                  agentName: message.event.data.agent as string,
                  isStepThought: true,
                },
              });
            }

            // Extract state from trace events for Data + Context tabs
            if (traceEvent.type === 'dsl_collect' || traceEvent.type === 'entity_extraction') {
              const extracted = (eventPayload.extracted || eventPayload.values) as
                | Record<string, unknown>
                | undefined;
              const context = eventPayload.context as Record<string, unknown> | undefined;
              if (extracted && typeof extracted === 'object') {
                updateState({ gatherProgress: extracted });
              }
              if (context && typeof context === 'object') {
                updateState({ context });
              }
            }

            if (traceEvent.type === 'dsl_set') {
              const assignments = eventPayload.assignments as Record<string, unknown> | undefined;
              if (assignments && typeof assignments === 'object') {
                updateState({ context: assignments });
              }
            }

            // Generate log entry from trace event
            const logEntry = formatTraceEventLog(traceEvent.type, eventPayload);
            if (logEntry) {
              addLog(logEntry.level, logEntry.message);
            }
            emitChatMessage(message);
            break;

          case 'trace_replay': {
            const traceEvents = message.events.map((traceEvent) => ({
              ...traceEvent,
              timestamp: new Date(traceEvent.timestamp),
            })) as TraceEvent[];
            rememberLatestTraceEventId(message.sessionId, traceEvents, {
              clearWhenEmpty: false,
            });

            const pendingCrossSessionSnapshotHydration =
              pendingCrossSessionSnapshotHydrationRef.current.has(message.sessionId);
            const currentSessionId = useSessionStore.getState().sessionId;
            if (currentSessionId !== message.sessionId) {
              if (pendingCrossSessionSnapshotHydration) {
                pendingCrossSessionSnapshotHydrationRef.current.delete(message.sessionId);
              }
              break;
            }

            if (message.snapshotRequired || pendingCrossSessionSnapshotHydration) {
              pendingCrossSessionSnapshotHydrationRef.current.delete(message.sessionId);
              const currentSessionEvents = useObservatoryStore
                .getState()
                .events.filter((storedEvent) => storedEvent.sessionId === message.sessionId);
              void hydrateTraceSnapshot(message.sessionId, {
                fallbackTraceEvents: traceEvents,
                preserveExistingObservatory: currentSessionEvents.length > 0,
              });
              break;
            }

            if (traceEvents.length === 0) {
              break;
            }

            const currentSessionEvents = useObservatoryStore
              .getState()
              .events.filter((storedEvent) => storedEvent.sessionId === message.sessionId);
            if (!message.afterEventId || currentSessionEvents.length === 0) {
              replayTraceEventsIntoObservatory(traceEvents, message.sessionId);
            } else {
              appendReplayEventsToObservatory(traceEvents, message.sessionId);
            }
            break;
          }
          case 'state_update':
            if (Object.keys(message.updates).length > 0) {
              updateState(message.updates);
            } else {
              setState(message.state);
            }
            break;

          case 'action_taken':
            setLastAction(message.action);
            break;

          case 'session_persisted': {
            const pending = pendingSessionPersistRequestsRef.current.get(message.requestId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingSessionPersistRequestsRef.current.delete(message.requestId);
              pending.resolve();
            }
            break;
          }

          case 'session_persist_failed': {
            const pending = pendingSessionPersistRequestsRef.current.get(message.requestId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingSessionPersistRequestsRef.current.delete(message.requestId);
              pending.reject(new Error(message.error.message));
            }
            break;
          }

          case 'session_resumed': {
            // Restore session state and conversation history from server
            const resumedId = message.sessionId;
            const previousSessionId = useSessionStore.getState().sessionId;
            const isSameSessionResume = previousSessionId === resumedId;
            const shouldHydrateDetailFromApi = !isSameSessionResume && !message.agent;
            const currentAgent = useSessionStore.getState().agent;
            const resumedAgent = message.agent ||
              (isSameSessionResume ? currentAgent : null) || {
                id: resumedId,
                name: 'Agent',
                filePath: '',
                type: 'agent' as const,
                mode: 'reasoning' as const,
                toolCount: 0,
                gatherFieldCount: 0,
                isSupervisor: false,
                dsl: '',
              };
            const baseTime = Date.now();
            const resumedMessages = message.conversationHistory.map((msg, i, history) => ({
              id: msg.id || `resume-${resumedId}-${i}`,
              role: msg.role as 'user' | 'assistant',
              content: msg.content,
              ...(msg.rawContent ? { rawContent: msg.rawContent } : {}),
              ...(msg.contentEnvelope ? { contentEnvelope: msg.contentEnvelope } : {}),
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              // Spread timestamps so messages don't all have the same time
              timestamp: new Date(baseTime - (history.length - 1 - i) * 1000),
              traceIds: [],
            }));
            // For same-session resumes, only apply the server snapshot if its
            // history is at least as long as what the client already has. A pod
            // that rebuilt the session before persistence completed can send a
            // shorter snapshot; applying it would roll chat and state backward.
            const currentMessageCount = useSessionStore.getState().messages.length;
            const shouldApplyResumeSnapshot =
              !isSameSessionResume || resumedMessages.length >= currentMessageCount;

            if (!isSameSessionResume) {
              pendingCrossSessionSnapshotHydrationRef.current.add(resumedId);
              clearObservatoryEvents();
              clearFlow();
            } else {
              pendingCrossSessionSnapshotHydrationRef.current.delete(resumedId);
            }
            rememberResumeHandle({
              sessionId: resumedId,
              ...(useNavigationStore.getState().projectId
                ? { projectId: useNavigationStore.getState().projectId }
                : {}),
              kind: 'web_debug',
            });
            if (shouldApplyResumeSnapshot) {
              useBatchConsentStore.getState().reset();
              useSessionStore.setState({ sessionId: resumedId, agent: resumedAgent });
              setState(message.state);
              replaceMessages(resumedMessages);
            }
            if (shouldHydrateDetailFromApi) {
              void hydrateSessionDetailFromApi(resumedId, {
                forceFetch: true,
                setDetailMode: false,
              });
            }
            break;
          }

          case 'session_reset': {
            const currentProjectId = useNavigationStore.getState().projectId;
            const { sessionId: currentSessionId, resumeHandle } = useSessionStore.getState();
            const resetAppliesToCurrentSession =
              !currentSessionId || currentSessionId === message.sessionId;

            pendingCrossSessionSnapshotHydrationRef.current.delete(message.sessionId);
            lastSeenTraceEventIdsRef.current.delete(message.sessionId);

            if (resetAppliesToCurrentSession) {
              clearMessages();
              setStoreStatusMessage(null);
              useSessionStore.setState({
                state: createInitialAgentState(),
                lastAction: null,
                isLoading: false,
                error: null,
              });
              setStatusMessage(null);
              clearObservatoryEvents();
              clearFlow();
              resetObservatoryMetrics();
              clearLogs();
              useBatchConsentStore.getState().reset();
            }

            if (
              currentSessionId === message.sessionId ||
              resumeHandle.sessionId === message.sessionId
            ) {
              rememberResumeHandle({
                sessionId: message.sessionId,
                ...(currentProjectId ? { projectId: currentProjectId } : {}),
                kind: 'web_debug',
                lastSeenTraceEventId: null,
              });
            }

            invalidateSessionCaches(message.sessionId);
            break;
          }

          case 'session_expired':
            lastSeenTraceEventIdsRef.current.delete(message.sessionId);
            clearResumeHandle();
            if (
              message.reasonCode === 'resume_not_found' &&
              wsRef.current?.readyState === WebSocket.OPEN
            ) {
              void (async () => {
                // Hydrate traces from ClickHouse before attempting fallback resume
                // so the debug panel retains the session's trace history even though
                // the runtime process no longer has the session in memory.
                const expiredProjectId = useNavigationStore.getState().projectId;
                if (expiredProjectId) {
                  void hydrateTraceSnapshot(message.sessionId, {
                    preserveExistingObservatory: false,
                  });
                }

                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  const resumedFallbackSession = await maybeResumeDiscoveredCurrentSession(
                    wsRef.current,
                    {
                      excludeSessionId: message.sessionId,
                    },
                  );
                  if (!resumedFallbackSession) {
                    setError(RESUME_NOT_FOUND_ERROR_MESSAGE);
                  }
                }
              })();
              break;
            }
            setError(
              message.reasonCode === 'resume_not_found'
                ? RESUME_NOT_FOUND_ERROR_MESSAGE
                : SESSION_UNAVAILABLE_ERROR_MESSAGE,
            );
            break;

          // Test context responses
          case 'context_injected':
            // Update session state with injected values
            if (message.updatedValues && Object.keys(message.updatedValues).length > 0) {
              updateState({ context: message.updatedValues });
            }
            break;

          case 'tool_mock_set':
            // Status notification — no store update needed
            break;

          case 'context_injection_error':
            setError(message.error?.message || 'Context injection failed');
            break;

          // JIT auth challenge (Phase 5) — insert as system message
          case 'auth_challenge':
            addMessage({
              id: `auth-challenge-${message.toolCallId}`,
              role: 'system',
              content: JSON.stringify({
                _type: 'auth_challenge',
                toolCallId: message.toolCallId,
                authType: message.authType,
                authUrl: message.authUrl,
                profileId: message.profileId,
                profileName: message.profileName,
                prompt: message.prompt,
                timeoutMs: message.timeoutMs,
                sessionId: message.sessionId,
              }),
              timestamp: new Date(),
              traceIds: [],
            });
            emitChatMessage(message);
            break;

          case 'auth_required':
            useBatchConsentStore
              .getState()
              .initFromAuthRequired(message.sessionId, message.pending, message.satisfied);
            {
              const notice = buildRuntimeChatNotice(message);
              if (notice) {
                setStoreStatusMessage(notice);
              }
            }
            emitChatMessage(message);
            break;

          case 'auth_gate_updated':
            useBatchConsentStore
              .getState()
              .updateFromGateUpdate(message.sessionId, message.pending, message.satisfied);
            break;

          case 'auth_gate_satisfied':
            useBatchConsentStore.getState().markAllSatisfied(message.sessionId);
            break;

          case 'status_update':
            setStoreStatusMessage(message.text);
            emitChatMessage(message);
            break;

          case 'status_clear':
            setStoreStatusMessage(null);
            emitChatMessage(message);
            break;

          case 'session_health': {
            const currentAgentName =
              useSessionStore.getState().agent?.name ||
              useNavigationStore.getState().subPage ||
              'unknown';
            const healthEvents = buildSessionHealthEvents(message, currentAgentName);
            for (const healthEvent of healthEvents) {
              addObservatoryEvent(healthEvent);
              addLog(
                healthEvent.type === 'error' ? 'error' : 'warn',
                String(healthEvent.data.message || healthEvent.data.code || 'Session health issue'),
              );
            }
            emitChatMessage(message);
            break;
          }

          case 'tool_warnings': {
            const notice = buildRuntimeChatNotice(message);
            for (const warning of message.warnings) {
              addLog('warn', warning);
            }
            if (notice) {
              setStoreStatusMessage(notice);
            }
            emitChatMessage(message);
            break;
          }

          case 'message_queued':
            setStoreStatusMessage(formatQueuedRuntimeNotice(message.reason));
            emitChatMessage(message);
            break;

          case 'error': {
            useSessionStore.getState().setLoading(false);
            const errorMsg = message.message || '';
            if (errorMsg.includes('LLM client not configured')) {
              setError(
                'Session configuration expired. Click + New Chat to start a new conversation.',
              );
            } else {
              setError(sanitizeServerError(errorMsg, 'An error occurred'));
            }
            emitChatMessage(message);
            break;
          }

          case 'info':
            setIsConfigured(message.configured);
            setStatusMessage(message.message);
            if (!message.configured) {
              setError(sanitizeServerError(message.message, 'Server is not configured'));
            }
            break;

          case 'agent_transfer_event': {
            // Inbound event from human agent via agent transfer webhook.
            const transferEvent = message.event as {
              type: string;
              data?: Record<string, unknown>;
            };
            if (transferEvent.type === 'agent:message') {
              // SmartAssist sends content in different fields depending on message type.
              // Plain messages use `message`; template/CSAT messages may use `text` or `body`.
              const content = firstNonEmptyString(
                transferEvent.data?.message,
                transferEvent.data?.text,
                transferEvent.data?.body,
              );
              if (content) {
                const agentInfo = transferEvent.data?.agentInfo as
                  | Record<string, unknown>
                  | undefined;
                const agentName =
                  (agentInfo?.name as string) || (agentInfo?.id as string) || 'Human Agent';
                addMessage({
                  id: `agent-transfer-${Date.now()}`,
                  role: 'assistant',
                  content,
                  timestamp: new Date(),
                  traceIds: [],
                  metadata: { agentName },
                });
              }
              // SmartAssist sends CSAT survey prompt in csatMessage.value when csatRequested=true.
              const csatMessage = transferEvent.data?.csatMessage as
                | { type?: string; value?: string; userId?: string }
                | undefined;
              if (transferEvent.data?.csatRequested && csatMessage?.value) {
                const existingCsat = useSessionStore.getState().messages.some((m) => m.csatData);
                if (!existingCsat) {
                  const surveyTypeRaw = transferEvent.data?.surveyType as string | undefined;
                  const surveyType = (['csat', 'nps', 'likeDislike'] as const).includes(
                    surveyTypeRaw as 'csat' | 'nps' | 'likeDislike',
                  )
                    ? (surveyTypeRaw as CsatData['surveyType'])
                    : 'csat';
                  addMessage({
                    id: `agent-transfer-csat-${Date.now()}`,
                    role: 'assistant',
                    content: csatMessage.value,
                    timestamp: new Date(),
                    traceIds: [],
                    csatData: {
                      provider: 'smartassist',
                      userId:
                        csatMessage.userId ??
                        (transferEvent.data?.userId as string | undefined) ??
                        '',
                      botId: (transferEvent.data?.iId as string | undefined) ?? '',
                      channel: (transferEvent.data?.source as string | undefined) ?? 'rtm',
                      surveyType,
                      conversationId:
                        (transferEvent.data?.conversationId as string | undefined) ?? '',
                      orgId: (transferEvent.data?.orgId as string | undefined) ?? '',
                    },
                  });
                }
              }
            } else if (transferEvent.type === 'agent:disconnected') {
              addMessage({
                id: `agent-transfer-disconnect-${Date.now()}`,
                role: 'system',
                content: 'Human agent has disconnected. You are now back with the AI assistant.',
                timestamp: new Date(),
                traceIds: [],
              });
              // Fallback: server injects csatRequired when SmartAssist omits csatRequested
              if (transferEvent.data?.csatRequired) {
                const existingCsat = useSessionStore.getState().messages.some((m) => m.csatData);
                if (!existingCsat) {
                  const surveyTypeRaw = transferEvent.data?.csatSurveyType as string | undefined;
                  const surveyType = (['csat', 'nps', 'likeDislike'] as const).includes(
                    surveyTypeRaw as 'csat' | 'nps' | 'likeDislike',
                  )
                    ? (surveyTypeRaw as CsatData['surveyType'])
                    : 'csat';
                  addMessage({
                    id: `agent-transfer-csat-${Date.now()}`,
                    role: 'assistant',
                    content: 'How would you rate your experience?',
                    timestamp: new Date(),
                    traceIds: [],
                    csatData: {
                      provider: 'smartassist',
                      userId: (transferEvent.data?.userId as string | undefined) ?? '',
                      botId: (transferEvent.data?.iId as string | undefined) ?? '',
                      channel: (transferEvent.data?.source as string | undefined) ?? 'rtm',
                      surveyType,
                      conversationId:
                        (transferEvent.data?.conversationId as string | undefined) ?? '',
                      orgId: (transferEvent.data?.orgId as string | undefined) ?? '',
                    },
                  });
                }
              }
            }
            emitChatMessage(message);
            break;
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV === 'development')
          console.error('[WS] Failed to parse message:', err);
      }
    },
    [
      setSession,
      setState,
      updateState,
      setLastAction,
      startStreaming,
      appendStreamChunk,
      endStreaming,
      setError,
      setStoreStatusMessage,
      addMessage,
      clearMessages,
      setDebugState,
      clearObservatoryEvents,
      clearFlow,
      resetObservatoryMetrics,
      clearLogs,
      setStaticGraph,
      addObservatoryEvent,
      addLog,
      rememberLatestTraceEventId,
      appendReplayEventsToObservatory,
      hydrateTraceSnapshot,
      hydrateSessionDetailFromApi,
      emitChatMessage,
      invalidateSessionCaches,
      maybeResumeDiscoveredCurrentSession,
      rememberResumeHandle,
    ],
  );

  const accessToken = useAuthStore((s) => s.accessToken);

  // Keep handleMessage in a ref so WS callbacks always use the latest version
  // without causing reconnections when store callbacks change
  const handleMessageRef = useRef(handleMessage);
  handleMessageRef.current = handleMessage;

  // Stable close helper — detaches handlers to prevent stale onclose from reconnecting
  const closeWs = useCallback(() => {
    for (const pending of pendingSessionPersistRequestsRef.current.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Runtime disconnected before session could be persisted'));
    }
    pendingSessionPersistRequestsRef.current.clear();

    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    connectingRef.current = false;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleLogout = () => {
      closeWs();
      setIsConnected(false);
      setIsReconnecting(false);
      setDebugState('disconnected');
    };

    window.addEventListener(LOGOUT_SIGNAL_EVENT, handleLogout as EventListener);

    return () => {
      window.removeEventListener(LOGOUT_SIGNAL_EVENT, handleLogout as EventListener);
    };
  }, [closeWs, setDebugState]);

  useEffect(() => {
    return () => {
      closeWs();
    };
  }, [closeWs]);

  // Track accessToken in a ref so the connect effect doesn't re-run on token refresh.
  // Token refreshes should NOT cause WS reconnection — the WS was already authenticated
  // on the initial connect and the server holds the session.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  useEffect(() => {
    // Need a token to connect — but read from ref so token refresh doesn't re-trigger
    if (!accessTokenRef.current) {
      return;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.url === url) {
      return;
    }

    closeWs();
    reconnectAttempts.current = 0;

    function doConnect() {
      doConnectRef.current = doConnect;
      const currentToken = useAuthStore.getState().accessToken;
      if (!currentToken) {
        return;
      }

      if (
        connectingRef.current ||
        wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }

      connectingRef.current = true;
      const ws = new WebSocket(url, buildWebDebugWSProtocols(currentToken));
      wsRef.current = ws;

      ws.onopen = () => {
        connectingRef.current = false;
        setIsConnected(true);
        setIsReconnecting(false);
        reconnectAttempts.current = 0;
        setDebugState('connected');
        // Clear any stale connection error from previous disconnect
        useSessionStore.getState().setError(null);

        void (async () => {
          const resumableSessionId = resolveCurrentResumableSessionId();

          if (resumableSessionId && wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            await resumeValidatedStoredSession(ws, resumableSessionId);
            return;
          }

          await maybeResumeDiscoveredCurrentSession(ws);
        })();
      };

      ws.onmessage = (event) => {
        handleMessageRef.current(event);
      };

      ws.onclose = () => {
        connectingRef.current = false;
        setIsConnected(false);
        setDebugState('disconnected');

        // Only reconnect if still authenticated and this is still the active WS
        if (wsRef.current !== ws) return; // Stale close, ignore

        const { accessToken: currentToken } = useAuthStore.getState();
        if (currentToken && reconnectAttempts.current < maxReconnectAttempts) {
          setIsReconnecting(true);
          reconnectAttempts.current++;
          reconnectTimeout.current = setTimeout(doConnect, reconnectInterval);
        } else {
          setIsReconnecting(false);
          if (!currentToken) {
            // User logged out — not reconnecting
          } else {
            setError('Failed to connect to server');
          }
        }
      };

      ws.onerror = (err) => {
        if (process.env.NODE_ENV === 'development') console.error('[WS] Error:', err);
      };
    }

    // Defer initial connect so React Strict Mode's rapid mount-unmount-remount
    // can cancel the first scheduled connect before it creates a WebSocket.
    const connectTimer = setTimeout(doConnect, 0);

    return () => {
      clearTimeout(connectTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    url,
    maxReconnectAttempts,
    reconnectInterval,
    maybeResumeDiscoveredCurrentSession,
    resumeValidatedStoredSession,
    resolveCurrentResumableSessionId,
  ]);

  // When accessToken changes from null → value (login), trigger connect
  useEffect(() => {
    if (accessToken && !wsRef.current) {
      // Token just became available (initial login or page load) — connect
      closeWs();
      reconnectAttempts.current = 0;
      // The main effect above will handle the actual connection on next tick
    }
    if (!accessToken && wsRef.current) {
      // Token cleared (logout) — disconnect
      closeWs();
      setIsConnected(false);
      setIsReconnecting(false);
      setDebugState('disconnected');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!accessToken]);

  // Send message
  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('[WS] Not connected, cannot send message');
    }
  }, []);

  const ensureSessionPersisted = useCallback((sessionId: string): Promise<void> => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Runtime is still connecting. Try again in a moment.'));
    }

    const requestId = createSessionPersistRequestId();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingSessionPersistRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while preparing the session for upload'));
      }, SESSION_PERSIST_TIMEOUT_MS);

      pendingSessionPersistRequestsRef.current.set(requestId, {
        sessionId,
        resolve,
        reject,
        timeoutId,
      });

      ws.send(
        JSON.stringify({
          type: 'ensure_session_persisted',
          sessionId,
          requestId,
        } satisfies ClientMessage),
      );
    });
  }, []);

  // High-level actions
  const loadAgent = useCallback(
    (agentPath: string, projectId: string, callerData?: Record<string, unknown>) => {
      useBatchConsentStore.getState().reset();
      clearObservatoryEvents();
      clearFlow();
      resetObservatoryMetrics();
      useSessionStore.getState().setLoading(true);
      useSessionStore.getState().setError(null);
      send({
        type: 'load_agent',
        agentPath,
        projectId,
        ...(callerData && Object.keys(callerData).length > 0 ? { callerData } : {}),
      });
    },
    [clearFlow, clearObservatoryEvents, resetObservatoryMetrics, send],
  );

  const sendMessage = useCallback(
    (
      text: string,
      options?: {
        attachmentIds?: string[];
        attachmentFilenames?: string[];
        attachmentMimeTypes?: string[];
        messageId?: string;
      },
    ) => {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentSessionId) {
        setError('No active session');
        return;
      }

      // Start client-side timing
      startClientTimer();

      const localMessageId =
        options?.messageId ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Add user message immediately
      useSessionStore.getState().addMessage({
        id: localMessageId,
        role: 'user',
        content: text,
        timestamp: new Date(),
        traceIds: [],
        ...(options?.attachmentFilenames?.length
          ? {
              metadata: {
                attachmentFilenames: options.attachmentFilenames,
                ...(options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
                ...(options.attachmentMimeTypes?.length
                  ? { attachmentMimeTypes: options.attachmentMimeTypes }
                  : {}),
              },
            }
          : {}),
      });

      send({
        type: 'send_message',
        sessionId: currentSessionId,
        text,
        ...(options?.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
        ...(options?.messageId ? { messageId: options.messageId } : {}),
      });
    },
    [send, setError, startClientTimer],
  );

  const runTest = useCallback(
    (testId: string) => {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentSessionId) {
        setError('No active session');
        return;
      }

      send({ type: 'run_test', sessionId: currentSessionId, testId });
    },
    [send, setError],
  );

  // Fetch available apps
  const fetchApps = useCallback(async () => {
    try {
      const apps = await fetchAvailableAppsList();
      setAvailableApps(apps);
    } catch (err) {
      if (process.env.NODE_ENV === 'development') console.error('[API] Failed to fetch apps:', err);
    }
  }, []);

  // Load an app (all agents in a domain)
  const loadApp = useCallback(
    async (domain: string) => {
      setLoadingApp(true);
      try {
        const appStaticGraph = await fetchAppStaticGraph(domain);
        setAppStaticGraph(appStaticGraph);
        setGraphViewMode('app');
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[API] Failed to load app:', err);
        }
        setError(err instanceof Error ? err.message : 'Failed to load app');
      } finally {
        setLoadingApp(false);
      }
    },
    [setError, setAppStaticGraph, setGraphViewMode],
  );

  // Switch to an existing session by fetching its full data
  const switchSession = useCallback(
    async (sessionId: string) => {
      await hydrateSessionDetailFromApi(sessionId, { setDetailMode: true });
    },
    [hydrateSessionDetailFromApi],
  );

  // Resume an active session via WS (rehydrates from Redis/memory on server)
  const resumeSession = useCallback(
    (runtimeSessionId: string) => {
      useBatchConsentStore.getState().reset();
      const currentProjectId = useNavigationStore.getState().projectId;
      rememberResumeHandle({
        sessionId: runtimeSessionId,
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
        kind: 'web_debug',
      });
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        useSessionStore.getState().setError(null);
        void (async () => {
          const validation = await validateDeveloperSessionAttachment({
            sessionId: runtimeSessionId,
            projectId: currentProjectId,
          });
          if (validation.kind === 'ready' && wsRef.current?.readyState === WebSocket.OPEN) {
            commitDeveloperSessionResume(wsRef.current, validation.session);
            return;
          }

          if (validation.kind === 'not_found') {
            lastSeenTraceEventIdsRef.current.delete(runtimeSessionId);
            clearResumeHandle();
            setError(RESUME_NOT_FOUND_ERROR_MESSAGE);
            return;
          }

          if (validation.kind === 'error') {
            setError(validation.message);
          }
        })();
        return;
      }
    },
    [
      clearResumeHandle,
      commitDeveloperSessionResume,
      rememberResumeHandle,
      setError,
      validateDeveloperSessionAttachment,
    ],
  );

  // Test context methods
  const loadAgentWithContext = useCallback(
    (agentPath: string, projectId: string, context: TestContextPayload) => {
      useSessionStore.getState().setLoading(true);
      useSessionStore.getState().setError(null);
      clearObservatoryEvents();
      clearFlow();
      resetObservatoryMetrics();
      send({ type: 'load_agent_with_context', agentPath, projectId, context });
    },
    [clearFlow, clearObservatoryEvents, resetObservatoryMetrics, send],
  );

  const { startProjectAgentSession: launchProjectAgentSession } = useProjectAgentSessionLauncher({
    isConnected,
    loadAgent,
    loadAgentWithContext,
  });

  const injectContext = useCallback(
    (injection: ContextInjection) => {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentSessionId) {
        setError('No active session');
        return;
      }
      send({ type: 'inject_context', sessionId: currentSessionId, injection });
    },
    [send, setError],
  );

  const setToolMocks = useCallback(
    (mocks: ToolMockConfig[]) => {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentSessionId) {
        setError('No active session');
        return;
      }
      send({ type: 'set_tool_mocks', sessionId: currentSessionId, mocks });
    },
    [send, setError],
  );

  const clearToolMocks = useCallback(() => {
    const currentSessionId = useSessionStore.getState().sessionId;
    if (!currentSessionId) return;
    send({ type: 'clear_tool_mocks', sessionId: currentSessionId });
  }, [send]);

  const subscribeChatMessage = useCallback((handler: ChatMessageHandler) => {
    chatMessageSubscribersRef.current.add(handler);
    return () => {
      chatMessageSubscribersRef.current.delete(handler);
    };
  }, []);

  // Manual reconnect — resets the attempt counter so the full retry budget is
  // available again, then calls doConnect immediately. Useful when all automatic
  // retries are exhausted and the user clicks a "Retry connection" button.
  const reconnect = useCallback(() => {
    if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    reconnectAttempts.current = 0;
    closeWs();
    // doConnectRef is set on the first call into doConnect (inside the main effect).
    // If for some reason it hasn't been set yet, the main effect will trigger on
    // its own when it detects no open WS.
    if (doConnectRef.current) {
      reconnectTimeout.current = setTimeout(doConnectRef.current, 0);
    }
  }, [closeWs]);

  const value: WebSocketContextValue = {
    isConnected,
    isReconnecting,
    isConfigured,
    statusMessage,
    availableApps,
    loadingApp,
    send,
    ensureSessionPersisted,
    loadAgent,
    startProjectAgentSession: (agentName, projectId, context, callerData) =>
      launchProjectAgentSession({ agentName, projectId, context, callerData }),
    loadApp,
    fetchApps,
    sendMessage,
    runTest,
    switchSession,
    resumeSession,
    loadAgentWithContext,
    injectContext,
    setToolMocks,
    clearToolMocks,
    reconnect,
    subscribeChatMessage,
  };

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export function useWebSocketContext(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
}

/**
 * Safe variant that returns null when used outside a WebSocketProvider.
 * Use this in components that may render both inside and outside the chat tab.
 */
export function useOptionalWebSocketContext(): WebSocketContextValue | null {
  return useContext(WebSocketContext);
}
