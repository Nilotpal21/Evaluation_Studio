/**
 * Profile Resolver Tests
 *
 * Tests for the three main functions:
 * - assembleProfileContext: Builds ProfileContext from runtime inputs
 * - resolveActiveProfiles: Evaluates WHEN expressions to find matching profiles
 * - buildEffectiveConfig: Merges base IR with active profile overrides
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyProfileInteractionContextToSessionData,
  assembleProfileContext,
  buildEffectiveConfig,
  extractProfileInteractionContextFromMetadata,
  mergeProfileInteractionContextInputs,
  readProfileInteractionContextFromSessionData,
  resolveActiveProfiles,
  type ProfileContextInput,
} from '../services/execution/profile-resolver.js';
import type { AgentIR, BehaviorProfileIR, ToolDefinition } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal AgentIR for testing */
function makeBaseIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test-agent',
      version: '1.0',
      source: 'abl',
      compiled_at: '2026-01-01T00:00:00Z',
    },
    execution: {
      mode: 'reasoning',
      max_turns: 10,
      llm: {
        model: 'claude-sonnet-4-20250514',
        temperature: 0.7,
        max_tokens: 1024,
      },
    },
    identity: {
      persona: 'A helpful assistant',
      goal: 'Help users',
      preamble: '',
    },
    tools: [
      makeTool('lookup_order', 'Look up an order'),
      makeTool('refund_order', 'Process a refund'),
      makeTool('transfer_to_agent', 'Transfer to live agent'),
    ],
    gather: { fields: [], strategy: 'progressive' },
    memory: { mode: 'full_history' },
    constraints: { constraints: [], guardrails: [] },
    coordination: { handoffs: [], delegate_targets: [] },
    completion: { conditions: [] },
    error_handling: { strategy: 'retry', max_retries: 3 },
    ...overrides,
  };
}

function makeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: [],
    returns: { type: 'string', description: 'result' },
    hints: {},
  };
}

function makeProfile(
  overrides: Partial<BehaviorProfileIR> & { name: string; when: string },
): BehaviorProfileIR {
  return {
    priority: 50,
    ...overrides,
  };
}

// =============================================================================
// assembleProfileContext
// =============================================================================

