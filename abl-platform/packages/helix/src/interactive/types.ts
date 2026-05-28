/**
 * Types for the HELIX Interactive Session Shell.
 *
 * Supports a REPL that runs alongside the pipeline, allowing users
 * to inject context, control execution, and query status mid-run.
 */

// ─── Intent Classification ──────────────────────────────────────

/**
 * Intents the input classifier can resolve from natural language input.
 */
export type InteractiveIntent =
  | 'inject-context' // "focus on auth middleware" → inject guidance into next stage
  | 'skip-stage' // "skip regression" → skip a stage
  | 'pause' // "pause" → pause pipeline
  | 'resume' // "resume" → resume paused pipeline
  | 'abort' // "stop" / "abort" → abort pipeline
  | 'status' // "what's happening?" → show pipeline status
  | 'prioritize' // "prioritize finding F-3" → bump finding priority
  | 'help' // "help" → show available commands
  | 'unknown'; // unclassifiable input

/**
 * Result of classifying a user's natural language input.
 */
export interface ClassifiedInput {
  /** The resolved intent */
  intent: InteractiveIntent;
  /** Confidence score from the classifier (0-1) */
  confidence: number;
  /** The original raw input */
  rawInput: string;
  /** Extracted parameters (e.g., stage name for skip, finding ID for prioritize) */
  params: Record<string, string>;
}

// ─── Live Context ───────────────────────────────────────────────

/**
 * A single entry in the live context accumulator.
 * Users inject these mid-run; they're rendered into the next stage prompt.
 */
export interface LiveContextEntry {
  id: string;
  /** When this entry was added */
  timestamp: string;
  /** The guidance or context from the user */
  content: string;
  /** Which stage consumed this entry (null if pending) */
  consumedByStage: string | null;
  /** When this entry was consumed */
  consumedAt: string | null;
}

// ─── Pipeline Control ───────────────────────────────────────────

/**
 * Commands that the REPL can issue to control the running pipeline.
 */
export type PipelineControlCommand =
  | { type: 'inject-context'; content: string }
  | { type: 'skip-stage'; stageName: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abort' }
  | { type: 'prioritize-finding'; findingId: string };

export type PipelinePauseResult = 'requested' | 'already-paused';

export type PipelineResumeResult = 'resumed' | 'cancelled-pending-pause' | 'not-paused';

/**
 * Snapshot of pipeline status returned by getStatus().
 */
export interface PipelineStatus {
  sessionId: string;
  state: string;
  currentStage: string;
  currentStageIndex: number;
  totalStages: number;
  currentSlice: number;
  totalSlices: number;
  findingsTotal: number;
  findingsOpen: number;
  findingsFixed: number;
  commits: number;
  elapsedMs: number;
  pendingContextEntries: number;
}
