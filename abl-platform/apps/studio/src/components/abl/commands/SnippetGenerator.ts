// SnippetGenerator.ts

/**
 * Apply indentation to every line of a snippet.
 */
export function applyIndent(snippet: string, spaces: number): string {
  if (!snippet) return '';
  const indent = ' '.repeat(spaces);
  return snippet
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}

// --- Tool Snippet ---

interface ToolSnippetInput {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; required: boolean }>;
  returns: string;
  toolType?: string;
  httpBinding?: { method: string; endpoint: string; auth?: string; timeout?: number };
  mcpBinding?: { server: string; tool?: string };
  sandboxBinding?: { runtime: string; code?: string };
}

export function generateToolSnippet(input: ToolSnippetInput): string {
  const params = input.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  const lines: string[] = [];

  lines.push(`${input.name}(${params}) -> ${input.returns}`);
  lines.push(`  description: "${input.description}"`);

  if (input.toolType) {
    lines.push(`  type: ${input.toolType}`);
  }

  if (input.httpBinding) {
    lines.push('  http:');
    lines.push(`    method: ${input.httpBinding.method}`);
    lines.push(`    endpoint: "${input.httpBinding.endpoint}"`);
    if (input.httpBinding.auth) lines.push(`    auth: ${input.httpBinding.auth}`);
    if (input.httpBinding.timeout) lines.push(`    timeout: ${input.httpBinding.timeout}`);
  }

  if (input.mcpBinding) {
    lines.push('  mcp:');
    lines.push(`    server: "${input.mcpBinding.server}"`);
    if (input.mcpBinding.tool) lines.push(`    tool: "${input.mcpBinding.tool}"`);
  }

  if (input.sandboxBinding) {
    lines.push('  sandbox:');
    lines.push(`    runtime: ${input.sandboxBinding.runtime}`);
    if (input.sandboxBinding.code) {
      lines.push('    code: |');
      for (const codeLine of input.sandboxBinding.code.split('\n')) {
        lines.push(`      ${codeLine}`);
      }
    }
  }

  return lines.join('\n');
}

// --- Template Snippet ---

export interface TemplateSnippetInput {
  name: string;
  content: string;
  formats?: {
    markdown?: string;
    html?: string;
    slack?: string;
    whatsapp?: string;
  };
  voiceInstructions?: string;
}

const TEMPLATE_FORMAT_FIELDS: Array<{
  inputKey: keyof NonNullable<TemplateSnippetInput['formats']>;
  dslKey: string;
}> = [
  { inputKey: 'markdown', dslKey: 'MARKDOWN' },
  { inputKey: 'html', dslKey: 'HTML' },
  { inputKey: 'slack', dslKey: 'SLACK' },
  { inputKey: 'whatsapp', dslKey: 'WHATSAPP' },
];

function appendBlockField(lines: string[], key: string, value: string, indent = 2): void {
  const fieldIndent = ' '.repeat(indent);
  const valueIndent = ' '.repeat(indent + 2);

  lines.push(`${fieldIndent}${key}: |`);
  for (const line of value.split('\n')) {
    lines.push(line ? `${valueIndent}${line}` : '');
  }
}

export function generateTemplateSnippet(input: TemplateSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  appendBlockField(lines, 'DEFAULT', input.content);

  for (const { inputKey, dslKey } of TEMPLATE_FORMAT_FIELDS) {
    const value = input.formats?.[inputKey];
    if (value) {
      appendBlockField(lines, dslKey, value);
    }
  }

  if (input.voiceInstructions) {
    appendBlockField(lines, 'VOICE INSTRUCTIONS', input.voiceInstructions);
  }

  return lines.join('\n');
}

// --- Guardrail Snippet ---

interface GuardrailSnippetInput {
  name: string;
  kind: string;
  check?: string;
  llmCheck?: string;
  action: string;
  message?: string;
  priority?: number;
}

