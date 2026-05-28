/**
 * Agent Architecture Planner — computes structural plans from topology.
 *
 * Pure function: topology in → per-agent plans out.
 * No LLM, no I/O, no side effects.
 *
 * All Map/Set instances are function-local and GC'd on return — no unbounded growth.
 */

import type {
  PlannerTopologyInput,
  AgentArchitecturePlan,
  AgentArchetype,
  HandoffHistoryHint,
  HandoffReturnContractHint,
  HandoffTargetPlan,
  HandoffPlan,
  GatherPlan,
  FlowPlan,
  AgentComplexityPlan,
  StructuralRequirement,
  BlockedPattern,
  ArchitecturePlanResult,
} from './types.js';
import {
  detectSelfHandoffs,
  detectCycles,
  findOrphanAgents,
  inferReturnPaths,
  type ReturnPathInfo,
} from './topology-analyzer.js';

/** MAX_SIZE: plans Map is bounded by topology agent count (typically 1-10) */
const MAX_PLANS_SIZE = 50;

/**
 * Compute architecture plans for all agents in the topology.
 * Called once before parallel generation workers are spawned.
 */
export function computeArchitecturePlans(topology: PlannerTopologyInput): ArchitecturePlanResult {
  const { agents, edges, entryPoint } = topology;

  if (agents.length === 0) {
    return { plans: new Map(), globalBlocked: [] };
  }

  const selfHandoffs = detectSelfHandoffs(edges);
  const cycles = detectCycles(edges, agents);
  const orphans = findOrphanAgents(agents, edges, entryPoint);
  const returnPaths = inferReturnPaths(edges);

  const globalBlocked: BlockedPattern[] = [...cycles, ...orphans];

  // Function-local Map bounded by agent count (capped at MAX_PLANS_SIZE)
  const plans = new Map<string, AgentArchitecturePlan>();
  const agentsToProcess = agents.slice(0, MAX_PLANS_SIZE);
  const agentByName = new Map(agents.map((agent) => [agent.name, agent] as const));

  for (const agent of agentsToProcess) {
    const isEntry = agent.name === entryPoint;
    const outgoing = edges.filter((e) => e.from === agent.name && e.to !== agent.name);
    const incoming = edges.filter((e) => e.to === agent.name);

    const archetype = inferArchetype(agent, isEntry, outgoing, incoming, agents.length);
    const keyword: 'SUPERVISOR' | 'AGENT' = archetype === 'supervisor' ? 'SUPERVISOR' : 'AGENT';

    const handoffs = computeHandoffPlan(agent, agent.name, archetype, outgoing, agentByName);
    const returnInfo = returnPaths.get(agent.name);

    const gather = computeGatherPlan(agent, archetype, returnInfo);
    const complete = computeCompletePlan(archetype, returnInfo);
    const complexity = computeComplexityPlan(agent, archetype, outgoing, returnInfo, agents.length);
    const flow = computeFlowPlan(agent, complexity);

    const agentBlocked: BlockedPattern[] = selfHandoffs.filter((b) => b.agentName === agent.name);

    // Function-local Set bounded by edge count, cleared after loop iteration
    const neighborNames = new Set<string>();
    for (const e of [...outgoing, ...incoming]) {
      if (e.from !== agent.name) neighborNames.add(e.from);
      if (e.to !== agent.name) neighborNames.add(e.to);
    }
    const localAgents = agents
      .filter((a) => a.name === agent.name || neighborNames.has(a.name))
      .map((a) => ({ name: a.name, role: a.role, executionMode: a.executionMode }));
    const localEdges = edges
      .filter((e) => e.from === agent.name || e.to === agent.name)
      .map((e) => ({
        from: e.from,
        to: e.to,
        type: e.type,
        experienceMode: e.experienceMode,
        returnExpected: e.type === 'delegate' ? e.expectReturn !== false : e.expectReturn === true,
      }));
    neighborNames.clear();

    plans.set(agent.name, {
      agentName: agent.name,
      archetype,
      keyword,
      isEntry,
      gather,
      complete,
      complexity,
      flow,
      handoffs,
      allowedPassFields: agent.gatherFields ?? [],
      blocked: agentBlocked,
      localTopology: { agents: localAgents, edges: localEdges },
    });
  }

  return { plans, globalBlocked };
}

function inferArchetype(
  agent: PlannerTopologyInput['agents'][number],
  isEntry: boolean,
  outgoing: ReadonlyArray<PlannerTopologyInput['edges'][number]>,
  incoming: ReadonlyArray<PlannerTopologyInput['edges'][number]>,
  totalAgents: number,
): AgentArchetype {
  // Entry agents that only escalate to humans still own the main resolution path
  // themselves. Treat them as specialists so generation does not force a
  // SUPERVISOR catch-all contract onto a direct responder with optional human
  // escalation.
  const hasIncomingDelegate = incoming.some((e) => e.type === 'delegate');

  if (isEntry && outgoing.some((edge) => edge.type !== 'escalate')) return 'supervisor';

  if (hasIncomingDelegate && outgoing.length > 0) return 'pipeline_stage';

  if (
    isEntry &&
    outgoing.length >= 2 &&
    /\b(supervisor|triage|router|coordinator)\b/i.test(agent.role)
  ) {
    return 'supervisor';
  }

  if (incoming.length > 0 && outgoing.length === 0) return 'specialist';
  if (totalAgents === 1) return 'specialist';
  if (incoming.length > 0) return 'worker';

  return 'specialist';
}

