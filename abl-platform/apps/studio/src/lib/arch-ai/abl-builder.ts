/**
 * ABL Builder — Constructs valid ABL/DSL from topology node data.
 * Guarantees syntactically valid ABL that passes the parser.
 */

export interface AgentBuildInput {
  name: string;
  type: 'supervisor' | 'agent';
  executionMode?: string;
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  /** Routing targets for supervisors */
  handoffs?: { to: string; when: string }[];
  /** Brief context */
  domain?: string;
  tone?: string;
  /** Primary language for agent responses (non-English triggers a PERSONA directive) */
  language?: string;
  /** Channels the project supports (e.g. 'Voice', 'Web Chat') */
  channels?: string[];
  /** Suggested ABL constructs from topology stage (e.g. 'MEMORY', 'CONSTRAINTS', 'ON_START') */
  suggestedConstructs?: string[];
}

/**
 * Build valid ABL DSL from structured agent data.
 * This is deterministic — same input always produces same output.
 */
export function buildAbl(input: AgentBuildInput): string {
  const lines: string[] = [];

  // Header
  if (input.type === 'supervisor') {
    lines.push(`SUPERVISOR: ${input.name}`);
  } else {
    lines.push(`AGENT: ${input.name}`);
  }

  // Note: MODE: is not supported by the compiler. Agents default to reasoning.
  // For scripted agents, FLOW section with REASONING: per step is used instead.
  const mode = input.executionMode || 'reasoning';
  lines.push('');

  // Persona
  const persona = input.description
    ? `  You handle ${input.description.toLowerCase()}.`
    : `  You are a specialist for ${input.name.replace(/_/g, ' ').toLowerCase()}.`;
  const toneStr = input.tone ? `\n  Your tone is ${input.tone}.` : '';
  const langStr =
    input.language && input.language !== 'English'
      ? `\n  Always respond in ${input.language}.`
      : '';
  const channelHints: string[] = [];
  if (input.channels) {
    const lower = input.channels.map((c) => c.toLowerCase());
    if (lower.includes('voice')) {
      channelHints.push('  Keep responses concise for voice delivery.');
    }
    if (lower.includes('whatsapp') || lower.includes('sms')) {
      channelHints.push('  Format messages for mobile — short paragraphs, no markdown tables.');
    }
  }
  const channelStr = channelHints.length > 0 ? '\n' + channelHints.join('\n') : '';
  lines.push('PERSONA: |');
  lines.push(`${persona}${toneStr}${langStr}${channelStr}`);
  lines.push('');

  // Goal
  const goal = input.description
    ? input.description
    : input.type === 'supervisor'
      ? `Route incoming requests to the correct specialist agent`
      : `Help users with ${input.name.replace(/_/g, ' ').toLowerCase()}`;
  lines.push(`GOAL: "${goal}"`);
  lines.push('');

  // Tools — only for non-supervisor agents (supervisors route, they don't call tools)
  // Uses arrow-signature format — the only format accepted by @abl/core parser
  if (input.type !== 'supervisor' && input.tools && input.tools.length > 0) {
    lines.push('TOOLS:');
    for (const tool of input.tools) {
      const label = tool.replace(/_/g, ' ');
      lines.push(`  ${tool}(id: string) -> { result: object }`);
      lines.push(`    description: "${label}"`);
    }
    lines.push('');
  }

  // Gather fields — only for non-supervisor agents
  if (input.type !== 'supervisor' && input.gatherFields && input.gatherFields.length > 0) {
    lines.push('GATHER:');
    for (const field of input.gatherFields) {
      const label = field.replace(/_/g, ' ');
      lines.push(`  ${field}:`);
      lines.push(`    type: string`);
      lines.push(`    required: true`);
      lines.push(`    prompt: "Please provide your ${label}"`);
    }
    lines.push('');
  }

  // Handoffs (supervisor routing)
  if (input.type === 'supervisor' && input.handoffs && input.handoffs.length > 0) {
    lines.push('HANDOFF:');
    for (const h of input.handoffs) {
      lines.push(`  - TO: ${h.to}`);
      lines.push(`    WHEN: ${h.when}`);
    }
    lines.push('');
  }

  // Scripted flow for non-supervisors
  if (input.type === 'agent' && mode === 'scripted') {
    lines.push('FLOW:');
    lines.push('  entry_point: greet');
    lines.push('  steps:');
    lines.push('    - greet');
    lines.push('    - collect_info');
    lines.push('    - process');
    lines.push('    - complete');
    lines.push('');
    lines.push('  greet:');
    lines.push('    REASONING: false');
    lines.push(
      `    RESPOND: "Hello! I can help you with ${input.name.replace(/_/g, ' ').toLowerCase()}."`,
    );
    lines.push('    THEN: collect_info');
    lines.push('');
    lines.push('  collect_info:');
    lines.push('    REASONING: false');
    lines.push('    RESPOND: "Let me gather some information."');
    lines.push('    THEN: process');
    lines.push('');
    lines.push('  process:');
    lines.push('    REASONING: false');
    lines.push('    RESPOND: "I am checking that now."');
    lines.push('    THEN: complete');
    lines.push('');
    lines.push('  complete:');
    lines.push('    REASONING: false');
    lines.push('    RESPOND: "All done! Is there anything else I can help with?"');
  }

  // Construct-aware stub sections based on suggestedConstructs from topology stage
  if (input.suggestedConstructs) {
    if (input.suggestedConstructs.includes('MEMORY') && input.type !== 'supervisor') {
      lines.push('');
      lines.push('MEMORY:');
      lines.push('  session:');
      lines.push('    - name: interaction_count');
      lines.push('      type: number');
      lines.push('      initial_value: 0');
    }
    if (input.suggestedConstructs.includes('CONSTRAINTS') && input.type !== 'supervisor') {
      // Do not invent generic constraints here. Deterministic REQUIRE rules must
      // reference declared runtime state, and this helper cannot infer a safe
      // authentication/compliance predicate from topology alone.
    }
    if (input.suggestedConstructs.includes('ON_START')) {
      lines.push('');
      lines.push('ON_START:');
      lines.push(`  RESPOND: "Hello! I'm the ${input.name}. How can I help you today?"`);
    }
  }

  return lines.join('\n');
}

/**
 * Build ABL for all agents from topology data.
 * Returns an array of { name, ablContent } ready for create_project.
 */
export function buildAblFromTopology(
  topology: { nodes: any[]; edges: any[] },
  brief: { domain?: string; tone?: string; language?: string; channels?: string[] },
): { name: string; ablContent: string; description?: string }[] {
  return topology.nodes.map((node) => {
    // Find routing edges for supervisors
    const handoffs =
      node.type === 'supervisor'
        ? topology.edges
            .filter((e: any) => e.from === node.id && e.type === 'routing')
            .map((e: any) => {
              const target = topology.nodes.find((n: any) => n.id === e.to);
              return {
                to: target?.name ?? e.to,
                when:
                  e.condition ||
                  `user needs ${(target?.name ?? e.to).replace(/_/g, ' ').toLowerCase()}`,
              };
            })
        : undefined;

    const ablContent = buildAbl({
      name: node.name,
      type: node.type,
      executionMode: node.executionMode,
      description: node.description,
      tools: node.tools,
      gatherFields: node.gatherFields,
      handoffs,
      domain: brief.domain,
      tone: brief.tone,
      language: brief.language,
      channels: brief.channels,
    });

    return {
      name: node.name,
      ablContent,
      description: node.description,
    };
  });
}