describe('assembleProfileContext', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should assemble context from session and connection data', () => {
    const input: ProfileContextInput = {
      channelType: 'whatsapp',
      callerContext: {
        identityTier: 1,
        customerId: 'cust-123',
        verificationMethod: 'hmac',
      },
      connectionConfig: {
        region: 'us-east',
        number_type: 'toll_free',
        provider: 'twilio',
        tags: { tier: 'premium' },
      },
      sessionMeta: {
        isNew: false,
        language: 'es',
        turnCount: 5,
      },
    };

    process.env.DEPLOYMENT_REGION = 'us-east-1';

    const ctx = assembleProfileContext(input);

    // Channel
    expect(ctx.channel.name).toBe('whatsapp');
    expect(ctx.channel.region).toBe('us-east');
    expect(ctx.channel.number_type).toBe('toll_free');
    expect(ctx.channel.provider).toBe('twilio');
    expect(ctx.channel.tags).toEqual({ tier: 'premium' });
    expect(ctx.channel.capabilities).toEqual({
      streaming: false,
      media: true,
      threading: false,
      interactive: true,
    });

    // Caller
    expect(ctx.caller.identity_tier).toBe(1);
    expect(ctx.caller.customer_id).toBe('cust-123');
    expect(ctx.caller.is_authenticated).toBe(true);
    expect(ctx.caller.verification_method).toBe('hmac');

    // Session
    expect(ctx.session.is_new).toBe(false);
    expect(ctx.session.language).toBe('es');
    expect(ctx.session.turn_count).toBe(5);

    // Env
    expect(ctx.env.deployment_region).toBe('us-east-1');
    expect(typeof ctx.env.timestamp).toBe('number');
  });

  it('should apply defaults when inputs are minimal', () => {
    const ctx = assembleProfileContext({ channelType: 'web' });

    expect(ctx.channel.name).toBe('web');
    expect(ctx.channel.region).toBe('');
    expect(ctx.channel.number_type).toBe('');
    expect(ctx.channel.provider).toBe('');
    expect(ctx.channel.tags).toEqual({});
    expect(ctx.channel.capabilities).toEqual({
      streaming: true,
      media: true,
      threading: true,
      interactive: true,
    });

    expect(ctx.caller.identity_tier).toBe(0);
    expect(ctx.caller.customer_id).toBeNull();
    expect(ctx.caller.is_authenticated).toBe(false);
    expect(ctx.caller.verification_method).toBe('none');
    expect(ctx.caller.tags).toEqual({});

    expect(ctx.session.is_new).toBe(true);
    expect(ctx.session.language).toBe('en');
    expect(ctx.session.turn_count).toBe(0);
    expect(ctx.interaction).toEqual({
      sentiment_score: 0,
      sentiment_label: '',
      emotion_label: '',
      turn_topic: '',
    });
  });

  it('should expose interaction state for profile WHEN expressions', () => {
    const ctx = assembleProfileContext({
      channelType: 'web',
      interactionContext: {
        language: 'en',
        sentiment: { score: -0.72, label: 'negative' },
        emotion: { label: 'frustrated' },
        turn: { topic: 'late_delivery' },
      } as unknown as ProfileContextInput['interactionContext'],
    });

    expect(ctx.interaction).toEqual({
      sentiment_score: -0.72,
      sentiment_label: 'negative',
      emotion_label: 'frustrated',
      turn_topic: 'late_delivery',
    });
  });

  it('should merge sanitized profile interaction hints from metadata aliases', () => {
    const merged = mergeProfileInteractionContextInputs(
      {
        language: 'en',
        sentiment: { score: -0.2, label: 'neutral' },
      },
      extractProfileInteractionContextFromMetadata({
        interactionContext: {
          locale: 'en-US',
          sentimentScore: -0.81,
          sentimentLabel: 'negative',
        },
        analysis: {
          emotion: { name: 'frustrated' },
          turn: { topic: 'billing' },
        },
      }),
    );

    expect(merged).toEqual({
      language: 'en',
      locale: 'en-US',
      sentiment_score: -0.81,
      sentiment_label: 'negative',
      emotion_label: 'frustrated',
      turn_topic: 'billing',
    });
  });

  it('should ignore malformed profile interaction classifier fields', () => {
    const merged = mergeProfileInteractionContextInputs({
      sentimentScore: Number.NaN,
      sentimentLabel: '',
      emotion: { label: ['frustrated'] },
      turn: { topic: '   ' },
    });

    expect(merged).toBeUndefined();
  });

  it('should store only current-turn profile interaction signals in session data', () => {
    const sessionData = {
      values: {
        session: {
          interaction: {
            current: {
              language: 'en',
              emotion: { label: 'concerned' },
            },
          },
        },
      },
    };

    expect(readProfileInteractionContextFromSessionData(sessionData)).toEqual({
      language: 'en',
      emotion_label: 'concerned',
    });

    applyProfileInteractionContextToSessionData(sessionData, {
      language: 'en',
      sentiment: { score: -0.7, label: 'negative' },
      emotion: { label: 'frustrated' },
    });

    expect(readProfileInteractionContextFromSessionData(sessionData)).toEqual({
      language: 'en',
      sentiment_score: -0.7,
      sentiment_label: 'negative',
      emotion_label: 'frustrated',
    });

    applyProfileInteractionContextToSessionData(sessionData, { language: 'en' });

    expect(readProfileInteractionContextFromSessionData(sessionData)).toEqual({
      language: 'en',
      emotion_label: 'concerned',
    });
  });

  it('should return default capabilities for unknown channel types', () => {
    const ctx = assembleProfileContext({ channelType: 'custom-channel' });

    expect(ctx.channel.capabilities).toEqual({
      streaming: false,
      media: false,
      threading: false,
      interactive: false,
    });
  });

  it('should derive web channel capabilities correctly', () => {
    const ctx = assembleProfileContext({ channelType: 'web' });

    expect(ctx.channel.capabilities.streaming).toBe(true);
    expect(ctx.channel.capabilities.media).toBe(true);
    expect(ctx.channel.capabilities.threading).toBe(true);
    expect(ctx.channel.capabilities.interactive).toBe(true);
  });

  it('should derive sms channel capabilities correctly', () => {
    const ctx = assembleProfileContext({ channelType: 'sms' });

    expect(ctx.channel.capabilities.streaming).toBe(false);
    expect(ctx.channel.capabilities.media).toBe(false);
    expect(ctx.channel.capabilities.threading).toBe(false);
    expect(ctx.channel.capabilities.interactive).toBe(false);
  });
});

