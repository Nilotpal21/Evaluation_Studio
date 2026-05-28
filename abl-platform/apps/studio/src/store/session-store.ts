/**
 * Session Store
 *
 * Manages chat session state including messages and agent state
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionMessage, AgentState, AgentDetails, ConstructAction } from '../types';
import { boundedPush } from '../lib/bounded-collection';
import {
  buildResponseEndContentEnvelope,
  hasRenderableResponseEndPayload,
  resolveRenderableResponseEndText,
  type ResponseEndMessagePayload,
} from '../utils/response-end-message';

const MAX_MESSAGES = 500;

export interface SessionResumeHandle {
  sessionId: string | null;
  projectId: string | null;
  kind: 'web_debug' | null;
  lastSeenTraceEventId: string | null;
}

const EMPTY_RESUME_HANDLE: SessionResumeHandle = {
  sessionId: null,
  projectId: null,
  kind: null,
  lastSeenTraceEventId: null,
};

export function createInitialAgentState(): AgentState {
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

interface SessionStore {
  // Session data
  sessionId: string | null;
  agent: AgentDetails | null;
  messages: SessionMessage[];
  messageSnapshotVersion: number;
  state: AgentState | null;
  lastAction: ConstructAction | null;

  // Streaming state
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;

  // Loading state
  isLoading: boolean;
  error: string | null;

  // Status message (filler/progress text from runtime, transient)
  statusMessage: string | null;

  // Minimal durable resume context for reconnects/reloads
  resumeHandle: SessionResumeHandle;

  // Actions
  setSession: (sessionId: string, agent: AgentDetails) => void;
  clearSession: () => void;
  rememberResumeHandle: (updates: Partial<SessionResumeHandle>) => void;
  clearResumeHandle: () => void;

  addMessage: (message: SessionMessage) => void;
  updateMessage: (id: string, updates: Partial<SessionMessage>) => void;
  clearMessages: () => void;
  replaceMessages: (messages: SessionMessage[]) => void;

  setState: (state: AgentState) => void;
  updateState: (updates: Partial<AgentState>) => void;

  setLastAction: (action: ConstructAction) => void;

  startStreaming: (messageId: string) => void;
  appendStreamChunk: (chunk: string) => void;
  endStreaming: (
    response: string | ResponseEndMessagePayload,
    metadata?: SessionMessage['metadata'],
  ) => void;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  setStatusMessage: (message: string | null) => void;

  // Thought expand/collapse
  expandedThoughtIds: Set<string>;
  expandThought: (id: string) => void;
  collapseAllThoughts: () => void;
  toggleThought: (id: string) => void;

  // Session restore (for switching between sessions)
  restoreSession: (data: {
    sessionId: string;
    agent: AgentDetails;
    messages: SessionMessage[];
    state: AgentState | null;
  }) => void;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      // Initial state
      sessionId: null,
      agent: null,
      messages: [],
      messageSnapshotVersion: 0,
      state: null,
      lastAction: null,
      isStreaming: false,
      streamingMessageId: null,
      streamingContent: '',
      isLoading: false,
      error: null,
      statusMessage: null,
      resumeHandle: EMPTY_RESUME_HANDLE,
      expandedThoughtIds: new Set<string>(),

      // Actions
      setSession: (sessionId, agent) => {
        set(() => ({
          sessionId,
          agent,
          messages: [],
          messageSnapshotVersion: 0,
          state: createInitialAgentState(),
          lastAction: null,
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...EMPTY_RESUME_HANDLE,
            sessionId,
            kind: 'web_debug',
          },
          expandedThoughtIds: new Set(),
        }));
      },

      clearSession: () => {
        set({
          sessionId: null,
          agent: null,
          messages: [],
          messageSnapshotVersion: 0,
          state: null,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: EMPTY_RESUME_HANDLE,
          expandedThoughtIds: new Set(),
        });
      },

      rememberResumeHandle: (updates) => {
        set((state) => {
          const nextSessionId =
            updates.sessionId !== undefined ? updates.sessionId : state.resumeHandle.sessionId;
          if (!nextSessionId) {
            return { resumeHandle: EMPTY_RESUME_HANDLE };
          }

          return {
            resumeHandle: {
              ...state.resumeHandle,
              ...updates,
              sessionId: nextSessionId,
              kind: updates.kind ?? state.resumeHandle.kind ?? 'web_debug',
            },
          };
        });
      },

      clearResumeHandle: () => {
        set({ resumeHandle: EMPTY_RESUME_HANDLE });
      },

      addMessage: (message) => {
        set((state) => ({
          messages: state.messages.some((existing) => existing.id === message.id)
            ? state.messages
            : boundedPush(state.messages, message, MAX_MESSAGES),
        }));
      },

      updateMessage: (id, updates) => {
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        }));
      },

      clearMessages: () => {
        set((state) => ({
          messages: [],
          messageSnapshotVersion: state.messageSnapshotVersion + 1,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          expandedThoughtIds: new Set(),
        }));
      },

      replaceMessages: (messages) => {
        set((state) => ({
          messages: messages.slice(-MAX_MESSAGES),
          messageSnapshotVersion: state.messageSnapshotVersion + 1,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          expandedThoughtIds: new Set(),
        }));
      },

      setState: (newState) => {
        set({ state: newState });
      },

      updateState: (updates) => {
        const currentState = get().state;
        if (!currentState) return;

        set({
          state: {
            ...currentState,
            ...updates,
            context: { ...currentState.context, ...updates.context },
            gatherProgress: { ...currentState.gatherProgress, ...updates.gatherProgress },
            constraintResults: { ...currentState.constraintResults, ...updates.constraintResults },
            lastToolResults: { ...currentState.lastToolResults, ...updates.lastToolResults },
            memory: {
              ...currentState.memory,
              ...updates.memory,
              session: { ...currentState.memory?.session, ...updates.memory?.session },
              persistentCache: {
                ...currentState.memory?.persistentCache,
                ...updates.memory?.persistentCache,
              },
            },
          },
        });
      },

      setLastAction: (action) => {
        set({ lastAction: action });
      },

      startStreaming: (messageId) => {
        // Create a placeholder thought in the message list so the blinking bulb
        // appears immediately. tool_thought events merge into this placeholder.
        const placeholderId = `thinking-${messageId}`;
        set((state) => ({
          isStreaming: true,
          streamingMessageId: messageId,
          streamingContent: '',
          expandedThoughtIds: new Set([placeholderId]),
          messages: boundedPush(
            state.messages,
            {
              id: placeholderId,
              role: 'thought' as const,
              content: '',
              timestamp: new Date(),
              traceIds: [],
            },
            MAX_MESSAGES,
          ),
        }));
      },

      appendStreamChunk: (chunk) => {
        set((state) => ({
          streamingContent: state.streamingContent + chunk,
        }));
      },

      endStreaming: (response, metadata) => {
        const { streamingMessageId } = get();
        const payload: ResponseEndMessagePayload =
          typeof response === 'string'
            ? { fullText: response, ...(metadata ? { metadata } : {}) }
            : response;
        const content = resolveRenderableResponseEndText(payload);
        const contentEnvelope = buildResponseEndContentEnvelope(payload);
        const hasRenderablePayload = hasRenderableResponseEndPayload(payload);
        const messageMetadata =
          contentEnvelope?.localization && !payload.metadata?.localization
            ? { ...(payload.metadata ?? {}), localization: contentEnvelope.localization }
            : payload.metadata;

        // Remove placeholder thoughts that never received content
        const cleanMessages = (msgs: SessionMessage[]) =>
          msgs.filter((m) => !(m.role === 'thought' && !m.content));

        if (streamingMessageId && hasRenderablePayload) {
          // Add the complete assistant message
          set((state) => ({
            messages: boundedPush(
              cleanMessages(state.messages),
              {
                id: streamingMessageId,
                role: 'assistant' as const,
                content,
                timestamp: new Date(),
                traceIds: [],
                ...(messageMetadata ? { metadata: messageMetadata } : {}),
                ...(contentEnvelope ? { contentEnvelope } : {}),
              },
              MAX_MESSAGES,
            ),
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: '',
            expandedThoughtIds: new Set(),
          }));
        } else if (streamingMessageId && !hasRenderablePayload) {
          // Empty response — surface as a visible error instead of silently dropping
          set((state) => ({
            messages: boundedPush(
              cleanMessages(state.messages),
              {
                id: streamingMessageId,
                role: 'system' as const,
                content: "I'm having trouble completing that request. Please try again.",
                timestamp: new Date(),
                traceIds: [],
                metadata: { agentName: 'system' },
              },
              MAX_MESSAGES,
            ),
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: '',
            expandedThoughtIds: new Set(),
          }));
        } else {
          set((state) => ({
            messages: cleanMessages(state.messages),
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: '',
            expandedThoughtIds: new Set(),
          }));
        }
      },

      setLoading: (loading) => {
        set({ isLoading: loading });
      },

      setError: (error) => {
        set({ error });
      },

      setStatusMessage: (message) => {
        set({ statusMessage: message });
      },

      expandThought: (id) => {
        set((state) => {
          const next = new Set(state.expandedThoughtIds);
          next.add(id);
          return { expandedThoughtIds: next };
        });
      },

      collapseAllThoughts: () => {
        set({ expandedThoughtIds: new Set() });
      },

      toggleThought: (id) => {
        set((state) => {
          const next = new Set(state.expandedThoughtIds);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { expandedThoughtIds: next };
        });
      },

      restoreSession: (data) => {
        set((state) => ({
          sessionId: data.sessionId,
          agent: data.agent,
          messages: data.messages,
          messageSnapshotVersion: state.messageSnapshotVersion + 1,
          state: data.state,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...EMPTY_RESUME_HANDLE,
            sessionId: data.sessionId,
            kind: 'web_debug',
          },
          expandedThoughtIds: new Set(),
        }));
      },
    }),
    {
      name: 'kore-session-storage',
      partialize: (state) => ({
        resumeHandle: state.resumeHandle,
      }),
    },
  ),
);
