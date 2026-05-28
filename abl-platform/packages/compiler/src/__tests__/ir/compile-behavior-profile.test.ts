/**
 * Tests for behavior profile compilation (AST -> IR).
 *
 * Verifies:
 * - Profile compilation from parsed DSL to IR
 * - Profile attachment to agents
 * - Priority sorting
 * - Validation errors (unknown tools, unknown steps, priority conflicts, invalid CEL, flow conflicts)
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import {
  compileBehaviorProfile,
  attachProfilesToAgent,
} from '../../platform/ir/compile-behavior-profile.js';
import type { BehaviorProfileIR, AgentIR } from '../../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal agent DSL for testing profile attachment */
const AGENT_DSL = `
AGENT: test_agent
GOAL: "Help users with testing"

TOOLS:
  - search_flights
    DESCRIPTION: Search for available flights
    PARAMETERS:
      - origin: string REQUIRED
      - destination: string REQUIRED
    RETURNS: object

  - book_flight
    DESCRIPTION: Book a flight
    PARAMETERS:
      - flight_id: string REQUIRED
    RETURNS: object

GATHER:
  - name: string REQUIRED "What is your name?"
  - email: string REQUIRED "What is your email?"

COMPLETE:
  WHEN: name IS SET AND email IS SET
  RESPOND: "All done!"
`;

/** Minimal scripted agent DSL with FLOW */
const SCRIPTED_AGENT_DSL = `
AGENT: scripted_agent
GOAL: "Collect booking info"

TOOLS:
  search_flights(origin: string) -> object
    description: "Search for available flights"
    type: http

FLOW:
  STEPS: greeting -> collect_info -> confirm -> done
  greeting:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: collect_info
  collect_info:
    REASONING: false
    COLLECT: origin, destination
    PROMPT: "Where are you traveling?"
    THEN: confirm
  confirm:
    REASONING: false
    RESPOND: "Confirming your booking."
    THEN: done
  done:
    REASONING: false
    RESPOND: "Goodbye!"
`;

/** Basic behavior profile DSL */
const VOICE_PROFILE_DSL = `
BEHAVIOR_PROFILE: voice_channel
PRIORITY: 10
WHEN: context.channel == "voice"
INSTRUCTIONS: |
  Keep responses short for voice.
  Use simple language.
`;

/** Profile with constraints and tools */
const WHATSAPP_PROFILE_DSL = `
BEHAVIOR_PROFILE: whatsapp_channel
PRIORITY: 20
WHEN: context.channel == "whatsapp"
INSTRUCTIONS: Use rich media when possible.
CONSTRAINTS:
  - len(response) < 500
  - response != ""
TOOLS:
  HIDE: [search_flights]
RESPONSE:
  MAX_BUTTONS: 3
  FALLBACK_FORMAT: plain_text
  MAX_RESPONSE_LENGTH: 500
GATHER:
  VALIDATION_STYLE: lenient
  CONFIRMATION: on_change
`;

// =============================================================================
// TESTS
// =============================================================================

