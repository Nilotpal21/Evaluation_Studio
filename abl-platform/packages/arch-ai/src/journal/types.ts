/**
 * Journal types — CC-F01
 *
 * 5 record types with typed content per CC-F01 req 9.
 * Append-only. Status transitions only (no update/delete of content).
 */

import type { ArchPhase } from '../types/session.js';
import type { SpecialistId } from '../types/tools.js';

export type JournalEntryType = 'decision' | 'consultation' | 'mutation' | 'validation' | 'analysis';

export type JournalEntryStatus = 'active' | 'superseded' | 'archived' | 'invalidated';

// CC-F01 req 9: typed content per record type

export interface DecisionContent {
  summary: string;
  rationale: string;
  specialist: string;
  field?: string;
  value?: unknown;
  source: 'user_input' | 'inferred' | 'specialist_recommendation';
}

export interface ConsultationContent {
  topic: string;
  fromSpecialist: string;
  toSpecialist: string;
  outcome: string;
  contextPassed?: string;
  artifacts?: string[];
}

export interface MutationContent {
  what: string;
  field?: string;
  from?: unknown;
  to?: unknown;
  reason: string;
  specialist: string;
  requestedBy: 'user' | 'specialist';
}

export interface ValidationContent {
  target: string;
  result: 'pass' | 'fail';
  errors?: string[];
  warnings?: string[];
  triggeredBy: string;
}

export interface AnalysisContent {
  question: string;
  rootCause: string;
  specialist: string;
  fixApplied?: boolean;
  fixDetails?: string;
  regressionTestAdded?: boolean;
}

export type JournalContent =
  | ({ type: 'decision' } & DecisionContent)
  | ({ type: 'consultation' } & ConsultationContent)
  | ({ type: 'mutation' } & MutationContent)
  | ({ type: 'validation' } & ValidationContent)
  | ({ type: 'analysis' } & AnalysisContent);

export interface JournalEntry {
  id: string;
  sessionId: string;
  projectId?: string;
  type: JournalEntryType;
  content: JournalContent;
  specialist: SpecialistId | string;
  phase: ArchPhase | string;
  timestamp: string;
  status: JournalEntryStatus;
  sequence: number;
}
