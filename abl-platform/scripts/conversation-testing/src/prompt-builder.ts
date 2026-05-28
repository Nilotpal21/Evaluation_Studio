/**
 * Pure functions for building LLM prompts.
 *
 * Two prompts serve two purposes:
 *   - Prompt A (buildScenarioPrompt): generates N diverse scenarios in one LLM call.
 *   - Prompt B (buildPersonaPrompt): produces the next user turn for a running conversation.
 */

import type { LLMMessage, PresetName, RunConfig, Scenario, SlotAssignment } from './types.js';
import { PRESETS } from './presets.js';

/** Maximum fraction of scenarios any single intent may claim. */
const MAX_INTENT_FRACTION = 0.4;

/** Labels used in the prompt for each preset (in SCREAMING-KEBAB for readability). */
const PRESET_LABELS: Record<Exclude<PresetName, 'auto'>, string> = {
  balanced: 'BALANCED',
  'stress-negative': 'STRESS-NEGATIVE',
  'short-simple': 'SHORT-SIMPLE',
  'long-complex': 'LONG-COMPLEX',
  abandonment: 'ABANDONMENT',
};

/**
 * Build the system prompt for scenario generation (Prompt A).
 *
 * Given the run configuration (project name, welcome message / domain hint,
 * preset, optional instructions, and run count), returns the full system
 * prompt that asks the LLM to produce a JSON array of Scenario objects.
 */
export function buildScenarioPrompt(config: RunConfig, slots?: SlotAssignment[]): string {
  const { runs, preset, instructions, domain, agents } = config;
  const domainSource = domain.hint || domain.welcomeMessage;
  const presetText = PRESETS[preset];

  // Slot-driven mode: exact per-scenario profile and targeting assignments.
  if (slots && slots.length > 0) {
    const usedPresets = Array.from(new Set(slots.map((s) => s.preset)));
    const profileBlock = usedPresets
      .map((p) => `- **${PRESET_LABELS[p]}**: ${PRESETS[p]}`)
      .join('\n\n');

    const assignmentBlock = slots
      .map((s, i) => {
        const agentPart = s.targetAgent ? `, target agent=${s.targetAgent}` : '';
        return `${i + 1}. profile=${PRESET_LABELS[s.preset]}${agentPart}`;
      })
      .join('\n');

    const lines: string[] = [
      'You are a test scenario generator for a conversational AI bot.',
      '',
      `**Bot project:** ${domain.projectName}`,
      `**Bot description / welcome message:** ${domainSource}`,
      '',
    ];

    if (agents && agents.length > 0) {
      const agentBlock = agents
        .map(
          (a, i) => `${i + 1}. **${a.name}** — goal: ${a.goal}\n   description: ${a.description}`,
        )
        .join('\n');
      lines.push(
        '**Bot agents (the bot routes users to one of these specialists):**',
        agentBlock,
        '',
      );
    }

    lines.push(
      '**Behavioral profile definitions:**',
      '',
      profileBlock,
      '',
      `**Generate EXACTLY ${slots.length} scenarios, in the order below. Each scenario MUST match its assigned profile${agents && agents.length > 0 ? ' and target agent' : ''}:**`,
      '',
      assignmentBlock,
      '',
      '**Output format:**',
      'Reply with a JSON array only — no markdown fences, no prose before or after.',
      `The array must have exactly ${slots.length} elements, in the same order as the assignments above.`,
      'Each element must have these fields:',
      '- "intent": string — short slug describing the user need (e.g. "battery_issue")',
      '- "persona": string — short persona description consistent with the assigned profile',
      '- "goal": string — what the persona wants to achieve',
      '- "behavior": string — tone/verbosity/mood matching the assigned profile',
      '- "endCondition": string — when the persona should end the conversation',
    );

    if (agents && agents.length > 0) {
      lines.push('- "targetAgent": string — the agent name this scenario targets');
    }

    if (instructions) {
      lines.push('', '**Additional instructions from the operator:**', instructions);
    }

    return lines.join('\n');
  }

  // All-agents mode fallback for direct callers that do not pass explicit slots.
  if (agents && agents.length > 0) {
    const totalRuns = runs;
    const baseRunsPerAgent = Math.floor(totalRuns / agents.length);
    const remainderRuns = totalRuns % agents.length;

    const agentBlock = agents
      .map((a, i) => `${i + 1}. **${a.name}** — goal: ${a.goal}\n   description: ${a.description}`)
      .join('\n');

    const distributionBlock = agents
      .map((agent, i) => {
        const assignedRuns = baseRunsPerAgent + (i < remainderRuns ? 1 : 0);
        return `- ${agent.name}: ${assignedRuns} scenario${assignedRuns === 1 ? '' : 's'}`;
      })
      .join('\n');

    const lines: string[] = [
      'You are a test scenario generator for a multi-agent conversational AI bot.',
      '',
      `**Bot project:** ${domain.projectName}`,
      `**Bot description / welcome message:** ${domainSource}`,
      '',
      '**Bot agents (the bot routes users to one of these specialists):**',
      agentBlock,
      '',
      '**Your task:** Generate scenarios that exercise EACH of the agents above. For every agent, craft scenarios whose user intent would cause the supervisor to route to that agent.',
      '',
      `**Total scenarios:** ${totalRuns}`,
      '**Target distribution:**',
      distributionBlock,
      '',
      '**Behavioral profile (preset):**',
      presetText,
      '',
      '**Output format:**',
      'Reply with a JSON array only — no markdown fences, no prose before or after.',
      'Each element must have exactly these fields:',
      '- "intent": string — short slug describing the user need (e.g. "battery_issue")',
      '- "persona": string — short persona description',
      '- "goal": string — what the persona wants to achieve',
      '- "behavior": string — how the persona behaves (tone, verbosity, mood)',
      '- "endCondition": string — when the persona should end the conversation',
      '- "targetAgent": string — the agent name from the list above that this scenario targets',
      '',
      'Group the output such that scenarios for earlier agents appear first. Keep persona and goal details grounded in the specific agent responsibilities and match the distribution above exactly.',
    ];

    if (instructions) {
      lines.push('', '**Additional instructions from the operator:**', instructions);
    }

    return lines.join('\n');
  }

  // Default mode: generate `runs` scenarios with inferred intent diversity.
  const maxPerIntent = Math.ceil(runs * MAX_INTENT_FRACTION);
  const lines: string[] = [
    'You are a test scenario generator for a conversational AI bot.',
    '',
    `**Bot project:** ${domain.projectName}`,
    `**Bot description / welcome message:** ${domainSource}`,
    '',
    '**Your task:** Generate a JSON array of conversation scenarios. Each scenario describes a simulated user persona who will interact with the bot.',
    '',
    `**Number of scenarios to generate:** ${runs}`,
    '',
    '**Behavioral profile (preset):**',
    presetText,
    '',
    '**Intent distribution rules:**',
    `- Spread scenarios across the bot's inferred intents for variety.`,
    `- No single intent may appear in more than ${maxPerIntent} scenarios (${Math.round(MAX_INTENT_FRACTION * 100)}% cap).`,
    '- Infer likely intents from the bot description above.',
    '',
    '**Output format:**',
    'Reply with a JSON array only — no markdown fences, no prose before or after.',
    'Each element must have exactly these fields:',
    '- "intent": string — the inferred intent this scenario exercises',
    '- "persona": string — short persona description (e.g. "Frustrated small-business owner")',
    '- "goal": string — what the persona wants to achieve',
    '- "behavior": string — how the persona behaves (tone, verbosity, mood)',
    '- "endCondition": string — when the persona should end the conversation',
  ];

  if (instructions) {
    lines.push('', '**Additional instructions from the operator:**', instructions);
  }

  return lines.join('\n');
}

