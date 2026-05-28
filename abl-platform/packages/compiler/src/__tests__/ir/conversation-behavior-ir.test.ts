import { describe, expect, it } from 'vitest';

import { parseAgentBasedABL } from '@abl/core';

import { compileBehaviorProfile } from '../../platform/ir/compile-behavior-profile.js';
import {
  compileABLtoIR,
  resolveConfigVariables,
  resolveEnvVariables,
} from '../../platform/ir/compiler.js';

describe('Conversation Behavior IR lowering', () => {
  it('compiles agent-level Conversation Behavior into AgentIR', () => {
    const result = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    style: "warm and concise"
    language_policy: interaction_context
    tool_results:
      style: top_option_first
      max_points: 2
    handoffs:
      internal: silent
      human: explicit
  listening:
    barge_in: allow
    on_unclear_audio: ask_to_repeat_or_confirm
  interaction:
    answer_shape: answer_first
    confirmation:
      parameters: when_ambiguous
      actions: before_sensitive_actions
    repair:
      on_misheard: confirm_best_guess
      max_attempts: 2
`);

    expect(result.errors).toHaveLength(0);

    const output = compileABLtoIR([result.document!]);
    const ir = output.agents['TravelAssistant'];

    expect(output.compilation_errors ?? []).toHaveLength(0);
    expect(ir.conversation_behavior).toEqual({
      speaking: {
        style: 'warm and concise',
        language_policy: 'interaction_context',
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
        on_unclear_audio: 'ask_to_repeat_or_confirm',
      },
      interaction: {
        answer_shape: 'answer_first',
        confirmation: {
          parameters: 'when_ambiguous',
          actions: 'before_sensitive_actions',
        },
        repair: {
          on_misheard: 'confirm_best_guess',
          max_attempts: 2,
        },
      },
    });
  });

  it('compiles behavior-profile Conversation Behavior into BehaviorProfileIR', () => {
    const result = parseAgentBasedABL(`
BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    tool_lead_in: brief
  interaction:
    detail: expandable
    closure: summarize_outcome
`);

    expect(result.errors).toHaveLength(0);

    const { profile, errors } = compileBehaviorProfile(result.document!);

    expect(errors).toHaveLength(0);
    expect(profile.conversation_behavior).toEqual({
      speaking: {
        tool_lead_in: 'brief',
      },
      interaction: {
        detail: 'expandable',
        closure: 'summarize_outcome',
      },
    });
  });

  it('preserves full behavior-profile Conversation Behavior fields in BehaviorProfileIR', () => {
    const result = parseAgentBasedABL(`
BEHAVIOR_PROFILE: chat_support
PRIORITY: 10
WHEN: true

CONVERSATION:
  speaking:
    style: "Professional and elaborate"
    tone: Friendly
    emotion: Calm
    pace: Steady
    language_policy: interaction_context
    one_thing_at_a_time: false
    tool_lead_in: explained
    tool_results:
      style: top_option_first
    handoffs:
      internal: explicit
  interaction:
    answer_shape: answer_first
    detail: concise
    initiative: guided
    empathy: acknowledge_when_emotional
    closure: summarize_outcome
    grounding:
      mode: acknowledge_then_answer
    clarification:
      mode: ask_to_disambiguate
      max_questions: 2
      assume_when_low_risk: false
    confirmation:
      parameters: when_ambiguous
      actions: before_sensitive_actions
    uncertainty:
      mode: say_when_unsure
      offer_next_step: true
    repair:
      on_correction: confirm_and_update
      on_confusion: rephrase_briefly
      on_misheard: ask_to_repeat
      max_attempts: 2
    context:
      avoid_reasking: false
      remember_recent_constraints: true
`);

    expect(result.errors).toHaveLength(0);

    const { profile, errors } = compileBehaviorProfile(result.document!);

    expect(errors).toHaveLength(0);
    expect(profile.conversation_behavior).toMatchObject({
      speaking: {
        style: 'Professional and elaborate',
        tone: 'Friendly',
        emotion: 'Calm',
        pace: 'Steady',
        language_policy: 'interaction_context',
        one_thing_at_a_time: false,
        tool_lead_in: 'explained',
        tool_results: {
          style: 'top_option_first',
        },
        handoffs: {
          internal: 'explicit',
        },
      },
      interaction: {
        answer_shape: 'answer_first',
        detail: 'concise',
        initiative: 'guided',
        empathy: 'acknowledge_when_emotional',
        closure: 'summarize_outcome',
        grounding: {
          mode: 'acknowledge_then_answer',
        },
        clarification: {
          mode: 'ask_to_disambiguate',
          max_questions: 2,
          assume_when_low_risk: false,
        },
        confirmation: {
          parameters: 'when_ambiguous',
          actions: 'before_sensitive_actions',
        },
        uncertainty: {
          mode: 'say_when_unsure',
          offer_next_step: true,
        },
        repair: {
          on_correction: 'confirm_and_update',
          on_confusion: 'rephrase_briefly',
          on_misheard: 'ask_to_repeat',
          max_attempts: 2,
        },
        context: {
          avoid_reasking: false,
          remember_recent_constraints: true,
        },
      },
    });
  });

  it('compiles launch readback and vocabulary asset refs', () => {
    const result = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    readback:
      numbers: digit_by_digit
      codes: spell_out
      critical_details: confirm_explicitly
    phrases_ref: "assets/phrases/travel.yaml"
    pronunciations_ref: "assets/pronunciations/travel.yaml"
`);

    expect(result.errors).toHaveLength(0);

    const output = compileABLtoIR([result.document!]);
    const travelAssistant = output.agents['TravelAssistant'];

    expect(output.compilation_errors ?? []).toHaveLength(0);
    expect(travelAssistant.conversation_behavior?.speaking).toMatchObject({
      readback: {
        numbers: 'digit_by_digit',
        codes: 'spell_out',
        critical_details: 'confirm_explicitly',
      },
      phrases_ref: 'assets/phrases/travel.yaml',
      pronunciations_ref: 'assets/pronunciations/travel.yaml',
    });
  });

  it('rejects explicitly deferred phase-1 fields with explicit diagnostics', () => {
    const result = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    variety: natural
  listening:
    backchannels: brief
    use_audio_cues: enabled
  interaction:
    adaptation:
      mode: mirror_user
    flow_mode: troubleshooting
`);

    expect(result.errors).toHaveLength(0);

    const output = compileABLtoIR([result.document!]);

    expect(output.compilation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONVERSATION_DEFERRED_FIELD',
          path: 'speaking.variety',
        }),
        expect.objectContaining({
          code: 'CONVERSATION_DEFERRED_FIELD',
          path: 'listening.backchannels',
        }),
        expect.objectContaining({
          code: 'CONVERSATION_DEFERRED_FIELD',
          path: 'listening.use_audio_cues',
        }),
        expect.objectContaining({
          code: 'CONVERSATION_DEFERRED_FIELD',
          path: 'interaction.adaptation',
        }),
        expect.objectContaining({
          code: 'CONVERSATION_DEFERRED_FIELD',
          path: 'interaction.flow_mode',
        }),
      ]),
    );
  });

  it('rejects invalid language policy combinations', () => {
    const result = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

CONVERSATION:
  speaking:
    fixed_language: en-US
`);

    expect(result.errors).toHaveLength(0);

    const output = compileABLtoIR([result.document!]);

    expect(output.compilation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONVERSATION_INVALID_COMBINATION',
          path: 'speaking.fixed_language',
        }),
      ]),
    );
  });

  it('resolves config placeholders inside profile conversation behavior', () => {
    const profileResult = parseAgentBasedABL(`
BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    style: "{{config.VOICE_STYLE}}"
`);
    const agentResult = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

USE BEHAVIOR_PROFILE: voice_profile
`);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    const output = compileABLtoIR([profileResult.document!, agentResult.document!]);
    const ir = output.agents['TravelAssistant'];
    const resolution = resolveConfigVariables(ir, { VOICE_STYLE: 'warm and concise' });

    expect(resolution.errors).toHaveLength(0);
    expect(ir.behavior_profiles?.[0].conversation_behavior?.speaking?.style).toBe(
      'warm and concise',
    );
  });

  it('resolves env placeholders inside profile conversation behavior', () => {
    const profileResult = parseAgentBasedABL(`
BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    tone: "{{env.VOICE_TONE}}"
`);
    const agentResult = parseAgentBasedABL(`
AGENT: TravelAssistant
GOAL: "Help with travel booking"

USE BEHAVIOR_PROFILE: voice_profile
`);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    const output = compileABLtoIR([profileResult.document!, agentResult.document!]);
    const ir = output.agents['TravelAssistant'];
    const resolution = resolveEnvVariables(ir, { VOICE_TONE: 'reassuring' });

    expect(resolution.errors).toHaveLength(0);
    expect(ir.behavior_profiles?.[0].conversation_behavior?.speaking?.tone).toBe('reassuring');
  });
});