function computeGatherPlan(
  agent: PlannerTopologyInput['agents'][number],
  archetype: AgentArchetype,
  returnInfo: ReturnPathInfo | undefined,
): GatherPlan {
  if (archetype === 'supervisor') {
    return { required: false, reason: 'Supervisors route, not gather', suggestedFields: [] };
  }

  if (returnInfo) {
    const sources = returnInfo.returnSources.join(', ');
    return {
      required: true,
      reason: `Delegate target with RETURN: true from ${sources} — GATHER fields drive structured progress toward COMPLETE conditions`,
      suggestedFields: agent.gatherFields ?? [],
    };
  }

  return {
    required: false,
    reason: 'No return contract — GATHER is optional but improves structured data collection',
    suggestedFields: agent.gatherFields ?? [],
  };
}

function computeCompletePlan(
  archetype: AgentArchetype,
  returnInfo: ReturnPathInfo | undefined,
): StructuralRequirement {
  if (archetype === 'supervisor') {
    return { required: false, reason: 'Supervisors route indefinitely — no COMPLETE needed' };
  }

  if (returnInfo?.needsComplete) {
    const sources = returnInfo.returnSources.join(', ');
    return {
      required: true,
      reason: `Return contract: ${sources} expects control to return — COMPLETE conditions signal when to return`,
    };
  }

  return {
    required: true,
    reason:
      'No return contract — terminal non-supervisor agents still need COMPLETE conditions so conversations do not run indefinitely',
  };
}

function computeComplexityPlan(
  agent: PlannerTopologyInput['agents'][number],
  archetype: AgentArchetype,
  outgoing: ReadonlyArray<PlannerTopologyInput['edges'][number]>,
  returnInfo: ReturnPathInfo | undefined,
  totalAgents: number,
): AgentComplexityPlan {
  const text = `${agent.role} ${agent.description ?? ''}`.toLowerCase();
  const signals: string[] = [];
  const gatherCount = agent.gatherFields?.length ?? 0;
  const toolCount = agent.tools?.length ?? 0;

  if (totalAgents === 1) signals.push('single_agent');
  if (archetype === 'supervisor' || outgoing.length > 0) signals.push('supervisor_routing');
  if (returnInfo) signals.push('return_contract');
  if (gatherCount >= 4) signals.push('many_gather_fields');
  if (toolCount > 0) signals.push('tool_backed');
  if (
    /\b(step|multi-step|workflow|approval|verify|verification|branch|eligib|escalat|onboard|intake|application|collects?)\b/.test(
      text,
    )
  ) {
    signals.push('ordered_business_process');
  }

  if (signals.includes('tool_backed') && signals.includes('ordered_business_process')) {
    return {
      selectedExecutionMode: 'hybrid',
      level: 'complex',
      reason:
        'The agent combines ordered business logic with tool-backed or branching work, so hybrid FLOW gives deterministic structure while preserving reasoning where useful.',
      signals,
    };
  }

  if (
    signals.includes('many_gather_fields') &&
    (signals.includes('ordered_business_process') || agent.executionMode === 'scripted')
  ) {
    return {
      selectedExecutionMode: 'scripted',
      level: 'complex',
      reason:
        'The agent needs ordered collection across several fields, so scripted FLOW should make the journey explicit.',
      signals,
    };
  }

  if (archetype === 'supervisor' || returnInfo || outgoing.length > 0 || gatherCount > 1) {
    return {
      selectedExecutionMode: 'reasoning',
      level: 'structured',
      reason:
        'The agent has routing or return contracts, but the runtime can handle it with reasoning plus explicit GATHER/HANDOFF contracts.',
      signals,
    };
  }

  return {
    selectedExecutionMode: 'reasoning',
    level: 'simple',
    reason: 'The agent can be solved as a fully reasoning agent without deterministic FLOW steps.',
    signals,
  };
}

function computeFlowPlan(
  agent: PlannerTopologyInput['agents'][number],
  complexity: AgentComplexityPlan,
): FlowPlan {
  const mode = complexity.selectedExecutionMode;
  if (mode === 'scripted') {
    return {
      recommended: true,
      reason: complexity.reason,
      executionMode: mode,
    };
  }
  if (mode === 'hybrid') {
    return {
      recommended: true,
      reason: complexity.reason,
      executionMode: mode,
    };
  }
  return {
    recommended: false,
    reason: complexity.reason,
    executionMode: mode,
  };
}

