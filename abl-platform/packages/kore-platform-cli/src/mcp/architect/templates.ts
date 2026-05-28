/**
 * Documentation Templates
 *
 * Markdown templates for generated project documentation.
 */

import type { ArchitectureSpec, GapReport, AgentSpec, HandoffSpec } from './types.js';

// =============================================================================
// README
// =============================================================================

export function generateReadme(spec: ArchitectureSpec): string {
  const agentList = getAgentList(spec);

  return `# ${spec.projectName}

${spec.description}

## Architecture

**Pattern**: ${formatTopology(spec.topology)}

${
  agentList.length > 0
    ? `### Agents

| Agent | Mode | Description |
|-------|------|-------------|
${agentList.map((a) => `| ${a.name} | ${a.mode} | ${a.goal} |`).join('\n')}
`
    : ''
}
## Quick Start

1. Review the architecture in \`docs/architecture.md\`
2. Check known limitations in \`docs/limitations.md\`
3. Load the ${spec.topology === 'single-agent' ? 'agent' : 'supervisor'} ABL file in your runtime
4. Configure tool implementations for your backend

## Project Structure

\`\`\`
${generateTreeView(spec)}
\`\`\`

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Best Practices](docs/best-practices.md)
- [Limitations & Gaps](docs/limitations.md)
- [Deployment Guide](docs/deployment.md)
`;
}

// =============================================================================
// ARCHITECTURE DOC
// =============================================================================

