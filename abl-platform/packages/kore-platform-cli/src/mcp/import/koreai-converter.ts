/**
 * Kore.ai Agent Platform (v12) Converter
 *
 * Converts Agent Platform v12 multi-agent system JSON exports to ABL projects.
 * Handles agents, tools, supervisor routing, memory, and gap detection.
 */

import type {
  ImportAnalysis,
  ImportConvertResult,
  AgentPlatformExport,
  AgentPlatformAgent,
  AgentPlatformTool,
  AgentPlatformMCPServer,
} from './types.js';
import type {
  ArchitectureSpec,
  AgentSpec,
  SupervisorSpec,
  ToolSpec,
  ToolParamSpec,
  HandoffSpec,
  MemorySpec,
  ErrorHandlerSpec,
} from '../architect/types.js';
import { scaffoldProject } from '../architect/scaffold.js';
import {
  toAgentName,
  toToolName,
  toFieldName,
  inferType,
  extractBrief,
  parseStepsFromPrompt,
  parseConstraintsFromPrompt,
  parseGuardrailsFromPrompt,
  extractMemoryReferences,
  extractToolCalls,
  parseLevelBasedRouting,
  detectLanguageFromPrompt,
} from './mapping.js';
import { buildPromptParsingPrompt, buildRoutingParsingPrompt } from '../architect/prompts.js';

// =============================================================================
// MAIN CONVERTER
// =============================================================================

/**
 * Convert an Agent Platform v12 export to an ABL project.
 */
export async function convertAgentPlatform(
  data: AgentPlatformExport,
  analysis: ImportAnalysis,
  outputDir: string,
): Promise<ImportConvertResult> {
  // Build tool registry from MCPServers
  const toolRegistry = buildToolRegistry(data.MCPServers);

  // Convert each agent
  const agentSpecs: AgentSpec[] = [];
  for (const agent of data.agents || []) {
    const spec = await convertAgent(agent, toolRegistry);
    agentSpecs.push(spec);
  }

  // Build supervisor if orchestration exists
  let supervisorSpec: SupervisorSpec | undefined;
  if (data.app?.orchestrationPrompt?.custom && agentSpecs.length > 1) {
    supervisorSpec = await convertSupervisor(
      data.app.orchestrationPrompt.custom,
      agentSpecs.map((a) => a.name),
      data.app,
    );
  }

  // Build architecture spec
  const architectureSpec: ArchitectureSpec = {
    projectName: sanitizeProjectName(data.app?.name || 'imported-project'),
    description:
      data.app?.description ||
      `Imported from Kore.ai Agent Platform v12 with ${agentSpecs.length} agents`,
    topology: supervisorSpec
      ? 'supervisor'
      : agentSpecs.length > 1
        ? 'adaptive-network'
        : 'single-agent',
    gapReport: analysis.gapReport,
  };

  if (architectureSpec.topology === 'single-agent' && agentSpecs.length === 1) {
    architectureSpec.agent = agentSpecs[0];
  } else if (architectureSpec.topology === 'supervisor') {
    architectureSpec.supervisor = supervisorSpec;
    architectureSpec.agents = agentSpecs;
  } else {
    architectureSpec.entryAgent = agentSpecs[0]?.name;
    architectureSpec.networkAgents = agentSpecs;
  }

  // Scaffold the project
  const result = scaffoldProject(architectureSpec, outputDir);

  return {
    ...result,
    gapReport: analysis.gapReport,
  };
}

/**
 * Main entry point called from server.ts
 */
export async function convertImport(
  analysis: ImportAnalysis,
  sourceJson: unknown,
  outputDir: string,
): Promise<ImportConvertResult> {
  if (analysis.format === 'agent-platform') {
    return convertAgentPlatform(sourceJson as AgentPlatformExport, analysis, outputDir);
  } else if (analysis.format === 'xo11') {
    // Import XO11 converter dynamically
    const { convertXO11 } = await import('./xo11-converter.js');
    return convertXO11(sourceJson, analysis, outputDir);
  } else {
    throw new Error(`Unsupported import format: ${analysis.format}`);
  }
}

// =============================================================================
// TOOL REGISTRY
// =============================================================================

function buildToolRegistry(mcpServers: AgentPlatformMCPServer[]): Map<string, ToolSpec> {
  const registry = new Map<string, ToolSpec>();

  for (const server of mcpServers || []) {
    for (const tool of server.tools || []) {
      const spec = convertTool(tool);
      registry.set(tool.name, spec);
    }
  }

  return registry;
}

function convertTool(tool: AgentPlatformTool): ToolSpec {
  const params: ToolParamSpec[] = (tool.properties || []).map((prop) => ({
    name: toFieldName(prop.name || prop.property || 'param'),
    type: inferType(prop.type),
    required: prop.required ?? false,
    description: prop.description,
  }));

  return {
    name: toToolName(tool.name),
    description: tool.description || tool.name,
    parameters: params,
    returns: 'object',
  };
}

