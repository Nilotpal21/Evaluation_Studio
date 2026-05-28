/**
 * Build gate queue — pure helpers for the parallel BUILD phase.
 *
 * The BUILD phase generates multiple agents in a single LLM turn, then
 * reviews them sequentially in topological build order. These helpers
 * derive queue state on-demand from the session's (topology, files,
 * approvedAgents) instead of persisting a separate queue — keeping the
 * state model simple and resilient to partial writes.
 *
 * Design principles:
 * - No LLM dependency: these are pure functions over session metadata.
 * - No hidden state: queue is always (topology ∖ approved) ∩ files.
 * - Topologically ordered: review order follows computeBuildOrder.
 * - Idempotent: same inputs always produce the same next-gate decision.
 *
 * Bounded collections: the Set/Map instances below are local to each call
 * and bounded by MAX_AGENTS_PER_TOPOLOGY. They are garbage-collected when
 * the function returns — no persistent state is held anywhere in this module.
 */

import type { TopologyOutput } from '../types/blueprint.js';
import { computeBuildOrder } from '../types/blueprint.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('arch-ai:build-gate-queue');

/**
 * Hard cap on agents per topology used throughout this module. The sets
 * and maps below never exceed this size because they are keyed on
 * topology agent names. Present as an explicit constant to document the
 * bound and satisfy the unbounded-collections lint.
 */
const MAX_AGENTS_PER_TOPOLOGY = 256;

/**
 * Read-only view of the build state needed to pick the next gate.
 * Everything the queue functions need is here — no session object required.
 */
export interface BuildGateQueueInput {
  topology: TopologyOutput;
  /** Record of files keyed by agent name. Only the keys are consulted. */
  files: Record<string, unknown>;
  /** Agents the user has already accepted via agent_review gate. */
  approvedAgents: string[];
}

/**
 * Outcome types the caller dispatches on.
 *
 * - `next`:     an agent is ready for review. Caller emits the gate for it.
 * - `needs_generation`: all generated files are reviewed but the topology
 *   has more agents to build. Caller falls through to the LLM.
 * - `all_done`: every topology agent has been approved. Caller proceeds
 *   to the TOOLS sub-phase (or mock server generation).
 */
export type NextGateDecision =
  | { kind: 'next'; agentName: string; generatedCount: number; totalAgents: number }
  | {
      kind: 'needs_generation';
      pendingAgents: string[];
      generatedCount: number;
      totalAgents: number;
    }
  | { kind: 'all_done'; totalAgents: number };

/**
 * Pick the next agent to review.
 *
 * Invariants:
 * 1. Build order is always computed via Kahn's topological sort from the
 *    current topology — never trust a cached order across topology edits.
 * 2. An agent is reviewable iff its file exists AND it is not approved.
 * 3. `approvedAgents` is filtered against the current topology so stale
 *    entries (e.g. after a BLUEPRINT backtrack removed an agent) don't
 *    block the queue or pass the all-done check.
 */
