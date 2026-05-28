/**
 * ABL Generator
 *
 * Generates complete ABL text from architecture specifications.
 * Covers all ABL sections: AGENT/SUPERVISOR, MODE, GOAL, PERSONA,
 * LIMITATIONS, TOOLS, GATHER, MEMORY, CONSTRAINTS, GUARDRAILS,
 * FLOW, DELEGATE, HANDOFF, ESCALATE, ON_ERROR, ON_START, COMPLETE.
 */

import type {
  AgentSpec,
  SupervisorSpec,
  ToolSpec,
  GatherFieldSpec,
  ConstraintSpec,
  GuardrailSpec,
  MemorySpec,
  HandoffSpec,
  DelegateSpec,
  EscalationSpec,
  ErrorHandlerSpec,
  FlowStepSpec,
  ArchitectureSpec,
} from './types.js';

// =============================================================================
// MAIN GENERATORS
// =============================================================================

/**
 * Generate all ABL files from an architecture spec.
 * Returns a map of filename -> ABL content.
 */
export function generateABL(spec: ArchitectureSpec): Map<string, string> {
  const files = new Map<string, string>();

  switch (spec.topology) {
    case 'single-agent': {
      if (spec.agent) {
        files.set(`${toFilename(spec.agent.name)}.agent.abl`, generateAgentABL(spec.agent));
      }
      break;
    }

    case 'supervisor': {
      if (spec.supervisor) {
        files.set('supervisor.agent.abl', generateSupervisorABL(spec.supervisor));
      }
      if (spec.agents) {
        for (const agent of spec.agents) {
          files.set(`agents/${toFilename(agent.name)}.agent.abl`, generateAgentABL(agent));
        }
      }
      break;
    }

    case 'adaptive-network': {
      if (spec.networkAgents) {
        for (const agent of spec.networkAgents) {
          const isEntry = agent.name === spec.entryAgent;
          const dir = isEntry ? '' : 'agents/';
          files.set(`${dir}${toFilename(agent.name)}.agent.abl`, generateAgentABL(agent));
        }
      }
      break;
    }
  }

  return files;
}

/**
 * Generate ABL for a single agent spec (for iteration).
 */
export function generateSingleAgentABL(agent: AgentSpec): string {
  return generateAgentABL(agent);
}

// =============================================================================
// AGENT ABL GENERATOR
// =============================================================================

function generateAgentABL(agent: AgentSpec): string {
  const sections: string[] = [];

  // AGENT declaration
  sections.push(`AGENT: ${agent.name}`);
  sections.push('');

  // MODE removed — execution style derived from flow presence

  // LANGUAGE
  if (agent.language) {
    sections.push(`LANGUAGE: ${agent.language}`);
    sections.push('');
  }

  // GOAL
  sections.push(`GOAL: "${escapeQuotes(agent.goal)}"`);
  sections.push('');

  // PERSONA
  if (agent.persona) {
    sections.push('PERSONA: |');
    for (const line of agent.persona.split('\n')) {
      sections.push(`  ${line}`);
    }
    sections.push('');
  }

  // LIMITATIONS
  if (agent.limitations.length > 0) {
    sections.push('LIMITATIONS:');
    for (const lim of agent.limitations) {
      sections.push(`  - "${escapeQuotes(lim)}"`);
    }
    sections.push('');
  }

  // TOOLS
  if (agent.tools.length > 0) {
    sections.push('TOOLS:');
    for (const tool of agent.tools) {
      sections.push(`  ${generateToolLine(tool)}`);
    }
    sections.push('');
  }

  // GATHER
  if (agent.gather.length > 0) {
    sections.push('GATHER:');
    for (const field of agent.gather) {
      sections.push(generateGatherField(field));
    }
    sections.push('');
  }

  // MEMORY
  if (agent.memory && (agent.memory.session.length > 0 || agent.memory.persistent.length > 0)) {
    sections.push(generateMemory(agent.memory));
    sections.push('');
  }

  // CONSTRAINTS
  if (agent.constraints.length > 0) {
    sections.push(generateConstraints(agent.constraints));
    sections.push('');
  }

  // GUARDRAILS
  if (agent.guardrails && agent.guardrails.length > 0) {
    sections.push(generateGuardrails(agent.guardrails));
    sections.push('');
  }

  // FLOW
  if (agent.flow) {
    sections.push(generateFlow(agent.flow.steps, agent.flow.definitions));
    sections.push('');
  }

  // DELEGATE
  if (agent.delegate.length > 0) {
    sections.push(generateDelegates(agent.delegate));
    sections.push('');
  }

  // HANDOFF
  if (agent.handoff.length > 0) {
    sections.push(generateHandoffs(agent.handoff));
    sections.push('');
  }

  // ESCALATE
  if (agent.escalation) {
    sections.push(generateEscalation(agent.escalation));
    sections.push('');
  }

  // ON_START
  if (agent.onStart) {
    sections.push(generateOnStart(agent.onStart));
    sections.push('');
  }

  // ON_ERROR
  if (agent.errorHandlers.length > 0) {
    sections.push(generateOnError(agent.errorHandlers));
    sections.push('');
  }

  // COMPLETE
  if (agent.complete.length > 0) {
    sections.push(generateComplete(agent.complete));
    sections.push('');
  }

  return sections.join('\n');
}

