import { parseAgentBasedABL } from '@abl/core';

import {
  extractRoutingEdgesFromDslFallback,
  extractRoutingEdgesFromParsedDocument,
} from './routing-edge-extraction';
import type { CrossAgentValidationResult } from './types';

interface AgentNode {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  isEntry: boolean;
}

interface AgentEdge {
  from: string;
  to: string;
  type: string;
  returnsControl: boolean;
}

interface GeneratedAgent {
  name: string;
  ablContent: string;
  constructsUsed: string[];
}

/**
 * Cross-agent validation after all agents are individually compiled.
 * Checks topology-level consistency that per-agent compilation cannot catch.
 */
export function validateCrossAgent(
  topology: { nodes: AgentNode[]; edges: AgentEdge[] },
  agents: GeneratedAgent[],
): CrossAgentValidationResult {
  const errors: CrossAgentValidationResult['errors'] = [];
  const agentNames = new Set(agents.map((a) => a.name));
  const nodeNames = new Set(topology.nodes.map((n) => n.name));

  // 1. Check handoff targets exist
  for (const edge of topology.edges) {
    const fromNode = topology.nodes.find((n) => n.id === edge.from || n.name === edge.from);
    const toNode = topology.nodes.find((n) => n.id === edge.to || n.name === edge.to);

    if (fromNode && !toNode) {
      errors.push({
        type: 'missing_handoff_target',
        severity: 'error',
        sourceAgent: fromNode.name,
        targetAgent: edge.to,
        message: `Agent "${fromNode.name}" has a ${edge.type} edge to "${edge.to}", but no agent with that name exists.`,
        suggestion: findSimilarName(edge.to, nodeNames),
      });
    }
  }

  // 2. Check delegate return paths (hub-spoke pattern)
  for (const edge of topology.edges) {
    if (edge.type === 'delegate') {
      const returnEdge = topology.edges.find(
        (e) => e.from === edge.to && e.to === edge.from && e.returnsControl,
      );
      if (!returnEdge) {
        const fromNode = topology.nodes.find((n) => n.id === edge.from || n.name === edge.from);
        const toNode = topology.nodes.find((n) => n.id === edge.to || n.name === edge.to);
        errors.push({
          type: 'missing_delegate_return',
          severity: 'warning',
          sourceAgent: fromNode?.name || edge.from,
          targetAgent: toNode?.name || edge.to,
          message: `Delegate edge from "${fromNode?.name || edge.from}" to "${toNode?.name || edge.to}" has no return path. The child agent should use __return_to_parent__.`,
          suggestion: `Add DELEGATE with RETURNS in the child agent's definition.`,
        });
      }
    }
  }

  // 3. Check for orphan agents (unreachable from entry)
  const entryNodes = topology.nodes.filter((n) => n.isEntry);
  if (entryNodes.length > 0) {
    const reachable = new Set<string>();
    const queue = entryNodes.map((n) => n.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      for (const edge of topology.edges) {
        if (edge.from === current && !reachable.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }

    for (const node of topology.nodes) {
      if (!reachable.has(node.id)) {
        errors.push({
          type: 'orphan_agent',
          severity: 'warning',
          sourceAgent: node.name,
          message: `Agent "${node.name}" is not reachable from any entry point.`,
          suggestion: `Add an edge from the supervisor to "${node.name}", or remove this agent if it's not needed.`,
        });
      }
    }
  }

  // 4. Check authored routing references in ABL match topology
  for (const agent of agents) {
    const parsed = parseAgentBasedABL(agent.ablContent);
    const referencedEdges = parsed.document
      ? extractRoutingEdgesFromParsedDocument(parsed.document, agent.name)
      : extractRoutingEdgesFromDslFallback(agent.ablContent, agent.name);

    for (const edge of referencedEdges) {
      const target = edge.to;
      if (!agentNames.has(target) && !nodeNames.has(target)) {
        errors.push({
          type: 'abl_routing_mismatch',
          severity: 'error',
          sourceAgent: agent.name,
          targetAgent: target,
          message: `Agent "${agent.name}" references ${edge.type.toUpperCase()} target "${target}", but no agent with that name exists in the topology.`,
          suggestion: findSimilarName(target, agentNames),
        });
      }
    }
  }

  return {
    valid: errors.filter((e) => e.severity === 'error').length === 0,
    errors,
  };
}

function findSimilarName(target: string, names: Set<string>): string | undefined {
  const lower = target.toLowerCase();
  for (const name of names) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return `Did you mean "${name}"?`;
    }
  }
  return undefined;
}
