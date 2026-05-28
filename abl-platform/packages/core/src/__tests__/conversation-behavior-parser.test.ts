import { describe, expect, it } from 'vitest';

import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import { parseYamlABL } from '../parser/yaml-parser.js';

describe('Conversation Behavior parsing', () => {
  it('parses agent-level CONVERSATION blocks in legacy ABL', () => {
    const dsl = `
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    style: "warm and concise"
    language_policy: interaction_context
    max_sentences: 2
    tool_results:
      style: top_option_first
      max_points: 2
    handoffs:
      internal: silent
      human: explicit
  listening:
    barge_in: allow
    on_pause: wait_briefly
  interaction:
    answer_shape: answer_first
    clarification:
      mode: ask_only_when_blocked
      max_questions: 1
    confirmation:
      actions: before_sensitive_actions
    closure: summarize_outcome
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.conversation).toEqual({
      speaking: {
        style: 'warm and concise',
        language_policy: 'interaction_context',
        max_sentences: 2,
        tool_results: {
          style: 'top_option_first',
          max_points: 2,
        },
        handoffs: {
          internal: 'silent',
          human: 'explicit',
        },
      },
      listening: {
        barge_in: 'allow',
        on_pause: 'wait_briefly',
      },
      interaction: {
        answer_shape: 'answer_first',
        clarification: {
          mode: 'ask_only_when_blocked',
          max_questions: 1,
        },
        confirmation: {
          actions: 'before_sensitive_actions',
        },
        closure: 'summarize_outcome',
      },
    });
  });

  it('parses standalone behavior profile CONVERSATION blocks', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_profile

PRIORITY: 10
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    tool_lead_in: brief
  interaction:
    detail: expandable
    repair:
      on_confusion: rephrase_briefly
      max_attempts: 2
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.behaviorProfile?.conversation).toEqual({
      speaking: {
        tool_lead_in: 'brief',
      },
      interaction: {
        detail: 'expandable',
        repair: {
          on_confusion: 'rephrase_briefly',
          max_attempts: 2,
        },
      },
    });
  });

  it('does not let inline behavior profile CONVERSATION consume later agent sections', () => {
    const dsl = `
AGENT: TravelAssistant
GOAL: "Help with travel booking"

BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"
CONVERSATION:
  speaking:
    style: warm

TOOLS:
  search_flights(origin: string) -> object
    description: "Search flights"
    type: http
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.inlineBehaviorProfiles).toHaveLength(1);
    expect(result.document?.inlineBehaviorProfiles?.[0].conversation).toEqual({
      speaking: {
        style: 'warm',
      },
    });
    expect(result.document?.inlineBehaviorProfiles?.[0].tools).toBeUndefined();
    expect(result.document?.tools).toHaveLength(1);
    expect(result.document?.tools?.[0].name).toBe('search_flights');
  });

  it('does not let inline behavior profile CONVERSATION consume a later agent CONVERSATION block', () => {
    const dsl = `
AGENT: TravelAssistant
GOAL: "Help with travel booking"

BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"
CONVERSATION:
  speaking:
    style: warm

CONVERSATION:
  speaking:
    tone: reassuring
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.inlineBehaviorProfiles).toHaveLength(1);
    expect(result.document?.inlineBehaviorProfiles?.[0].conversation).toEqual({
      speaking: {
        style: 'warm',
      },
    });
    expect(result.document?.conversation).toEqual({
      speaking: {
        tone: 'reassuring',
      },
    });
  });

  it('parses YAML conversation blocks', () => {
    const yaml = `
agent: TravelAssistant
goal: "Help with travel booking"
conversation:
  speaking:
    tone: reassuring
    one_thing_at_a_time: true
  interaction:
    uncertainty:
      mode: say_when_unsure
      offer_next_step: true
`;

    const result = parseYamlABL(yaml);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.conversation).toEqual({
      speaking: {
        tone: 'reassuring',
        one_thing_at_a_time: true,
      },
      interaction: {
        uncertainty: {
          mode: 'say_when_unsure',
          offer_next_step: true,
        },
      },
    });
  });

  it('rejects unknown CONVERSATION fields', () => {
    const dsl = `
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    voice_id: marina
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).not.toHaveLength(0);
    expect(result.errors[0].message).toContain(
      'CONVERSATION.speaking.voice_id is not a supported Conversation Behavior field.',
    );
  });

  it('reports behavior profile CONVERSATION diagnostics on the section header line', () => {
    const dsl = [
      'BEHAVIOR_PROFILE: voice_profile',
      '',
      'PRIORITY: 10',
      'WHEN: channel.name == "voice"',
      '',
      'CONVERSATION:',
      '  speaking:',
      '    voice_id: marina',
    ].join('\n');

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).not.toHaveLength(0);
    expect(result.errors[0].message).toContain(
      'CONVERSATION.speaking.voice_id is not a supported Conversation Behavior field.',
    );
    expect(result.errors[0].line).toBe(6);
  });
});
