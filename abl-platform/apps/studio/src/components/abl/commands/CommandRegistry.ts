// CommandRegistry.ts
import type { DSLSection } from './DSLContextDetector';

export interface Command {
  id: string;
  label: string;
  description: string;
  category: string;
  availableIn: DSLSection[];
}

export const COMMAND_REGISTRY: Command[] = [
  // Tools
  {
    id: 'tool',
    label: '/tool',
    description: 'Browse & insert tool',
    category: 'Capabilities',
    availableIn: ['tools', 'root'],
  },
  {
    id: 'http-tool',
    label: '/http-tool',
    description: 'New HTTP API tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'mcp-tool',
    label: '/mcp-tool',
    description: 'New MCP tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'sandbox-tool',
    label: '/sandbox-tool',
    description: 'Inline code tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'lambda-tool',
    label: '/lambda-tool',
    description: 'Serverless function',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'async-tool',
    label: '/async-tool',
    description: 'Async webhook tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  // Guardrails
  {
    id: 'guardrail',
    label: '/guardrail',
    description: 'Browse & insert guardrail',
    category: 'Safety',
    availableIn: ['guardrails', 'root'],
  },
  {
    id: 'builtin-guard',
    label: '/builtin-guard',
    description: 'Built-in guardrail template',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  {
    id: 'input-guard',
    label: '/input-guard',
    description: 'New input guardrail',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  {
    id: 'output-guard',
    label: '/output-guard',
    description: 'New output guardrail',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  // Templates
  {
    id: 'template',
    label: '/template',
    description: 'Browse template gallery',
    category: 'Capabilities',
    availableIn: ['templates', 'root'],
  },
  {
    id: 'multiformat',
    label: '/multiformat',
    description: 'Multi-channel template',
    category: 'Capabilities',
    availableIn: ['templates'],
  },
  {
    id: 'voice-template',
    label: '/voice-template',
    description: 'Voice-only template',
    category: 'Capabilities',
    availableIn: ['templates'],
  },
  {
    id: 'rich-template',
    label: '/rich-template',
    description: 'Insert rich content template (image, chart, form, etc.)',
    category: 'Capabilities',
    availableIn: ['templates', 'root'],
  },
  // Gather
  {
    id: 'field',
    label: '/field',
    description: 'Add gather field',
    category: 'Capabilities',
    availableIn: ['gather', 'root'],
  },
  {
    id: 'string-field',
    label: '/string-field',
    description: 'Text field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'number-field',
    label: '/number-field',
    description: 'Number field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'date-field',
    label: '/date-field',
    description: 'Date field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'email-field',
    label: '/email-field',
    description: 'Email field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'enum-field',
    label: '/enum-field',
    description: 'Selection field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  // Flow
  {
    id: 'step',
    label: '/step',
    description: 'Add flow step',
    category: 'Flow',
    availableIn: ['flow', 'root'],
  },
  {
    id: 'reasoning-step',
    label: '/reasoning-step',
    description: 'LLM-powered step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'scripted-step',
    label: '/scripted-step',
    description: 'Deterministic step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'gather-step',
    label: '/gather-step',
    description: 'Data collection step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'digression',
    label: '/digression',
    description: 'Off-topic handler',
    category: 'Flow',
    availableIn: ['flow'],
  },
  // Memory
  {
    id: 'memory-var',
    label: '/memory-var',
    description: 'Session variable',
    category: 'Memory',
    availableIn: ['memory', 'root'],
  },
  {
    id: 'persistent',
    label: '/persistent',
    description: 'Persistent path',
    category: 'Memory',
    availableIn: ['memory'],
  },
  {
    id: 'remember',
    label: '/remember',
    description: 'Remember trigger',
    category: 'Memory',
    availableIn: ['memory'],
  },
  {
    id: 'recall',
    label: '/recall',
    description: 'Recall instruction',
    category: 'Memory',
    availableIn: ['memory'],
  },
  // Constraints
  {
    id: 'constraint',
    label: '/constraint',
    description: 'Add business rule',
    category: 'Safety',
    availableIn: ['constraints', 'root'],
  },
  {
    id: 'require',
    label: '/require',
    description: 'Blocking rule',
    category: 'Safety',
    availableIn: ['constraints'],
  },
  {
    id: 'warn',
    label: '/warn',
    description: 'Warning rule',
    category: 'Safety',
    availableIn: ['constraints'],
  },
  // Coordination
  {
    id: 'handoff',
    label: '/handoff',
    description: 'Transfer to agent',
    category: 'Coordination',
    availableIn: ['handoff', 'root'],
  },
  {
    id: 'delegate',
    label: '/delegate',
    description: 'Sub-agent task',
    category: 'Coordination',
    availableIn: ['delegates', 'root'],
  },
  {
    id: 'escalate',
    label: '/escalate',
    description: 'Human escalation',
    category: 'Coordination',
    availableIn: ['escalation', 'root'],
  },
  // Lifecycle
  {
    id: 'onstart',
    label: '/onstart',
    description: 'Welcome + init',
    category: 'Lifecycle',
    availableIn: ['root'],
  },
  {
    id: 'complete',
    label: '/complete',
    description: 'Completion condition',
    category: 'Lifecycle',
    availableIn: ['completion', 'root'],
  },
  {
    id: 'onerror',
    label: '/onerror',
    description: 'Error handler',
    category: 'Lifecycle',
    availableIn: ['error_handling', 'root'],
  },
  {
    id: 'hook',
    label: '/hook',
    description: 'Lifecycle hook',
    category: 'Lifecycle',
    availableIn: ['hooks', 'root'],
  },
  // Rich Editor
  {
    id: 'edit',
    label: '/edit',
    description: 'Open rich markdown editor',
    category: 'Edit',
    availableIn: ['identity', 'unknown', 'root'],
  },
];

export function getCommandsForSection(section: DSLSection): Command[] {
  if (section === 'root') {
    return COMMAND_REGISTRY;
  }
  // Only show commands specifically available in this section
  return COMMAND_REGISTRY.filter((cmd) => cmd.availableIn.includes(section));
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query) return commands;
  const q = query.toLowerCase().replace(/^\//, '');
  return commands.filter(
    (cmd) =>
      cmd.id.includes(q) || cmd.label.includes(q) || cmd.description.toLowerCase().includes(q),
  );
}

export function groupCommandsByCategory(commands: Command[]): Record<string, Command[]> {
  const groups: Record<string, Command[]> = {};
  for (const cmd of commands) {
    if (!groups[cmd.category]) groups[cmd.category] = [];
    groups[cmd.category].push(cmd);
  }
  return groups;
}