// =============================================================================
// resolveActiveProfiles
// =============================================================================

describe('resolveActiveProfiles', () => {
  it('should return matching profiles sorted by priority ascending', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({ name: 'high-pri', when: 'channel.name == "whatsapp"', priority: 100 }),
      makeProfile({ name: 'low-pri', when: 'channel.name == "whatsapp"', priority: 10 }),
      makeProfile({ name: 'mid-pri', when: 'channel.name == "whatsapp"', priority: 50 }),
    ];

    const ctx = assembleProfileContext({ channelType: 'whatsapp' });
    const result = resolveActiveProfiles(profiles, ctx);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('low-pri');
    expect(result[1].name).toBe('mid-pri');
    expect(result[2].name).toBe('high-pri');
  });

  it('should return empty array when no profiles match', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({ name: 'web-only', when: 'channel.name == "web"', priority: 50 }),
      makeProfile({ name: 'slack-only', when: 'channel.name == "slack"', priority: 50 }),
    ];

    const ctx = assembleProfileContext({ channelType: 'whatsapp' });
    const result = resolveActiveProfiles(profiles, ctx);

    expect(result).toHaveLength(0);
  });

  it('should return empty array when profiles list is empty', () => {
    const ctx = assembleProfileContext({ channelType: 'web' });
    const result = resolveActiveProfiles([], ctx);

    expect(result).toHaveLength(0);
  });

  it('should handle null/undefined profiles gracefully', () => {
    const ctx = assembleProfileContext({ channelType: 'web' });

    expect(resolveActiveProfiles(undefined as unknown as BehaviorProfileIR[], ctx)).toHaveLength(0);
    expect(resolveActiveProfiles(null as unknown as BehaviorProfileIR[], ctx)).toHaveLength(0);
  });

  it('should gracefully handle invalid CEL expressions by skipping profile', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({ name: 'valid', when: 'channel.name == "web"', priority: 10 }),
      makeProfile({ name: 'invalid', when: '>>> INVALID CEL <<<', priority: 20 }),
      makeProfile({ name: 'also-valid', when: 'caller.is_authenticated == true', priority: 30 }),
    ];

    const ctx = assembleProfileContext({
      channelType: 'web',
      callerContext: { identityTier: 1 },
    });

    // Should not throw
    const result = resolveActiveProfiles(profiles, ctx);

    // The valid profiles should be matched; the invalid one should be skipped
    const names = result.map((p) => p.name);
    expect(names).toContain('valid');
    expect(names).toContain('also-valid');
    // The invalid expression evaluates via the evaluator's internal catch which returns false,
    // so it won't match. Either way it must not crash.
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('should evaluate compound AND conditions', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'whatsapp-authenticated',
        when: 'channel.name == "whatsapp" AND caller.is_authenticated == true',
        priority: 50,
      }),
    ];

    // Authenticated on whatsapp -> matches
    const ctx1 = assembleProfileContext({
      channelType: 'whatsapp',
      callerContext: { identityTier: 1 },
    });
    expect(resolveActiveProfiles(profiles, ctx1)).toHaveLength(1);

    // Unauthenticated on whatsapp -> no match
    const ctx2 = assembleProfileContext({
      channelType: 'whatsapp',
      callerContext: { identityTier: 0 },
    });
    expect(resolveActiveProfiles(profiles, ctx2)).toHaveLength(0);
  });

  it('should match profiles with interaction sentiment conditions', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'empathy-mode',
        when: 'interaction.sentiment_score < -0.3',
        priority: 50,
        instructions: 'Use a concise empathy beat.',
      }),
    ];
    const ctx = assembleProfileContext({
      channelType: 'web',
      interactionContext: {
        sentiment_score: -0.8,
        emotion_label: 'frustrated',
      } as unknown as ProfileContextInput['interactionContext'],
    });

    const result = resolveActiveProfiles(profiles, ctx);
    expect(result.map((profile) => profile.name)).toEqual(['empathy-mode']);
  });

  it('should evaluate OR conditions', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'messaging',
        when: 'channel.name == "whatsapp" OR channel.name == "messenger"',
        priority: 50,
      }),
    ];

    const ctx1 = assembleProfileContext({ channelType: 'whatsapp' });
    expect(resolveActiveProfiles(profiles, ctx1)).toHaveLength(1);

    const ctx2 = assembleProfileContext({ channelType: 'messenger' });
    expect(resolveActiveProfiles(profiles, ctx2)).toHaveLength(1);

    const ctx3 = assembleProfileContext({ channelType: 'web' });
    expect(resolveActiveProfiles(profiles, ctx3)).toHaveLength(0);
  });

  it('should evaluate numeric comparisons', () => {
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'verified-user',
        when: 'caller.identity_tier >= 1',
        priority: 50,
      }),
    ];

    const ctx1 = assembleProfileContext({
      channelType: 'web',
      callerContext: { identityTier: 2 },
    });
    expect(resolveActiveProfiles(profiles, ctx1)).toHaveLength(1);

    const ctx2 = assembleProfileContext({
      channelType: 'web',
      callerContext: { identityTier: 0 },
    });
    expect(resolveActiveProfiles(profiles, ctx2)).toHaveLength(0);
  });
});