// =============================================================================
// SUPERVISOR ABL GENERATOR
// =============================================================================

function generateSupervisorABL(sup: SupervisorSpec): string {
  const sections: string[] = [];

  // SUPERVISOR declaration
  sections.push(`SUPERVISOR: ${sup.name}`);
  sections.push('');

  // MODE (supervisors are always reasoning)
  sections.push('MODE: reasoning');
  sections.push('');

  // GOAL
  sections.push(`GOAL: "${escapeQuotes(sup.goal)}"`);
  sections.push('');

  // PERSONA
  if (sup.persona) {
    sections.push('PERSONA: |');
    for (const line of sup.persona.split('\n')) {
      sections.push(`  ${line}`);
    }
    sections.push('');
  }

  // LIMITATIONS
  if (sup.limitations.length > 0) {
    sections.push('LIMITATIONS:');
    for (const lim of sup.limitations) {
      sections.push(`  - "${escapeQuotes(lim)}"`);
    }
    sections.push('');
  }

  // MEMORY
  if (sup.memory && (sup.memory.session.length > 0 || sup.memory.persistent.length > 0)) {
    sections.push(generateMemory(sup.memory));
    sections.push('');
  }

  // HANDOFF (core of supervisor)
  if (sup.handoff.length > 0) {
    sections.push(generateHandoffs(sup.handoff));
    sections.push('');
  }

  // ESCALATE
  if (sup.escalation) {
    sections.push(generateEscalation(sup.escalation));
    sections.push('');
  }

  // ON_ERROR
  if (sup.errorHandlers.length > 0) {
    sections.push(generateOnError(sup.errorHandlers));
    sections.push('');
  }

  // COMPLETE
  if (sup.complete.length > 0) {
    sections.push(generateComplete(sup.complete));
    sections.push('');
  }

  return sections.join('\n');
}

// =============================================================================
// SECTION GENERATORS
// =============================================================================

function generateToolLine(tool: ToolSpec): string {
  const params = tool.parameters
    .map((p) => {
      let param = `${p.name}: ${p.type}`;
      if (p.default !== undefined) {
        param += ` = ${p.default}`;
      }
      return param;
    })
    .join(', ');

  return `${tool.name}(${params}) -> ${tool.returns}`;
}

function generateGatherField(field: GatherFieldSpec): string {
  const lines: string[] = [];
  lines.push(`  ${field.name}:`);
  lines.push(`    prompt: "${escapeQuotes(field.prompt)}"`);
  lines.push(`    type: ${field.type}`);
  lines.push(`    required: ${field.required}`);
  if (field.validation) {
    lines.push(`    validate: "${escapeQuotes(field.validation)}"`);
  }
  return lines.join('\n');
}

function generateMemory(memory: MemorySpec): string {
  const lines: string[] = ['MEMORY:'];

  if (memory.session.length > 0) {
    lines.push('  session:');
    for (const v of memory.session) {
      lines.push(`    - ${v}`);
    }
  }

  if (memory.persistent.length > 0) {
    lines.push('  persistent:');
    for (const p of memory.persistent) {
      lines.push(`    - ${p}`);
    }
  }

  return lines.join('\n');
}

function generateConstraints(constraints: ConstraintSpec[]): string {
  const lines: string[] = ['CONSTRAINTS:'];

  for (const constraint of constraints) {
    lines.push(`  - REQUIRE ${constraint.condition}`);
    lines.push(`    ON_FAIL: "${escapeQuotes(constraint.onFail)}"`);
  }

  return lines.join('\n');
}

function generateGuardrails(guardrails: GuardrailSpec[]): string {
  const lines: string[] = ['GUARDRAILS:'];

  for (const g of guardrails) {
    lines.push(`  ${g.name}:`);
    lines.push(`    kind: ${g.kind}`);
    lines.push(`    check: "${escapeQuotes(g.check)}"`);
    lines.push(`    action: ${g.action}`);
    if (g.message) {
      lines.push(`    message: "${escapeQuotes(g.message)}"`);
    }
  }

  return lines.join('\n');
}

