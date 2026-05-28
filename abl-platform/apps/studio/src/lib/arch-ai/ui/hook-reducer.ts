/**
 * @arch-ai-ui
 *
 * Pure reducer for the Arch chat hook. Maps TurnEvent envelopes to ArchUIState
 * transitions with no side effects and no React imports.
 *
 * Fully unit-testable with synthetic envelopes — no stores, no hooks.
 *
 * Design principles:
 * - Idempotency: events with seq ≤ lastAppliedSeq are no-ops (same object
 *   reference returned). This makes reconnect-replay safe.
 * - Unknown kinds: returned unchanged — forward-compatible with new event types.
 * - Immutable: always return a new state object (or the same reference for
 *   no-ops). Never mutate the input state.
 */

import type { TurnEvent, ArtifactUpdate, SpecPatch } from '@agent-platform/arch-ai/types';

// ─── ArchUIState ─────────────────────────────────────────────────────────────────

/** A single message in the chat transcript. */
export interface ArchMessageState {
  /** Unique identifier for the message (crypto.randomUUID or fallback). */
  id: string;
  role: 'user' | 'assistant';
  /** Accumulated text content. */
  text: string;
  /** True while the assistant is mid-stream. */
  isStreaming?: boolean;
  /** Specialist name, if the engine routed to one. */
  specialist?: string;
  /** Tool call info for interactive_tool pauses. */
  toolCall?: {
    toolCallId: string;
    toolName: string;
    payload: unknown;
  };
  /** ISO timestamp string. */
  timestamp: string;
}

/** Pending widget interaction waiting for a user response. */
export interface ArchPendingInteraction {
  kind: 'widget' | 'gate';
  /** toolCallId from the interactive_tool event. */
  id: string;
  toolName: string;
  payload: unknown;
}

/** Current artifact document for the spec panel (raw patch list). */
export interface ArchSpecDocumentState {
  version: number;
  patches: SpecPatch[];
}

export interface ArchUIState {
  /** Chat transcript. */
  messages: ArchMessageState[];
  /** Whether the assistant is streaming, waiting for a widget response, or idle. */
  chatState: 'idle' | 'streaming' | 'widget_pending';
  /** Pending interactive_tool interaction, if chatState === 'widget_pending'. */
  pendingInteraction: ArchPendingInteraction | null;
  /** Latest spec document (from artifact_updated spec events). */
  specDocument: ArchSpecDocumentState | null;
  /** Latest topology payload (raw). */
  topology: unknown | null;
  /** Journal entries accumulated this session. */
  journal: Array<Record<string, unknown>>;
  /** Ephemeral status label from the last `status` event. */
  statusLabel: string | null;
  /** Phase from the last turn_committed event. */
  phase: string | null;
  /** Seq of the last applied event. Used for idempotency during replay. */
  lastAppliedSeq: number;
  /** Internal: tracks the in-flight assistant message id for text_delta appends. */
  _streamingMsgId: string | null;
}

export const INITIAL_ARCH_UI_STATE: ArchUIState = {
  messages: [],
  chatState: 'idle',
  pendingInteraction: null,
  specDocument: null,
  topology: null,
  journal: [],
  statusLabel: null,
  phase: null,
  lastAppliedSeq: -1,
  _streamingMsgId: null,
};

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Pure reducer: TurnEvent × ArchUIState → ArchUIState.
 *
 * Idempotency contract:
 * - If `event.seq <= state.lastAppliedSeq`, the SAME state reference is returned.
 * - Otherwise a new state object is returned with `lastAppliedSeq` advanced.
 *
 * This makes reconnect-replay safe: replaying events through a state that has
 * already seen them produces no additional mutations.
 */