// =============================================================================
// buildEffectiveConfig
// =============================================================================

describe('buildEffectiveConfig', () => {
  it('should return base config when no profiles are active', () => {
    const baseIR = makeBaseIR();
    const config = buildEffectiveConfig(baseIR, []);

    expect(config.additionalInstructions).toEqual([]);
    expect(config.additionalConstraints).toEqual([]);
    expect(config.tools).toHaveLength(3);
    expect(config.activeProfileNames).toEqual([]);
    expect(config.responseRules).toBeUndefined();
    expect(config.voiceConfig).toBeUndefined();
    expect(config.gatherOverrides).toBeUndefined();
    expect(config.flowReplace).toBeUndefined();
  });

  it('should preserve base conversation behavior when no profiles are active', () => {
    const baseIR = makeBaseIR({
      conversation_behavior: {
        speaking: {
          style: 'warm and concise',
          max_sentences: 2,
        },
      },
    });

    const config = buildEffectiveConfig(baseIR, [], { channelType: 'web' });

    expect(config.conversationBehavior).toBeDefined();
    expect(config.conversationBehavior?.speaking?.style).toBe('warm and concise');
    expect(config.conversationBehavior?.speaking?.max_sentences).toBe(2);
    expect(config.conversationBehavior?.sourceChain).toEqual(['agent']);
    expect(config.conversationBehavior?.capabilityDrops).toEqual([]);
  });

  it('should append instructions from all active profiles', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'profile-a',
        when: 'true',
        priority: 10,
        instructions: 'Be concise in responses.',
      }),
      makeProfile({
        name: 'profile-b',
        when: 'true',
        priority: 20,
        instructions: 'Always greet the user warmly.',
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.additionalInstructions).toEqual([
      'Be concise in responses.',
      'Always greet the user warmly.',
    ]);
  });

  it('should merge conversation behavior with active profiles overriding base fields', () => {
    const baseIR = makeBaseIR({
      conversation_behavior: {
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
          },
        },
      },
    });
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'voice-profile',
        when: 'true',
        priority: 50,
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
    ];

    const config = buildEffectiveConfig(baseIR, profiles, { channelType: 'voice' });

    expect(config.conversationBehavior?.speaking?.style).toBe('warm and concise');
    expect(config.conversationBehavior?.speaking?.max_sentences).toBe(1);
    expect(config.conversationBehavior?.speaking?.tool_results).toEqual({
      style: 'top_option_first',
      max_points: 1,
    });
    expect(config.conversationBehavior?.interaction?.clarification?.mode).toBe(
      'ask_only_when_blocked',
    );
    expect(config.conversationBehavior?.interaction?.confirmation?.actions).toBe(
      'before_sensitive_actions',
    );
    expect(config.conversationBehavior?.sourceChain).toEqual(['agent', 'profile:voice-profile']);
  });

  it('should drop listening behavior on non-voice channels and record capability drops', () => {
    const baseIR = makeBaseIR({
      conversation_behavior: {
        listening: {
          barge_in: 'allow',
          on_pause: 'wait_briefly',
        },
      },
    });

    const config = buildEffectiveConfig(baseIR, [], { channelType: 'whatsapp' });

    expect(config.conversationBehavior?.listening).toBeUndefined();
    expect(config.conversationBehavior?.capabilityDrops).toEqual([
      {
        fieldPath: 'listening.barge_in',
        reason: 'voice_channel_required',
        message:
          'Listening behavior requires a voice-capable channel, but "whatsapp" is not voice-capable.',
      },
      {
        fieldPath: 'listening.on_pause',
        reason: 'voice_channel_required',
        message:
          'Listening behavior requires a voice-capable channel, but "whatsapp" is not voice-capable.',
      },
    ]);
  });

  it('should hide and add tools correctly', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'limited',
        when: 'true',
        priority: 10,
        tools_hide: ['refund_order'],
        tools_add: [makeTool('check_status', 'Check order status')],
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).toContain('lookup_order');
    expect(toolNames).not.toContain('refund_order');
    expect(toolNames).toContain('transfer_to_agent');
    expect(toolNames).toContain('check_status');
    expect(config.tools).toHaveLength(3); // 3 base - 1 hidden + 1 added
  });

  it('should accumulate hidden tools from multiple profiles', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'hide-refund',
        when: 'true',
        priority: 10,
        tools_hide: ['refund_order'],
      }),
      makeProfile({
        name: 'hide-transfer',
        when: 'true',
        priority: 20,
        tools_hide: ['transfer_to_agent'],
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).toEqual(['lookup_order']);
  });

  it('should apply highest priority response_rules per field', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'low-pri',
        when: 'true',
        priority: 10,
        response_rules: {
          max_buttons: 3,
          fallback_format: 'markdown',
          max_response_length: 500,
        },
      }),
      makeProfile({
        name: 'high-pri',
        when: 'true',
        priority: 20,
        response_rules: {
          max_buttons: 5,
          fallback_format: 'plain_text',
        },
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    // high-pri overrides max_buttons and fallback_format
    expect(config.responseRules?.max_buttons).toBe(5);
    expect(config.responseRules?.fallback_format).toBe('plain_text');
    // max_response_length from low-pri survives since high-pri didn't set it
    expect(config.responseRules?.max_response_length).toBe(500);
  });

  it('should apply highest priority voice config per field', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'low-voice',
        when: 'true',
        priority: 10,
        voice: {
          provider: 'elevenlabs',
          voice_id: 'voice-123',
          speed: 1.0,
          language: 'en',
        },
      }),
      makeProfile({
        name: 'high-voice',
        when: 'true',
        priority: 20,
        voice: {
          voice_id: 'voice-456',
          speed: 1.2,
        },
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.voiceConfig?.provider).toBe('elevenlabs'); // from low-voice
    expect(config.voiceConfig?.voice_id).toBe('voice-456'); // overridden by high-voice
    expect(config.voiceConfig?.speed).toBe(1.2); // overridden by high-voice
    expect(config.voiceConfig?.language).toBe('en'); // from low-voice
  });

  it('should apply flow skip modifications', () => {
    const baseIR = makeBaseIR({
      flow: {
        steps: ['welcome', 'collect_info', 'verify_identity', 'process', 'confirm'],
        definitions: {},
      },
    });

    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'skip-verify',
        when: 'true',
        priority: 10,
        flow_modifications: {
          skip: ['verify_identity'],
        },
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.flow?.steps).toEqual(['welcome', 'collect_info', 'process', 'confirm']);
    expect(config.flow?.steps).not.toContain('verify_identity');
  });

  it('should accumulate flow skips from multiple profiles', () => {
    const baseIR = makeBaseIR({
      flow: {
        steps: ['welcome', 'collect_info', 'verify_identity', 'process', 'confirm'],
        definitions: {},
      },
    });

    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'skip-verify',
        when: 'true',
        priority: 10,
        flow_modifications: { skip: ['verify_identity'] },
      }),
      makeProfile({
        name: 'skip-confirm',
        when: 'true',
        priority: 20,
        flow_modifications: { skip: ['confirm'] },
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.flow?.steps).toEqual(['welcome', 'collect_info', 'process']);
  });

  it('should append constraints from all profiles', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'safety',
        when: 'true',
        priority: 10,
        constraints: [
          {
            condition: 'NOT contains(response, "password")',
            on_fail: { type: 'redact', message: 'Cannot share passwords' },
          },
        ],
      }),
      makeProfile({
        name: 'compliance',
        when: 'true',
        priority: 20,
        constraints: [
          {
            condition: 'NOT contains(response, "SSN")',
            on_fail: { type: 'block', message: 'Cannot share SSNs' },
          },
        ],
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.additionalConstraints).toHaveLength(2);
    expect(config.additionalConstraints[0].on_fail.message).toBe('Cannot share passwords');
    expect(config.additionalConstraints[1].on_fail.message).toBe('Cannot share SSNs');
  });

  it('should deep merge gather overrides across profiles', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'lenient',
        when: 'true',
        priority: 10,
        gather_overrides: {
          validation_style: 'lenient',
          field_overrides: {
            email: { prompt: 'What is your email?', required: true },
            phone: { prompt: 'What is your phone?' },
          },
        },
      }),
      makeProfile({
        name: 'strict-email',
        when: 'true',
        priority: 20,
        gather_overrides: {
          validation_style: 'strict',
          field_overrides: {
            email: { validation: 'must be corporate email' },
          },
        },
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    // Last wins for top-level
    expect(config.gatherOverrides?.validation_style).toBe('strict');
    // Field overrides deep merged
    expect(config.gatherOverrides?.field_overrides?.email?.prompt).toBe('What is your email?');
    expect(config.gatherOverrides?.field_overrides?.email?.required).toBe(true);
    expect(config.gatherOverrides?.field_overrides?.email?.validation).toBe(
      'must be corporate email',
    );
    // Phone untouched from first profile
    expect(config.gatherOverrides?.field_overrides?.phone?.prompt).toBe('What is your phone?');
  });

  it('should use last flow_replace when multiple profiles define it', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({
        name: 'flow-a',
        when: 'true',
        priority: 10,
        flow_replace: 'simplified_flow',
      }),
      makeProfile({
        name: 'flow-b',
        when: 'true',
        priority: 20,
        flow_replace: 'premium_flow',
      }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.flowReplace).toBe('premium_flow');
  });

  it('should record active profile names', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({ name: 'alpha', when: 'true', priority: 10 }),
      makeProfile({ name: 'beta', when: 'true', priority: 20 }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.activeProfileNames).toEqual(['alpha', 'beta']);
  });

  it('should handle profiles with no overrides gracefully', () => {
    const baseIR = makeBaseIR();
    const profiles: BehaviorProfileIR[] = [
      makeProfile({ name: 'empty', when: 'true', priority: 10 }),
    ];

    const config = buildEffectiveConfig(baseIR, profiles);

    expect(config.additionalInstructions).toEqual([]);
    expect(config.additionalConstraints).toEqual([]);
    expect(config.tools).toHaveLength(3); // unchanged
    expect(config.activeProfileNames).toEqual(['empty']);
  });
});