/**
 * Format a conversation history for inclusion in a persona prompt.
 */
export function formatHistory(messages: Array<{ role: 'user' | 'agent'; text: string }>): string {
  if (messages.length === 0) {
    return '(No messages yet — this is the start of the conversation.)';
  }

  return messages
    .map((m) => {
      const label = m.role === 'user' ? 'User' : 'Agent';
      return `${label}: ${m.text}`;
    })
    .join('\n');
}

/**
 * Build the system prompt for a persona user turn (Prompt B).
 *
 * Given the scenario and the conversation history so far, returns the
 * system prompt that instructs the LLM to produce the next user utterance
 * or the [END_CONVERSATION] sentinel.
 */
export function buildPersonaPrompt(
  scenario: Scenario,
  history: Array<{ role: 'user' | 'agent'; text: string }>,
): LLMMessage[] {
  const system =
    'You are role-playing as a user persona interacting with a customer support bot.\n\n' +
    `**Persona:** ${scenario.persona}\n` +
    `**Goal:** ${scenario.goal}\n` +
    `**Behavior:** ${scenario.behavior}\n` +
    `**End condition:** ${scenario.endCondition}\n\n` +
    'Produce ONLY the next user message — nothing else. Do not include labels like "User:" or quotation marks.\n' +
    'When the end condition is met, output exactly [END_CONVERSATION] instead of a user message.';

  const formattedHistory = formatHistory(history);

  return [
    { role: 'user' as const, content: system },
    {
      role: 'assistant' as const,
      content: 'Understood. I will role-play as this persona. Share the conversation so far.',
    },
    { role: 'user' as const, content: `Conversation so far:\n\n${formattedHistory}` },
  ];
}

/**
 * Detect the [END_CONVERSATION] sentinel in LLM output.
 *
 * Matches case-insensitively, allowing optional space or underscore
 * between "end" and "conversation": [END_CONVERSATION], [end conversation],
 * [End_Conversation], etc.
 *
 * Does NOT match "END CONVERSATION" without brackets.
 */
export function detectEndSentinel(text: string): boolean {
  return /\[end[ _]?conversation\]/i.test(text);
}
