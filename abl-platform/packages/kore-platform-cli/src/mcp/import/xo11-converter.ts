/**
 * Kore.ai XO11 Converter
 *
 * Converts XO11 dialog flow exports to ABL projects.
 * Maps dialog flows to agents, entity nodes to GATHER fields,
 * webhook nodes to TOOLS, and transitions to FLOW steps.
 */

import type {
  ImportAnalysis,
  ImportConvertResult,
  XO11Export,
  XO11DialogFlow,
  XO11EntityNode,
  XO11WebhookNode,
  XO11MessageNode,
  XO11ScriptNode,
} from './types.js';
import type {
  ArchitectureSpec,
  AgentSpec,
  SupervisorSpec,
  ToolSpec,
  GatherFieldSpec,
  FlowStepSpec,
  HandoffSpec,
  MemorySpec,
  ErrorHandlerSpec,
} from '../architect/types.js';
import { scaffoldProject } from '../architect/scaffold.js';
import { toAgentName, toToolName, toFieldName, inferType, extractBrief } from './mapping.js';

// =============================================================================
// MAIN CONVERTER
// =============================================================================

/**
 * Convert an XO11 export to an ABL project.
 */
export async function convertXO11(
  data: unknown,
  analysis: ImportAnalysis,
  outputDir: string,
): Promise<ImportConvertResult> {
  const xo11 = data as XO11Export;
  const dialogFlows = xo11.dialogFlows || xo11.dialogTasks || [];

  // Convert each dialog flow to an agent
  const agentSpecs: AgentSpec[] = [];
  for (const flow of dialogFlows) {
    const spec = convertDialogFlow(flow);
    agentSpecs.push(spec);
  }

  // Build supervisor if multiple flows
  let supervisorSpec: SupervisorSpec | undefined;
  if (agentSpecs.length > 1) {
    supervisorSpec = buildXO11Supervisor(agentSpecs, dialogFlows);
  }

  // Build architecture spec
  const architectureSpec: ArchitectureSpec = {
    projectName: 'xo11-imported',
    description: `Imported from Kore.ai XO11 with ${agentSpecs.length} dialog flow(s)`,
    topology: supervisorSpec ? 'supervisor' : 'single-agent',
    gapReport: analysis.gapReport,
  };

  if (architectureSpec.topology === 'single-agent' && agentSpecs.length === 1) {
    architectureSpec.agent = agentSpecs[0];
  } else if (supervisorSpec) {
    architectureSpec.supervisor = supervisorSpec;
    architectureSpec.agents = agentSpecs;
  }

  // Scaffold the project
  const result = scaffoldProject(architectureSpec, outputDir);

  return {
    ...result,
    gapReport: analysis.gapReport,
  };
}

// =============================================================================
// DIALOG FLOW CONVERSION
// =============================================================================

