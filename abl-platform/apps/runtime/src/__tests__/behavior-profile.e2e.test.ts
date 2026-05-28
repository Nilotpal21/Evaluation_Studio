/**
 * Behavior Profile End-to-End Tests
 *
 * Full integration test exercising the complete pipeline:
 * Parse DSL -> Compile to IR -> Resolve profiles -> Build effective config
 *
 * Verifies:
 * - Agent + profile DSL parses correctly
 * - Compilation attaches profiles to agent IR
 * - Profile resolves for matching channel context (whatsapp)
 * - Profile does NOT resolve for non-matching context (web)
 * - Effective config hides tools, adds instructions, adds constraints
 * - Multiple profiles with priority ordering
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import {
  assembleProfileContext,
  resolveActiveProfiles,
  buildEffectiveConfig,
} from '../services/execution/profile-resolver.js';

// =============================================================================
// TEST DSL FIXTURES
// =============================================================================

/**
 * Agent DSL using the function-call tool syntax: name(params) -> return_type
 * The compiler adds system tools like __escalate__ automatically.
 */
const AGENT_DSL = `AGENT: booking_agent
GOAL: "Help users book hotels"

TOOLS:
  search_hotels(city: string) -> object
    DESCRIPTION: Search for hotels
  send_sms(phone: string) -> object
    DESCRIPTION: Send SMS notification

USE BEHAVIOR_PROFILE: whatsapp_mode
`;

/**
 * Profile DSL using bracket syntax for HIDE: [tool1, tool2]
 */
const PROFILE_DSL = `BEHAVIOR_PROFILE: whatsapp_mode
PRIORITY: 10
WHEN: channel.name == "whatsapp"
INSTRUCTIONS: "Use short messages. No markdown formatting. Use emojis sparingly."
CONSTRAINTS:
  - "response_length < 500"
TOOLS:
  HIDE: [send_sms]
`;

/** A second profile with higher priority for multi-profile tests */
const VOICE_PROFILE_DSL = `BEHAVIOR_PROFILE: voice_mode
PRIORITY: 20
WHEN: channel.name == "voice"
INSTRUCTIONS: "Speak naturally. Avoid technical jargon."
CONSTRAINTS:
  - "response_length < 200"
`;

/** Agent that references both profiles */
const MULTI_PROFILE_AGENT_DSL = `AGENT: multi_profile_agent
GOAL: "Help users with multi-channel support"

TOOLS:
  search_hotels(city: string) -> object
    DESCRIPTION: Search for hotels
  send_sms(phone: string) -> object
    DESCRIPTION: Send SMS notification

USE BEHAVIOR_PROFILE: whatsapp_mode
USE BEHAVIOR_PROFILE: voice_mode
`;

// =============================================================================
// FULL PIPELINE: PARSE -> COMPILE -> VERIFY PROFILE ON IR
// =============================================================================

describe('behavior profile e2e: parse -> compile -> resolve -> build', () => {
  it('should parse and compile agent with attached profile', () => {
    // Parse both documents
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    expect(agentParse.errors).toHaveLength(0);

    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    expect(profileParse.errors).toHaveLength(0);

    // Compile both together
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toBeDefined();
    expect(agentIR.behavior_profiles).toHaveLength(1);

    const profile = agentIR.behavior_profiles![0];
    expect(profile.name).toBe('whatsapp_mode');
    expect(profile.priority).toBe(10);
    expect(profile.when).toBe('channel.name == "whatsapp"');
    expect(profile.instructions).toBe(
      'Use short messages. No markdown formatting. Use emojis sparingly.',
    );
    expect(profile.tools_hide).toEqual(['send_sms']);
    expect(profile.constraints).toBeDefined();
    expect(profile.constraints!.length).toBeGreaterThan(0);
    expect(profile.constraints![0].condition).toBe('response_length < 500');
  });

  it('should resolve profile for WhatsApp channel context', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    expect(context.channel.name).toBe('whatsapp');

    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    expect(activeProfiles).toHaveLength(1);
    expect(activeProfiles[0].name).toBe('whatsapp_mode');
  });

  it('should NOT resolve profile for web channel context', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'web' });
    expect(context.channel.name).toBe('web');

    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    expect(activeProfiles).toHaveLength(0);
  });

  it('should build effective config that hides send_sms tool', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    // send_sms should be hidden, search_hotels should remain
    const toolNames = effectiveConfig.tools.map((t) => t.name);
    expect(toolNames).toContain('search_hotels');
    expect(toolNames).not.toContain('send_sms');
    expect(effectiveConfig.activeProfileNames).toEqual(['whatsapp_mode']);
  });

  it('should build effective config with additional instructions from profile', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    expect(effectiveConfig.additionalInstructions).toHaveLength(1);
    expect(effectiveConfig.additionalInstructions[0]).toBe(
      'Use short messages. No markdown formatting. Use emojis sparingly.',
    );
  });

  it('should build effective config with additional constraints from profile', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    expect(effectiveConfig.additionalConstraints).toHaveLength(1);
    expect(effectiveConfig.additionalConstraints[0].condition).toBe('response_length < 500');
  });

  it('should return unmodified tools when no profile matches (web channel)', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    const context = assembleProfileContext({ channelType: 'web' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    // All declared tools should remain (including system tools added by compiler)
    const toolNames = effectiveConfig.tools.map((t) => t.name);
    expect(toolNames).toContain('search_hotels');
    expect(toolNames).toContain('send_sms');
    expect(effectiveConfig.additionalInstructions).toHaveLength(0);
    expect(effectiveConfig.additionalConstraints).toHaveLength(0);
    expect(effectiveConfig.activeProfileNames).toHaveLength(0);
  });
});