// =============================================================================
// AGENT CONVERSION
// =============================================================================

async function convertAgent(
  agent: AgentPlatformAgent,
  toolRegistry: Map<string, ToolSpec>,
): Promise<AgentSpec> {
  const name = toAgentName(agent.name);

  // Resolve tools (handles both string refs and {name, type} objects)
  const tools: ToolSpec[] = [];
  for (const toolRef of agent.tools || []) {
    const toolName = typeof toolRef === 'string' ? toolRef : toolRef.name;
    const toolSpec = toolRegistry.get(toolName);
    if (toolSpec) {
      tools.push(toolSpec);
    }
  }

  // Parse prompt to extract structure
  let goal = `Handle ${agent.name} tasks`;
  let persona = '';
  let limitations: string[] = [];
  let constraints: AgentSpec['constraints'] = [];
  let guardrails: AgentSpec['guardrails'] = [];
  let mode: 'reasoning' | 'scripted' = 'reasoning';
  let flow: AgentSpec['flow'] = undefined;
  let language: string | undefined;

  const promptText = agent.prompt?.custom || '';

  if (promptText) {
    // Basic goal/persona extraction
    const parsed = parsePromptLocally(agent.name, promptText);
    goal = parsed.goal || goal;
    persona = parsed.persona || persona;

    // --- Enhanced extraction ---

    // 1. Extract STEP sequences → FLOW (sets mode to scripted)
    const stepResult = parseStepsFromPrompt(promptText);
    if (stepResult && stepResult.steps.length >= 2) {
      mode = 'scripted';
      const definitions: Record<string, (typeof stepResult.steps)[0]> = {};
      for (const step of stepResult.steps) {
        definitions[step.name] = step;
      }
      flow = {
        steps: stepResult.stepOrder,
        definitions,
      };
    }

    // 2. Extract NEVER/MUST → CONSTRAINTS (not limitations)
    const extractedConstraints = parseConstraintsFromPrompt(promptText);
    if (extractedConstraints.length > 0) {
      constraints = extractedConstraints;
    }

    // 3. Remaining unstructured limitation lines (not already in constraints)
    const constraintConditions = new Set(constraints.map((c) => c.condition));
    limitations = parsed.limitations.filter((l) => !constraintConditions.has(l));

    // 4. Extract channel/role/mask → GUARDRAILS
    guardrails = parseGuardrailsFromPrompt(promptText);

    // 5. Extract {{memory.X}} → MEMORY
    const extractedMemory = extractMemoryReferences(promptText);

    // 6. Detect language directive
    language = detectLanguageFromPrompt(promptText);
  }

  // Extract instructions as limitations (only non-constraint items)
  if (agent.prompt?.instructions) {
    for (const instr of agent.prompt.instructions) {
      if (instr.text) {
        limitations.push(instr.text);
      }
    }
  }

  // Build memory spec (merge extracted memory refs with defaults)
  const extractedMem = promptText
    ? extractMemoryReferences(promptText)
    : { session: [], persistent: [] };
  const memory: MemorySpec = {
    session: [...new Set(['conversation_context', ...extractedMem.session])],
    persistent: [...new Set(extractedMem.persistent)],
  };

  // Default error handlers
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
    mode,
    language,
    goal,
    persona,
    limitations,
    tools,
    gather: [],
    memory,
    constraints,
    guardrails,
    flow,
    delegate: [],
    handoff: [],
    errorHandlers,
    complete: [{ when: 'task_completed == true', respond: 'Task completed successfully.' }],
  };
}

// =============================================================================
// SUPERVISOR CONVERSION
// =============================================================================

