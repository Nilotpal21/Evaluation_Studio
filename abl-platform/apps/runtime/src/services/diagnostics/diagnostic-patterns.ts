/**
 * Arch Diagnostic Pattern Detection
 *
 * Scans trace events for signature patterns that indicate common issues.
 * Returns human-readable explanations and fixes for Arch and agent developers.
 *
 * Detectors are ordered by priority — array order is the display order.
 */

export interface DiagnosticPattern {
  id: string;
  name: string;
  explanation: string;
  fix: string;
  eventCount: number;
  specReference?: string;
}

import type { TraceEvent } from '../pipeline/types.js';
export type { TraceEvent };
export type TraceEvents = TraceEvent[];

export interface DiagnosticRequest {
  traces: TraceEvents;
  agentHasMemory?: boolean;
}

export interface DiagnosticResult {
  patterns: DiagnosticPattern[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all diagnostic detectors against the provided trace events.
 * Returns detected patterns in priority order (array order of detectors).
 */
export function runDiagnostics(request: DiagnosticRequest): DiagnosticResult {
  const { traces } = request;
  const detected: DiagnosticPattern[] = [];

  const detectors: Array<() => DiagnosticPattern | null> = [
    () => detectMemorySilentNoop(traces, request.agentHasMemory ?? false),
    () => detectBacktrackEscalation(traces),
    () => detectPreferenceNotPersisted(traces),
    () => detectOnInputDrop(traces),
    () => detectValidationFailOpen(traces),
    () => detectStrategyMismatch(traces),
    () => detectGatherStall(traces),
    () => detectWrongFieldCorrected(traces),
  ];

  for (const detector of detectors) {
    try {
      const result = detector();
      if (result) detected.push(result);
    } catch (err: unknown) {
      // Individual detector failures must not break other detectors — but log for observability
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Diagnostics] Detector failed: ${message}`);
    }
  }

  return { patterns: detected };
}

// ---------------------------------------------------------------------------
// Detectors (ordered by priority)
// ---------------------------------------------------------------------------

function detectMemorySilentNoop(
  traces: TraceEvents,
  agentHasMemory: boolean,
): DiagnosticPattern | null {
  if (!agentHasMemory) return null;
  const events = traces.filter((t) => t.type === 'memory_unavailable');
  if (events.length === 0) return null;
  const reason = (events[0].data.reason as string) || 'unknown';
  return {
    id: 'memory_silent_noop',
    name: 'Memory System Inactive',
    explanation: `Your agent has REMEMBER/RECALL configured, but the memory system is inactive. Reason: ${reason}. Memory requires a configured FactStore (MongoDB) and a user ID on the session.`,
    fix:
      reason === 'no_fact_store'
        ? 'Configure a FactStore in your deployment settings, or use InMemoryFactStore for testing.'
        : reason === 'no_user_id'
          ? 'Ensure the session is created with a userId for memory to be scoped to.'
          : 'Verify your MEMORY configuration in the agent DSL and check deployment settings.',
    eventCount: events.length,
    specReference: 'docs/ABL_QUICK_REFERENCE.md#memory-rememberrecall--working-example',
  };
}

function detectBacktrackEscalation(traces: TraceEvents): DiagnosticPattern | null {
  const events = traces.filter((t) => t.type === 'constraint_backtrack_limit');
  if (events.length === 0) return null;
  const step = (events[0].data.step as string) || 'unknown';
  const count = (events[0].data.count as number) || 3;
  return {
    id: 'backtrack_escalation',
    name: 'Backtrack Limit Escalation',
    explanation: `Constraint on step '${step}' triggered a GOTO/RETRY loop that hit the maximum backtrack limit (${count}). The runtime escalated instead of continuing the loop.`,
    fix: 'Restructure your flow so the correction path uses different steps, or handle the case where the constraint cannot be satisfied after multiple attempts.',
    eventCount: events.length,
    specReference: 'docs/CONSTRAINTS.md#backtrack-limit-semantics',
  };
}

function detectPreferenceNotPersisted(traces: TraceEvents): DiagnosticPattern | null {
  const prefEvents = traces.filter((t) => t.type === 'preference_detected');
  if (prefEvents.length === 0) return null;
  const memoryUnavail = traces.filter((t) => t.type === 'memory_unavailable');
  if (memoryUnavail.length === 0) return null;
  return {
    id: 'preference_not_persisted',
    name: 'Preferences Detected But Not Persisted',
    explanation: `User preferences were detected (${prefEvents.length} found) but the memory system is unavailable. Detected preferences will not be remembered for future sessions.`,
    fix: 'Configure a FactStore to enable persistent memory. Preferences are only useful when they can be recalled in future sessions.',
    eventCount: prefEvents.length,
    specReference: 'docs/ABL_QUICK_REFERENCE.md#memory-rememberrecall--working-example',
  };
}

function detectOnInputDrop(traces: TraceEvents): DiagnosticPattern | null {
  const noMatch = traces.filter(
    (t) =>
      t.type === 'dsl_on_input' &&
      (t.data.matched === false || t.data.branchMatched === false || t.data.result === 'no_match'),
  );
  if (noMatch.length === 0) return null;
  return {
    id: 'on_input_drop',
    name: 'ON_INPUT Silent Drop',
    explanation: `User input was evaluated against ON_INPUT conditions but no branch matched. The input was silently re-prompted without feedback.`,
    fix: 'Add an ELSE branch to your ON_INPUT block to provide feedback when no condition matches.',
    eventCount: noMatch.length,
    specReference: 'docs/ABL_QUICK_REFERENCE.md#on_input-evaluation-rules',
  };
}

function detectValidationFailOpen(traces: TraceEvents): DiagnosticPattern | null {
  const events = traces.filter((t) => t.type === 'validation_fail_open');
  if (events.length === 0) return null;
  const fields = [...new Set(events.map((t) => (t.data.field as string) || 'unknown'))];
  return {
    id: 'validation_fail_open',
    name: 'LLM Validation Fail-Open',
    explanation: `LLM-based validation failed for field(s) [${fields.join(', ')}] due to LLM errors. Values were accepted as valid (fail-open behavior).`,
    fix: 'Check your LLM service availability. For security-critical fields, use pattern or custom validation instead of LLM validation.',
    eventCount: events.length,
    specReference: 'docs/TOOLS_AND_GATHER.md#llm-validation-fail-open-behavior',
  };
}

function detectStrategyMismatch(traces: TraceEvents): DiagnosticPattern | null {
  const events = traces.filter((t) => t.type === 'extraction_fallback');
  if (events.length === 0) return null;
  const fields = [...new Set(events.flatMap((t) => (t.data.fields as string[]) || []))];
  return {
    id: 'strategy_mismatch',
    name: 'Extraction Strategy Fallback',
    explanation: `LLM extraction failed for field(s) [${fields.join(', ')}], fell back to pattern-based extraction. Fields with strategy 'llm' would have no fallback.`,
    fix: 'Check your LLM configuration and provider availability. Use strategy: "hybrid" (default) for critical fields that need pattern fallback.',
    eventCount: events.length,
    specReference: 'docs/TOOLS_AND_GATHER.md#extraction-strategy-selection-guide',
  };
}

function detectGatherStall(traces: TraceEvents): DiagnosticPattern | null {
  const prompts = traces.filter((t) => t.type === 'dsl_prompt' || t.type === 'dsl_collect');
  if (prompts.length < 3) return null;

  const stepCounts: Record<string, number> = {};
  for (const p of prompts) {
    const step = (p.data.stepName as string) || (p.data.step as string) || 'unknown';
    stepCounts[step] = (stepCounts[step] || 0) + 1;
  }

  const stalled = Object.entries(stepCounts).find(([, count]) => count >= 3);
  if (!stalled) return null;

  return {
    id: 'gather_stall',
    name: 'Gather Progress Stall',
    explanation: `Step '${stalled[0]}' has prompted the user ${stalled[1]} times without making progress on field collection.`,
    fix: 'Check field types and validation rules match expected input. Add extraction_hints to help the LLM recognize values.',
    eventCount: stalled[1],
    specReference: 'docs/TOOLS_AND_GATHER.md#extraction-strategy-selection-guide',
  };
}

function detectWrongFieldCorrected(traces: TraceEvents): DiagnosticPattern | null {
  const ambiguous = traces.filter(
    (t) =>
      (t.type === 'correction' || t.type === 'correction_invalidation') &&
      ((t.data.field as string) === '_correction' || (t.data.method as string) === 'heuristic'),
  );
  if (ambiguous.length === 0) return null;
  return {
    id: 'wrong_field_corrected',
    name: 'Ambiguous Correction Detection',
    explanation: `A user correction was detected but the system couldn't determine which field was being corrected. The value was stored in '_correction' as a fallback.`,
    fix: 'Add extraction_hints to your GATHER fields to help the system identify corrections more accurately.',
    eventCount: ambiguous.length,
    specReference: 'docs/TOOLS_AND_GATHER.md#correction-detection-semantics',
  };
}
