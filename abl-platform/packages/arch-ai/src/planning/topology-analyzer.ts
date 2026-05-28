/**
 * Topology Analyzer — pure graph analysis functions.
 *
 * Operates on topology edges and agent lists to detect:
 * - Self-handoffs (from === to)
 * - Circular handoffs (non-trivial cycles without allowCycle)
 * - Reachability from entry point
 * - Orphan agents (unreachable from entry)
 * - Return-path inference (which agents need GATHER + COMPLETE)
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { PlannerTopologyInput, BlockedPattern } from './types.js';

type EdgeLike = PlannerTopologyInput['edges'][number];
type AgentLike = Pick<PlannerTopologyInput['agents'][number], 'name'>;

/** Return-path analysis result for a single target agent */
export interface ReturnPathInfo {
  needsGather: boolean;
  needsComplete: boolean;
  returnSources: string[];
}

/** Detect self-handoff edges (from === to) */
export function detectSelfHandoffs(edges: ReadonlyArray<EdgeLike>): BlockedPattern[] {
  const results: BlockedPattern[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to) {
      results.push({
        pattern: 'self_handoff',
        agentName: edge.from,
        detail: `Agent "${edge.from}" has a handoff edge to itself`,
      });
    }
  }
  return results;
}

/** Detect circular handoff paths using DFS cycle detection */
export function detectCycles(
  edges: ReadonlyArray<EdgeLike>,
  agents: ReadonlyArray<AgentLike>,
): BlockedPattern[] {
  // Build adjacency list (exclude self-loops and allowCycle edges)
  const adj = new Map<string, string[]>();
  for (const agent of agents) {
    adj.set(agent.name, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (edge.allowCycle) continue;
    const list = adj.get(edge.from);
    if (list) list.push(edge.to);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycleAgents = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      cycleAgents.add(node);
      return true;
    }
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (dfs(neighbor)) {
        cycleAgents.add(node);
      }
    }

    inStack.delete(node);
    return false;
  }

  for (const agent of agents) {
    dfs(agent.name);
  }

  return Array.from(cycleAgents).map((name) => ({
    pattern: 'circular_handoff' as const,
    agentName: name,
    detail: `Agent "${name}" is part of a circular handoff path`,
  }));
}

/** Compute the set of agent names reachable from entryPoint via BFS */
export function computeReachability(
  edges: ReadonlyArray<EdgeLike>,
  entryPoint: string,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const reachable = new Set<string>();
  const queue = [entryPoint];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const neighbor of adj.get(current) ?? []) {
      if (!reachable.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  return reachable;
}

/** Find agents not reachable from the entry point */
export function findOrphanAgents(
  agents: ReadonlyArray<AgentLike>,
  edges: ReadonlyArray<EdgeLike>,
  entryPoint: string,
): BlockedPattern[] {
  const reachable = computeReachability(edges, entryPoint);
  const results: BlockedPattern[] = [];

  for (const agent of agents) {
    if (!reachable.has(agent.name)) {
      results.push({
        pattern: 'orphan_agent',
        agentName: agent.name,
        detail: `Agent "${agent.name}" is not reachable from entry point "${entryPoint}"`,
      });
    }
  }

  return results;
}

/**
 * Infer which agents need GATHER + COMPLETE based on return expectations.
 *
 * An agent needs both when at least one incoming edge has expectReturn: true
 * (or type === 'delegate' with no explicit false).
 *
 * Returns a Map keyed by target agent name.
 */
export function inferReturnPaths(edges: ReadonlyArray<EdgeLike>): Map<string, ReturnPathInfo> {
  const result = new Map<string, ReturnPathInfo>();

  for (const edge of edges) {
    // Escalate edges don't expect structured return
    if (edge.type === 'escalate') continue;

    // Delegate edges default to expectReturn: true unless explicitly false
    const expectReturn =
      edge.type === 'delegate' ? edge.expectReturn !== false : edge.expectReturn === true;

    if (!expectReturn) continue;

    const existing = result.get(edge.to);
    if (existing) {
      existing.returnSources.push(edge.from);
    } else {
      result.set(edge.to, {
        needsGather: true,
        needsComplete: true,
        returnSources: [edge.from],
      });
    }
  }

  return result;
}