export function generateGuardrailSnippet(input: GuardrailSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  kind: ${input.kind}`);
  if (input.check) lines.push(`  check: ${JSON.stringify(input.check)}`);
  if (input.llmCheck) lines.push(`  llm_check: ${JSON.stringify(input.llmCheck)}`);
  lines.push(`  action: ${input.action}`);
  if (input.message) lines.push(`  message: "${input.message}"`);
  if (input.priority != null) lines.push(`  priority: ${input.priority}`);
  return lines.join('\n');
}

// --- Gather Field Snippet ---

interface GatherFieldSnippetInput {
  name: string;
  type: string;
  prompt: string;
  required: boolean;
  validate?: string;
  retryPrompt?: string;
  infer?: boolean;
  sensitive?: boolean;
}

export function generateGatherFieldSnippet(input: GatherFieldSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  prompt: "${input.prompt}"`);
  lines.push(`  type: ${input.type}`);
  lines.push(`  required: ${input.required}`);
  if (input.validate) lines.push(`  validate: "${input.validate}"`);
  if (input.retryPrompt) lines.push(`  retryPrompt: "${input.retryPrompt}"`);
  if (input.infer) lines.push('  infer: true');
  if (input.sensitive) lines.push('  sensitive: true');
  return lines.join('\n');
}

// --- Flow Step Snippet ---

interface FlowStepSnippetInput {
  name: string;
  reasoning: boolean;
  goal?: string;
  exitWhen?: string;
  maxTurns?: number;
  availableTools?: string[];
  respond?: string;
  call?: string;
  then?: string;
}

export function generateFlowStepSnippet(input: FlowStepSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  REASONING: ${input.reasoning}`);
  if (input.goal) lines.push(`  GOAL: "${input.goal}"`);
  if (input.availableTools?.length) {
    lines.push(`  AVAILABLE_TOOLS: [${input.availableTools.join(', ')}]`);
  }
  if (input.exitWhen) lines.push(`  EXIT_WHEN: ${input.exitWhen}`);
  if (input.maxTurns != null) lines.push(`  MAX_TURNS: ${input.maxTurns}`);
  if (input.respond) lines.push(`  RESPOND: "${input.respond}"`);
  if (input.call) lines.push(`  CALL: ${input.call}`);
  if (input.then) lines.push(`  THEN: ${input.then}`);
  return lines.join('\n');
}

// --- Memory Var Snippet ---

interface MemoryVarSnippetInput {
  name: string;
  type: string;
  initialValue?: string;
}

export function generateMemoryVarSnippet(input: MemoryVarSnippetInput): string {
  let line = `- ${input.name}: ${input.type}`;
  if (input.initialValue != null) line += ` = ${input.initialValue}`;
  return line;
}

// --- Handoff Snippet ---

interface HandoffSnippetInput {
  to: string;
  when: string;
  priority?: number;
  contextPass?: string[];
  history?: string | { mode: 'last_n'; count: number };
  returnEnabled?: boolean;
}

export function generateHandoffSnippet(input: HandoffSnippetInput): string {
  const lines: string[] = [];
  lines.push(`- TO: ${input.to}`);
  lines.push(`  WHEN: ${input.when}`);
  if (input.priority != null) lines.push(`  PRIORITY: ${input.priority}`);
  if (input.contextPass?.length) {
    lines.push('  CONTEXT:');
    lines.push(`    pass: [${input.contextPass.map((p) => `"${p}"`).join(', ')}]`);
    if (typeof input.history === 'string') {
      lines.push(`    history: ${input.history}`);
    } else if (input.history) {
      lines.push('    history:');
      lines.push(`      mode: ${input.history.mode}`);
      lines.push(`      count: ${input.history.count}`);
    }
  }
  if (input.returnEnabled != null) lines.push(`  RETURN: ${input.returnEnabled}`);
  return lines.join('\n');
}

// --- Constraint Snippet ---

interface ConstraintSnippetInput {
  phase: string;
  severity: 'REQUIRE' | 'WARN';
  condition: string;
  onFail: string;
}

export function generateConstraintSnippet(input: ConstraintSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.phase}:`);
  lines.push(`  - ${input.severity}: ${input.condition}`);
  lines.push(`    ON_FAIL: "${input.onFail}"`);
  return lines.join('\n');
}