function computeHandoffPlan(
  sourceAgent: PlannerTopologyInput['agents'][number],
  agentName: string,
  archetype: AgentArchetype,
  outgoing: ReadonlyArray<PlannerTopologyInput['edges'][number]>,
  agentByName: ReadonlyMap<string, PlannerTopologyInput['agents'][number]>,
): HandoffPlan {
  const targets: HandoffTargetPlan[] = outgoing
    .filter((e) => e.to !== agentName)
    .map((e) => {
      const returnExpected =
        e.type === 'delegate' ? e.expectReturn !== false : e.expectReturn === true;
      const targetAgent = agentByName.get(e.to);

      return {
        to: e.to,
        edgeType: e.type,
        experienceMode: e.experienceMode,
        returnExpected,
        condition: e.condition,
        returnFieldSeeds: returnExpected ? [...(targetAgent?.gatherFields ?? [])] : [],
        historyHint: targetAgent ? buildHandoffHistoryHint(sourceAgent, targetAgent) : undefined,
        returnContractHint:
          returnExpected && targetAgent
            ? buildReturnContractHint(targetAgent, archetype)
            : undefined,
      };
    });

  let catchAllTarget: string | undefined;
  if (archetype === 'supervisor') {
    const customerFacingTargets = targets.filter(isCustomerFacingCatchAllTarget);
    catchAllTarget =
      customerFacingTargets.length > 0
        ? customerFacingTargets[customerFacingTargets.length - 1].to
        : undefined;
  }

  const needsCatchAll = archetype === 'supervisor' && catchAllTarget !== undefined;

  return { targets, needsCatchAll, catchAllTarget };
}

function isCustomerFacingCatchAllTarget(target: HandoffTargetPlan): boolean {
  if (
    target.edgeType === 'escalate' ||
    target.experienceMode === 'silent_delegate' ||
    target.experienceMode === 'human_escalation'
  ) {
    return false;
  }

  return (
    target.edgeType === 'transfer' &&
    (target.experienceMode === 'visible_handoff' ||
      target.experienceMode === 'shared_voice_handoff')
  );
}

function buildHandoffHistoryHint(
  sourceAgent: PlannerTopologyInput['agents'][number],
  targetAgent: PlannerTopologyInput['agents'][number],
): HandoffHistoryHint {
  const summaryFocusFields = [...(sourceAgent.gatherFields ?? [])];
  const summaryFieldSuffix =
    summaryFocusFields.length > 0
      ? ` Mention any already-known context about ${summaryFocusFields.join(', ')} when it is relevant.`
      : '';
  const summaryTemplateSeed =
    `Summarize the user's request, why ${targetAgent.name} is being invoked, and the most relevant ` +
    `context already known to ${sourceAgent.name}.${summaryFieldSuffix}`;

  if (targetAgent.executionMode === 'scripted') {
    return {
      suggestedHistory: 'auto',
      autoSummaryEligible: false,
      summaryRecommended: true,
      summaryFocusFields,
      summaryTemplateSeed,
      reason:
        `${targetAgent.name} is scripted. If you author CONTEXT.summary, keep history: auto ` +
        `(or bounded last_n); runtime auto falls back to bounded raw history for scripted targets ` +
        `instead of summary_only.`,
    };
  }

  return {
    suggestedHistory: 'auto',
    autoSummaryEligible: true,
    summaryRecommended: true,
    summaryFocusFields,
    summaryTemplateSeed,
    reason:
      `${targetAgent.name} uses ${targetAgent.executionMode} execution. If you author CONTEXT.summary, ` +
      `keep history: auto; runtime can resolve it to summary_only for this target when summary is present ` +
      `and otherwise falls back to bounded raw history.`,
  };
}

function buildReturnContractHint(
  targetAgent: PlannerTopologyInput['agents'][number],
  sourceArchetype: AgentArchetype,
): HandoffReturnContractHint {
  const defaultMergedFields = [...(targetAgent.gatherFields ?? [])];
  const archetypePrefix =
    sourceArchetype === 'supervisor'
      ? 'Supervisors usually only need explicit ON_RETURN.map when they want renamed parent fields or non-gather child outputs.'
      : 'Non-supervisor parents often continue their own completion or routing after return, so be explicit when they need outputs beyond the child gather contract.';

  if (defaultMergedFields.length === 0) {
    return {
      defaultMergedFields,
      reason:
        `${archetypePrefix} ${targetAgent.name} has no topology-declared gather fields, so if the parent needs structured child outputs after RETURN: true, ` +
        `you will likely need ON_RETURN.map for non-gather child outputs or renamed parent session vars.`,
    };
  }

  return {
    defaultMergedFields,
    reason:
      `${archetypePrefix} Runtime default return already merges ${targetAgent.name}'s gathered fields ` +
      `back to the parent by same name (${defaultMergedFields.join(', ')}). Use ON_RETURN.map only when ` +
      `the parent needs renamed fields, selective mapping, or non-gather child outputs.`,
  };
}
