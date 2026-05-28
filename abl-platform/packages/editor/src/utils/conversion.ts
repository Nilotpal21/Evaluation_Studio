/**
 * Conversion utilities - Transform between ABL documents and React Flow nodes
 */

import type {
  DSLNode,
  DSLEdge,
  SupervisorNodeData,
  AgentNodeData,
  StepNodeData,
  RoutingRuleNodeData,
  ToolNodeData,
  GuardrailNodeData,
  BaseNodeData,
} from '../types.js';

// Generic document interfaces for compatibility
interface SupervisorDocLike {
  name?: string;
  state?: Record<string, unknown>;
  agents?: Array<{ name?: string; path?: string; tags?: string[] }>;
  routing?: Array<{
    priority: number;
    condition?: unknown;
    target?: string;
    flags?: string[];
  }>;
  intents?: unknown[];
  communication?: { language?: string; formality?: string };
}

interface AgentDocLike {
  name?: string;
  identity?: { role?: string; expertise?: string[] };
  contract?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
  tools?: Array<{
    name?: string;
    parameters?: Array<{ name: string; type: unknown }>;
    returnType?: unknown;
  }>;
  flow?: Array<{
    number?: string;
    name?: string;
    action?: { type?: string; message?: string; tool?: string; variable?: string };
  }>;
  guardrails?: Array<{
    name?: string;
    type?: 'input' | 'output' | 'behavioral';
    action?: 'block' | 'warn' | 'redact';
  }>;
}

/**
 * Convert a supervisor document to React Flow nodes
 */
export function supervisorToNodes(
  supervisor: SupervisorDocLike,
  basePosition = { x: 100, y: 100 },
): { nodes: DSLNode[]; edges: DSLEdge[] } {
  const nodes: DSLNode[] = [];
  const edges: DSLEdge[] = [];

  const supervisorName = supervisor.name || 'Supervisor';
  const supervisorId = `supervisor-${supervisorName.toLowerCase().replace(/\s+/g, '-')}`;

  // Main supervisor node
  const supervisorNode: DSLNode = {
    id: supervisorId,
    type: 'supervisor',
    position: basePosition,
    data: {
      type: 'supervisor',
      label: supervisorName,
      description: 'Main supervisor orchestrator',
      document: supervisor,
    } as SupervisorNodeData,
  };
  nodes.push(supervisorNode);

  // Agent reference nodes
  if (supervisor.agents) {
    supervisor.agents.forEach((agent, index) => {
      const agentName = agent.name || `Agent ${index}`;
      const agentNode: DSLNode = {
        id: `agent-ref-${agentName.toLowerCase().replace(/\s+/g, '-')}`,
        type: 'agent',
        position: {
          x: basePosition.x + 400,
          y: basePosition.y + index * 200,
        },
        data: {
          type: 'agent',
          label: agentName,
          agentId: agentName,
          description: agent.tags?.join(', '),
        } as AgentNodeData,
      };
      nodes.push(agentNode);

      // Edge from supervisor to agent
      edges.push({
        id: `e-sup-${agentName}`,
        source: supervisorNode.id,
        target: agentNode.id,
        data: { type: 'agent-reference' },
      });
    });
  }

  // Routing rule nodes
  if (supervisor.routing) {
    supervisor.routing.forEach((rule, index) => {
      const ruleNode: DSLNode = {
        id: `routing-${index}`,
        type: 'routing-rule',
        position: {
          x: basePosition.x + 200,
          y: basePosition.y + 100 + index * 120,
        },
        data: {
          type: 'routing-rule',
          label: `Route ${rule.priority}`,
          priority: rule.priority,
          condition: formatCondition(rule.condition),
          target: rule.target || '',
          flags: rule.flags,
        } as RoutingRuleNodeData,
      };
      nodes.push(ruleNode);
    });
  }

  return { nodes, edges };
}

/**
 * Convert an agent document to React Flow nodes
 */
