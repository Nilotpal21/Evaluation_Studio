/**
 * Profile Serializer Tests
 *
 * Verifies that serializeProfileToABL generates valid BEHAVIOR_PROFILE DSL text.
 */

import { describe, test, expect } from 'vitest';
import { serializeProfileToABL, type ProfileData } from '../lib/abl-serializers';

// =============================================================================
// HELPERS
// =============================================================================

function minimalProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    name: 'test_profile',
    priority: 10,
    when: 'channel.name == "whatsapp"',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('serializeProfileToABL', () => {
  // ---------------------------------------------------------------------------
  // Basic profile
  // ---------------------------------------------------------------------------

  test('generates minimal profile with header, priority, and when', () => {
    const result = serializeProfileToABL(minimalProfile());

    expect(result).toContain('BEHAVIOR_PROFILE: test_profile');
    expect(result).toContain('PRIORITY: 10');
    expect(result).toContain('WHEN: channel.name == "whatsapp"');
  });

  test('ends with a newline', () => {
    const result = serializeProfileToABL(minimalProfile());
    expect(result.endsWith('\n')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Instructions
  // ---------------------------------------------------------------------------

  test('serializes single-line instructions with quotes', () => {
    const result = serializeProfileToABL(minimalProfile({ instructions: 'Keep it brief' }));
    expect(result).toContain('INSTRUCTIONS: "Keep it brief"');
  });

  test('serializes multi-line instructions with pipe syntax', () => {
    const result = serializeProfileToABL(minimalProfile({ instructions: 'Line one.\nLine two.' }));
    expect(result).toContain('INSTRUCTIONS: |');
    expect(result).toContain('  Line one.');
    expect(result).toContain('  Line two.');
  });

  // ---------------------------------------------------------------------------
  // Constraints
  // ---------------------------------------------------------------------------

  test('serializes constraints as quoted list items', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        constraints: [
          { condition: 'Response under 500 chars', action: 'warn' },
          { condition: 'No images allowed', action: 'block' },
        ],
      }),
    );

    expect(result).toContain('CONSTRAINTS:');
    expect(result).toContain('  - "Response under 500 chars"');
    expect(result).toContain('  - "No images allowed"');
  });

  test('omits CONSTRAINTS section when empty', () => {
    const result = serializeProfileToABL(minimalProfile({ constraints: [] }));
    expect(result).not.toContain('CONSTRAINTS:');
  });

  // ---------------------------------------------------------------------------
  // Response rules
  // ---------------------------------------------------------------------------

  test('serializes response rules', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        responseRules: {
          max_buttons: 0,
          fallback_format: 'plain_text',
          max_length: 500,
          tone: 'formal',
          format: 'concise',
        },
      }),
    );

    expect(result).toContain('RESPONSE:');
    expect(result).toContain('  MAX_BUTTONS: 0');
    expect(result).toContain('  FALLBACK_FORMAT: plain_text');
    expect(result).toContain('  MAX_RESPONSE_LENGTH: 500');
    expect(result).toContain('  TONE: "formal"');
    expect(result).toContain('  FORMAT: "concise"');
  });

  test('omits RESPONSE section when all fields are empty', () => {
    const result = serializeProfileToABL(minimalProfile({ responseRules: {} }));
    expect(result).not.toContain('RESPONSE:');
  });

  // ---------------------------------------------------------------------------
  // Voice
  // ---------------------------------------------------------------------------

  test('serializes voice section', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        voice: {
          instructions: 'Warm tone',
          ssml: '<speak>Hello</speak>',
          plain_text: 'Hello there',
        },
      }),
    );

    expect(result).toContain('VOICE:');
    expect(result).toContain('  INSTRUCTIONS: "Warm tone"');
    expect(result).toContain('  SSML: "<speak>Hello</speak>"');
    expect(result).toContain('  PLAIN_TEXT: "Hello there"');
  });

  test('omits VOICE section when all fields are empty', () => {
    const result = serializeProfileToABL(minimalProfile({ voice: {} }));
    expect(result).not.toContain('VOICE:');
  });

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  test('serializes tools hide list', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        toolsHide: ['show_carousel', 'display_map'],
      }),
    );

    expect(result).toContain('TOOLS:');
    expect(result).toContain('  HIDE: [show_carousel, display_map]');
  });

  test('serializes tools add section', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        toolsAdd: [
          {
            name: 'voice_transfer',
            description: 'Transfer call to agent',
            parameters: [
              { name: 'agent_id', type: 'string' },
              { name: 'reason', type: 'string' },
            ],
            returns: 'object',
          },
        ],
      }),
    );

    expect(result).toContain('TOOLS:');
    expect(result).toContain('  ADD:');
    expect(result).toContain('    voice_transfer:');
    expect(result).toContain('      DESCRIPTION: "Transfer call to agent"');
    expect(result).toContain('      PARAMETERS:');
    expect(result).toContain('        - agent_id: string');
    expect(result).toContain('        - reason: string');
    expect(result).toContain('      RETURNS: object');
  });

  test('serializes both tools hide and add together', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        toolsHide: ['show_carousel'],
        toolsAdd: [{ name: 'read_dtmf', description: 'Read DTMF tones from caller' }],
      }),
    );

    expect(result).toContain('  HIDE: [show_carousel]');
    expect(result).toContain('  ADD:');
    expect(result).toContain('    read_dtmf:');
  });

  test('omits TOOLS section when no hide or add', () => {
    const result = serializeProfileToABL(minimalProfile({ toolsHide: [], toolsAdd: [] }));
    expect(result).not.toContain('TOOLS:');
  });

  // ---------------------------------------------------------------------------
  // Gather overrides
  // ---------------------------------------------------------------------------

  test('serializes gather overrides', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        gatherOverrides: {
          validationStyle: 'strict',
          confirmation: 'always',
          fieldOverrides: {
            email: {
              prompt: 'Spell your email',
              extraction_hints: ['Letter by letter'],
            },
          },
        },
      }),
    );

    expect(result).toContain('GATHER:');
    expect(result).toContain('  VALIDATION_STYLE: strict');
    expect(result).toContain('  CONFIRMATION: always');
    expect(result).toContain('  FIELD_OVERRIDES:');
    expect(result).toContain('    email:');
    expect(result).toContain('      PROMPT: "Spell your email"');
    expect(result).toContain('      EXTRACTION_HINTS: ["Letter by letter"]');
  });

  test('omits GATHER section when all fields are empty', () => {
    const result = serializeProfileToABL(minimalProfile({ gatherOverrides: {} }));
    expect(result).not.toContain('GATHER:');
  });

  // ---------------------------------------------------------------------------
  // Flow modifications
  // ---------------------------------------------------------------------------

  test('serializes flow replace', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        flowModifications: { replace: 'voice_booking_flow' },
      }),
    );

    expect(result).toContain('FLOW:');
    expect(result).toContain('  REPLACE: voice_booking_flow');
  });

  test('serializes flow skip list', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        flowModifications: { skip: ['pdf_generation', 'loyalty_lookup'] },
      }),
    );

    expect(result).toContain('FLOW:');
    expect(result).toContain('  SKIP: [pdf_generation, loyalty_lookup]');
  });

  test('serializes conversation behavior block', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        conversationBehavior: {
          speaking: {
            style: 'warm and concise',
            tool_lead_in: 'brief',
          },
          interaction: {
            answer_shape: 'answer_first',
            clarification: {
              mode: 'ask_only_when_blocked',
              max_questions: 1,
            },
          },
        },
      }),
    );

    expect(result).toContain('CONVERSATION:');
    expect(result).toContain('  speaking:');
    expect(result).toContain('    style: "warm and concise"');
    expect(result).toContain('    tool_lead_in: brief');
    expect(result).toContain('  interaction:');
    expect(result).toContain('    answer_shape: answer_first');
    expect(result).toContain('    clarification:');
    expect(result).toContain('      mode: ask_only_when_blocked');
    expect(result).toContain('      max_questions: 1');
  });

  test('serializes flow overrides', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        flowModifications: {
          overrides: {
            welcome: { respond: 'Hello via voice!' },
          },
        },
      }),
    );

    expect(result).toContain('FLOW:');
    expect(result).toContain('  OVERRIDE:');
    expect(result).toContain('    welcome:');
    expect(result).toContain('      RESPOND: "Hello via voice!"');
  });

  test('omits FLOW section when no modifications', () => {
    const result = serializeProfileToABL(minimalProfile({ flowModifications: {} }));
    expect(result).not.toContain('FLOW:');
  });

  // ---------------------------------------------------------------------------
  // All sections combined
  // ---------------------------------------------------------------------------

  test('generates full profile with all sections', () => {
    const result = serializeProfileToABL({
      name: 'voice_friendly',
      priority: 10,
      when: 'channel.name.startsWith("voice")',
      instructions: 'Speak naturally.',
      constraints: [{ condition: 'Response under 500 chars', action: 'warn' }],
      responseRules: { max_buttons: 0, fallback_format: 'plain_text', max_length: 500 },
      voice: { instructions: 'Warm tone' },
      toolsHide: ['show_carousel', 'display_map'],
      gatherOverrides: {
        validationStyle: 'strict',
        confirmation: 'always',
        fieldOverrides: {
          email: { prompt: 'Spell your email', extraction_hints: ['Letter by letter'] },
        },
      },
      flowModifications: {
        skip: ['pdf_generation', 'loyalty_lookup'],
        overrides: { welcome: { respond: 'Hello via voice!' } },
      },
    });

    // Verify all sections are present
    expect(result).toContain('BEHAVIOR_PROFILE: voice_friendly');
    expect(result).toContain('PRIORITY: 10');
    expect(result).toContain('WHEN: channel.name.startsWith("voice")');
    expect(result).toContain('INSTRUCTIONS:');
    expect(result).toContain('CONSTRAINTS:');
    expect(result).toContain('RESPONSE:');
    expect(result).toContain('VOICE:');
    expect(result).toContain('TOOLS:');
    expect(result).toContain('GATHER:');
    expect(result).toContain('FLOW:');
  });

  // ---------------------------------------------------------------------------
  // Empty optional sections
  // ---------------------------------------------------------------------------

  test('omits all optional sections when not provided', () => {
    const result = serializeProfileToABL(minimalProfile());

    expect(result).not.toContain('INSTRUCTIONS:');
    expect(result).not.toContain('CONSTRAINTS:');
    expect(result).not.toContain('RESPONSE:');
    expect(result).not.toContain('VOICE:');
    expect(result).not.toContain('TOOLS:');
    expect(result).not.toContain('GATHER:');
    expect(result).not.toContain('FLOW:');
  });

  // ---------------------------------------------------------------------------
  // Special characters
  // ---------------------------------------------------------------------------

  test('escapes double quotes in string values', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        instructions: 'Say "hello" to the user',
      }),
    );
    expect(result).toContain('INSTRUCTIONS: "Say \\"hello\\" to the user"');
  });

  test('escapes backslashes in string values', () => {
    const result = serializeProfileToABL(
      minimalProfile({
        instructions: 'Path: C:\\Users\\test',
      }),
    );
    expect(result).toContain('INSTRUCTIONS: "Path: C:\\\\Users\\\\test"');
  });

  test('handles empty WHEN expression by including it as-is', () => {
    const result = serializeProfileToABL(minimalProfile({ when: 'true' }));
    expect(result).toContain('WHEN: true');
  });
});
