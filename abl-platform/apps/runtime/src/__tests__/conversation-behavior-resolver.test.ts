import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileBehaviorProfile } from '@abl/compiler';
import type { BehaviorProfileIR } from '@abl/compiler';
import {
  buildConversationBehaviorTraceSummary,
  buildConversationBehaviorPromptLines,
  resolveConversationBehavior,
  resolveConversationBehaviorVoiceRuntimeConfig,
} from '../services/execution/conversation-behavior-resolver.js';

function makeProfile(
  overrides: Partial<BehaviorProfileIR> & { name: string; when: string },
): BehaviorProfileIR {
  return {
    priority: 50,
    ...overrides,
  };
}

describe('conversation behavior resolver', () => {
  it('merges base behavior with active profile overrides and preserves source order', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'voice',
      baseBehavior: {
        speaking: {
          style: 'warm and concise',
          max_sentences: 2,
          tool_results: {
            style: 'top_option_first',
            max_points: 2,
          },
        },
        interaction: {
          clarification: {
            mode: 'ask_only_when_blocked',
            max_questions: 1,
          },
        },
      },
      activeProfiles: [
        makeProfile({
          name: 'voice_short',
          when: 'channel.name == "voice"',
          conversation_behavior: {
            speaking: {
              max_sentences: 1,
              tool_results: {
                max_points: 1,
              },
            },
            interaction: {
              confirmation: {
                actions: 'before_sensitive_actions',
              },
            },
          },
        }),
      ],
    });

    expect(resolved).toMatchObject({
      speaking: {
        style: 'warm and concise',
        max_sentences: 1,
        tool_results: {
          style: 'top_option_first',
          max_points: 1,
        },
      },
      interaction: {
        clarification: {
          mode: 'ask_only_when_blocked',
          max_questions: 1,
        },
        confirmation: {
          actions: 'before_sensitive_actions',
        },
      },
      sourceChain: ['agent', 'profile:voice_short'],
      capabilityDrops: [],
    });
  });

  it('builds interaction-context aware prompt lines for phase-1 speaking and interaction fields', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'voice',
      baseBehavior: {
        speaking: {
          style: 'warm and concise',
          language_policy: 'interaction_context',
          max_sentences: 2,
          one_thing_at_a_time: true,
          tool_lead_in: 'brief',
          tool_results: {
            style: 'top_option_first',
            max_points: 2,
          },
        },
        interaction: {
          clarification: {
            mode: 'ask_only_when_blocked',
            max_questions: 1,
            assume_when_low_risk: true,
          },
          confirmation: {
            actions: 'before_sensitive_actions',
          },
          closure: 'summarize_outcome',
        },
      },
      activeProfiles: [],
    });

    expect(resolved).toBeDefined();

    const lines = buildConversationBehaviorPromptLines(resolved!, {
      interactionLanguage: 'fr',
      interactionLocale: 'fr-FR',
      interactionTimezone: 'Europe/Paris',
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        'Adopt a warm and concise speaking style.',
        'Match the current interaction language (fr) and respect locale fr-FR and timezone Europe/Paris when phrasing responses.',
        'Keep most replies to 2 sentences or fewer.',
        'Ask for or present one thing at a time.',
        'Use brief tool lead-ins.',
        'Present tool results with top option first.',
        'Limit tool-result summaries to 2 key points.',
        'Clarify using ask only when blocked.',
        'Ask at most 1 clarification question before answering.',
        'Make low-risk assumptions instead of over-clarifying.',
        'Confirm actions before sensitive actions.',
        'Close turns with summarize outcome.',
      ]),
    );
  });

  it('renders all authored profile conversation fields into prompt lines', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'web_chat',
      baseBehavior: undefined,
      activeProfiles: [
        makeProfile({
          name: 'chat_support',
          when: 'true',
          conversation_behavior: {
            speaking: {
              style: 'Professional and elaborate',
              tone: 'Friendly',
              emotion: 'Calm',
              pace: 'Steady',
              language_policy: 'interaction_context',
              one_thing_at_a_time: false,
              tool_lead_in: 'explained',
              tool_results: { style: 'top_option_first' },
              handoffs: { internal: 'explicit' },
            },
            interaction: {
              answer_shape: 'answer_first',
              detail: 'concise',
              initiative: 'guided',
              grounding: { mode: 'acknowledge_then_answer' },
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
              empathy: 'acknowledge_when_emotional',
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
              closure: 'summarize_outcome',
            },
          },
        }),
      ],
    });

    expect(resolved).toBeDefined();

    const lines = buildConversationBehaviorPromptLines(resolved!, {
      interactionLanguage: 'en',
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        'Adopt a Professional and elaborate speaking style.',
        'Use a Friendly tone.',
        'Keep an emotional register that feels Calm.',
        'Maintain a Steady pace.',
        'Match the current interaction language (en).',
        'Use explained tool lead-ins.',
        'Present tool results with top option first.',
        'Internal handoffs should be explicit.',
        'Structure answers with answer first.',
        'Aim for concise detail.',
        'Take a guided level of initiative.',
        'Ground responses with acknowledge then answer.',
        'Clarify using ask to disambiguate.',
        'Ask at most 2 clarification questions before answering.',
        'Confirm parameters when ambiguous.',
        'Confirm actions before sensitive actions.',
        'Handle uncertainty with say when unsure.',
        'When unsure, offer a sensible next step.',
        'Show empathy using acknowledge when emotional.',
        'When corrected, confirm and update.',
        'When the user is confused, rephrase briefly.',
        'If you may have misheard, ask to repeat.',
        'Keep repair attempts to 2 before changing strategy.',
        'Keep recent user constraints in mind as you answer.',
        'Close turns with summarize outcome.',
      ]),
    );
  });

  it('keeps full profile conversation behavior across parser, IR, resolver, and prompt rendering', () => {
    const parsed = parseAgentBasedABL(`
BEHAVIOR_PROFILE: chat_support
PRIORITY: 10
WHEN: true

CONVERSATION:
  speaking:
    style: "Professional and elaborate"
    tone: Friendly
    tool_lead_in: explained
    tool_results:
      style: top_option_first
  interaction:
    answer_shape: answer_first
    detail: concise
    clarification:
      mode: ask_to_disambiguate
      max_questions: 2
    uncertainty:
      mode: say_when_unsure
      offer_next_step: true
`);

    expect(parsed.errors).toHaveLength(0);
    const { profile, errors } = compileBehaviorProfile(parsed.document!);
    expect(errors).toHaveLength(0);

    const resolved = resolveConversationBehavior({
      channelType: 'web_chat',
      activeProfiles: [profile],
    });

    expect(buildConversationBehaviorPromptLines(resolved!)).toEqual(
      expect.arrayContaining([
        'Adopt a Professional and elaborate speaking style.',
        'Use a Friendly tone.',
        'Use explained tool lead-ins.',
        'Present tool results with top option first.',
        'Structure answers with answer first.',
        'Aim for concise detail.',
        'Clarify using ask to disambiguate.',
        'Ask at most 2 clarification questions before answering.',
        'Handle uncertainty with say when unsure.',
        'When unsure, offer a sensible next step.',
      ]),
    );
  });

  it('drops listening-only behavior on non-voice channels and keeps explicit drop diagnostics', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'http',
      baseBehavior: {
        listening: {
          barge_in: 'allow',
          on_pause: 'wait_briefly',
        },
      },
      activeProfiles: [],
    });

    expect(resolved).toEqual({
      sourceChain: ['agent'],
      capabilityDrops: [
        {
          fieldPath: 'listening.barge_in',
          reason: 'voice_channel_required',
          message:
            'Listening behavior requires a voice-capable channel, but "http" is not voice-capable.',
        },
        {
          fieldPath: 'listening.on_pause',
          reason: 'voice_channel_required',
          message:
            'Listening behavior requires a voice-capable channel, but "http" is not voice-capable.',
        },
      ],
    });
  });

  it('preserves launch asset refs and exposes voice runtime controls', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'voice_vxml',
      baseBehavior: {
        speaking: {
          readback: {
            numbers: 'digit_by_digit',
          },
          handoffs: {
            internal: 'silent',
            human: 'explicit',
          },
          phrases_ref: 'assets/phrases/support.yaml',
          pronunciations_ref: 'assets/pronunciations/support.yaml',
        },
        listening: {
          barge_in: 'disallow',
          on_pause: 'wait_briefly',
          on_unclear_audio: 'ask_to_repeat_or_confirm',
        },
      },
      activeProfiles: [],
    });

    expect(resolved?.speaking?.phrases_ref).toBe('assets/phrases/support.yaml');
    expect(resolveConversationBehaviorVoiceRuntimeConfig(resolved)).toMatchObject({
      bargeIn: false,
      bargeInPolicy: 'disallow',
      pauseTimeoutMs: 800,
      onPause: 'wait_briefly',
      onUnclearAudio: 'ask_to_repeat_or_confirm',
      internalHandoffSpeech: 'silent',
      humanHandoffSpeech: 'explicit',
    });

    const traceSummary = buildConversationBehaviorTraceSummary(resolved, {
      interactionLocale: 'en-US',
    });
    expect(traceSummary).toMatchObject({
      phrasesRef: 'assets/phrases/support.yaml',
      pronunciationsRef: 'assets/pronunciations/support.yaml',
      hasReadback: true,
      voiceRuntime: { bargeIn: false, pauseTimeoutMs: 800 },
      interactionContext: { locale: 'en-US' },
    });
  });
});
