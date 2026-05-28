/**
 * @arch-ai-ui
 *
 * Lifecycle orchestrator for the Arch chat surface.
 * Owns: fetch-based SSE stream, per-event dedup, and the
 * send-action surface returned to consumers.
 *
 * State management: useReducer over ArchUIState driven by reduceArchUIState().
 * The zustand store (store.ts) is updated in parallel for legacy consumers
 * (ArchPage and shared arch components) while the UI state stays unified.
 *
 * Reconnect path (M1 stub):
 * On stream drop, fetches /sessions/[id]/events?lastSeenSeq=N and replays
 * events through the same reducer. Snapshot fallback deferred to M2.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { dispatchEnvelope } from './event-dispatcher';
import { parseEnvelope } from './event-parser';
import { reduceArchUIState, INITIAL_ARCH_UI_STATE } from './hook-reducer';
import {
  cancelTurn,
  createSession,
  fetchCurrentSession,
  postMessage,
  type InProjectSessionScopeOptions,
} from './session-api';
import { useArchUIStore } from './store';
import { syncBuildStateFromSession } from './build-state';
import { useArchAIStore } from '../store/arch-ai-store';
import { shouldPreserveCreateProjectState } from './create-project-state';
import { buildPageContext } from '../build-page-context';
import { deriveSessionScope, resolveSessionScope, type SessionScope } from './session-scope';
import { clearPendingDiffTabIfUnbacked, restorePendingMutationDiffTab } from './proposal-artifacts';
import { buildBlueprintDocumentArtifact } from '../blueprint-document';
import { getBlueprintStage, getEffectiveTopology } from '../blueprint-flow';
import type { ArchSession, ChatMessage, LiveArchEvent, StatusMessage, TurnEvent } from './types';
import { normalizeContent } from '@agent-platform/arch-ai/types';
import type { ArchContentBlock } from '@agent-platform/arch-ai/types';
import type { ResumeSnapshot, SessionCheckpoint } from '@agent-platform/arch-ai/types';

// Browser-safe logger — this file runs in the client bundle (Next.js 'use client').
// console.warn/error are acceptable for client-side diagnostic output per session-api.ts.
const log = {
  warn: (msg: string, ctx?: Record<string, unknown>) =>
    console.warn(`[arch-ai:hook] ${msg}`, ctx ?? ''),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    console.error(`[arch-ai:hook] ${msg}`, ctx ?? ''),
};

// Exponential backoff settings for the SSE reconnect loop.
const SSE_INITIAL_DELAY_MS = 500;
const SSE_MAX_DELAY_MS = 30_000;
const SSE_MAX_RETRIES = 5;
const ATTACHMENT_STILL_PROCESSING_CODE = 'ATTACHMENT_STILL_PROCESSING';

interface MessageFileRef {
  blobId: string;
  name?: string;
  type?: string;
}

interface ArchErrorPayload {
  success?: boolean;
  errors?: Array<{
    msg?: string;
    code?: string;
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

// Re-export the Arch-local UI types consumed by the shared arch components.
export type { ActivityGroup, ActivityStep, StatusMessage, ArchError } from './types';
export type { ResumeSnapshot, SessionCheckpoint };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readArchErrorResponse(
  response: Response,
): Promise<{ message: string; code?: string }> {
  const payload = (await response.json().catch(() => ({}))) as ArchErrorPayload;
  const sharedError = Array.isArray(payload.errors)
    ? payload.errors.find((entry) => typeof entry?.msg === 'string' && entry.msg.trim().length > 0)
    : undefined;

  if (sharedError?.msg) {
    return {
      message: sharedError.msg,
      code: sharedError.code,
    };
  }

  if (payload.error?.message) {
    return {
      message: payload.error.message,
      code: payload.error.code,
    };
  }

  return {
    message: `Request failed: ${response.status} ${response.statusText}`,
  };
}

function createArchRequestError(message: string, code: string | undefined, status: number): Error {
  return Object.assign(new Error(message), {
    code,
    status,
  });
}

function inferPendingWidgetToolName(
  payload: unknown,
): 'ask_user' | 'collect_file' | 'collect_secret' | 'gate_request' | null {
  if (
    isRecord(payload) &&
    payload.widgetType === 'GateRequest' &&
    typeof payload.question === 'string'
  ) {
    return 'gate_request';
  }
  if (
    isRecord(payload) &&
    typeof payload.widgetType === 'string' &&
    (typeof payload.question === 'string' || typeof payload.message === 'string')
  ) {
    return 'ask_user';
  }
  if (
    isRecord(payload) &&
    typeof payload.message === 'string' &&
    (payload.widgetType === undefined || payload.widgetType === 'FileUpload')
  ) {
    return 'collect_file';
  }
  if (
    isRecord(payload) &&
    typeof payload.flowId === 'string' &&
    typeof payload.field === 'string' &&
    typeof payload.label === 'string'
  ) {
    return 'collect_secret';
  }
  return null;
}

function isConfirmationPendingInteraction(session: ArchSession | null): boolean {
  const pending = session?.metadata?.pendingInteraction;
  if (!pending || pending.kind !== 'widget' || !isRecord(pending.payload)) {
    return false;
  }

  return pending.payload.widgetType === 'Confirmation';
}

function hasOpenDiffArtifactTab(): boolean {
  return useArchAIStore.getState().artifactTabs.some((tab) => tab.type === 'diff');
}

function isPhantomUserMessage(message: {
  role: string;
  messageMetadata?: { source?: string };
}): boolean {
  if (message.role !== 'user') return false;
  const source = message.messageMetadata?.source;
  return source === 'deterministic_tool_answer' || source === 'widget_answer';
}

function buildUserRawContent(
  text: string,
  fileRefs?: MessageFileRef[],
): ArchContentBlock[] | undefined {
  if (!fileRefs || fileRefs.length === 0) {
    return undefined;
  }

  const blocks: ArchContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: 'text', text });
  }

  for (const ref of fileRefs) {
    const name = ref.name?.trim() || 'attached file';
    const mediaType = ref.type?.trim() || 'application/octet-stream';
    blocks.push(
      mediaType.startsWith('image/')
        ? {
            type: 'image_ref',
            blobId: ref.blobId,
            name,
            mediaType,
            width: 0,
            height: 0,
            tokenCost: 0,
          }
        : {
            type: 'file_ref',
            blobId: ref.blobId,
            name,
            mediaType,
            tokenCost: 0,
          },
    );
  }

  return blocks;
}

function extractRetryFileRefs(message: ChatMessage): MessageFileRef[] | undefined {
  const refs =
    message.rawContent
      ?.filter(
        (block): block is Extract<ArchContentBlock, { type: 'file_ref' | 'image_ref' }> =>
          block.type === 'file_ref' || block.type === 'image_ref',
      )
      .map((block) => ({
        blobId: block.blobId,
        name: block.name,
        type: block.mediaType,
      })) ?? [];

  return refs.length > 0 ? refs : undefined;
}

function findLastRetryableUserMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message;
    }
  }

  return null;
}

function toFetchScopeOptions(scope: SessionScope): InProjectSessionScopeOptions | undefined {
  const options: InProjectSessionScopeOptions = {};

  if (scope.mode === 'IN_PROJECT') {
    if (scope.surface) {
      options.surface = scope.surface;
    }
    if (scope.agentName) {
      options.agentName = scope.agentName;
    }
  }
  if (scope.threadId) {
    options.threadId = scope.threadId;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

const INTERACTIVE_RESTORE_TOOL_NAMES = new Set([
  'ask_user',
  'collect_file',
  'collect_secret',
  'gate_request',
]);

function pickRestoreToolCall(
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    result?: unknown;
  }>,
):
  | { toolCallId: string; toolName: string; input: Record<string, unknown>; result?: unknown }
  | undefined {
  const interactive = toolCalls.find((tc) => INTERACTIVE_RESTORE_TOOL_NAMES.has(tc.toolName));
  return interactive ?? toolCalls[0];
}

function restoreMessagesFromSession(session: ArchSession): ChatMessage[] {
  const storedMessages = Array.isArray(session.metadata.messages) ? session.metadata.messages : [];
  return storedMessages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    if (isPhantomUserMessage(message)) {
      return [];
    }

    const tc =
      Array.isArray(message.toolCalls) && message.toolCalls.length > 0
        ? pickRestoreToolCall(message.toolCalls)
        : undefined;

    return [
      {
        id: message.id,
        role: message.role,
        content: normalizeContent(message.content),
        specialist: message.specialist ? { name: message.specialist, icon: 'bot' } : undefined,
        toolCall: tc
          ? {
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
              result: tc.result,
            }
          : undefined,
        timestamp: message.timestamp,
        rawContent: Array.isArray(message.content) ? message.content : undefined,
      } satisfies ChatMessage,
    ];
  });
}

function restoreOnboardingArtifactsFromSession(session: ArchSession): void {
  if (session.metadata.mode !== 'ONBOARDING') {
    return;
  }

  const topology = getEffectiveTopology(session);
  const metadata = session.metadata as unknown as Record<string, unknown>;
  const stage = getBlueprintStage(session);
  const phase = session.metadata.phase;
  const store = useArchAIStore.getState();

  if (!topology) {
    if (phase === 'INTERVIEW') {
      const specTab = store.artifactTabs.find((tab) => tab.type === 'spec-document');
      if (specTab) {
        store.setActiveTab(specTab.id);
      }
      return;
    }
    const existingBlueprint = store.artifactTabs.find((tab) => tab.type === 'blueprint-document');
    if (!existingBlueprint) {
      const blueprintTabId = store.addTab({
        type: 'blueprint-document',
        label: 'Blueprint',
        data: buildBlueprintDocumentArtifact({
          metadata,
          topology: null,
          stage,
          approved: false,
          locked: false,
        }),
        toolCallId: `restored-blueprint-${session.id}`,
      });
      store.setActiveTab(blueprintTabId);
    }
    return;
  }

  const topologyTabId = store.addTab({
    type: 'topology',
    label: 'Topology',
    data: topology,
    toolCallId: `restored-topology-${session.id}`,
  });
  const blueprintTabId = store.addTab({
    type: 'blueprint-document',
    label: 'Blueprint',
    data: buildBlueprintDocumentArtifact({
      metadata,
      topology: topology as unknown as Record<string, unknown>,
      stage,
      approved: session.metadata.topologyApproved === true,
      locked: session.metadata.topologyApproved === true || !!session.metadata.lockedTopology,
    }),
    toolCallId: `restored-blueprint-${session.id}`,
  });

  const shouldShowTopology =
    session.metadata.phase === 'BUILD' || session.metadata.phase === 'CREATE';
  store.setActiveTab(shouldShowTopology ? topologyTabId : blueprintTabId);
  store.setOverlayState('artifacts');
}

function isTurnEventEnvelope(value: LiveArchEvent): value is TurnEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'turnId' in value &&
    typeof value.turnId === 'string' &&
    'seq' in value &&
    typeof value.seq === 'number'
  );
}

export function useArchChatController() {
  const session = useArchUIStore((s) => s.session);

  // ── Event-driven reducer ────────────────────────────────────────────────
  // reduceArchUIState is a pure function; useReducer gives React a stable dispatch
  // handle. Consumers of useArchChat read state from the zustand store
  // (for backward compatibility) — the reducer drives the new ArchUIState surface.
  const [_archUIState, dispatchArchUIState] = useReducer(reduceArchUIState, INITIAL_ARCH_UI_STATE);

  // Track the highest durable replay cursor seen for reconnect replay.
  // Durable replay cursors are allocated from Redis INCR and start at 1.
  // Cold loads must therefore begin at 0, not -1, otherwise every session
  // with any durable event will be treated as "behind the retention window"
  // and the client will skip artifact replay on first open.
  const lastSeenDurableSeqRef = useRef<number>(0);
  const seenTurnEventIdsRef = useRef<Set<string>>(new Set());
  const inFlightPostRef = useRef(false);

  /**
   * Apply a deduplicated envelope through BOTH the legacy zustand store
   * (for backward compat) and the new pure Arch reducer.
   */
  const applyEnvelope = (env: LiveArchEvent): void => {
    const store = useArchUIStore.getState();

    if (isTurnEventEnvelope(env)) {
      if (seenTurnEventIdsRef.current.has(env.eventId)) {
        return;
      }
      seenTurnEventIdsRef.current.add(env.eventId);

      if (typeof env.replaySeq === 'number' && env.replaySeq > lastSeenDurableSeqRef.current) {
        lastSeenDurableSeqRef.current = env.replaySeq;
      }

      dispatchEnvelope(env, store);
      dispatchArchUIState(env);
      return;
    }

    dispatchEnvelope(env, store);
  };

  const applySessionSnapshot = useCallback(
    (nextSession: ArchSession | null, resume: ResumeSnapshot | null) => {
      const store = useArchUIStore.getState();
      const previousSessionId = store.session?.id ?? null;
      const nextSessionId = nextSession?.id ?? null;
      const preservedError = previousSessionId === nextSessionId ? store.error : null;

      if (previousSessionId !== nextSessionId) {
        lastSeenDurableSeqRef.current = 0;
        seenTurnEventIdsRef.current = new Set();
      }

      if (
        shouldPreserveCreateProjectState(
          nextSession,
          useArchAIStore.getState().createdProjectId,
          store.messages,
        )
      ) {
        syncBuildStateFromSession(null);
        useArchUIStore.setState((state) => ({
          session: state.session,
          resume: null,
          state: 'idle',
          currentMsgId: null,
          statusMessage: null,
          error: null,
          suggestions: [],
          phase: 'CREATE',
        }));
        return null;
      }

      store.clear();

      if (!nextSession) {
        syncBuildStateFromSession(null);
        clearPendingDiffTabIfUnbacked();
        useArchUIStore.setState({
          session: null,
          resume: null,
          state: 'idle',
          phase: 'INTERVIEW',
        });
        return null;
      }

      const restoredMessages = restoreMessagesFromSession(nextSession);
      const currentSpecialist =
        [...restoredMessages].reverse().find((message) => message.specialist)?.specialist ??
        (nextSession.metadata.activeSpecialist
          ? { name: nextSession.metadata.activeSpecialist, icon: 'bot' }
          : null);

      let chatState: 'idle' | 'widget_pending' = 'idle';
      const pending = resume?.pending;
      if (pending?.kind === 'widget') {
        const toolName = inferPendingWidgetToolName(pending.interaction.payload);
        const alreadyRestored = restoredMessages.some(
          (m) => m.toolCall?.toolCallId === pending.interaction.id,
        );
        if (!alreadyRestored) {
          restoredMessages.push(
            toolName
              ? {
                  id: `pending-${pending.interaction.id}`,
                  role: 'assistant',
                  content: '',
                  toolCall: {
                    toolCallId: pending.interaction.id,
                    toolName,
                    input: pending.interaction.payload,
                  },
                  timestamp: pending.interaction.createdAt,
                }
              : {
                  id: `pending-invalid-${pending.interaction.id}`,
                  role: 'assistant',
                  content:
                    'A previous question could not be restored correctly. You can continue the conversation and retry that request if needed.',
                  timestamp: pending.interaction.createdAt,
                },
          );
        }
        chatState = 'widget_pending';
      }

      useArchUIStore.setState({
        session: nextSession,
        resume,
        messages: restoredMessages,
        state: chatState,
        phase: nextSession.metadata.phase,
        currentMsgId: null,
        lastCommittedSeq: -1,
        seenSeqByTurn: new Map(),
        currentSpecialist,
        statusMessage: null,
        error: preservedError,
        suggestions: [],
        topology: nextSession.metadata.topology ?? null,
        pendingMutation: nextSession.metadata.pendingMutation ?? null,
      });

      syncBuildStateFromSession(nextSession);
      restoreOnboardingArtifactsFromSession(nextSession);
      if (nextSession.metadata.pendingMutation) {
        restorePendingMutationDiffTab(nextSession.metadata.pendingMutation);
      } else {
        clearPendingDiffTabIfUnbacked();
      }
      if (nextSession.metadata.pendingPlan) {
        const store = useArchAIStore.getState();
        const existing = store.artifactTabs.find((tab) => tab.type === 'plan');
        if (existing) {
          store.updateTab(existing.id, nextSession.metadata.pendingPlan);
          store.setActiveTab(existing.id);
        } else {
          store.addTab({
            type: 'plan',
            label: 'Plan',
            data: nextSession.metadata.pendingPlan,
            toolCallId: `restored-${nextSession.metadata.pendingPlan.id}`,
          });
        }
      }

      return nextSession;
    },
    [],
  );

  // ── Fetch-based SSE stream (POST body) ──────────────────────────────────
  const streamPost = async (body: Record<string, unknown>): Promise<void> => {
    if (inFlightPostRef.current) {
      log.warn('streamPost ignored while another Arch request is in flight', {
        bodyType: typeof body.type === 'string' ? body.type : 'unknown',
      });
      return;
    }
    inFlightPostRef.current = true;

    try {
      const currentStore = useArchUIStore.getState();
      const currentSession = currentStore.session;
      if (!currentSession?.id) {
        return;
      }

      // Optimistically append the user's message so it renders immediately.
      // Matches legacy useArchChat behavior — current code adds user msg to
      // local state on send, server persists, snapshot reload reflects it.
      // The Arch reducer appends assistant text via `text_delta`; user messages
      // must be added here because the engine only emits events for its own
      // output, not echoes of user input.
      const bodyType = (body as { type?: string }).type;
      const userText = (body as { text?: string }).text;
      const messageFileRefs = (body as { fileRefs?: MessageFileRef[] }).fileRefs;
      const toolAnswer = (body as { answer?: unknown }).answer;
      const toolCallId = (body as { toolCallId?: string }).toolCallId;
      const toolAnswerRollback =
        bodyType === 'tool_answer'
          ? {
              messages: currentStore.messages,
              session: currentStore.session,
              state: currentStore.state,
              statusMessage: currentStore.statusMessage,
              error: currentStore.error,
            }
          : null;
      if (bodyType === 'message' && typeof userText === 'string' && userText.length > 0) {
        useArchUIStore.setState((st) => ({
          messages: [
            ...st.messages,
            {
              id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'user',
              content: userText,
              timestamp: new Date().toISOString(),
              rawContent: buildUserRawContent(userText, messageFileRefs),
            } as never,
          ],
        }));
      }

      useArchUIStore.setState((state) => ({
        state: 'streaming',
        error: null,
        statusMessage: null,
        messages:
          bodyType === 'tool_answer' && typeof toolCallId === 'string'
            ? state.messages.map((message) =>
                message.toolCall?.toolCallId === toolCallId
                  ? {
                      ...message,
                      toolCall: {
                        ...message.toolCall,
                        result: toolAnswer,
                      },
                    }
                  : message,
              )
            : state.messages,
        session: state.session
          ? {
              ...state.session,
              metadata: {
                ...state.session.metadata,
                pendingInteraction: null,
              },
            }
          : state.session,
      }));

      const restoreToolAnswerState = () => {
        if (!toolAnswerRollback) {
          return;
        }

        useArchUIStore.setState({
          messages: toolAnswerRollback.messages,
          session: toolAnswerRollback.session,
          state: toolAnswerRollback.state,
          statusMessage: toolAnswerRollback.statusMessage,
          error: toolAnswerRollback.error,
        });
      };

      const { accessToken } = useAuthStore.getState();
      let res: Response;
      try {
        res = await postMessage({
          sessionId: currentSession.id,
          accessToken: accessToken ?? undefined,
          ...body,
        } as never);
      } catch (err: unknown) {
        restoreToolAnswerState();
        if (toolAnswerRollback) {
          useArchUIStore.setState({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: 'network_error',
              recoverable: true,
            } as never,
            state: toolAnswerRollback.state,
          });
          return;
        }
        throw err;
      }
      if (!res.ok) {
        restoreToolAnswerState();
        const errorInfo = await readArchErrorResponse(res);
        useArchUIStore.setState({
          error: {
            message: errorInfo.message,
            type: 'generic',
            recoverable: true,
          } as never,
          state: toolAnswerRollback?.state ?? 'idle',
        });
        if (errorInfo.code === ATTACHMENT_STILL_PROCESSING_CODE) {
          throw createArchRequestError(errorInfo.message, errorInfo.code, res.status);
        }
        return;
      }
      if (!res.body) {
        return;
      }
      await drainSSEStream(res.body.getReader(), applyEnvelope);

      const postStreamStore = useArchUIStore.getState();
      const shouldReconcilePendingMutation =
        bodyType === 'message' &&
        currentSession.metadata.mode === 'IN_PROJECT' &&
        typeof currentSession.metadata.projectId === 'string' &&
        currentSession.metadata.projectId.length > 0 &&
        postStreamStore.state === 'widget_pending' &&
        isConfirmationPendingInteraction(postStreamStore.session) &&
        !hasOpenDiffArtifactTab();

      if (!shouldReconcilePendingMutation) {
        return;
      }

      try {
        const currentScope = deriveSessionScope(currentSession);
        if (currentScope?.mode !== 'IN_PROJECT') {
          return;
        }
        const { session: freshSession, resume } = await fetchCurrentSession(
          currentScope.mode,
          currentScope.projectId,
          toFetchScopeOptions(currentScope),
        );
        if (freshSession) {
          applySessionSnapshot(freshSession, resume);
        }
      } catch (err: unknown) {
        log.warn('post-turn pending mutation reconcile failed', {
          sessionId: currentSession.id,
          projectId: currentSession.metadata.projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      inFlightPostRef.current = false;
    }
  };

  // ── Reconnect replay (M1) ────────────────────────────────────────────────
  // On stream drop: re-fetch /api/arch-ai/sessions/[id]/events?lastSeenSeq=N
  // and replay events through the same reducer. Uses fetch-based SSE with
  // header auth per spec §9.4 (EventSource cannot set Authorization headers).
  // Exponential backoff on error: 500ms → 1s → 2s → 4s → 8s, then stop.
  // If the server responds with snapshot_required, fall back to a scoped
  // /sessions/current reload. AbortController cancels on unmount or session change.
  useEffect(() => {
    if (!session?.id) return;
    const sessionId = session.id;
    const initialScope = deriveSessionScope(session);
    const controller = new AbortController();
    let retries = 0;
    let delayMs = SSE_INITIAL_DELAY_MS;
    let consecutiveEmptyStreams = 0;
    const MAX_CONSECUTIVE_EMPTY_STREAMS = 2;

    const loadReconnectSnapshot = () => {
      const activeSession = useArchUIStore.getState().session;
      const activeScope =
        activeSession?.id === sessionId ? deriveSessionScope(activeSession) : initialScope;

      if (!activeScope) {
        log.warn('[arch-ai] snapshot fallback skipped — missing IN_PROJECT projectId', {
          sessionId,
        });
        return Promise.resolve(null);
      }

      return loadCurrentSession(
        activeScope.mode,
        activeScope.mode === 'IN_PROJECT' ? activeScope.projectId : undefined,
        toFetchScopeOptions(activeScope),
      );
    };

    const connect = async (): Promise<void> => {
      const { accessToken } = useAuthStore.getState();
      const seq = lastSeenDurableSeqRef.current;
      const url = `/api/arch-ai/sessions/${encodeURIComponent(sessionId)}/events?lastSeenSeq=${seq}`;

      let res: Response;
      try {
        res = await fetch(url, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        log.warn('[arch-ai] SSE fetch failed', {
          error: err instanceof Error ? err.message : String(err),
          retries,
        });
        if (retries >= SSE_MAX_RETRIES) {
          log.error('[arch-ai] SSE max retries reached, stopping reconnect', { sessionId });
          return;
        }
        retries++;
        const wait = delayMs;
        delayMs = Math.min(delayMs * 2, SSE_MAX_DELAY_MS);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        if (!controller.signal.aborted) await connect();
        return;
      }

      if (res.status === 409) {
        // HTTP-level snapshot_required (legacy path).
        log.warn('[arch-ai] SSE snapshot_required (HTTP 409), falling back to /sessions/current');
        loadReconnectSnapshot().catch((err: unknown) => {
          log.error('snapshot fallback failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      if (!res.ok) {
        log.warn('[arch-ai] SSE response not ok', { status: res.status, sessionId, retries });
        if (retries >= SSE_MAX_RETRIES) {
          log.error('[arch-ai] SSE max retries reached, stopping reconnect', { sessionId });
          return;
        }
        retries++;
        const wait = delayMs;
        delayMs = Math.min(delayMs * 2, SSE_MAX_DELAY_MS);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        if (!controller.signal.aborted) await connect();
        return;
      }

      // 200 OK — drain the stream and only reset backoff if envelopes arrived.
      // DO NOT reset retries/delayMs here: a 200 with an empty body (M1 stub)
      // would otherwise pin retries=0 forever, bypassing SSE_MAX_RETRIES.
      if (!res.body) {
        // No body — treat as empty close. Fall through to reconnect block below
        // without resetting backoff so the guard can eventually trip.
      } else {
        const reader = res.body.getReader();
        try {
          const delivered = await drainSSEStream(reader, applyEnvelope);
          if (delivered > 0) {
            // Real events received — reset backoff.
            retries = 0;
            delayMs = SSE_INITIAL_DELAY_MS;
            consecutiveEmptyStreams = 0;
          } else {
            // Empty stream: server closed with no envelopes (M1 stub / caught up).
            consecutiveEmptyStreams++;
            if (consecutiveEmptyStreams >= MAX_CONSECUTIVE_EMPTY_STREAMS) {
              log.warn(
                '[arch-ai] SSE returning empty — server has nothing to replay, stopping reconnect',
                { sessionId, consecutiveEmptyStreams },
              );
              return;
            }
          }
        } catch (err: unknown) {
          if (controller.signal.aborted) return;
          if (err instanceof SnapshotRequiredError) {
            log.warn('[arch-ai] ring buffer snapshot_required — falling back to /sessions/current');
            controller.abort();
            loadReconnectSnapshot().catch((err: unknown) => {
              log.error('snapshot fallback failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
            return;
          }
          log.warn('[arch-ai] SSE stream error', {
            error: err instanceof Error ? err.message : String(err),
            retries,
          });
        } finally {
          reader.releaseLock();
        }
      }

      // Stream ended cleanly (server closed). Attempt reconnect with backoff.
      if (controller.signal.aborted) return;
      if (retries >= SSE_MAX_RETRIES) {
        log.error('[arch-ai] SSE max retries reached, stopping reconnect', { sessionId });
        return;
      }
      retries++;
      const wait = delayMs;
      delayMs = Math.min(delayMs * 2, SSE_MAX_DELAY_MS);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (!controller.signal.aborted) await connect();
    };

    void connect();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const loadCurrentSession = useCallback(
    async (
      mode: 'ONBOARDING' | 'IN_PROJECT',
      projectId?: string,
      options?: InProjectSessionScopeOptions,
    ) => {
      const scope = resolveSessionScope(null, mode, projectId, options);
      if (!scope) {
        log.warn('loadCurrentSession skipped — missing IN_PROJECT projectId', {
          mode,
          projectId: projectId ?? null,
        });
        return null;
      }

      const { session: s, resume: r } = await fetchCurrentSession(
        scope.mode,
        scope.mode === 'IN_PROJECT' ? scope.projectId : undefined,
        toFetchScopeOptions(scope),
      );
      return applySessionSnapshot(s, r);
    },
    [applySessionSnapshot],
  );

  return {
    sendMessage: (text: string, files?: unknown[], fileRefs?: MessageFileRef[]) =>
      streamPost({
        type: 'message',
        text,
        files,
        fileRefs,
        pageContext: buildPageContext() ?? undefined,
      }),
    sendToolAnswer: (
      toolCallId: string,
      answer: unknown,
      secrets?: { flowId: string; values: Record<string, string> },
    ) => streamPost({ type: 'tool_answer', toolCallId, answer, secrets }),
    sendGateResponse: (action: 'accept' | 'modify' | 'reject', feedback?: string) =>
      streamPost({ type: 'gate_response', action, feedback }),
    sendProposal: (action: 'accept' | 'modify' | 'reject', feedback?: string) =>
      streamPost({ type: 'proposal_response', action, feedback }),
    sendContinue: () => streamPost({ type: 'continue' }),
    sendCreate: () => streamPost({ type: 'create' }),
    cancel: () => (session?.id ? cancelTurn(session.id) : Promise.resolve()),
    newChat: async () => {
      useArchUIStore.getState().clear();
      const s = await createSession({ mode: 'ONBOARDING', force: true });
      applySessionSnapshot(s, null);
    },
    loadCurrentSession,
  };
}

/** Sentinel thrown by drainSSEStream when the server sends a `snapshot_required` SSE event. */
class SnapshotRequiredError extends Error {
  constructor() {
    super('snapshot_required');
    this.name = 'SnapshotRequiredError';
  }
}

/**
 * Parse raw SSE frames from a ReadableStream reader, invoking `onEnvelope`
 * for each valid TurnEvent. Handles partial-frame buffering.
 *
 * Returns the number of envelopes delivered. The caller uses this to decide
 * whether to reset backoff: a 200 with zero envelopes (M1 stub / caught up)
 * should NOT reset retries, so the max-retries guard can eventually trip.
 *
 * Uses fetch-based streaming (not EventSource) per spec §9.4.
 */
async function drainSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEnvelope: (env: LiveArchEvent) => void,
): Promise<number> {
  const decoder = new TextDecoder();
  let buf = '';
  let count = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      // The Arch SSE serializer puts `type` in the `event:` SSE field but not
      // in the JSON data body.
      // We extract it from the `event:` line and inject it before parsing so
      // parseEnvelope's `typeof parsed.type !== 'string'` guard passes.
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const eventType = eventLine ? eventLine.slice(7).trim() : undefined;
      // Server sends snapshot_required as an SSE event frame when the caller's
      // cursor is behind the ring buffer's retention window. Signal the
      // reconnect loop to abort and fall back to a full session fetch.
      if (eventType === 'snapshot_required') {
        throw new SnapshotRequiredError();
      }
      const env = parseEnvelope(dataLine.slice(6), eventType);
      if (!env) continue;
      onEnvelope(env);
      count++;
    }
    if (done) break;
  }
  return count;
}

/**
 * useArchChat — active controller compatible with the shared arch component interface.
 *
 * Returns the combined state + actions shape that shared arch components
 * expect from `useArchChat`. State comes from the Arch UI store; actions
 * delegate to useArchChatController.
 *
 * Provides backwards compatibility without duplicating action logic.
 */
export function useArchChat() {
  const store = useArchUIStore();
  const actions = useArchChatController();

  return {
    // ─── State from the Arch UI store ───────────────────────────────────
    messages: store.messages,
    state: store.state,
    phase: store.phase,
    error: store.error,
    suggestions: store.suggestions,
    session: store.session,

    // ─── Extended state ──────────────────────────────────────────────────
    currentSpecialist: store.currentSpecialist,
    statusMessage: store.statusMessage,
    /**
     * statusMessages plural: combines the legacy single statusMessage (for
     * backward compat) with the accumulating statusMessages list populated
     * by the event-dispatcher (e.g. specialist-transition narration).
     */
    statusMessages: [
      ...(store.statusMessage
        ? ([
            {
              id: 'v2-status',
              text: store.statusMessage,
              type: 'info',
              timestamp: new Date().toISOString(),
            },
          ] satisfies StatusMessage[])
        : ([] as StatusMessage[])),
      ...store.statusMessages,
    ],

    // ─── Actions from the controller ─────────────────────────────────────
    /** Send a chat message. */
    send: actions.sendMessage,
    sendToolAnswer: actions.sendToolAnswer,
    sendGateResponse: actions.sendGateResponse,
    sendProposal: actions.sendProposal,
    sendCreate: actions.sendCreate,
    stop: actions.cancel,
    startFresh: actions.newChat,

    // ─── Session lifecycle stubs ────────────────────────────────────────
    // These delegate to the controller's session helpers where available,
    // or provide no-op stubs for features not yet ported into this hook.
    loadSession: (
      mode: 'ONBOARDING' | 'IN_PROJECT',
      projectId?: string,
      options?: InProjectSessionScopeOptions,
    ) => actions.loadCurrentSession(mode, projectId, options),
    refreshSession: async (mode?: 'ONBOARDING' | 'IN_PROJECT', projectId?: string) => {
      const currentSession = useArchUIStore.getState().session;
      const scope = resolveSessionScope(currentSession, mode, projectId);
      if (!scope) {
        log.warn('refreshSession skipped — missing IN_PROJECT projectId', {
          sessionId: currentSession?.id ?? null,
          requestedMode: mode ?? null,
          requestedProjectId: projectId ?? null,
        });
        return currentSession ?? null;
      }

      const fresh = await actions.loadCurrentSession(
        scope.mode,
        scope.mode === 'IN_PROJECT' ? scope.projectId : undefined,
        toFetchScopeOptions(scope),
      );
      return fresh ?? null;
    },
    clearSession: () => {
      useArchUIStore.getState().clear();
    },
    retry: async () => {
      const store = useArchUIStore.getState();
      if (store.state === 'streaming') {
        return;
      }

      const lastUserMessage = findLastRetryableUserMessage(store.messages);
      if (!lastUserMessage) {
        useArchUIStore.getState().setError({
          message: 'There is no previous message to retry.',
          type: 'generic',
          recoverable: false,
        });
        return;
      }

      await actions.sendMessage(
        lastUserMessage.content,
        undefined,
        extractRetryFileRefs(lastUserMessage),
      );
    },

    // ─── Stubs: features not yet ported into the current engine ─────────
    resume: store.resume,
    /** checkpoints: the current UI flow does not yet expose checkpoint list; always empty. */
    checkpoints: [] as SessionCheckpoint[],
    /** rollback: not yet implemented in the current engine flow. */
    rollback: async (_checkpointId: string): Promise<void> => {
      // TODO: Implement rollback in the current engine flow.
    },
  };
}