export function reduceArchUIState(state: ArchUIState, event: TurnEvent): ArchUIState {
  // ── Idempotency guard ──────────────────────────────────────────────────────
  if (event.seq <= state.lastAppliedSeq) {
    return state; // same reference — caller can use Object.is() to detect no-op
  }

  const nextSeq = event.seq;

  switch (event.type) {
    // ── Ephemeral: turn_started ─────────────────────────────────────────────
    case 'turn_started': {
      const msgId = randomId();
      const msg: ArchMessageState = {
        id: msgId,
        role: 'assistant',
        text: '',
        isStreaming: true,
        specialist: event.specialist,
        timestamp: new Date(event.timestamp).toISOString(),
      };
      return {
        ...state,
        chatState: 'streaming',
        messages: [...state.messages, msg],
        _streamingMsgId: msgId,
        statusLabel: null,
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Ephemeral: text_delta ───────────────────────────────────────────────
    case 'text_delta': {
      const { _streamingMsgId } = state;
      if (!_streamingMsgId) {
        // No in-flight message: create one (handles edge case where turn_started
        // was missed, e.g., replay started mid-turn).
        const msgId = randomId();
        const msg: ArchMessageState = {
          id: msgId,
          role: 'assistant',
          text: event.delta,
          isStreaming: true,
          specialist: event.specialist,
          timestamp: new Date(event.timestamp).toISOString(),
        };
        return {
          ...state,
          chatState: 'streaming',
          messages: [...state.messages, msg],
          _streamingMsgId: msgId,
          lastAppliedSeq: nextSeq,
        };
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === _streamingMsgId ? { ...m, text: m.text + event.delta } : m,
        ),
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Ephemeral: status ───────────────────────────────────────────────────
    case 'status': {
      return {
        ...state,
        statusLabel: event.label,
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Durable: artifact_updated ───────────────────────────────────────────
    case 'artifact_updated': {
      return applyArtifactUpdate(state, event.update, nextSeq);
    }

    // ── Durable: interactive_tool ───────────────────────────────────────────
    case 'interactive_tool': {
      const pending: ArchPendingInteraction = {
        kind: event.kind === 'gate' ? 'gate' : 'widget',
        id: event.toolCallId,
        toolName: event.tool,
        payload: event.payload,
      };
      const msgId = randomId();
      const msg: ArchMessageState = {
        id: msgId,
        role: 'assistant',
        text: '',
        toolCall: {
          toolCallId: event.toolCallId,
          toolName: event.tool,
          payload: event.payload,
        },
        timestamp: new Date(event.timestamp).toISOString(),
      };
      return {
        ...state,
        chatState: 'widget_pending',
        pendingInteraction: pending,
        messages: [...state.messages, msg],
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Durable: turn_committed ─────────────────────────────────────────────
    case 'turn_committed': {
      return {
        ...state,
        phase: event.phase,
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Durable: turn_ended ─────────────────────────────────────────────────
    case 'turn_ended': {
      const { _streamingMsgId } = state;
      return {
        ...state,
        chatState: 'idle',
        statusLabel: null,
        pendingInteraction: null,
        _streamingMsgId: null,
        messages: state.messages.map((m) =>
          m.id === _streamingMsgId ? { ...m, isStreaming: false } : m,
        ),
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Durable: error (turn_failed) ────────────────────────────────────────
    case 'error': {
      const { _streamingMsgId } = state;
      return {
        ...state,
        chatState: 'idle',
        statusLabel: null,
        _streamingMsgId: null,
        // Mark the in-flight message as no longer streaming
        messages: state.messages.map((m) =>
          m.id === _streamingMsgId ? { ...m, isStreaming: false } : m,
        ),
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Durable: phase_transition ───────────────────────────────────────────
    case 'phase_transition': {
      return {
        ...state,
        phase: event.to,
        lastAppliedSeq: nextSeq,
      };
    }

    // ── Unknown kind: forward-compatible no-op ──────────────────────────────
    default: {
      // turn_canceled: not yet in the wire TurnEvent union (engine emits
      // turn_ended(reason:'canceled') today), but handled here for forward
      // compatibility and to support direct client-side cancel signaling.
      // Resets chat state and clears in-flight streaming state identically to
      // an abort (same behaviour as turn_ended).
      if ((event as { type: string }).type === 'turn_canceled') {
        const { _streamingMsgId } = state;
        return {
          ...state,
          chatState: 'idle',
          statusLabel: null,
          pendingInteraction: null,
          _streamingMsgId: null,
          messages: state.messages.map((m) =>
            m.id === _streamingMsgId ? { ...m, isStreaming: false } : m,
          ),
          lastAppliedSeq: nextSeq,
        };
      }

      // Advance seq so replay does not re-apply this unknown event, but
      // return a new object so callers know the seq advanced.
      return {
        ...state,
        lastAppliedSeq: nextSeq,
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Apply a single ArtifactUpdate to state.
 * For M1, spec and topology channels are fully handled.
 * Other channels (journal, build, file, diff, widget, project, health,
 * traces, diagnostics, insights) are stored or no-op'd.
 */
function applyArtifactUpdate(
  state: ArchUIState,
  update: ArtifactUpdate,
  nextSeq: number,
): ArchUIState {
  switch (update.artifact) {
    case 'spec':
      return {
        ...state,
        specDocument: {
          version: update.version,
          patches: update.patches,
        },
        lastAppliedSeq: nextSeq,
      };

    case 'topology':
      return {
        ...state,
        topology: update.payload,
        lastAppliedSeq: nextSeq,
      };

    case 'journal':
      return {
        ...state,
        journal: [...state.journal, update.entry as Record<string, unknown>],
        lastAppliedSeq: nextSeq,
      };

    // All other artifact channels (build, file, diff, widget, project,
    // health, traces, diagnostics, insights) — advance seq, no-op for M1.
    // Full M2 coverage wires these to their respective panel states.
    default:
      return {
        ...state,
        lastAppliedSeq: nextSeq,
      };
  }
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}`;
}