// =============================================================================
// MULTIPLE PROFILES WITH PRIORITY ORDERING
// =============================================================================

describe('behavior profile e2e: multiple profiles with priority ordering', () => {
  it('should compile agent with multiple profiles sorted by priority', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    expect(agentParse.errors).toHaveLength(0);

    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    expect(profile1Parse.errors).toHaveLength(0);

    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);
    expect(profile2Parse.errors).toHaveLength(0);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toBeDefined();
    expect(agentIR.behavior_profiles).toHaveLength(2);

    // Profiles should be sorted by priority ascending
    expect(agentIR.behavior_profiles![0].name).toBe('whatsapp_mode');
    expect(agentIR.behavior_profiles![0].priority).toBe(10);
    expect(agentIR.behavior_profiles![1].name).toBe('voice_mode');
    expect(agentIR.behavior_profiles![1].priority).toBe(20);
  });

  it('should resolve only whatsapp profile for whatsapp channel', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);

    expect(activeProfiles).toHaveLength(1);
    expect(activeProfiles[0].name).toBe('whatsapp_mode');
  });

  it('should resolve only voice profile for voice channel', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    const context = assembleProfileContext({ channelType: 'voice' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);

    expect(activeProfiles).toHaveLength(1);
    expect(activeProfiles[0].name).toBe('voice_mode');
  });

  it('should resolve no profiles for email channel (no matching conditions)', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    const context = assembleProfileContext({ channelType: 'email' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);

    expect(activeProfiles).toHaveLength(0);
  });

  it('should build effective config correctly for whatsapp with tool hiding', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    // WhatsApp profile hides send_sms
    const toolNames = effectiveConfig.tools.map((t) => t.name);
    expect(toolNames).toContain('search_hotels');
    expect(toolNames).not.toContain('send_sms');

    // WhatsApp profile adds instructions and constraints
    expect(effectiveConfig.additionalInstructions).toHaveLength(1);
    expect(effectiveConfig.additionalInstructions[0]).toContain('short messages');
    expect(effectiveConfig.additionalConstraints).toHaveLength(1);
    expect(effectiveConfig.activeProfileNames).toEqual(['whatsapp_mode']);
  });

  it('should build effective config correctly for voice channel without tool hiding', () => {
    const agentParse = parseAgentBasedABL(MULTI_PROFILE_AGENT_DSL);
    const profile1Parse = parseAgentBasedABL(PROFILE_DSL);
    const profile2Parse = parseAgentBasedABL(VOICE_PROFILE_DSL);

    const result = compileABLtoIR([
      profile1Parse.document,
      profile2Parse.document,
      agentParse.document,
    ]);
    const agentIR = result.agents['multi_profile_agent'];

    const context = assembleProfileContext({ channelType: 'voice' });
    const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles!, context);
    const effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);

    // Voice profile does NOT hide tools
    const toolNames = effectiveConfig.tools.map((t) => t.name);
    expect(toolNames).toContain('search_hotels');
    expect(toolNames).toContain('send_sms');

    // Voice profile adds its own instructions and constraints
    expect(effectiveConfig.additionalInstructions).toHaveLength(1);
    expect(effectiveConfig.additionalInstructions[0]).toContain('Speak naturally');
    expect(effectiveConfig.additionalConstraints).toHaveLength(1);
    expect(effectiveConfig.additionalConstraints[0].condition).toBe('response_length < 200');
    expect(effectiveConfig.activeProfileNames).toEqual(['voice_mode']);
  });
});

// =============================================================================
// PROFILE CONTEXT ASSEMBLY
// =============================================================================