export function agentToNodes(
  agent: AgentDocLike,
  basePosition = { x: 100, y: 100 },
): { nodes: DSLNode[]; edges: DSLEdge[] } {
  const nodes: DSLNode[] = [];
  const edges: DSLEdge[] = [];

  const agentName = agent.name || 'Agent';
  const agentId = agentName.toLowerCase().replace(/\s+/g, '-');

  // Main agent node
  const agentNode: DSLNode = {
    id: `agent-${agentId}`,
    type: 'agent',
    position: basePosition,
    data: {
      type: 'agent',
      label: agentName,
      agentId: agentName,
      description: agent.identity?.role,
      document: agent,
    } as AgentNodeData,
  };
  nodes.push(agentNode);

  // Step nodes
  if (agent.flow && Array.isArray(agent.flow)) {
    agent.flow.forEach((step, index) => {
      const stepNumber = step.number || String(index + 1);
      const stepNode: DSLNode = {
        id: `step-${agentId}-${stepNumber}`,
        type: 'step',
        position: {
          x: basePosition.x + 300,
          y: basePosition.y + index * 150,
        },
        data: {
          type: 'step',
          label: step.name || `Step ${stepNumber}`,
          stepNumber: stepNumber,
          action: (step.action?.type as StepNodeData['action']) || 'RESPOND',
          content: getStepContent(step),
          agentId: agentName,
        } as StepNodeData,
      };
      nodes.push(stepNode);

      // Edge from previous step or agent
      if (index === 0) {
        edges.push({
          id: `e-${agentId}-start`,
          source: agentNode.id,
          target: stepNode.id,
          sourceHandle: 'steps',
          data: { type: 'step-flow' },
        });
      } else {
        const prevStep = agent.flow![index - 1];
        const prevStepNumber = prevStep.number || String(index);
        const prevStepId = `step-${agentId}-${prevStepNumber}`;
        edges.push({
          id: `e-${prevStepId}-${stepNode.id}`,
          source: prevStepId,
          target: stepNode.id,
          data: { type: 'step-flow' },
        });
      }
    });
  }

  // Tool nodes
  if (agent.tools) {
    agent.tools.forEach((tool, index) => {
      const toolName = tool.name || `Tool ${index}`;
      const toolNode: DSLNode = {
        id: `tool-${agentId}-${toolName}`,
        type: 'tool',
        position: {
          x: basePosition.x - 200,
          y: basePosition.y + 100 + index * 120,
        },
        data: {
          type: 'tool',
          label: toolName,
          toolName: toolName,
          parameters:
            tool.parameters?.map((p) => ({
              name: p.name,
              type: typeof p.type === 'string' ? p.type : 'any',
            })) || [],
          returnType: typeof tool.returnType === 'string' ? tool.returnType : undefined,
          agentId: agentName,
        } as ToolNodeData,
      };
      nodes.push(toolNode);
    });
  }

  // Guardrail nodes
  if (agent.guardrails) {
    agent.guardrails.forEach((guardrail, index) => {
      const guardrailName = guardrail.name || `Guardrail ${index}`;
      const guardNode: DSLNode = {
        id: `guard-${agentId}-${guardrailName}`,
        type: 'guardrail',
        position: {
          x: basePosition.x - 200,
          y: basePosition.y + 300 + index * 100,
        },
        data: {
          type: 'guardrail',
          label: guardrailName,
          guardrailName: guardrailName,
          guardrailType: guardrail.type || 'input',
          action: guardrail.action || 'warn',
        } as GuardrailNodeData,
      };
      nodes.push(guardNode);
    });
  }

  return { nodes, edges };
}

/**
 * Convert React Flow nodes back to ABL documents
 */
export function nodesToDocuments(
  nodes: DSLNode[],
  edges: DSLEdge[],
): { supervisor?: SupervisorDocLike; agents: AgentDocLike[] } {
  const supervisor = nodes.find((n) => n.type === 'supervisor');
  const agentNodes = nodes.filter((n) => n.type === 'agent');

  // Build supervisor document
  let supervisorDoc: SupervisorDocLike | undefined;
  if (supervisor) {
    const data = supervisor.data as SupervisorNodeData;
    supervisorDoc = (data.document as SupervisorDocLike) || {
      name: data.label,
      state: {},
      agents: [],
      routing: [],
    };
  }

  // Build agent documents
  const agents: AgentDocLike[] = agentNodes
    .filter((n) => (n.data as AgentNodeData).document)
    .map((n) => (n.data as AgentNodeData).document as AgentDocLike);

  return { supervisor: supervisorDoc, agents };
}

// Helper functions

function formatCondition(condition: unknown): string {
  if (typeof condition === 'string') {
    return condition;
  }
  if (condition && typeof condition === 'object') {
    const cond = condition as Record<string, unknown>;
    if (cond.type === 'wildcard') {
      return '*';
    }
    if (cond.type === 'comparison') {
      return `${cond.left} ${cond.operator} ${cond.right}`;
    }
  }
  return JSON.stringify(condition);
}

function getStepContent(step: {
  action?: { type?: string; message?: string; tool?: string; variable?: string };
}): string {
  if (step.action?.type === 'RESPOND') {
    return step.action.message || '';
  }
  if (step.action?.type === 'CALL') {
    return `${step.action.tool}(...)`;
  }
  if (step.action?.type === 'SET') {
    return `${step.action.variable} = ...`;
  }
  return '';
}
