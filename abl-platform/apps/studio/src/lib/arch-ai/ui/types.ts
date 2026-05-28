import type { ArchContentBlock } from '@agent-platform/arch-ai';
import type {
  ArchSSEEvent as RuntimeArchSSEEvent,
  TurnEvent as RuntimeTurnEvent,
} from '@agent-platform/arch-ai/types';

/**
 * @arch-ai-ui
 *
 * Internal types for the active Arch UI surface. These were previously
 * re-exported from the current Arch hook; keeping them local prevents the
 * UI layer from reaching back into older implementations for shape data.
 */

export type { ArchSuggestion } from '@/types/arch';
export type { ArchSession, ArchContentBlock } from '@agent-platform/arch-ai';
export type { BuildState } from '@/lib/arch-ai/store/arch-ai-store';
export type TurnEvent = RuntimeTurnEvent;
export type ArchSSEEvent = RuntimeArchSSEEvent;
export type LiveArchEvent = TurnEvent | ArchSSEEvent;

export type ArchErrorType =
  | 'stream_timeout'
  | 'blank_response'
  | 'loop_detected'
  | 'session_stuck'
  | 'session_building'
  | 'network_error'
  | 'generic';

export interface ArchError {
  message: string;
  type: ArchErrorType;
  recoverable: boolean;
  technicalDetails?: string;
}

export interface StatusMessage {
  id: string;
  text: string;
  type: 'info' | 'warning' | 'error' | 'success';
  timestamp: string;
}

export interface ActivityStep {
  id: string;
  status: 'active' | 'done' | 'error' | 'warning' | 'info';
  label: string;
  detail?: string;
  timestamp: string;
}

export interface ActivityGroup {
  id: string;
  label: string;
  steps: ActivityStep[];
  status: 'active' | 'done' | 'error' | 'pending';
  summary?: string;
  startTime: string;
  endTime?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  specialist?: { name: string; icon: string };
  toolCall?: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    result?: unknown;
    requestId?: string;
  };
  timestamp: string;
  activityGroups?: ActivityGroup[];
  isStreaming?: boolean;
  thinkingText?: string;
  thinkingElapsed?: number;
  rawContent?: ArchContentBlock[];
  kbCards?: Array<{ type: string; [key: string]: unknown }>;
  completion?: {
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    finishReason: string;
    stepCount: number;
    latencyMs: number;
    model: string;
  };
}

/** Local runtime state for the Arch chat surface. */
export type ArchChatState = 'idle' | 'streaming' | 'widget_pending';

/** Phase enum matching what the active engine emits in phase_transition events. */
export type ArchUIPhase = 'INTERVIEW' | 'BLUEPRINT' | 'BUILD' | 'CREATE' | 'IN_PROJECT';

/** Queue entry mirror — server-side queue on ArchSession.queue[]. */
export interface ArchQueueEntry {
  id: string;
  payload: Record<string, unknown>;
  enqueuedAt: string;
  enqueuedBy: string;
}
