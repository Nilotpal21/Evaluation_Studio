/**
 * Queue classification and flush-decision rules.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4
 *
 * Pure functions — no I/O, no side effects, no dependencies beyond types.
 */

import type { MessageRequest } from '../types/message-request.js';

// ─── Queue classification ───────────────────────────────────────────────

export type QueueClassification =
  | { action: 'queue' }
  | { action: 'route_direct' }
  | { action: 'reject'; status: 400 | 409; code: string };

/**
 * Classify an incoming MessageRequest into one of three actions:
 *   - queue: standard user messages that enter the per-session FIFO queue
 *   - route_direct: interactive responses (tool_answer, gate, proposal) that
 *     bypass the queue and wake the suspended turn directly
 *   - reject: invalid request types that should not reach the engine
 */
export function classifyRequestForQueue(req: MessageRequest): QueueClassification {
  switch (req.type) {
    case 'message':
    case 'continue':
      return { action: 'queue' };
    case 'tool_answer':
    case 'gate_response':
    case 'proposal_response':
      return { action: 'route_direct' };
    case 'create':
      return { action: 'route_direct' };
    default: {
      const _exhaustive: never = req;
      return { action: 'reject', status: 400, code: 'UNKNOWN_REQUEST_TYPE' };
    }
  }
}

// ─── Queue entry ────────────────────────────────────────────────────────

export interface QueueEntry {
  id: string;
  payload: Omit<MessageRequest, 'sessionId'>;
  enqueuedAt: Date;
  enqueuedBy: string;
}

// ─── Flush decision ─────────────────────────────────────────────────────

export type FlushDecision =
  | { action: 'flush_head'; entryId: string }
  | { action: 'hold' }
  | { action: 'drop_all' };

/**
 * Decide what to do with the queue after a turn ends.
 *
 * Rules:
 *   - turn_canceled → drop the entire queue (user navigated away / abort)
 *   - pendingInteractivePrompt → hold (turn suspended, waiting for user input)
 *   - queue empty → hold (nothing to flush)
 *   - otherwise → flush the head entry (FIFO)
 */
export function nextFlushDecision(args: {
  terminal: 'turn_committed' | 'turn_canceled';
  pendingInteractivePrompt: boolean;
  queue: QueueEntry[];
}): FlushDecision {
  if (args.terminal === 'turn_canceled') return { action: 'drop_all' };
  if (args.pendingInteractivePrompt) return { action: 'hold' };
  if (args.queue.length === 0) return { action: 'hold' };
  return { action: 'flush_head', entryId: args.queue[0].id };
}
