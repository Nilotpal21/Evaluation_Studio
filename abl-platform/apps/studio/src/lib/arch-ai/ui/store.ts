/**
 * @arch-ai-ui
 *
 * Single source of truth for the active Arch UI. Mutated only via
 * dispatchEnvelope (from events, implemented in event-dispatcher.ts)
 * or primitive setters (session load, clear, cancel).
 */

import { create } from 'zustand';
import type {
  ArchSession,
  ChatMessage,
  ArchSuggestion,
  ArchError,
  BuildState,
  ArchChatState,
  ArchUIPhase,
  ArchQueueEntry,
  LiveArchEvent,
  StatusMessage,
} from './types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';

export interface ArchUIStore {
  // Session lifecycle
  session: ArchSession | null;
  resume: ResumeSnapshot | null;
  state: ArchChatState;
  phase: ArchUIPhase;
  currentSpecialist: { name: string; icon: string } | null;

  // Message stream
  messages: ChatMessage[];
  currentMsgId: string | null;
  lastCommittedSeq: number;
  seenSeqByTurn: Map<string, number>;

  // Artifacts
  topology: unknown | null;
  specDocument: unknown | null;
  journal: Array<Record<string, unknown>>;
  buildState: BuildState;
  pendingMutation: unknown | null;

  // Transient UX
  statusMessage: string | null;
  /**
   * Accumulated inline status messages rendered between chat messages
   * (specialist transitions, BUILD progress, thinking-timeout warnings).
   * Append-only via {@link appendStatusMessage}; cleared on `clear()`.
   */
  statusMessages: StatusMessage[];
  error: ArchError | null;
  suggestions: ArchSuggestion[];
  queue: ArchQueueEntry[];

  // Actions
  setSession: (s: ArchSession | null) => void;
  setResume: (r: ResumeSnapshot | null) => void;
  markSeqSeen: (turnId: string, seq: number) => void;
  setError: (e: ArchError | null) => void;
  setStatusMessage: (m: string | null) => void;
  /** Append a single inline status message to {@link statusMessages}. */
  appendStatusMessage: (msg: StatusMessage) => void;
  clear: () => void;

  /**
   * Overridden by event-dispatcher.ts when it loads. Safe default no-op
   * so the store is usable in isolation (e.g., unit tests).
   */
  dispatchEnvelope: (env: LiveArchEvent) => void;
}

const DEFAULT_BUILD_STATE: BuildState = {
  phase: 'idle',
  agents: {},
  summary: null,
  log: [],
};

const initialState = {
  session: null as ArchSession | null,
  resume: null as ResumeSnapshot | null,
  state: 'idle' as ArchChatState,
  phase: 'INTERVIEW' as ArchUIPhase,
  currentSpecialist: null as { name: string; icon: string } | null,
  messages: [] as ChatMessage[],
  currentMsgId: null as string | null,
  lastCommittedSeq: -1,
  seenSeqByTurn: new Map<string, number>(),
  topology: null as unknown | null,
  specDocument: null as unknown | null,
  journal: [] as Array<Record<string, unknown>>,
  buildState: DEFAULT_BUILD_STATE,
  pendingMutation: null as unknown | null,
  statusMessage: null as string | null,
  statusMessages: [] as StatusMessage[],
  error: null as ArchError | null,
  suggestions: [] as ArchSuggestion[],
  queue: [] as ArchQueueEntry[],
};

export const useArchUIStore = create<ArchUIStore>((set) => ({
  ...initialState,

  setSession: (s) =>
    set({
      session: s,
      phase: ((s as { metadata?: { phase?: ArchUIPhase } } | null)?.metadata?.phase ??
        'INTERVIEW') as ArchUIPhase,
    }),

  setResume: (r) => set({ resume: r }),

  markSeqSeen: (turnId, seq) =>
    set((st) => {
      const cur = st.seenSeqByTurn.get(turnId) ?? -1;
      if (seq <= cur) return {};
      const next = new Map(st.seenSeqByTurn);
      next.set(turnId, seq);
      return { seenSeqByTurn: next };
    }),

  setError: (e) => set({ error: e }),
  setStatusMessage: (m) => set({ statusMessage: m }),
  appendStatusMessage: (msg) => set((s) => ({ statusMessages: [...s.statusMessages, msg] })),

  clear: () =>
    set(() => ({
      ...initialState,
      seenSeqByTurn: new Map(),
    })),

  dispatchEnvelope: () => {
    /* Overridden by event-dispatcher module. */
  },
}));