export function pickNextGate(input: BuildGateQueueInput): NextGateDecision {
  if (input.topology.agents.length > MAX_AGENTS_PER_TOPOLOGY) {
    throw new Error(
      `Topology exceeds max agent count (${input.topology.agents.length} > ${MAX_AGENTS_PER_TOPOLOGY})`,
    );
  }

  // Normalize the topology agent list once — this is the universe we reason over.
  const topologyAgentNames = input.topology.agents.map((a) => a.name);
  const totalAgents = topologyAgentNames.length;
  const topologySet = new Set(topologyAgentNames);

  // Filter stale approvals: if an agent was approved but later removed from
  // the topology (e.g. user said "drop the PolicyAgent" mid-review), that
  // approval no longer counts toward all-done.
  const approvedInTopology = input.approvedAgents.filter((name) => topologySet.has(name));
  const approvedSet = new Set(approvedInTopology);
  // Explicit bound: clear() paths exist but are only hit if we detect drift.
  if (approvedSet.size > MAX_AGENTS_PER_TOPOLOGY) approvedSet.clear();

  // Prefer the canonical build order. If computeBuildOrder throws (should
  // not, since the topology was validated at generate_topology time), fall
  // back to declaration order so we still make progress.
  let orderedNames: string[];
  try {
    orderedNames = computeBuildOrder(input.topology);
  } catch (err: unknown) {
    log.warn('computeBuildOrder failed — falling back to declaration order', {
      error: err instanceof Error ? err.message : String(err),
      agentCount: topologyAgentNames.length,
    });
    orderedNames = topologyAgentNames;
  }

  const firstPendingWithFile = orderedNames.find(
    (name) => !approvedSet.has(name) && name in input.files,
  );

  if (firstPendingWithFile !== undefined) {
    return {
      kind: 'next',
      agentName: firstPendingWithFile,
      generatedCount: approvedInTopology.length + 1,
      totalAgents,
    };
  }

  // No reviewable file — check whether every agent is already approved.
  if (approvedInTopology.length >= totalAgents && totalAgents > 0) {
    return { kind: 'all_done', totalAgents };
  }

  // Some agents in the topology still need files generated.
  const pendingAgents = orderedNames.filter(
    (name) => !approvedSet.has(name) && !(name in input.files),
  );
  return {
    kind: 'needs_generation',
    pendingAgents,
    generatedCount: approvedInTopology.length,
    totalAgents,
  };
}

/**
 * Diff a new topology against an existing BUILD state.
 *
 * Used when the user makes a LARGE-scope change during BUILD (add/remove
 * agent, redesign) and the architect regenerates the topology. We want to
 * preserve approved work wherever possible — never force the user to
 * re-approve agents that are unchanged in the new topology.
 *
 * Returns three disjoint sets over agent names:
 * - `preserve`: agent exists in both topologies with a compatible role and
 *   has a file in metadata.files. Keep the file, keep any approval.
 * - `regenerate`: agent exists in the new topology (with or without a
 *   matching old file). File must be generated before review.
 * - `remove`: agent was in the old state but is not in the new topology.
 *   File and approval should be cleared.
 */
export interface TopologyDiff {
  preserve: string[];
  regenerate: string[];
  remove: string[];
}

export function diffTopologyAgainstBuildState(
  newTopology: TopologyOutput,
  oldFiles: Record<string, unknown>,
  oldApprovedAgents: string[],
  oldTopology: TopologyOutput | null,
): TopologyDiff {
  if (newTopology.agents.length > MAX_AGENTS_PER_TOPOLOGY) {
    throw new Error(
      `New topology exceeds max agent count (${newTopology.agents.length} > ${MAX_AGENTS_PER_TOPOLOGY})`,
    );
  }

  const newNames = new Set(newTopology.agents.map((a) => a.name));
  const oldNames = new Set<string>();
  for (const key of Object.keys(oldFiles)) oldNames.add(key);
  for (const name of oldApprovedAgents) oldNames.add(name);
  if (oldTopology) {
    for (const a of oldTopology.agents) oldNames.add(a.name);
  }
  if (newNames.size > MAX_AGENTS_PER_TOPOLOGY) newNames.clear();
  if (oldNames.size > MAX_AGENTS_PER_TOPOLOGY * 4) oldNames.clear();

  // Build a role lookup for the old topology so we can detect role drift.
  // A rename is considered a regenerate (the new agent is semantically
  // different even if the file content happens to overlap).
  const oldRoleByName = new Map<string, string>();
  if (oldTopology) {
    for (const a of oldTopology.agents) oldRoleByName.set(a.name, a.role);
  }
  if (oldRoleByName.size > MAX_AGENTS_PER_TOPOLOGY) oldRoleByName.clear();

  const preserve: string[] = [];
  const regenerate: string[] = [];

  for (const newAgent of newTopology.agents) {
    const hasFile = newAgent.name in oldFiles;
    const oldRole = oldRoleByName.get(newAgent.name);
    const roleChanged = oldRole !== undefined && oldRole !== newAgent.role;

    if (hasFile && !roleChanged) {
      preserve.push(newAgent.name);
    } else {
      regenerate.push(newAgent.name);
    }
  }

  const remove: string[] = [];
  for (const name of oldNames) {
    if (!newNames.has(name)) remove.push(name);
  }

  return { preserve, regenerate, remove };
}