export function generateArchitectureDoc(spec: ArchitectureSpec): string {
  const sections: string[] = [];

  sections.push(`# Architecture: ${spec.projectName}`);
  sections.push('');
  sections.push(`## Pattern: ${formatTopology(spec.topology)}`);
  sections.push('');
  sections.push(spec.description);
  sections.push('');

  if (spec.topology === 'supervisor' && spec.supervisor) {
    sections.push('## Supervisor');
    sections.push('');
    sections.push(`**${spec.supervisor.name}**: ${spec.supervisor.goal}`);
    sections.push('');
    sections.push('### Routing Rules');
    sections.push('');
    sections.push('| Priority | Target Agent | Condition | Returns |');
    sections.push('|----------|-------------|-----------|---------|');
    for (let i = 0; i < spec.supervisor.handoff.length; i++) {
      const h = spec.supervisor.handoff[i];
      sections.push(`| ${i + 1} | ${h.to} | \`${h.when}\` | ${h.return ? 'Yes' : 'No'} |`);
    }
    sections.push('');
  }

  if (spec.topology === 'adaptive-network' && spec.networkAgents) {
    sections.push('## Handoff Graph');
    sections.push('');
    sections.push(`**Entry Point**: ${spec.entryAgent}`);
    sections.push('');
    sections.push('| From Agent | To Agent | Condition | Round-trip |');
    sections.push('|-----------|----------|-----------|------------|');
    for (const agent of spec.networkAgents) {
      for (const h of agent.handoff) {
        sections.push(`| ${agent.name} | ${h.to} | \`${h.when}\` | ${h.return ? 'Yes' : 'No'} |`);
      }
    }
    sections.push('');
  }

  const agents = getAgentList(spec);
  if (agents.length > 0) {
    sections.push('## Agent Details');
    sections.push('');
    for (const agent of agents) {
      sections.push(`### ${agent.name}`);
      sections.push('');
      sections.push(`- **Mode**: ${agent.mode}`);
      sections.push(`- **Goal**: ${agent.goal}`);
      sections.push(
        `- **Tools**: ${agent.tools.length > 0 ? agent.tools.map((t) => `\`${t.name}\``).join(', ') : 'None'}`,
      );
      sections.push(
        `- **Gather fields**: ${agent.gather.length > 0 ? agent.gather.map((f) => `\`${f.name}\``).join(', ') : 'None'}`,
      );
      sections.push('');
    }
  }

  return sections.join('\n');
}

// =============================================================================
// BEST PRACTICES DOC
// =============================================================================

export function generateBestPracticesDoc(): string {
  return `# ABL Best Practices

## Agent Design

### Choosing the Right Mode

- **Reasoning mode**: Use when the agent needs to make judgment calls, handle ambiguous input, or dynamically decide which tools to use. Best for open-ended tasks.
- **Scripted mode**: Use when the workflow is well-defined with clear steps. Best for forms, wizards, and structured data collection.

### Writing Effective Goals

- Be specific about what the agent should accomplish
- Include key constraints in the goal description
- Avoid vague goals like "help the user" - specify how

### PERSONA Guidelines

- Define personality traits that affect communication style
- Include domain expertise relevant to the agent's role
- Keep it concise - 2-4 lines maximum

## Tool Design

### Parameter Types
- Use specific types: \`string\`, \`number\`, \`boolean\`, \`date\`, \`email\`
- Set defaults for optional parameters: \`status: string = "active"\`
- Return structured objects: \`-> {success: boolean, data: object}\`

### Error Handling
- Always define ON_ERROR handlers for tool failures
- Use RETRY for transient errors (API timeouts)
- Use ESCALATE for persistent failures

## GATHER Best Practices

- Provide clear, specific prompts
- Mark fields as required/optional explicitly
- Use appropriate types for validation
- Keep field names in snake_case

## Multi-Agent Patterns

### Supervisor Pattern
- Keep routing conditions specific and non-overlapping
- Always include a fallback agent
- Use RETURN: true when the supervisor needs to orchestrate further
- Use RETURN: false for terminal handoffs

### Adaptive Network Pattern
- Define clear handoff conditions between agents
- Use RETURN: true for round-trip consultations
- Use RETURN: false for permanent transfers
- Ensure there's always a path back or to completion

## Common Pitfalls

1. **Missing error handlers**: Always define ON_ERROR for each tool failure type
2. **Overlapping routing rules**: Ensure HANDOFF conditions are mutually exclusive
3. **Missing COMPLETE conditions**: Define when the conversation ends
4. **Circular handoffs**: Avoid A -> B -> A loops without exit conditions
5. **Over-gathering**: Don't collect more information than needed
`;
}

// =============================================================================
// LIMITATIONS DOC
// =============================================================================

export function generateLimitationsDoc(gapReport: GapReport): string {
  const sections: string[] = [];

  sections.push('# Limitations & ABL Gaps');
  sections.push('');
  sections.push(`**Overall ABL Coverage**: ${gapReport.overallCoverage}%`);
  sections.push('');

  if (gapReport.gaps.length === 0) {
    sections.push('No significant ABL limitations were identified for this use case.');
    return sections.join('\n');
  }

  sections.push(`${gapReport.gaps.length} limitation(s) identified:`);
  sections.push('');

  // Group by severity
  const significant = gapReport.gaps.filter((g) => g.severity === 'significant');
  const moderate = gapReport.gaps.filter((g) => g.severity === 'moderate');
  const minor = gapReport.gaps.filter((g) => g.severity === 'minor');

  if (significant.length > 0) {
    sections.push('## Significant Limitations');
    sections.push('');
    for (const gap of significant) {
      sections.push(formatGap(gap));
    }
  }

  if (moderate.length > 0) {
    sections.push('## Moderate Limitations');
    sections.push('');
    for (const gap of moderate) {
      sections.push(formatGap(gap));
    }
  }

  if (minor.length > 0) {
    sections.push('## Minor Limitations');
    sections.push('');
    for (const gap of minor) {
      sections.push(formatGap(gap));
    }
  }

  return sections.join('\n');
}

function formatGap(gap: {
  requirement: string;
  ablLimitation: string;
  alternatives: Array<{ approach: string; tradeoffs: string; dslPattern: string }>;
  severity: string;
}): string {
  const lines: string[] = [];
  lines.push(`### ${gap.requirement}`);
  lines.push('');
  lines.push(`**Limitation**: ${gap.ablLimitation}`);
  lines.push('');

  if (gap.alternatives.length > 0) {
    lines.push('**Alternatives**:');
    lines.push('');
    for (const alt of gap.alternatives) {
      lines.push(`- **${alt.approach}**`);
      lines.push(`  - Tradeoffs: ${alt.tradeoffs}`);
      lines.push(`  - Example:`);
      lines.push('  ```');
      for (const line of alt.dslPattern.split('\n')) {
        lines.push(`  ${line}`);
      }
      lines.push('  ```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// =============================================================================
// DEPLOYMENT DOC
// =============================================================================

export function generateDeploymentDoc(spec: ArchitectureSpec): string {
  const agentList = getAgentList(spec);
  const allTools = agentList.flatMap((a) => a.tools);
  const uniqueTools = [...new Map(allTools.map((t) => [t.name, t])).values()];

  return `# Deployment Guide

## Prerequisites

- ABL runtime environment
- Tool implementations for all defined tools

## Tool Implementations Required

The following tools need backend implementations:

${
  uniqueTools.length > 0
    ? uniqueTools
        .map((t) => {
          const params = t.parameters
            .map((p) => `\`${p.name}: ${p.type}${p.required ? '' : ' (optional)'}\``)
            .join(', ');
          return `### \`${t.name}\`
- **Description**: ${t.description}
- **Parameters**: ${params || 'None'}
- **Returns**: \`${t.returns}\`
`;
        })
        .join('\n')
    : 'No tools defined.'
}

## Loading the Project

1. Point your ABL runtime to the project directory
2. The ${spec.topology === 'single-agent' ? 'agent file' : 'supervisor file'} is the entry point
3. Ensure all tool implementations are registered

## Testing

1. Start with simple test messages
2. Verify routing (for multi-agent systems)
3. Test error handling paths
4. Verify tool integrations
`;
}

// =============================================================================
// HELPERS
// =============================================================================

function getAgentList(spec: ArchitectureSpec): AgentSpec[] {
  switch (spec.topology) {
    case 'single-agent':
      return spec.agent ? [spec.agent] : [];
    case 'supervisor':
      return spec.agents || [];
    case 'adaptive-network':
      return spec.networkAgents || [];
    default:
      return [];
  }
}

function formatTopology(topology: string): string {
  switch (topology) {
    case 'single-agent':
      return 'Single Agent';
    case 'supervisor':
      return 'Multi-Agent Supervisor';
    case 'adaptive-network':
      return 'Adaptive Agent Network';
    default:
      return topology;
  }
}

function generateTreeView(spec: ArchitectureSpec): string {
  const lines: string[] = [];

  lines.push(`${spec.projectName}/`);
  lines.push(`├── README.md`);
  lines.push(`├── docs/`);
  lines.push(`│   ├── architecture.md`);
  lines.push(`│   ├── best-practices.md`);
  lines.push(`│   ├── limitations.md`);
  lines.push(`│   └── deployment.md`);

  if (spec.topology === 'single-agent' && spec.agent) {
    lines.push(`└── ${spec.agent.name.toLowerCase()}.agent.abl`);
  } else if (spec.topology === 'supervisor') {
    lines.push(`├── supervisor.agent.abl`);
    lines.push(`└── agents/`);
    const agents = spec.agents || [];
    for (let i = 0; i < agents.length; i++) {
      const prefix = i === agents.length - 1 ? '    └── ' : '    ├── ';
      lines.push(`${prefix}${agents[i].name.toLowerCase()}.agent.abl`);
    }
  } else if (spec.topology === 'adaptive-network') {
    const agents = spec.networkAgents || [];
    const entry = agents.find((a) => a.name === spec.entryAgent);
    const rest = agents.filter((a) => a.name !== spec.entryAgent);
    if (entry) {
      lines.push(`├── ${entry.name.toLowerCase()}.agent.abl`);
    }
    if (rest.length > 0) {
      lines.push(`└── agents/`);
      for (let i = 0; i < rest.length; i++) {
        const prefix = i === rest.length - 1 ? '    └── ' : '    ├── ';
        lines.push(`${prefix}${rest[i].name.toLowerCase()}.agent.abl`);
      }
    }
  }

  return lines.join('\n');
}
