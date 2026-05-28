/**
 * ABL Generator - converts extracted structures to Agent Blueprint Language text
 */

import type {
  AgentExtraction,
  SupervisorExtraction,
  InferredTool,
  ExtractedStep,
} from './types.js';

/**
 * Generate Agent ABL from extraction
 */
export function generateAgentABL(extraction: AgentExtraction): string {
  const lines: string[] = [];

  // AGENT header
  lines.push(`AGENT: ${extraction.agent_name}`);
  lines.push('');

  // MODE removed — execution style derived from flow presence
  const hasFlow = extraction.steps.length > 0;

  // GOAL
  lines.push(`GOAL: "${extraction.description}"`);
  lines.push('');

  // PERSONA
  if (extraction.identity.persona || extraction.identity.role) {
    lines.push('PERSONA: |');
    if (extraction.identity.role) {
      lines.push(`  ${extraction.identity.role}`);
    }
    if (extraction.identity.persona) {
      lines.push(`  ${extraction.identity.persona}`);
    }
    if (extraction.identity.expertise.length > 0) {
      lines.push(`  Expert in: ${extraction.identity.expertise.join(', ')}`);
    }
    lines.push('');
  }

  // LIMITATIONS
  if (extraction.identity.limitations.length > 0) {
    lines.push('LIMITATIONS:');
    for (const limitation of extraction.identity.limitations) {
      lines.push(`  - "${limitation}"`);
    }
    lines.push('');
  }

  // TOOLS
  if (extraction.inferred_tools.length > 0) {
    lines.push('TOOLS:');
    for (const tool of extraction.inferred_tools) {
      lines.push(generateToolABL(tool));
    }
    lines.push('');
  }

  // GATHER - from steps that wait for input
  const gatherSteps = extraction.steps.filter((s) => s.action_type === 'wait_input');
  if (gatherSteps.length > 0) {
    lines.push('GATHER:');
    for (const step of gatherSteps) {
      const fieldName = step.name.toLowerCase().replace(/\s+/g, '_');
      lines.push(`  ${fieldName}:`);
      lines.push(`    prompt: "${step.description}"`);
      lines.push(`    type: string`);
      lines.push(`    required: true`);
    }
    lines.push('');
  }

  // MEMORY - generate memory section if we have state-related steps
  const setSteps = extraction.steps.filter((s) => s.action_type === 'set_state');
  if (setSteps.length > 0) {
    lines.push('MEMORY:');
    lines.push('  session:');
    for (const step of setSteps) {
      const varName = step.action_details.variable || step.name.toLowerCase().replace(/\s+/g, '_');
      lines.push(`    - ${varName}`);
    }
    lines.push('');
  }

  // CONSTRAINTS - from guardrails that are behavioral checks
  const constraintGuardrails = extraction.guardrails.filter((g) => g.type === 'behavioral');
  if (constraintGuardrails.length > 0) {
    lines.push('CONSTRAINTS:');
    lines.push('  validation:');
    for (const guardrail of constraintGuardrails) {
      lines.push(`    - REQUIRE: ${guardrail.check}`);
      lines.push(`      ON_FAIL: "${guardrail.name}"`);
    }
    lines.push('');
  }

  // GUARDRAILS - from input/output guardrails
  const ioGuardrails = extraction.guardrails.filter(
    (g) => g.type === 'input' || g.type === 'output',
  );
  if (ioGuardrails.length > 0) {
    lines.push('GUARDRAILS:');
    for (const guardrail of ioGuardrails) {
      lines.push(`  - name: ${guardrail.name}`);
      lines.push(`    kind: ${guardrail.type}`);
      lines.push(`    check: ${guardrail.check}`);
      lines.push(`    action: ${guardrail.action}`);
    }
    lines.push('');
  }

  // FLOW - for scripted mode with actual flow steps
  const flowSteps = extraction.steps.filter(
    (s) => s.action_type !== 'wait_input' && s.action_type !== 'set_state',
  );
  if (hasFlow && flowSteps.length > 0) {
    lines.push('FLOW:');
    lines.push(
      `  STEPS: [${flowSteps.map((s) => s.name.toLowerCase().replace(/\s+/g, '_')).join(', ')}]`,
    );
    lines.push('');

    for (const step of flowSteps) {
      lines.push(generateFlowStepABL(step));
    }
  }

  // ESCALATE - from guardrails with escalation actions
  const escalateGuardrails = extraction.guardrails.filter((g) => g.action === 'block');
  if (escalateGuardrails.length > 0) {
    lines.push('ESCALATE:');
    lines.push('  triggers:');
    for (const guardrail of escalateGuardrails) {
      lines.push(`    - WHEN: ${guardrail.check}`);
      lines.push(`      REASON: "${guardrail.name}"`);
      lines.push('      PRIORITY: high');
    }
    lines.push('  context_for_human:');
    lines.push('    - conversation_summary');
    lines.push('    - collected_data');
    lines.push('  on_human_complete:');
    lines.push('    - WHEN: resolved == true');
    lines.push('      RESPOND: "Thank you for your patience. The issue has been resolved."');
    lines.push('');
  }

  // ON_ERROR - generate default error handlers
  lines.push('ON_ERROR:');
  lines.push('  - TYPE: tool_error');
  lines.push('    RESPOND: "I encountered an issue. Let me try again."');
  lines.push('    RETRY: 2');
  lines.push('  - TYPE: invalid_input');
  lines.push('    RESPOND: "I didn\'t quite understand that. Could you please rephrase?"');
  lines.push('');

  // COMPLETE
  lines.push('COMPLETE:');
  const completeSteps = extraction.steps.filter((s) => s.action_type === 'signal');
  if (completeSteps.length > 0) {
    for (const step of completeSteps) {
      const when = step.action_details.when || 'task_complete == true';
      const message = step.action_details.message || 'Task completed successfully.';
      lines.push(`  - WHEN: ${when}`);
      lines.push(`    RESPOND: "${message}"`);
    }
  } else {
    lines.push('  - WHEN: goal_achieved == true');
    lines.push(
      '    RESPOND: "Thank you for using our service. Is there anything else I can help with?"',
    );
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate Supervisor ABL from extraction
 */
export function generateSupervisorABL(extraction: SupervisorExtraction): string {
  const lines: string[] = [];

  // AGENT header (supervisors are also agents)
  lines.push(`AGENT: ${extraction.name}`);
  lines.push('');

  // MODE removed — execution style is declared per-step with REASONING: true/false

  // GOAL
  lines.push(`GOAL: "${extraction.description}"`);
  lines.push('');

  // PERSONA
  if (extraction.description) {
    lines.push('PERSONA: |');
    lines.push(`  ${extraction.description}`);
    lines.push('  Routes conversations to specialized agents based on user intent.');
    lines.push('');
  }

  // MEMORY - from state variables
  if (extraction.state_variables.length > 0) {
    lines.push('MEMORY:');

    // Group by namespace
    const sessionVars = extraction.state_variables.filter((v) => v.namespace === 'session');
    const persistentVars = extraction.state_variables.filter((v) => v.namespace === 'persistent');

    if (sessionVars.length > 0) {
      lines.push('  session:');
      for (const v of sessionVars) {
        lines.push(`    - ${v.name}`);
      }
    }

    if (persistentVars.length > 0) {
      lines.push('  persistent:');
      for (const v of persistentVars) {
        lines.push(`    - ${v.name}`);
      }
    }
    lines.push('');
  }

  // GATHER - from intent detection needs
  if (extraction.intent_mappings.length > 0) {
    lines.push('GATHER:');
    lines.push('  user_intent:');
    lines.push('    prompt: "How can I help you today?"');
    lines.push('    type: string');
    lines.push('    required: true');
    lines.push('');
  }

  // HANDOFF - from routing rules
  if (extraction.routing_rules.length > 0) {
    lines.push('HANDOFF:');
    for (const rule of extraction.routing_rules) {
      lines.push(`  - TO: ${rule.target}`);
      lines.push(`    WHEN: ${rule.condition}`);
      if (rule.context_fields && rule.context_fields.length > 0) {
        lines.push(`    CONTEXT:`);
        lines.push(`      PASS: [${rule.context_fields.join(', ')}]`);
        lines.push(
          `      SUMMARY: "User needs help with ${rule.target.toLowerCase().replace(/_/g, ' ')}"`,
        );
      }
      if (rule.flags?.includes('return')) {
        lines.push('    RETURN: true');
        lines.push('    ON_RETURN: "Welcome back. How else can I help?"');
      }
    }
    lines.push('');
  }

  // Add intent-based handoffs
  if (extraction.intent_mappings.length > 0) {
    // Already covered in routing rules, add as comments for clarity
    lines.push('# Intent mappings:');
    for (const mapping of extraction.intent_mappings) {
      lines.push(`# - ${mapping.intents.join(', ')} -> ${mapping.target_agent}`);
    }
    lines.push('');
  }

  // ESCALATE - default for supervisor
  lines.push('ESCALATE:');
  lines.push('  triggers:');
  lines.push('    - WHEN: user.frustrated == true');
  lines.push('      REASON: "User expressing frustration"');
  lines.push('      PRIORITY: high');
  lines.push('    - WHEN: no_matching_agent == true');
  lines.push('      REASON: "No specialized agent available"');
  lines.push('      PRIORITY: medium');
  lines.push('');

  // ON_ERROR
  lines.push('ON_ERROR:');
  lines.push('  - TYPE: handoff_failed');
  lines.push('    RESPOND: "I apologize, I\'m having trouble connecting you. Please try again."');
  lines.push('    RETRY: 1');
  lines.push('');

  // COMPLETE
  lines.push('COMPLETE:');
  lines.push('  - WHEN: handoff_successful == true');
  lines.push('    RESPOND: "I\'ve connected you with a specialist."');
  lines.push('  - WHEN: user_intent == "goodbye"');
  lines.push('    RESPOND: "Thank you for contacting us. Have a great day!"');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate tool ABL
 */
function generateToolABL(tool: InferredTool): string {
  const params = tool.parameters
    .map((p) => `${p.name}: ${p.type}${p.required ? '' : '?'}`)
    .join(', ');

  const lines: string[] = [];
  lines.push(`  ${tool.name}(${params}) -> ${tool.returns}`);
  if (tool.description) {
    lines.push(`    # ${tool.description}`);
  }

  return lines.join('\n');
}

/**
 * Generate flow step ABL
 */
function generateFlowStepABL(step: ExtractedStep): string {
  const stepName = step.name.toLowerCase().replace(/\s+/g, '_');
  const lines: string[] = [];

  lines.push(`  - ${stepName}:`);

  // Handle different action types
  switch (step.action_type) {
    case 'respond':
      if (step.action_details.message) {
        lines.push(`      RESPOND: "${step.action_details.message}"`);
      }
      break;

    case 'call_tool':
      if (step.action_details.tool) {
        const args = step.action_details.args
          ? `(${Object.entries(step.action_details.args)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')})`
          : '()';
        lines.push(`      CALL: ${step.action_details.tool}${args}`);

        if (step.action_details.onSuccess) {
          lines.push(`      ON_SUCCESS:`);
          lines.push(`        RESPOND: "${step.action_details.onSuccess}"`);
        }
        if (step.action_details.onFail) {
          lines.push(`      ON_FAIL:`);
          lines.push(`        RESPOND: "${step.action_details.onFail}"`);
        }
      }
      break;

    case 'classify':
      lines.push(`      # Classification step: ${step.description}`);
      break;

    case 'condition':
      if (step.action_details.condition) {
        lines.push(`      IF: ${step.action_details.condition}`);
      }
      break;
  }

  // Add branches as ON_INPUT
  if (step.branches.length > 0) {
    lines.push(`      ON_INPUT:`);
    for (const branch of step.branches) {
      lines.push(`        - IF: ${branch.condition}`);
      lines.push(`          THEN: ${branch.target_step}`);
    }
  }

  // Add next step
  if (step.action_details.next) {
    lines.push(`      THEN: ${step.action_details.next}`);
  }

  return lines.join('\n');
}

/**
 * ABL Generator class for more advanced generation
 */
export class ABLGenerator {
  // TODO: These fields are part of the public API contract but are not yet wired up
  // to the generate methods. The generate() methods currently delegate to standalone
  // functions which don't reference these options.
  private includeComments: boolean;
  private includeDefaults: boolean;

  constructor(options: { includeComments?: boolean; includeDefaults?: boolean } = {}) {
    this.includeComments = options.includeComments ?? true;
    this.includeDefaults = options.includeDefaults ?? true;
  }

  /**
   * Generate ABL from extraction
   */
  generate(
    extraction: AgentExtraction | SupervisorExtraction,
    type: 'agent' | 'supervisor',
  ): string {
    if (type === 'agent') {
      return generateAgentABL(extraction as AgentExtraction);
    } else {
      return generateSupervisorABL(extraction as SupervisorExtraction);
    }
  }

  /**
   * Generate agent ABL
   */
  generateAgentABL(extraction: AgentExtraction): string {
    return generateAgentABL(extraction);
  }

  /**
   * Generate supervisor ABL
   */
  generateSupervisorABL(extraction: SupervisorExtraction): string {
    return generateSupervisorABL(extraction);
  }

  /**
   * Generate ABL from a template with placeholders
   */
  generateFromTemplate(
    template: 'simple-agent' | 'supervisor' | 'scripted-agent',
    name: string,
  ): string {
    switch (template) {
      case 'simple-agent':
        return this.generateSimpleAgentTemplate(name);
      case 'supervisor':
        return this.generateSupervisorTemplate(name);
      case 'scripted-agent':
        return this.generateScriptedAgentTemplate(name);
      default:
        throw new Error(`Unknown template: ${template}`);
    }
  }

  private generateSimpleAgentTemplate(name: string): string {
    return `AGENT: ${name}

GOAL: "Help users with their requests"

PERSONA: |
  A helpful and professional assistant.
  Always maintains a friendly tone while being efficient.

LIMITATIONS:
  - "Cannot access external systems without tools"
  - "Cannot make decisions that require human approval"

TOOLS:
  # Add your tools here
  # example_tool(param: string) -> object

GATHER:
  user_request:
    prompt: "How can I help you today?"
    type: string
    required: true

COMPLETE:
  - WHEN: request_fulfilled == true
    RESPOND: "Is there anything else I can help you with?"
  - WHEN: user_intent == "goodbye"
    RESPOND: "Thank you! Have a great day!"
`;
  }

  private generateSupervisorTemplate(name: string): string {
    return `AGENT: ${name}

GOAL: "Route user requests to the appropriate specialized agent"

PERSONA: |
  A helpful routing supervisor that understands user intent
  and connects them with the right specialist.

GATHER:
  user_intent:
    prompt: "Hello! How can I help you today?"
    type: string
    required: true

HANDOFF:
  # Add your routing rules here
  # - TO: Agent_Name
  #   WHEN: intent == "specific_intent"
  #   CONTEXT:
  #     PASS: [relevant_fields]
  #     SUMMARY: "User needs help with..."

ESCALATE:
  triggers:
    - WHEN: no_matching_agent == true
      REASON: "No specialized agent for this request"
      PRIORITY: medium
    - WHEN: user.frustrated == true
      REASON: "User expressing frustration"
      PRIORITY: high

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "I've connected you with a specialist."
  - WHEN: user_intent == "goodbye"
    RESPOND: "Thank you for contacting us!"
`;
  }

  private generateScriptedAgentTemplate(name: string): string {
    return `AGENT: ${name}

GOAL: "Guide users through a structured workflow"

PERSONA: |
  A helpful assistant that follows a defined process.

TOOLS:
  # Add your tools here

GATHER:
  # Add fields to collect

FLOW:
  STEPS: [welcome, collect_info, process, complete]

  - welcome:
      RESPOND: "Hello! I'll help you through this process."
      THEN: collect_info

  - collect_info:
      COLLECT: [required_field]
      PROMPT: "Please provide the required information."
      THEN: process

  - process:
      CALL: process_request()
      ON_SUCCESS:
        RESPOND: "Processing complete!"
        THEN: complete
      ON_FAIL:
        RESPOND: "There was an issue. Let me try again."
        THEN: collect_info

  - complete:
      RESPOND: "All done! Is there anything else?"
      THEN: COMPLETE

ON_ERROR:
  - TYPE: tool_error
    RESPOND: "I encountered an issue. Let me try again."
    RETRY: 2

COMPLETE:
  - WHEN: workflow_complete == true
    RESPOND: "Thank you for using our service!"
`;
  }
}

/**
 * Create generator instance
 */
export function createGenerator(options?: {
  includeComments?: boolean;
  includeDefaults?: boolean;
}): ABLGenerator {
  return new ABLGenerator(options);
}

// Legacy exports for backward compatibility
export const DSLGenerator = ABLGenerator;
export const generateAgentDSL = generateAgentABL;
export const generateSupervisorDSL = generateSupervisorABL;