async function convertSupervisor(
  orchestrationText: string,
  agentNames: string[],
  app: AgentPlatformExport['app'],
): Promise<SupervisorSpec> {
  const ablAgentNames = agentNames.map(toAgentName);

  // Try LEVEL-based routing first (structured), fall back to basic parsing
  let handoffs = parseLevelBasedRouting(orchestrationText, ablAgentNames);
  if (handoffs.length === 0) {
    handoffs = parseRoutingLocally(orchestrationText, ablAgentNames);
  }

  // Extract constraints and guardrails from orchestration text
  const constraints = parseConstraintsFromPrompt(orchestrationText);
  const guardrails = parseGuardrailsFromPrompt(orchestrationText);

  // Build memory from app memory stores + extracted references
  const extractedMem = extractMemoryReferences(orchestrationText);
  const memory: MemorySpec = {
    session: [...new Set(['current_intent', 'routing_history', ...extractedMem.session])],
    persistent: [...new Set(extractedMem.persistent)],
  };
  for (const store of app.memoryStores || []) {
    const storeName =
      store.memoryStoreName || store.name || store.technicalMemoryKey || 'unnamed_store';
    if (!memory.persistent.includes(storeName)) {
      memory.persistent.push(storeName);
    }
  }

  // Build limitations from constraints not captured structurally
  const limitations: string[] = [
    'Cannot handle tasks directly - must delegate to specialist agents',
    'Cannot process data or make changes without delegating',
  ];

  return {
    name: 'Supervisor',
    goal: 'Route user requests to the appropriate specialist agent based on intent analysis',
    persona:
      'Intelligent routing supervisor that quickly understands user needs and delegates to the right specialist.',
    limitations,
    memory,
    handoff: handoffs,
    escalation: {
      triggers: [
        {
          when: 'routing_failures >= 3',
          reason: 'Multiple routing failures',
          priority: 'high',
        },
        {
          when: 'user.frustration_detected == true',
          reason: 'User showing frustration',
          priority: 'high',
        },
      ],
      contextForHuman: ['conversation_history', 'routing_history'],
    },
    errorHandlers: [
      {
        type: 'routing_failure',
        respond: "I'm having trouble understanding your request. Let me try again.",
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
// LOCAL PARSING (no LLM required)
// =============================================================================

/**
 * Parse a prompt text locally to extract goal, persona, and remaining limitations.
 * Constraint extraction is now handled by parseConstraintsFromPrompt() in mapping.ts.
 * This function focuses on goal/persona identification and collecting
 * lines that aren't structured constraints.
 */
function parsePromptLocally(
  agentName: string,
  promptText: string,
): {
  goal: string;
  persona: string;
  limitations: string[];
  constraints: AgentSpec['constraints'];
} {
  const lines = promptText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);
  let goal = '';
  let persona = '';
  const limitations: string[] = [];

  // First non-empty line or first sentence is often the goal
  if (lines.length > 0) {
    const firstLine = lines[0];
    // If it starts with "You are" or "Your role", extract persona + goal
    if (firstLine.match(/^(you are|your role|as an?)/i)) {
      persona = firstLine;
      goal = lines.length > 1 ? extractBrief(lines[1]) : `Handle ${agentName} tasks`;
    } else {
      goal = extractBrief(firstLine);
    }
  }

  // Collect remaining lines that are behavioral limitations (not structural constraints)
  // Structural constraints (NEVER/MUST NOT/ALWAYS/MUST) are now extracted by parseConstraintsFromPrompt
  for (const line of lines) {
    // Skip lines that will be captured as constraints
    if (
      line.match(
        /^(never|must not|do not|don't|forbidden to|cannot|should not|must\b|always|ensure|strictly|required to)/i,
      )
    ) {
      // These go to limitations as a fallback — the caller will deduplicate
      limitations.push(line);
    }
  }

  return {
    goal,
    persona,
    limitations: limitations.slice(0, 10),
    constraints: [], // Constraints are now extracted by parseConstraintsFromPrompt()
  };
}

/**
 * Parse routing rules from orchestration text locally.
 * Extracts patterns like "if user asks about X, route to Agent_Y"
 */
function parseRoutingLocally(orchestrationText: string, agentNames: string[]): HandoffSpec[] {
  const handoffs: HandoffSpec[] = [];
  const lines = orchestrationText.split('\n');

  // Try to match each agent to routing conditions
  for (const agentName of agentNames) {
    const nameParts = agentName.toLowerCase().split('_');

    // Search for mentions of this agent in the orchestration text
    const relevantLines: string[] = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      // Check if the line mentions any part of the agent name
      if (nameParts.some((part) => part.length > 3 && lower.includes(part))) {
        relevantLines.push(line.trim());
      }
    }

    if (relevantLines.length > 0) {
      // Extract a condition from the relevant lines
      const condition = extractCondition(relevantLines, agentName);
      handoffs.push({
        to: agentName,
        when: condition,
        pass: ['conversation_context'],
        summary: extractBrief(relevantLines[0]),
        return: false,
      });
    }
  }

  // If no routing rules were found, create basic intent-based routing
  if (handoffs.length === 0) {
    for (const agentName of agentNames) {
      handoffs.push({
        to: agentName,
        when: `intent.category == "${agentName.toLowerCase()}"`,
        pass: ['conversation_context'],
        summary: `Route to ${agentName}`,
        return: false,
      });
    }
  }

  return handoffs;
}

/**
 * Extract a routing condition from context lines
 */
function extractCondition(lines: string[], agentName: string): string {
  // Look for "if", "when", "for" patterns
  for (const line of lines) {
    const ifMatch = line.match(
      /(?:if|when|for)\s+(?:the\s+)?(?:user\s+)?(?:asks?\s+)?(?:about\s+)?(.+?)(?:,|\.|$)/i,
    );
    if (ifMatch) {
      const condition = ifMatch[1].trim().replace(/['"]/g, '');
      return `intent contains "${condition}"`;
    }
  }

  // Fallback: use agent name as intent category
  return `intent.category == "${agentName.toLowerCase()}"`;
}

// =============================================================================
// UTILITIES
// =============================================================================

function sanitizeProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '') || 'imported-project'
  );
}