function convertDialogFlow(flow: XO11DialogFlow): AgentSpec {
  const name = toAgentName(flow.name);
  const tools: ToolSpec[] = [];
  const gather: GatherFieldSpec[] = [];
  const flowSteps: Record<string, FlowStepSpec> = {};
  const stepOrder: string[] = [];

  // Process nodes
  for (const node of flow.nodes || []) {
    if (isWebhookNode(node)) {
      // Webhook -> TOOL
      tools.push(convertWebhookToTool(node as XO11WebhookNode));
    } else if (isScriptNode(node)) {
      // Script -> TOOL (gap)
      tools.push({
        name: toToolName(node.name),
        description: `Custom logic (converted from XO11 script node)`,
        parameters: [{ name: 'input', type: 'object', required: true }],
        returns: 'object',
      });
    } else if (isEntityNode(node)) {
      // Entity -> GATHER field
      const entityNode = node as XO11EntityNode;
      gather.push({
        name: toFieldName(entityNode.name),
        prompt: entityNode.prompt || `Please provide ${entityNode.name}`,
        type: inferType(entityNode.type),
        required: entityNode.required ?? true,
      });
    } else if (isMessageNode(node)) {
      // Message -> FLOW step with RESPOND
      const msgNode = node as XO11MessageNode;
      const stepName = toFieldName(msgNode.name) + '_step';
      stepOrder.push(stepName);
      flowSteps[stepName] = {
        name: stepName,
        respond: msgNode.message || '',
      };
    }
  }

  // Process transitions to link flow steps
  for (const transition of flow.transitions || []) {
    const fromStep = toFieldName(transition.from) + '_step';
    const toStep = toFieldName(transition.to) + '_step';
    if (flowSteps[fromStep]) {
      flowSteps[fromStep].then = toStep;
    }
  }

  // Build a scripted flow if we have steps
  const hasFlow = stepOrder.length > 0;

  // If we have gather fields but no explicit flow, create a gather step
  if (!hasFlow && gather.length > 0) {
    const gatherStep = 'collect_info';
    const processStep = 'process';
    stepOrder.push(gatherStep, processStep);
    flowSteps[gatherStep] = {
      name: gatherStep,
      gather: { fields: gather },
      then: processStep,
    };
    flowSteps[processStep] = {
      name: processStep,
      respond: 'Processing your request...',
    };
    if (tools.length > 0) {
      flowSteps[processStep].call = tools[0].name;
    }
  }

  const memory: MemorySpec = {
    session: ['conversation_context'],
    persistent: [],
  };

  const errorHandlers: ErrorHandlerSpec[] = [
    {
      type: 'tool_error',
      respond: 'I encountered an issue. Let me try again.',
      retry: 1,
      then: 'CONTINUE',
    },
  ];

  return {
    name,
    // mode removed — derived from flow presence
    goal: flow.intent ? `Handle ${flow.intent} requests` : `Handle ${flow.name} tasks`,
    persona: `Specialist for ${flow.name} tasks. Helpful and efficient.`,
    limitations: [],
    tools,
    gather: hasFlow ? [] : gather, // Gather is in flow steps for scripted mode
    memory,
    constraints: [],
    guardrails: [],
    flow: hasFlow ? { steps: stepOrder, definitions: flowSteps } : undefined,
    delegate: [],
    handoff: [],
    errorHandlers,
    complete: [{ when: 'task_completed == true', respond: 'Task completed.' }],
  };
}

// =============================================================================
// SUPERVISOR BUILDING
// =============================================================================

function buildXO11Supervisor(agents: AgentSpec[], flows: XO11DialogFlow[]): SupervisorSpec {
  const handoffs: HandoffSpec[] = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const flow = flows[i];
    const intent = flow?.intent;

    handoffs.push({
      to: agent.name,
      when: intent
        ? `intent contains "${intent}"`
        : `intent.category == "${agent.name.toLowerCase()}"`,
      pass: ['conversation_context'],
      summary: agent.goal,
      return: false,
    });
  }

  return {
    name: 'Supervisor',
    goal: 'Route user requests to the appropriate specialist agent',
    persona:
      'Intelligent supervisor that understands user intent and delegates to the right specialist.',
    limitations: ['Cannot handle tasks directly - must delegate to specialist agents'],
    memory: {
      session: ['current_intent', 'routing_history'],
      persistent: [],
    },
    handoff: handoffs,
    escalation: {
      triggers: [
        {
          when: 'routing_failures >= 3',
          reason: 'Multiple routing failures',
          priority: 'high',
        },
      ],
      contextForHuman: ['conversation_history'],
    },
    errorHandlers: [
      {
        type: 'routing_failure',
        respond: "I'm having trouble. Let me try again.",
        retry: 1,
        then: 'ESCALATE',
      },
    ],
    complete: [
      {
        when: 'handoff_successful == true',
        respond: "I've connected you with the right specialist.",
      },
    ],
  };
}

// =============================================================================
// NODE TYPE GUARDS
// =============================================================================

function isWebhookNode(node: unknown): boolean {
  return typeof node === 'object' && node !== null && 'url' in node;
}

function isScriptNode(node: unknown): boolean {
  return typeof node === 'object' && node !== null && 'script' in node;
}

function isEntityNode(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    ('prompt' in node || 'patterns' in node) &&
    !('url' in node) &&
    !('script' in node) &&
    !('message' in node)
  );
}

function isMessageNode(node: unknown): boolean {
  return typeof node === 'object' && node !== null && 'message' in node && !('url' in node);
}

// =============================================================================
// WEBHOOK -> TOOL CONVERSION
// =============================================================================

function convertWebhookToTool(node: XO11WebhookNode): ToolSpec {
  return {
    name: toToolName(node.name),
    description: `Webhook call to ${node.url || 'external service'}`,
    parameters: [{ name: 'input', type: 'object', required: true }],
    returns: 'object',
  };
}
