import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import {
  resolveAllowedHandoffTargets,
  type HandoffTargetAuthority,
} from '@abl/compiler/platform/constructs';

export type HandoffTargetCapability = HandoffTargetAuthority;

export interface ActiveRoutingCapabilities {
  handoffTargets: Map<string, HandoffTargetCapability>;
  delegateTargets: Set<string>;
}

/**
 * Derive the active agent's routing authority directly from IR.
 *
 * This stays pure so routing validation never depends on mutable session state
 * that may have been inherited from another agent.
 */
export function resolveActiveRoutingCapabilities(
  agentIR: AgentIR | null | undefined,
): ActiveRoutingCapabilities {
  const handoffTargets = resolveAllowedHandoffTargets(agentIR);
  const delegateTargets = new Set<string>();

  for (const delegate of agentIR?.coordination?.delegates ?? []) {
    if (!delegate.agent) continue;
    delegateTargets.add(delegate.agent);
  }

  return {
    handoffTargets,
    delegateTargets,
  };
}

export function getValidHandoffTargets(capabilities: ActiveRoutingCapabilities): string[] {
  return Array.from(capabilities.handoffTargets.keys());
}

export function getHandoffReturnInfo(
  capabilities: ActiveRoutingCapabilities,
): Record<string, boolean> {
  return Object.fromEntries(
    Array.from(capabilities.handoffTargets.entries()).map(([target, capability]) => [
      target,
      capability.returnExpected,
    ]),
  );
}

export function getReturnExpectedForTarget(
  capabilities: ActiveRoutingCapabilities,
  targetAgent: string,
): boolean {
  return capabilities.handoffTargets.get(targetAgent)?.returnExpected ?? false;
}
