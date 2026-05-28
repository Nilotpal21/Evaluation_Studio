/**
 * Graph Generator Utility
 *
 * Generates static graphs for supervisors and reasoning agents
 * that don't have a FLOW definition.
 */

import type { StaticGraph, StaticGraphNode, StaticGraphEdge } from '../types';

interface AgentInfo {
  name: string;
  type?: string;
  mode?: string;
  isSupervisor?: boolean;
  ir?: Record<string, unknown>;
}

/**
 * Generate a static graph for any agent type
 */
export function generateStaticGraph(agent: AgentInfo): StaticGraph | null {
  const ir = agent.ir;

  // If scripted agent with flow, the graph should come from IR
  if (ir?.flow) {
    const flow = ir.flow as { staticGraph?: StaticGraph };
    if (flow.staticGraph) {
      return flow.staticGraph;
    }
  }

  // Generate graph for supervisor
  if (agent.isSupervisor || agent.type === 'supervisor') {
    return generateSupervisorGraph(agent.name, ir);
  }

  // Generate graph for reasoning agent
  return generateReasoningGraph(agent.name, ir);
}

/**
 * Generate graph for supervisors with HANDOFF rules
 */
function generateSupervisorGraph(_agentName: string, ir?: Record<string, unknown>): StaticGraph {
  const nodes: StaticGraphNode[] = [];
  const edges: StaticGraphEdge[] = [];

  // Entry node
  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  // Intent classification node
  const intentNodeId = '__intent_classifier__';
  const coordination = ir?.coordination as Record<string, unknown> | undefined;
  const handoffs = coordination?.handoffs as
    | Array<{
        to: string;
        when: string;
        return?: boolean;
        context?: { summary?: string };
      }>
    | undefined;

  nodes.push({
    id: intentNodeId,
    type: 'llm_decision',
    label: 'Intent Classification',
    deterministic: false,
    conditions: handoffs?.map((h) => h.when) || [],
  });

  edges.push({
    id: '__entry__->intent',
    from: '__entry__',
    to: intentNodeId,
    type: 'sequential',
  });

  // Add handoff nodes for each target
  if (handoffs) {
    const targets = new Set(handoffs.map((h) => h.to));

    for (const target of targets) {
      const handoffNodeId = `__handoff_${target}__`;
      const handoff = handoffs.find((h) => h.to === target);

      nodes.push({
        id: handoffNodeId,
        type: 'step',
        label: `→ ${target}`,
        deterministic: true,
        step: {
          respond: handoff?.context?.summary || `Handoff to ${target}`,
        },
      });

      edges.push({
        id: `${intentNodeId}->${handoffNodeId}`,
        from: intentNodeId,
        to: handoffNodeId,
        type: 'digression',
        label: handoff?.context?.summary || handoff?.when || target,
      });

      // If return expected, add return edge
      if (handoff?.return) {
        edges.push({
          id: `${handoffNodeId}->intent_return`,
          from: handoffNodeId,
          to: intentNodeId,
          type: 'sequential',
          label: 'return',
        });
      }
    }
  }

  // Add escalation path if present
  const escalation = ir?.escalation as
    | { triggers?: Array<{ when: string; reason: string }> }
    | undefined;
  if (escalation?.triggers && escalation.triggers.length > 0) {
    const escalateNodeId = '__escalate__';
    nodes.push({
      id: escalateNodeId,
      type: 'exit',
      label: '⚠️ ESCALATE',
      deterministic: true,
    });

    edges.push({
      id: `${intentNodeId}->escalate`,
      from: intentNodeId,
      to: escalateNodeId,
      type: 'error',
      label: 'escalation',
    });
  }

  // Exit node
  nodes.push({
    id: '__exit__',
    type: 'exit',
    label: 'End',
    deterministic: true,
  });

  return {
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}

/**
 * Generate graph for reasoning agents with tools
 */
function generateReasoningGraph(agentName: string, ir?: Record<string, unknown>): StaticGraph {
  const nodes: StaticGraphNode[] = [];
  const edges: StaticGraphEdge[] = [];

  // Entry node
  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  // Main reasoning node
  const reasoningId = '__reasoning__';
  const tools = ir?.tools as Array<{ name: string; description?: string }> | undefined;

  nodes.push({
    id: reasoningId,
    type: 'llm_decision',
    label: agentName,
    deterministic: false,
    conditions: tools?.map((t) => t.name) || [],
  });

  edges.push({
    id: '__entry__->reasoning',
    from: '__entry__',
    to: reasoningId,
    type: 'sequential',
  });

  // Add tool nodes
  if (tools) {
    for (const tool of tools) {
      const toolNodeId = `__tool_${tool.name}__`;
      nodes.push({
        id: toolNodeId,
        type: 'step',
        label: tool.name,
        deterministic: true,
        step: {
          call: tool.name,
        },
      });

      // Bidirectional edges for tool usage
      edges.push({
        id: `${reasoningId}->${toolNodeId}`,
        from: reasoningId,
        to: toolNodeId,
        type: 'digression',
        label: tool.name,
      });

      edges.push({
        id: `${toolNodeId}->${reasoningId}`,
        from: toolNodeId,
        to: reasoningId,
        type: 'sequential',
        label: 'result',
      });
    }
  }

  // Add handoff nodes if coordination exists
  const coordination = ir?.coordination as Record<string, unknown> | undefined;
  const handoffs = coordination?.handoffs as Array<{ to: string; when: string }> | undefined;

  if (handoffs) {
    for (const handoff of handoffs) {
      const handoffNodeId = `__handoff_${handoff.to}__`;
      nodes.push({
        id: handoffNodeId,
        type: 'step',
        label: `→ ${handoff.to}`,
        deterministic: true,
      });

      edges.push({
        id: `${reasoningId}->${handoffNodeId}`,
        from: reasoningId,
        to: handoffNodeId,
        type: 'digression',
        label: handoff.when,
      });
    }
  }

  // Exit node
  nodes.push({
    id: '__exit__',
    type: 'exit',
    label: 'End',
    deterministic: true,
  });

  edges.push({
    id: `${reasoningId}->exit`,
    from: reasoningId,
    to: '__exit__',
    type: 'sequential',
    label: 'complete',
  });

  return {
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}
