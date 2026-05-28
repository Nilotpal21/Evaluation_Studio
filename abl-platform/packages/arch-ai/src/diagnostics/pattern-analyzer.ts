/**
 * Tier 3: Pattern Analyzer — architecture classification and anti-pattern detection.
 *
 * Pure functions operating on compiled IR. No I/O.
 */

import type { AgentIR } from '@abl/compiler';
import type { ArchitecturePattern, AntiPattern, ValidatorContext } from './types.js';

/**
 * Classify the project's architecture pattern based on agent topology.
 */
export function classifyArchitecture(ctx: ValidatorContext): ArchitecturePattern {
  const agents = Object.entries(ctx.agents);
  if (agents.length === 0) return 'unknown';
  if (agents.length === 1) return 'single-agent';

  // Count handoff relationships
  const outboundHandoffs = new Map<string, string[]>();
  const inboundHandoffs = new Map<string, string[]>();

  for (const [name, agent] of agents) {
    const targets = (agent.coordination?.handoffs ?? []).map((h) => h.to);
    outboundHandoffs.set(name, targets);
    for (const target of targets) {
      const existing = inboundHandoffs.get(target) ?? [];
      existing.push(name);
      inboundHandoffs.set(target, existing);
    }
  }

  // Check for routing rules (supervisor pattern)
  const routers = agents.filter(([, a]) => (a.routing?.rules?.length ?? 0) > 0);

  // Hub-spoke: one agent routes to many, others don't route
  if (routers.length === 1) {
    const routerName = routers[0][0];
    const routerTargets = outboundHandoffs.get(routerName) ?? [];
    const nonRouterHandoffs = agents.filter(
      ([n]) => n !== routerName && (outboundHandoffs.get(n)?.length ?? 0) > 0,
    );
    if (routerTargets.length >= 2 && nonRouterHandoffs.length <= 1) {
      return 'hub-spoke';
    }
  }

  // Triage: entry agent routes and never handles directly
  if (ctx.entryAgent) {
    const entry = ctx.agents[ctx.entryAgent];
    const hasRouting = (entry?.routing?.rules?.length ?? 0) > 0;
    const hasNoGather = (entry?.gather?.fields?.length ?? 0) === 0;
    const hasNoTools = (entry?.tools?.length ?? 0) === 0;
    if (hasRouting && hasNoGather && hasNoTools) {
      return 'triage';
    }
  }

  // Pipeline: linear chain A→B→C
  const chainAgents = agents.filter(
    ([name]) =>
      (outboundHandoffs.get(name)?.length ?? 0) === 1 &&
      (inboundHandoffs.get(name)?.length ?? 0) <= 1,
  );
  if (chainAgents.length >= agents.length - 1) {
    return 'pipeline';
  }

  // Hierarchical: multiple levels of delegation
  const delegators = agents.filter(([, a]) => (a.coordination?.delegates?.length ?? 0) > 0);
  if (delegators.length >= 2) {
    return 'hierarchical';
  }

  // Mesh: many-to-many handoffs
  const bidirectional = agents.filter(([name]) => {
    const targets = outboundHandoffs.get(name) ?? [];
    return targets.some((t) => (outboundHandoffs.get(t) ?? []).includes(name));
  });
  if (bidirectional.length >= 2) {
    return 'mesh';
  }

  return 'hub-spoke'; // Default for multi-agent with unclear structure
}

/**
 * Detect anti-patterns in the project.
 */
export function detectAntiPatterns(ctx: ValidatorContext): AntiPattern[] {
  const patterns: AntiPattern[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    // Overloaded agent: >10 tools, >10 gather fields, AND handoffs
    const toolCount = agent.tools?.length ?? 0;
    const gatherCount = agent.gather?.fields?.length ?? 0;
    const handoffCount =
      (agent.coordination?.handoffs?.length ?? 0) + (agent.coordination?.delegates?.length ?? 0);

    if (toolCount > 10 && gatherCount > 10 && handoffCount > 0) {
      patterns.push({
        name: 'overloaded-agent',
        description: `Agent "${name}" has ${toolCount} tools, ${gatherCount} gather fields, and ${handoffCount} handoffs — doing too much. Split into focused sub-agents.`,
        agents: [name],
        severity: 'warning',
        fix: {
          description: `Split "${name}" into 2-3 focused agents based on tool clusters`,
          effort: 'L',
        },
      });
    }

    // Supervisor-with-logic: declared SUPERVISOR with routing AND heavy gather/tools
    // Only applies to actual supervisors (metadata.type === 'supervisor'), not AGENT:
    // types that happen to have escalation handoffs compiled into routing.rules.
    const hasRouting = (agent.routing?.rules?.length ?? 0) > 0;
    if (hasRouting && agent.metadata?.type === 'supervisor' && (gatherCount > 3 || toolCount > 3)) {
      patterns.push({
        name: 'supervisor-with-logic',
        description: `Agent "${name}" acts as both supervisor (routing) and worker (${gatherCount} gather fields, ${toolCount} tools). Supervisors should route, not handle.`,
        agents: [name],
        severity: 'warning',
        fix: {
          description: `Extract gather/tool logic into a separate worker agent`,
          effort: 'M',
        },
      });
    }

    // Under-constrained: reasoning agent with tools but no guardrails
    const isReasoning = agent.execution?.mode === 'reasoning';
    const hasGuardrails = (agent.constraints?.guardrails?.length ?? 0) > 0;
    if (isReasoning && toolCount > 0 && !hasGuardrails) {
      patterns.push({
        name: 'under-constrained',
        description: `Agent "${name}" uses reasoning mode with ${toolCount} tools but has no guardrails — could produce unsafe outputs`,
        agents: [name],
        severity: 'warning',
        fix: {
          description: `Add input/output guardrails to constrain reasoning behavior`,
          effort: 'M',
        },
      });
    }
  }

  // Cross-agent: orphaned agents (no inbound handoffs, not entry)
  const inbound = new Set<string>();
  for (const [, agent] of Object.entries(ctx.agents)) {
    for (const h of agent.coordination?.handoffs ?? []) {
      inbound.add(h.to);
    }
    for (const d of agent.coordination?.delegates ?? []) {
      inbound.add(d.agent);
    }
    for (const r of agent.routing?.rules ?? []) {
      inbound.add(r.to);
    }
  }

  const orphans = ctx.agentNames.filter((name) => !inbound.has(name) && name !== ctx.entryAgent);
  if (orphans.length > 0) {
    patterns.push({
      name: 'orphaned-agents',
      description: `${orphans.length} agent(s) are unreachable — no handoff, delegate, or routing points to them`,
      agents: orphans,
      severity: 'warning',
      fix: {
        description: `Add handoff rules from the supervisor or remove unused agents`,
        effort: 'S',
      },
    });
  }

  return patterns;
}
