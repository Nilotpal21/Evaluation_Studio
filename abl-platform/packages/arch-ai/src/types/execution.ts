/**
 * Execution types — Contract: execution-model.md
 *
 * Contract 13 defines ExecutionResult with a journalEntries field.
 * That field is deferred until CC-F01 (Journal System, step 7 in build order)
 * defines the JournalEntry type. When CC-F01 is implemented, add:
 *   journalEntries: JournalEntry[];
 */

import type { SessionMetadata } from './session.js';

export type ExecutionStatus = 'completed' | 'awaiting_tool_result' | 'tool_executed' | 'error';

export interface ExecutionResult {
  status: ExecutionStatus;
  toolCallId?: string;
  /** Present when status === 'awaiting_tool_result' — original client-side tool input */
  toolInput?: Record<string, unknown>;
  /** Present when status === 'tool_executed' — the name of the tool that was run */
  toolName?: string;
  /** Present when status === 'tool_executed' — the result returned by the tool executor */
  toolResult?: unknown;
  updatedMetadata: Partial<SessionMetadata>;
  // journalEntries: JournalEntry[] — deferred to CC-F01 (Journal System)
}
