import type { AgentIR } from '../../ir/schema.js';

export interface HandoffTargetAuthority {
  returnExpected: boolean;
  source: 'routing' | 'coordination' | 'constraint';
}

export interface HandoffTargetReference {
  target: string;
  rawTarget: string;
  path: string;
  returnExpected: boolean;
  source: 'routing' | 'coordination' | 'constraint';
  remote: boolean;
}

export function normalizeHandoffTarget(target: string | undefined): string | undefined {
  if (typeof target !== 'string') {
    return undefined;
  }

  const normalizedTarget = target.trim();
  return normalizedTarget.length > 0 ? normalizedTarget : undefined;
}

export function normalizeConstraintHandoffTarget(target: string | undefined): string | undefined {
  const normalizedTarget = normalizeHandoffTarget(target);
  if (!normalizedTarget) {
    return undefined;
  }

  // Constraint HANDOFF actions may be compiled as "AgentName free-form reason".
  // Only the leading token is the actual routing target.
  const firstToken = normalizedTarget.split(/\s+/, 1)[0];
  return firstToken.length > 0 ? firstToken : undefined;
}

export function collectHandoffTargetReferences(
  agentIR: AgentIR | null | undefined,
): HandoffTargetReference[] {
  const refs: HandoffTargetReference[] = [];

  for (let i = 0; i < (agentIR?.routing?.rules?.length ?? 0); i++) {
    const rule = agentIR!.routing!.rules[i];
    const target = normalizeHandoffTarget(rule.to);
    if (!target) continue;
    refs.push({
      target,
      rawTarget: rule.to,
      path: `routing.rules[${i}].to`,
      returnExpected: rule.return === true,
      source: 'routing',
      remote: false,
    });
  }

  for (let i = 0; i < (agentIR?.coordination?.handoffs?.length ?? 0); i++) {
    const handoff = agentIR!.coordination!.handoffs[i];
    const target = normalizeHandoffTarget(handoff.to);
    if (!target) continue;
    refs.push({
      target,
      rawTarget: handoff.to,
      path: `coordination.handoffs[${i}].to`,
      returnExpected: handoff.return === true,
      source: 'coordination',
      remote: handoff.remote?.location === 'remote',
    });
  }

  for (let i = 0; i < (agentIR?.constraints?.constraints?.length ?? 0); i++) {
    const constraint = agentIR!.constraints!.constraints[i];
    if (constraint.on_fail?.type !== 'handoff') continue;
    const rawTarget = constraint.on_fail.target;
    const target = normalizeConstraintHandoffTarget(rawTarget);
    if (!target || !rawTarget) continue;
    refs.push({
      target,
      rawTarget,
      path: `constraints[${i}].on_fail.target`,
      returnExpected: false,
      source: 'constraint',
      remote: false,
    });
  }

  return refs;
}

export function resolveAllowedHandoffTargets(
  agentIR: AgentIR | null | undefined,
): Map<string, HandoffTargetAuthority> {
  const handoffTargets = new Map<string, HandoffTargetAuthority>();

  for (const ref of collectHandoffTargetReferences(agentIR)) {
    if (ref.source === 'constraint' && handoffTargets.has(ref.target)) {
      continue;
    }
    handoffTargets.set(ref.target, {
      returnExpected: ref.returnExpected,
      source: ref.source,
    });
  }

  return handoffTargets;
}