describe('behavior profile e2e: profile context assembly', () => {
  it('should assemble context with all channel capabilities for whatsapp', () => {
    const context = assembleProfileContext({
      channelType: 'whatsapp',
      callerContext: {
        identityTier: 2,
        customerId: 'cust-123',
        verificationMethod: 'oauth',
      },
      connectionConfig: {
        region: 'us-east-1',
        provider: 'twilio',
      },
      sessionMeta: {
        isNew: true,
        language: 'en',
        turnCount: 0,
      },
    });

    expect(context.channel.name).toBe('whatsapp');
    expect(context.channel.capabilities.streaming).toBe(false);
    expect(context.channel.capabilities.media).toBe(true);
    expect(context.channel.capabilities.threading).toBe(false);
    expect(context.channel.capabilities.interactive).toBe(true);
    expect(context.channel.region).toBe('us-east-1');
    expect(context.channel.provider).toBe('twilio');

    expect(context.caller.identity_tier).toBe(2);
    expect(context.caller.customer_id).toBe('cust-123');
    expect(context.caller.is_authenticated).toBe(true);
    expect(context.caller.verification_method).toBe('oauth');

    expect(context.session.is_new).toBe(true);
    expect(context.session.language).toBe('en');
    expect(context.session.turn_count).toBe(0);
  });

  it('should default unauthenticated caller context', () => {
    const context = assembleProfileContext({
      channelType: 'web',
    });

    expect(context.caller.identity_tier).toBe(0);
    expect(context.caller.customer_id).toBeNull();
    expect(context.caller.is_authenticated).toBe(false);
    expect(context.caller.verification_method).toBe('none');
  });

  it('should set correct capabilities for web channel', () => {
    const context = assembleProfileContext({ channelType: 'web' });

    expect(context.channel.capabilities.streaming).toBe(true);
    expect(context.channel.capabilities.media).toBe(true);
    expect(context.channel.capabilities.threading).toBe(true);
    expect(context.channel.capabilities.interactive).toBe(true);
  });

  it('should set correct capabilities for sms channel', () => {
    const context = assembleProfileContext({ channelType: 'sms' });

    expect(context.channel.capabilities.streaming).toBe(false);
    expect(context.channel.capabilities.media).toBe(false);
    expect(context.channel.capabilities.threading).toBe(false);
    expect(context.channel.capabilities.interactive).toBe(false);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('behavior profile e2e: edge cases', () => {
  it('should handle agent with no profiles gracefully', () => {
    const agentDSL = `AGENT: no_profile_agent
GOAL: "Simple agent"

TOOLS:
  search(query: string) -> object
    DESCRIPTION: Search for something
`;

    const agentParse = parseAgentBasedABL(agentDSL);
    expect(agentParse.errors).toHaveLength(0);

    const result = compileABLtoIR([agentParse.document]);
    const agentIR = result.agents['no_profile_agent'];

    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toBeUndefined();

    // Build effective config with empty profiles
    const effectiveConfig = buildEffectiveConfig(agentIR, []);

    const toolNames = effectiveConfig.tools.map((t) => t.name);
    expect(toolNames).toContain('search');
    expect(effectiveConfig.additionalInstructions).toHaveLength(0);
    expect(effectiveConfig.additionalConstraints).toHaveLength(0);
    expect(effectiveConfig.activeProfileNames).toHaveLength(0);
  });

  it('should handle profile with unknown tool reference as compilation error', () => {
    const agentDSL = `AGENT: strict_agent
GOAL: "Agent with limited tools"

TOOLS:
  search(query: string) -> object
    DESCRIPTION: Search

USE BEHAVIOR_PROFILE: bad_profile
`;

    const profileDSL = `BEHAVIOR_PROFILE: bad_profile
PRIORITY: 10
WHEN: channel.name == "web"
TOOLS:
  HIDE: [nonexistent_tool]
`;

    const agentParse = parseAgentBasedABL(agentDSL);
    const profileParse = parseAgentBasedABL(profileDSL);

    const result = compileABLtoIR([profileParse.document, agentParse.document]);

    // Should still compile, but with validation errors about unknown tool
    expect(result.agents['strict_agent']).toBeDefined();
    const hasToolError = result.compilation_errors?.some(
      (e) => e.message.includes('PROFILE_UNKNOWN_TOOL') && e.message.includes('nonexistent_tool'),
    );
    expect(hasToolError).toBe(true);
  });

  it('should handle profile referenced but not provided as compilation error', () => {
    const agentDSL = `AGENT: orphan_ref_agent
GOAL: "Agent referencing missing profile"

USE BEHAVIOR_PROFILE: missing_profile
`;

    const agentParse = parseAgentBasedABL(agentDSL);
    const result = compileABLtoIR([agentParse.document]);

    // Should have a PROFILE_NOT_FOUND error
    const hasNotFoundError = result.compilation_errors?.some(
      (e) => e.message.includes('PROFILE_NOT_FOUND') && e.message.includes('missing_profile'),
    );
    expect(hasNotFoundError).toBe(true);
  });

  it('should skip profile with failing CEL expression gracefully', () => {
    const agentParse = parseAgentBasedABL(AGENT_DSL);
    const profileParse = parseAgentBasedABL(PROFILE_DSL);
    const result = compileABLtoIR([profileParse.document, agentParse.document]);
    const agentIR = result.agents['booking_agent'];

    // Create a profile with an expression that will fail at runtime
    const brokenProfile = {
      ...agentIR.behavior_profiles![0],
      when: 'nonexistent.deeply.nested.property == "value"',
    };

    const context = assembleProfileContext({ channelType: 'whatsapp' });
    const activeProfiles = resolveActiveProfiles([brokenProfile], context);

    // The broken expression should not match (not crash)
    expect(activeProfiles).toHaveLength(0);
  });
});
