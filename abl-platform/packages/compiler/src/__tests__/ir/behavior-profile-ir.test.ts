/**
 * Tests for BehaviorProfileIR types in the IR schema.
 *
 * Verifies that behavior profile types can be constructed,
 * attached to AgentIR, and all fields/variants are correct.
 */

import { describe, test, expect } from 'vitest';
import type {
  AgentIR,
  BehaviorProfileIR,
  ResponseRulesIR,
  GatherProfileOverrides,
  GatherFieldProfileOverride,
  FlowModificationsIR,
  FlowStepOverrideIR,
  FlowInsertionIR,
  VoiceConfigIR,
  RichContentIR,
  ActionSetIR,
  Constraint,
  ToolDefinition,
  FlowStep,
} from '../../platform/ir/schema.js';

describe('BehaviorProfileIR', () => {
  test('can construct a minimal BehaviorProfileIR with required fields only', () => {
    const profile: BehaviorProfileIR = {
      name: 'voice-channel',
      priority: 10,
      when: 'context.channel == "voice"',
    };

    expect(profile.name).toBe('voice-channel');
    expect(profile.priority).toBe(10);
    expect(profile.when).toBe('context.channel == "voice"');
    expect(profile.instructions).toBeUndefined();
    expect(profile.voice).toBeUndefined();
    expect(profile.response_rules).toBeUndefined();
    expect(profile.constraints).toBeUndefined();
    expect(profile.tools_hide).toBeUndefined();
    expect(profile.tools_add).toBeUndefined();
    expect(profile.gather_overrides).toBeUndefined();
    expect(profile.flow_modifications).toBeUndefined();
    expect(profile.flow_replace).toBeUndefined();
  });

  test('can construct a BehaviorProfileIR with all optional fields', () => {
    const constraint: Constraint = {
      condition: 'len(response) < 200',
      on_fail: { type: 'respond', message: 'Keep it short' },
    };

    const toolDef: ToolDefinition = {
      name: 'send_sms',
      description: 'Send an SMS message',
      parameters: [{ name: 'phone', type: 'string', required: true }],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: true,
        requires_auth: true,
      },
    };

    const voiceConfig: VoiceConfigIR = {
      provider: 'elevenlabs',
      voice_id: 'aria',
      speed: 1.1,
    };

    const richContent: RichContentIR = {
      type: 'card',
      payload: { title: 'Summary', body: 'Done' },
    };

    const actionSet: ActionSetIR = {
      actions: [{ type: 'set', key: 'confirmed', value: 'true' }],
    };

    const flowStep: FlowStep = {
      name: 'sms_confirm',
      respond: 'SMS sent successfully.',
      then: 'done',
    };

    const profile: BehaviorProfileIR = {
      name: 'whatsapp-vip',
      priority: 50,
      when: 'context.channel == "whatsapp" && caller.tier == "vip"',
      instructions: 'Be concise and use rich media.',
      voice: voiceConfig,
      response_rules: {
        max_buttons: 3,
        fallback_format: 'plain_text',
        media_types: ['image', 'video'],
        max_response_length: 500,
      },
      constraints: [constraint],
      tools_hide: ['internal_debug'],
      tools_add: [toolDef],
      gather_overrides: {
        validation_style: 'lenient',
        confirmation: 'on_change',
        field_overrides: {
          email: {
            prompt: 'Please share your email',
            extraction_hints: ['email', 'e-mail'],
            skip: false,
            required: true,
            validation: 'email_format',
          },
        },
      },
      flow_modifications: {
        skip: ['intro_step'],
        overrides: {
          greeting_step: {
            respond: 'Welcome, VIP!',
            voice: voiceConfig,
            rich_content: richContent,
            transition: 'vip_menu',
            actions: actionSet,
          },
        },
        insertions: [
          {
            position: 'after',
            target_step: 'greeting_step',
            step: flowStep,
          },
        ],
      },
    };

    expect(profile.name).toBe('whatsapp-vip');
    expect(profile.priority).toBe(50);
    expect(profile.instructions).toBe('Be concise and use rich media.');
    expect(profile.voice?.provider).toBe('elevenlabs');
    expect(profile.response_rules?.max_buttons).toBe(3);
    expect(profile.constraints).toHaveLength(1);
    expect(profile.tools_hide).toEqual(['internal_debug']);
    expect(profile.tools_add).toHaveLength(1);
    expect(profile.gather_overrides?.field_overrides?.email?.prompt).toBe(
      'Please share your email',
    );
    expect(profile.flow_modifications?.skip).toEqual(['intro_step']);
    expect(profile.flow_modifications?.overrides?.greeting_step?.respond).toBe('Welcome, VIP!');
    expect(profile.flow_modifications?.insertions?.[0].position).toBe('after');
  });

  test('can attach behavior_profiles to an AgentIR', () => {
    const profiles: BehaviorProfileIR[] = [
      { name: 'voice', priority: 10, when: 'context.channel == "voice"' },
      { name: 'whatsapp', priority: 20, when: 'context.channel == "whatsapp"' },
    ];

    // Verify the type allows behavior_profiles on AgentIR
    const partialAgent: Pick<AgentIR, 'behavior_profiles'> = {
      behavior_profiles: profiles,
    };

    expect(partialAgent.behavior_profiles).toHaveLength(2);
    expect(partialAgent.behavior_profiles![0].name).toBe('voice');
    expect(partialAgent.behavior_profiles![1].name).toBe('whatsapp');
  });

  test('behavior_profiles is optional on AgentIR', () => {
    const partialAgent: Pick<AgentIR, 'behavior_profiles'> = {};
    expect(partialAgent.behavior_profiles).toBeUndefined();
  });

  test('flow_replace and flow_modifications are both optional', () => {
    const profileNoFlow: BehaviorProfileIR = {
      name: 'no-flow-changes',
      priority: 1,
      when: 'true',
    };
    expect(profileNoFlow.flow_replace).toBeUndefined();
    expect(profileNoFlow.flow_modifications).toBeUndefined();

    const profileWithReplace: BehaviorProfileIR = {
      name: 'replace-flow',
      priority: 2,
      when: 'context.channel == "voice"',
      flow_replace: 'voice_flow',
    };
    expect(profileWithReplace.flow_replace).toBe('voice_flow');
    expect(profileWithReplace.flow_modifications).toBeUndefined();

    const profileWithMods: BehaviorProfileIR = {
      name: 'modify-flow',
      priority: 3,
      when: 'context.channel == "web"',
      flow_modifications: { skip: ['step_a'] },
    };
    expect(profileWithMods.flow_modifications?.skip).toEqual(['step_a']);
    expect(profileWithMods.flow_replace).toBeUndefined();
  });

  test('ResponseRulesIR fallback_format accepts the 3 valid values', () => {
    const plainText: ResponseRulesIR = { fallback_format: 'plain_text' };
    const markdown: ResponseRulesIR = { fallback_format: 'markdown' };
    const html: ResponseRulesIR = { fallback_format: 'html' };

    expect(plainText.fallback_format).toBe('plain_text');
    expect(markdown.fallback_format).toBe('markdown');
    expect(html.fallback_format).toBe('html');
  });

  test('GatherProfileOverrides validation_style accepts strict and lenient', () => {
    const strict: GatherProfileOverrides = { validation_style: 'strict' };
    const lenient: GatherProfileOverrides = { validation_style: 'lenient' };

    expect(strict.validation_style).toBe('strict');
    expect(lenient.validation_style).toBe('lenient');
  });

  test('GatherProfileOverrides confirmation accepts all 3 values', () => {
    const always: GatherProfileOverrides = { confirmation: 'always' };
    const never: GatherProfileOverrides = { confirmation: 'never' };
    const onChange: GatherProfileOverrides = { confirmation: 'on_change' };

    expect(always.confirmation).toBe('always');
    expect(never.confirmation).toBe('never');
    expect(onChange.confirmation).toBe('on_change');
  });

  test('FlowInsertionIR position accepts before and after', () => {
    const beforeInsertion: FlowInsertionIR = {
      position: 'before',
      target_step: 'step_a',
      step: { name: 'new_step', respond: 'Hello' },
    };
    const afterInsertion: FlowInsertionIR = {
      position: 'after',
      target_step: 'step_b',
      step: { name: 'another_step', respond: 'Goodbye' },
    };

    expect(beforeInsertion.position).toBe('before');
    expect(afterInsertion.position).toBe('after');
  });

  test('GatherFieldProfileOverride all fields are optional', () => {
    const empty: GatherFieldProfileOverride = {};
    expect(empty.prompt).toBeUndefined();
    expect(empty.extraction_hints).toBeUndefined();
    expect(empty.skip).toBeUndefined();
    expect(empty.required).toBeUndefined();
    expect(empty.validation).toBeUndefined();

    const full: GatherFieldProfileOverride = {
      prompt: 'Enter your name',
      extraction_hints: ['first name', 'full name'],
      skip: false,
      required: true,
      validation: 'non_empty',
    };
    expect(full.prompt).toBe('Enter your name');
    expect(full.extraction_hints).toHaveLength(2);
  });
});
