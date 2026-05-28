/**
 * Trajectory Scorers — 4 built-in scoring functions for R5 trajectory evaluation.
 *
 * These score conversation trajectories against expected paths, milestones,
 * and efficiency targets defined in eval scenarios.
 *
 * Scorers:
 * - milestoneCompletionScorer: % of expected milestones hit
 * - handoffCorrectnessScorer: actual vs expected agent handoff path
 * - pathEfficiencyScorer:     path length vs optimal (shorter = better)
 * - toolSequenceScorer:       tool call count vs maxToolCalls threshold
 */

import type { TraceEvent, TrajectoryScoreResult } from './eval-types.js';

// ── Milestone Completion ────────────────────────────────────────────

/**
 * Score based on percentage of expected milestones achieved during conversation.
 * Returns 0-1 where 1 = all milestones hit.
 */
export function milestoneCompletionScorer(
  milestonesHit: string[],
  expectedMilestones: string[],
): number {
  if (expectedMilestones.length === 0) return 1.0; // No expectations = full score
  const hitSet = new Set(milestonesHit);
  const matched = expectedMilestones.filter((m) => hitSet.has(m)).length;
  return matched / expectedMilestones.length;
}

// ── Handoff Correctness ─────────────────────────────────────────────

/**
 * Score based on how closely the actual agent path matches the expected path.
 * Uses longest common subsequence for partial credit.
 * Returns 0-1 where 1 = exact match.
 */
export function handoffCorrectnessScorer(
  actualAgentPath: string[],
  expectedAgentPath: string[],
): number {
  if (expectedAgentPath.length === 0) return 1.0; // No expectations = full score
  if (actualAgentPath.length === 0) return 0.0;

  // Longest common subsequence (LCS) for partial credit
  const lcsLength = longestCommonSubsequence(actualAgentPath, expectedAgentPath);
  return lcsLength / expectedAgentPath.length;
}

function longestCommonSubsequence(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  // Use 1D DP for space efficiency
  const prev = new Array<number>(n + 1).fill(0);
  const curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    for (let j = 0; j <= n; j++) {
      prev[j] = curr[j];
      curr[j] = 0;
    }
  }

  return prev[n];
}

// ── Path Efficiency ─────────────────────────────────────────────────

/**
 * Score based on how efficiently the agent resolved the conversation.
 * Compares actual path length to expected path length (shorter actual = higher score).
 * Returns 0-1 where 1 = optimal or better efficiency.
 */
export function pathEfficiencyScorer(
  actualAgentPath: string[],
  expectedAgentPath: string[],
): number {
  if (expectedAgentPath.length === 0) return 1.0;
  if (actualAgentPath.length === 0) return 0.0;

  const expectedLength = expectedAgentPath.length;
  const actualLength = actualAgentPath.length;

  // If actual is shorter or equal to expected, it's maximally efficient
  if (actualLength <= expectedLength) return 1.0;

  // Penalize linearly for extra hops, floor at 0
  const efficiency = expectedLength / actualLength;
  return Math.max(0, efficiency);
}

// ── Tool Sequence ───────────────────────────────────────────────────

/**
 * Score based on tool call efficiency. Fewer tool calls than the threshold = better.
 * If no maxToolCalls is defined, checks that tool calls were reasonable (< 2× turn count).
 * Returns 0-1 where 1 = within efficiency threshold.
 */
export function toolSequenceScorer(
  toolCallCount: number,
  maxToolCalls: number | undefined,
  turnCount: number,
): number {
  // If explicit threshold defined, score against it
  if (maxToolCalls !== undefined && maxToolCalls > 0) {
    if (toolCallCount <= maxToolCalls) return 1.0;
    // Linearly penalize overuse, floor at 0
    return Math.max(0, 1.0 - (toolCallCount - maxToolCalls) / maxToolCalls);
  }

  // Default heuristic: tool calls should be < 2× turn count
  const heuristicMax = Math.max(turnCount * 2, 1);
  if (toolCallCount <= heuristicMax) return 1.0;
  return Math.max(0, heuristicMax / toolCallCount);
}

// ── Check Milestones from Trace Events ──────────────────────────────

/**
 * Extract milestones hit from trace events.
 * Milestones are detected from:
 * - tool_call events: tool name matches a milestone
 * - flow_step_enter events: step name matches a milestone
 * - decision events: decision value matches a milestone
 * - handoff events: agent name matches a milestone
 */
export function extractMilestonesFromTraces(
  traceEvents: TraceEvent[],
  expectedMilestones: string[],
): string[] {
  if (expectedMilestones.length === 0) return [];

  const milestoneSet = new Set(expectedMilestones);
  const hit = new Set<string>();

  for (const event of traceEvents) {
    const data = event.data;

    switch (event.type) {
      case 'tool_call': {
        const toolName = String(data.toolName ?? data.name ?? '');
        if (milestoneSet.has(toolName)) hit.add(toolName);
        break;
      }
      case 'flow_step_enter':
      case 'flow_step_exit': {
        const stepName = String(data.stepName ?? '');
        if (milestoneSet.has(stepName)) hit.add(stepName);
        break;
      }
      case 'decision': {
        const decision = String(data.decision ?? '');
        if (milestoneSet.has(decision)) hit.add(decision);
        break;
      }
      case 'handoff':
      case 'delegate_start': {
        const targetAgent = String(data.toAgent ?? data.targetAgent ?? '');
        if (milestoneSet.has(targetAgent)) hit.add(targetAgent);
        break;
      }
    }
  }

  return Array.from(hit);
}

/**
 * Extract the agent path from trace events (handoff sequence).
 */
export function extractAgentPathFromTraces(traceEvents: TraceEvent[]): string[] {
  const path: string[] = [];

  for (const event of traceEvents) {
    if (event.type === 'agent_enter') {
      const agentName = String(event.data.agentName ?? '');
      if (agentName && (path.length === 0 || path[path.length - 1] !== agentName)) {
        path.push(agentName);
      }
    }
  }

  return path;
}

// ── Composite Scorer ────────────────────────────────────────────────

/**
 * Compute all trajectory scores for a conversation.
 */
export function computeTrajectoryScores(params: {
  milestonesHit: string[];
  expectedMilestones: string[];
  actualAgentPath: string[];
  expectedAgentPath: string[];
  toolCallCount: number;
  maxToolCalls?: number;
  turnCount: number;
}): TrajectoryScoreResult {
  return {
    milestoneCompletionRate: milestoneCompletionScorer(
      params.milestonesHit,
      params.expectedMilestones,
    ),
    handoffCorrectnessRate: handoffCorrectnessScorer(
      params.actualAgentPath,
      params.expectedAgentPath,
    ),
    pathEfficiencyScore: pathEfficiencyScorer(params.actualAgentPath, params.expectedAgentPath),
    toolSequenceScore: toolSequenceScorer(
      params.toolCallCount,
      params.maxToolCalls,
      params.turnCount,
    ),
  };
}
