/**
 * Behavior Profile Parser Tests
 *
 * Tests for parsing BEHAVIOR_PROFILE: documents and USE BEHAVIOR_PROFILE: references.
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import { parse } from '../parser/index.js';

describe('BEHAVIOR_PROFILE parsing', () => {
  it('should parse a minimal behavior profile', () => {
    const dsl = `
BEHAVIOR_PROFILE: whatsapp_standard

PRIORITY: 20
WHEN: channel.name == "whatsapp"

INSTRUCTIONS: |
  Keep responses under 160 characters.
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.name).toBe('whatsapp_standard');
    expect(result.document!.meta.kind).toBe('behavior_profile');
    expect(result.document!.behaviorProfile).toBeDefined();
    expect(result.document!.behaviorProfile!.priority).toBe(20);
    expect(result.document!.behaviorProfile!.when).toBe('channel.name == "whatsapp"');
    expect(result.document!.behaviorProfile!.instructions).toContain('Keep responses under 160');
  });

  it('should parse profile with CONSTRAINTS section', () => {
    const dsl = `
BEHAVIOR_PROFILE: concise_profile

PRIORITY: 5
WHEN: channel.name == "sms"

CONSTRAINTS:
  - "Response under 500 chars"
  - "No images allowed"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.constraints).toHaveLength(2);
    expect(profile.constraints![0]).toBe('Response under 500 chars');
    expect(profile.constraints![1]).toBe('No images allowed');
  });

  it('should parse profile with RESPONSE section', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_friendly

PRIORITY: 10
WHEN: channel.name.startsWith("voice")

RESPONSE:
  MAX_BUTTONS: 0
  FALLBACK_FORMAT: plain_text
  MAX_RESPONSE_LENGTH: 500
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.response).toBeDefined();
    expect(profile.response!.max_buttons).toBe(0);
    expect(profile.response!.fallback_format).toBe('plain_text');
    expect(profile.response!.max_response_length).toBe(500);
  });

  it('should parse profile with VOICE section', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_profile

PRIORITY: 10
WHEN: channel.name == "voice"

VOICE:
  INSTRUCTIONS: "Warm tone"
  SSML: "<speak>Hello</speak>"
  PLAIN_TEXT: "Hello there"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.voice).toBeDefined();
    expect(profile.voice!.instructions).toBe('Warm tone');
    expect(profile.voice!.ssml).toBe('<speak>Hello</speak>');
    expect(profile.voice!.plain_text).toBe('Hello there');
  });

  it('should parse profile with TOOLS HIDE section', () => {
    const dsl = `
BEHAVIOR_PROFILE: no_carousel

PRIORITY: 15
WHEN: channel.name == "whatsapp"

TOOLS:
  HIDE: [show_carousel, display_map]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.tools).toBeDefined();
    expect(profile.tools!.hide).toEqual(['show_carousel', 'display_map']);
  });

  it('should parse profile with TOOLS ADD section', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_tools

PRIORITY: 10
WHEN: channel.name == "voice"

TOOLS:
  HIDE: [show_carousel]
  ADD:
    voice_transfer:
      DESCRIPTION: "Transfer call to agent"
      PARAMETERS:
        - agent_id: string
        - reason: string
      RETURNS: object
    read_dtmf:
      DESCRIPTION: "Read DTMF tones from caller"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.tools).toBeDefined();
    expect(profile.tools!.hide).toEqual(['show_carousel']);
    expect(profile.tools!.add).toBeDefined();
    expect(profile.tools!.add).toHaveLength(2);

    const transfer = profile.tools!.add![0];
    expect(transfer.name).toBe('voice_transfer');
    expect(transfer.description).toBe('Transfer call to agent');
    expect(transfer.parameters).toHaveLength(2);
    expect(transfer.parameters![0]).toEqual({ name: 'agent_id', type: 'string', required: true });
    expect(transfer.parameters![1]).toEqual({ name: 'reason', type: 'string', required: true });
    expect(transfer.returns).toEqual({ type: 'object' });

    const dtmf = profile.tools!.add![1];
    expect(dtmf.name).toBe('read_dtmf');
    expect(dtmf.description).toBe('Read DTMF tones from caller');
  });

  it('should parse profile with GATHER section', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_gather

PRIORITY: 10
WHEN: channel.name == "voice"

GATHER:
  VALIDATION_STYLE: strict
  CONFIRMATION: always
  FIELD_OVERRIDES:
    email:
      PROMPT: "Spell your email"
      EXTRACTION_HINTS: ["Letter by letter"]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.gather).toBeDefined();
    expect(profile.gather!.validation_style).toBe('strict');
    expect(profile.gather!.confirmation).toBe('always');
    expect(profile.gather!.field_overrides).toBeDefined();
    expect(profile.gather!.field_overrides!.email).toBeDefined();
    expect(profile.gather!.field_overrides!.email.prompt).toBe('Spell your email');
    expect(profile.gather!.field_overrides!.email.extraction_hints).toEqual(['Letter by letter']);
  });

  it('should parse profile with FLOW SKIP and OVERRIDE', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_flow

PRIORITY: 10
WHEN: channel.name == "voice"

FLOW:
  SKIP: [pdf_generation, loyalty_lookup]
  OVERRIDE:
    welcome:
      RESPOND: "Hello via voice!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.flow).toBeDefined();
    expect(profile.flow!.skip).toEqual(['pdf_generation', 'loyalty_lookup']);
    expect(profile.flow!.overrides).toBeDefined();
    expect(profile.flow!.overrides!.welcome).toBeDefined();
    expect(profile.flow!.overrides!.welcome.respond).toBe('Hello via voice!');
  });

  it('should parse profile with FLOW REPLACE', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_flow

PRIORITY: 15
WHEN: channel.name == "voice"

FLOW:
  REPLACE: voice_booking_flow
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.behaviorProfile!.flow?.replace).toBe('voice_booking_flow');
  });

  it('should parse profile with all sections', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_friendly

PRIORITY: 10
WHEN: channel.name.startsWith("voice")

INSTRUCTIONS: |
  Speak naturally.

CONSTRAINTS:
  - "Response under 500 chars"

RESPONSE:
  MAX_BUTTONS: 0
  FALLBACK_FORMAT: plain_text
  MAX_RESPONSE_LENGTH: 500

VOICE:
  INSTRUCTIONS: "Warm tone"

TOOLS:
  HIDE: [show_carousel, display_map]

GATHER:
  VALIDATION_STYLE: strict
  CONFIRMATION: always
  FIELD_OVERRIDES:
    email:
      PROMPT: "Spell your email"
      EXTRACTION_HINTS: ["Letter by letter"]

FLOW:
  SKIP: [pdf_generation, loyalty_lookup]
  OVERRIDE:
    welcome:
      RESPOND: "Hello via voice!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.document!.behaviorProfile!;
    expect(profile.priority).toBe(10);
    expect(profile.when).toBe('channel.name.startsWith("voice")');
    expect(profile.instructions).toContain('Speak naturally');
    expect(profile.constraints).toHaveLength(1);
    expect(profile.response?.max_buttons).toBe(0);
    expect(profile.response?.fallback_format).toBe('plain_text');
    expect(profile.voice?.instructions).toBe('Warm tone');
    expect(profile.tools?.hide).toEqual(['show_carousel', 'display_map']);
    expect(profile.gather?.validation_style).toBe('strict');
    expect(profile.gather?.field_overrides?.email?.prompt).toBe('Spell your email');
    expect(profile.flow?.skip).toEqual(['pdf_generation', 'loyalty_lookup']);
    expect(profile.flow?.overrides?.welcome?.respond).toBe('Hello via voice!');
  });

  it('should parse USE BEHAVIOR_PROFILE in agent documents', () => {
    const dsl = `
AGENT: booking_agent

GOAL: "Help book hotels"

USE BEHAVIOR_PROFILE: whatsapp_standard
USE BEHAVIOR_PROFILE: voice_friendly

FLOW:
  welcome:
    REASONING: false
    RESPOND: "Welcome!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.useBehaviorProfiles).toEqual(['whatsapp_standard', 'voice_friendly']);
  });

  it('should parse USE_BEHAVIOR_PROFILE underscore variant', () => {
    const dsl = `
AGENT: booking_agent

GOAL: "Help book hotels"

USE_BEHAVIOR_PROFILE: whatsapp_standard
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.useBehaviorProfiles).toEqual(['whatsapp_standard']);
  });

  it('should error on missing PRIORITY', () => {
    const dsl = `
BEHAVIOR_PROFILE: missing_priority

WHEN: channel.name == "whatsapp"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.toLowerCase().includes('priority'))).toBe(true);
  });

  it('should error on missing WHEN', () => {
    const dsl = `
BEHAVIOR_PROFILE: missing_when

PRIORITY: 10
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.toLowerCase().includes('when'))).toBe(true);
  });

  it('should not require GOAL for behavior profiles', () => {
    const dsl = `
BEHAVIOR_PROFILE: no_goal

PRIORITY: 5
WHEN: channel.name == "web"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    // Should not have a warning about missing GOAL
    expect(result.warnings.every((w) => !w.message.includes('GOAL'))).toBe(true);
  });

  it('should set meta.kind to behavior_profile', () => {
    const dsl = `
BEHAVIOR_PROFILE: test_profile

PRIORITY: 1
WHEN: channel.name == "test"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.meta.kind).toBe('behavior_profile');
  });

  it('should not interfere with normal agent CONSTRAINTS parsing', () => {
    const dsl = `
AGENT: normal_agent

GOAL: "Do things"

CONSTRAINTS:
  always:
    - REQUIRE some_condition
      ON_FAIL: "Sorry, cannot do that"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    // Should parse as normal ConstraintPhase[], not string[]
    expect(result.document!.constraints).toHaveLength(1);
    expect(result.document!.constraints[0].name).toBe('always');
    // Should NOT have behaviorProfile set
    expect(result.document!.behaviorProfile).toBeUndefined();
  });

  it('should not interfere with normal agent FLOW parsing', () => {
    const dsl = `
AGENT: normal_agent

GOAL: "Do things"

FLOW:
  welcome:
    REASONING: false
    RESPOND: "Hello!"
    THEN: done
  done:
    REASONING: false
    RESPOND: "Goodbye!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.flow).toBeDefined();
    expect(result.document!.flow!.definitions.welcome).toBeDefined();
    expect(result.document!.behaviorProfile).toBeUndefined();
  });

  it('should error on invalid PRIORITY value', () => {
    const dsl = `
BEHAVIOR_PROFILE: bad_priority

PRIORITY: abc
WHEN: channel.name == "test"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(
      result.errors.some((e) => e.message.includes('PRIORITY must be a non-negative integer')),
    ).toBe(true);
  });

  it('should error on negative PRIORITY value', () => {
    const dsl = `
BEHAVIOR_PROFILE: negative_priority

PRIORITY: -5
WHEN: channel.name == "test"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(
      result.errors.some((e) => e.message.includes('PRIORITY must be a non-negative integer')),
    ).toBe(true);
  });

  it('should be auto-detected by unified parse() function', () => {
    const dsl = `
BEHAVIOR_PROFILE: auto_detect

PRIORITY: 10
WHEN: channel.name == "web"
`;
    const result = parse(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.meta.kind).toBe('behavior_profile');
    expect(result.document!.name).toBe('auto_detect');
  });

  it('should not create behaviorProfile on non-profile documents with PRIORITY-like lines', () => {
    const dsl = `
AGENT: normal_agent

GOAL: "Do things"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.behaviorProfile).toBeUndefined();
  });
});