describe('compileBehaviorProfile', () => {
  test('compile a profile and attach to agent IR', () => {
    const profileResult = parseAgentBasedABL(VOICE_PROFILE_DSL);
    const agentResult = parseAgentBasedABL(AGENT_DSL);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    agentResult.document!.useBehaviorProfiles = ['voice_channel'];

    const allDocs = [profileResult.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    const agentIR = output.agents['test_agent'];
    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toBeDefined();
    expect(agentIR.behavior_profiles).toHaveLength(1);

    const profile = agentIR.behavior_profiles![0];
    expect(profile.name).toBe('voice_channel');
    expect(profile.priority).toBe(10);
    expect(profile.when).toBe('context.channel == "voice"');
    expect(profile.instructions).toContain('Keep responses short for voice.');
  });

  test('sort profiles by priority ascending', () => {
    const profile1Result = parseAgentBasedABL(WHATSAPP_PROFILE_DSL);
    const profile2Result = parseAgentBasedABL(VOICE_PROFILE_DSL);
    const agentResult = parseAgentBasedABL(AGENT_DSL);

    expect(profile1Result.errors).toHaveLength(0);
    expect(profile2Result.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    agentResult.document!.useBehaviorProfiles = ['whatsapp_channel', 'voice_channel'];

    const allDocs = [profile1Result.document!, profile2Result.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    const agentIR = output.agents['test_agent'];
    expect(agentIR.behavior_profiles).toHaveLength(2);
    // voice_channel (priority 10) should come before whatsapp_channel (priority 20)
    expect(agentIR.behavior_profiles![0].name).toBe('voice_channel');
    expect(agentIR.behavior_profiles![0].priority).toBe(10);
    expect(agentIR.behavior_profiles![1].name).toBe('whatsapp_channel');
    expect(agentIR.behavior_profiles![1].priority).toBe(20);
  });

  test('PROFILE_UNKNOWN_TOOL warning when profile hides a tool the agent does not declare', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: hide_nonexistent
PRIORITY: 5
WHEN: context.channel == "sms"
TOOLS:
  HIDE: [nonexistent_tool]
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    const agentResult = parseAgentBasedABL(AGENT_DSL);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    agentResult.document!.useBehaviorProfiles = ['hide_nonexistent'];

    const allDocs = [profileResult.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    expect(output.compilation_errors).toBeDefined();
    const toolError = output.compilation_errors!.find((e) =>
      e.message.includes('PROFILE_UNKNOWN_TOOL'),
    );
    expect(toolError).toBeDefined();
    expect(toolError!.message).toContain('nonexistent_tool');
  });

  test('PROFILE_PRIORITY_CONFLICT error when two profiles share same priority', () => {
    const profile1Dsl = `
BEHAVIOR_PROFILE: profile_a
PRIORITY: 10
WHEN: context.channel == "voice"
`;
    const profile2Dsl = `
BEHAVIOR_PROFILE: profile_b
PRIORITY: 10
WHEN: context.channel == "sms"
`;
    const profile1Result = parseAgentBasedABL(profile1Dsl);
    const profile2Result = parseAgentBasedABL(profile2Dsl);
    const agentResult = parseAgentBasedABL(AGENT_DSL);

    agentResult.document!.useBehaviorProfiles = ['profile_a', 'profile_b'];

    const allDocs = [profile1Result.document!, profile2Result.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    expect(output.compilation_errors).toBeDefined();
    const priorityError = output.compilation_errors!.find((e) =>
      e.message.includes('PROFILE_PRIORITY_CONFLICT'),
    );
    expect(priorityError).toBeDefined();
    expect(priorityError!.message).toContain('priority 10');
  });

  test('PROFILE_INVALID_WHEN error for expression with unbalanced brackets', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: bad_when_brackets
PRIORITY: 5
WHEN: context.channel == "voice" && data[0
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    expect(profileResult.document).toBeDefined();

    const { errors } = compileBehaviorProfile(profileResult.document!);
    const celError = errors.find((e) => e.message.includes('PROFILE_INVALID_WHEN'));
    expect(celError).toBeDefined();
    expect(celError!.type).toBe('validation');
    expect(celError!.message).toContain('unbalanced');
  });

  test('PROFILE_INVALID_WHEN error for JavaScript-style strict equality', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: bad_when_js
PRIORITY: 5
WHEN: context.channel === "voice"
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    expect(profileResult.document).toBeDefined();

    const { errors } = compileBehaviorProfile(profileResult.document!);
    const celError = errors.find((e) => e.message.includes('PROFILE_INVALID_WHEN'));
    expect(celError).toBeDefined();
    expect(celError!.message).toContain('===');
  });

  test('PROFILE_FLOW_CONFLICT error when profile has both flow_replace and flow modifications', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: conflict_flow
PRIORITY: 15
WHEN: context.channel == "voice"
FLOW:
  REPLACE: voice_flow
  SKIP: [greeting]
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    expect(profileResult.document).toBeDefined();

    const { profile, errors } = compileBehaviorProfile(profileResult.document!);
    const flowError = errors.find((e) => e.message.includes('PROFILE_FLOW_CONFLICT'));
    expect(flowError).toBeDefined();
    expect(flowError!.type).toBe('validation');
  });

  test('PROFILE_NOT_FOUND error when agent references a nonexistent profile', () => {
    const agentResult = parseAgentBasedABL(AGENT_DSL);
    expect(agentResult.errors).toHaveLength(0);

    agentResult.document!.useBehaviorProfiles = ['nonexistent_profile'];

    const allDocs = [agentResult.document!];
    const output = compileABLtoIR(allDocs);

    expect(output.compilation_errors).toBeDefined();
    const notFoundError = output.compilation_errors!.find((e) =>
      e.message.includes('PROFILE_NOT_FOUND'),
    );
    expect(notFoundError).toBeDefined();
    expect(notFoundError!.message).toContain('nonexistent_profile');
  });

  test('PROFILE_UNKNOWN_STEP error when profile skips a nonexistent flow step', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: skip_unknown
PRIORITY: 5
WHEN: context.channel == "voice"
FLOW:
  SKIP: [nonexistent_step]
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    const agentResult = parseAgentBasedABL(SCRIPTED_AGENT_DSL);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    agentResult.document!.useBehaviorProfiles = ['skip_unknown'];

    const allDocs = [profileResult.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    expect(output.compilation_errors).toBeDefined();
    const stepError = output.compilation_errors!.find((e) =>
      e.message.includes('PROFILE_UNKNOWN_STEP'),
    );
    expect(stepError).toBeDefined();
    expect(stepError!.message).toContain('nonexistent_step');
  });

  test('compile profile with constraints produces Constraint[] in IR', () => {
    const profileResult = parseAgentBasedABL(WHATSAPP_PROFILE_DSL);
    expect(profileResult.errors).toHaveLength(0);

    const { profile, errors } = compileBehaviorProfile(profileResult.document!);
    expect(profile.constraints).toBeDefined();
    expect(profile.constraints).toHaveLength(2);
    expect(profile.constraints![0].condition).toBe('len(response) < 500');
    expect(profile.constraints![0].on_fail.type).toBe('respond');
  });

  test('compile profile with response rules', () => {
    const profileResult = parseAgentBasedABL(WHATSAPP_PROFILE_DSL);
    const { profile } = compileBehaviorProfile(profileResult.document!);

    expect(profile.response_rules).toBeDefined();
    expect(profile.response_rules!.max_buttons).toBe(3);
    expect(profile.response_rules!.fallback_format).toBe('plain_text');
    expect(profile.response_rules!.max_response_length).toBe(500);
  });

  test('compile profile with gather overrides', () => {
    const profileResult = parseAgentBasedABL(WHATSAPP_PROFILE_DSL);
    const { profile } = compileBehaviorProfile(profileResult.document!);

    expect(profile.gather_overrides).toBeDefined();
    expect(profile.gather_overrides!.validation_style).toBe('lenient');
    expect(profile.gather_overrides!.confirmation).toBe('on_change');
  });

  test('compile profile with tools_hide', () => {
    const profileResult = parseAgentBasedABL(WHATSAPP_PROFILE_DSL);
    const { profile } = compileBehaviorProfile(profileResult.document!);

    expect(profile.tools_hide).toBeDefined();
    expect(profile.tools_hide).toEqual(['search_flights']);
  });

  test('agents without useBehaviorProfiles have no behavior_profiles on IR', () => {
    const agentResult = parseAgentBasedABL(AGENT_DSL);
    const output = compileABLtoIR([agentResult.document!]);

    const agentIR = output.agents['test_agent'];
    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toBeUndefined();
  });

  test('behavior profile documents are not compiled as agents', () => {
    const profileResult = parseAgentBasedABL(VOICE_PROFILE_DSL);
    const agentResult = parseAgentBasedABL(AGENT_DSL);

    const allDocs = [profileResult.document!, agentResult.document!];
    const output = compileABLtoIR(allDocs);

    // Only the agent should be in agents map, not the profile
    expect(Object.keys(output.agents)).toEqual(['test_agent']);
    expect(output.agents['voice_channel']).toBeUndefined();
  });
});