function generateFlow(steps: string[], definitions: Record<string, FlowStepSpec>): string {
  const lines: string[] = ['FLOW:'];

  // Step order
  lines.push(`  ${steps.join(' -> ')}`);
  lines.push('');

  // Step definitions
  for (const stepName of steps) {
    const step = definitions[stepName];
    if (!step) continue;

    lines.push(`  ${stepName}:`);

    if (step.when) {
      lines.push(`    WHEN: ${step.when}`);
    }

    if (step.maxAttempts !== undefined) {
      lines.push(`    MAX_ATTEMPTS: ${step.maxAttempts}`);
    }

    if (step.onExhausted) {
      lines.push(`    ON_EXHAUSTED: ${step.onExhausted}`);
    }

    if (step.gather && step.gather.fields.length > 0) {
      const fieldNames = step.gather.fields.map((f) => f.name).join(', ');
      lines.push(`    GATHER: ${fieldNames}`);
    }

    if (step.call) {
      lines.push(`    CALL: ${step.call}`);
    }

    if (step.respond) {
      lines.push(`    RESPOND: "${escapeQuotes(step.respond)}"`);
    }

    if (step.onFail) {
      lines.push(`    ON_FAIL: ${step.onFail}`);
    }

    if (step.then) {
      lines.push(`    THEN: ${step.then}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function generateDelegates(delegates: DelegateSpec[]): string {
  const lines: string[] = ['DELEGATE:'];

  for (const d of delegates) {
    lines.push(`  - AGENT: ${d.agent}`);
    lines.push(`    WHEN: ${d.when}`);
    lines.push(`    PURPOSE: "${escapeQuotes(d.purpose)}"`);

    const inputStr = Object.entries(d.input)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    lines.push(`    INPUT: {${inputStr}}`);

    const returnsStr = Object.entries(d.returns)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    lines.push(`    RETURNS: {${returnsStr}}`);

    lines.push(`    USE_RESULT: "${escapeQuotes(d.useResult)}"`);

    if (d.timeout) {
      lines.push(`    TIMEOUT: ${d.timeout}`);
    }
    if (d.onFailure) {
      lines.push(`    ON_FAILURE: ${d.onFailure}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function generateHandoffs(handoffs: HandoffSpec[]): string {
  const lines: string[] = ['HANDOFF:'];

  for (const h of handoffs) {
    lines.push(`  - TO: ${h.to}`);
    lines.push(`    WHEN: ${h.when}`);
    if (h.priority !== undefined) {
      lines.push(`    PRIORITY: ${h.priority}`);
    }
    lines.push('    CONTEXT:');
    lines.push(`      pass: [${h.pass.join(', ')}]`);
    lines.push(`      summary: "${escapeQuotes(h.summary)}"`);
    lines.push(`    RETURN: ${h.return}`);
    if (h.onReturn) {
      lines.push(`    ON_RETURN: "${escapeQuotes(h.onReturn)}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateEscalation(escalation: EscalationSpec): string {
  const lines: string[] = ['ESCALATE:'];

  lines.push('  triggers:');
  for (const t of escalation.triggers) {
    lines.push(`    - WHEN: ${t.when}`);
    lines.push(`      REASON: "${escapeQuotes(t.reason)}"`);
    lines.push(`      PRIORITY: ${t.priority}`);
    if (t.tags && t.tags.length > 0) {
      lines.push(`      TAGS: [${t.tags.join(', ')}]`);
    }
  }

  if (escalation.contextForHuman.length > 0) {
    lines.push('');
    lines.push('  context_for_human:');
    for (const ctx of escalation.contextForHuman) {
      lines.push(`    - ${ctx}`);
    }
  }

  return lines.join('\n');
}

function generateOnStart(onStart: {
  respond?: string;
  call?: string;
  set?: Record<string, string>;
}): string {
  const lines: string[] = ['ON_START:'];

  if (onStart.respond) {
    lines.push(`  respond: "${escapeQuotes(onStart.respond)}"`);
  }
  if (onStart.call) {
    lines.push(`  call: ${onStart.call}`);
  }
  if (onStart.set) {
    for (const [key, value] of Object.entries(onStart.set)) {
      lines.push(`  set: ${key} = ${value}`);
    }
  }

  return lines.join('\n');
}

function generateOnError(handlers: ErrorHandlerSpec[]): string {
  const lines: string[] = ['ON_ERROR:'];

  for (const h of handlers) {
    lines.push(`  ${h.type}:`);
    lines.push(`    RESPOND: "${escapeQuotes(h.respond)}"`);
    if (h.retry !== undefined) {
      lines.push(`    RETRY: ${h.retry}`);
    }
    if (h.then) {
      lines.push(`    THEN: ${h.then}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateComplete(conditions: Array<{ when: string; respond?: string }>): string {
  const lines: string[] = ['COMPLETE:'];

  for (const c of conditions) {
    lines.push(`  - WHEN: ${c.when}`);
    if (c.respond) {
      lines.push(`    RESPOND: "${escapeQuotes(c.respond)}"`);
    }
  }

  return lines.join('\n');
}

// =============================================================================
// UTILITIES
// =============================================================================

function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}

function toFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
