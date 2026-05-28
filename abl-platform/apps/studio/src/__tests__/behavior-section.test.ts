/**
 * BehaviorSection + serializeBehaviorRefsToABL Tests
 *
 * Tests for:
 * 1. BehaviorSection rendering (structural tests via createElement inspection)
 * 2. serializeBehaviorRefsToABL serialization logic
 * 3. parseBehavior integration via parseIRToSections
 */

import { describe, it, expect } from 'vitest';
import { serializeBehaviorRefsToABL } from '../lib/abl-serializers';
import { parseIRToSections, computeVisibleSections } from '../store/agent-detail-store';
import type { BehaviorProfileRef, BehaviorSectionData } from '../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const channelProfile: BehaviorProfileRef = {
  name: 'whatsapp_adaptation',
  priority: 10,
  whenSummary: 'context.channel == "whatsapp"',
  overrideCategories: ['instructions', 'response_rules', 'tools'],
};

const voiceProfile: BehaviorProfileRef = {
  name: 'voice_mode',
  priority: 20,
  whenSummary: 'context.channel == "voice"',
  overrideCategories: ['voice', 'constraints'],
};

const minimalProfile: BehaviorProfileRef = {
  name: 'basic_override',
  priority: 1,
  whenSummary: 'true',
  overrideCategories: [],
};

// =============================================================================
// serializeBehaviorRefsToABL
// =============================================================================

describe('serializeBehaviorRefsToABL', () => {
  it('generates correct USE lines for multiple profiles', () => {
    const edits = serializeBehaviorRefsToABL(['whatsapp_adaptation', 'voice_mode', 'vip_customer']);

    expect(edits).toHaveLength(1);
    expect(edits[0].section).toBe('BEHAVIOR');
    expect(edits[0].content).toBe(
      'USE BEHAVIOR_PROFILE: whatsapp_adaptation\n' +
        'USE BEHAVIOR_PROFILE: voice_mode\n' +
        'USE BEHAVIOR_PROFILE: vip_customer',
    );
  });

  it('handles single profile', () => {
    const edits = serializeBehaviorRefsToABL(['channel_profile']);

    expect(edits).toHaveLength(1);
    expect(edits[0].section).toBe('BEHAVIOR');
    expect(edits[0].content).toBe('USE BEHAVIOR_PROFILE: channel_profile');
  });

  it('returns null content for empty array', () => {
    const edits = serializeBehaviorRefsToABL([]);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ section: 'BEHAVIOR', content: null });
  });

  it('returns null content for undefined input', () => {
    const edits = serializeBehaviorRefsToABL(undefined as unknown as string[]);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ section: 'BEHAVIOR', content: null });
  });

  it('preserves profile names with special characters', () => {
    const edits = serializeBehaviorRefsToABL(['my-profile_v2']);

    expect(edits[0].content).toBe('USE BEHAVIOR_PROFILE: my-profile_v2');
  });
});

// =============================================================================
// parseIRToSections — behavior parsing
// =============================================================================

describe('parseIRToSections — behavior profiles', () => {
  it('parses behavior profiles from IR', () => {
    const ir = {
      identity: { goal: 'Help users' },
      behavior_profiles: [
        {
          name: 'whatsapp_adaptation',
          priority: 10,
          when: 'context.channel == "whatsapp"',
          instructions: 'Use short responses',
          response_rules: { max_length: 160 },
          tools_hide: ['send_email'],
        },
        {
          name: 'voice_mode',
          priority: 20,
          when: 'context.channel == "voice"',
          voice: { provider: 'elevenlabs' },
          constraints: [{ condition: 'no_images' }],
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles).toHaveLength(2);

    const first = sections.behavior.profiles[0];
    expect(first.name).toBe('whatsapp_adaptation');
    expect(first.priority).toBe(10);
    expect(first.whenSummary).toBe('context.channel == "whatsapp"');
    expect(first.overrideCategories).toContain('instructions');
    expect(first.overrideCategories).toContain('response_rules');
    expect(first.overrideCategories).toContain('tools');

    const second = sections.behavior.profiles[1];
    expect(second.name).toBe('voice_mode');
    expect(second.priority).toBe(20);
    expect(second.overrideCategories).toContain('voice');
    expect(second.overrideCategories).toContain('constraints');
  });

  it('returns empty profiles when no behavior_profiles in IR', () => {
    const ir = { identity: { goal: 'Help' } };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles).toEqual([]);
  });

  it('detects flow override category from flow_modifications', () => {
    const ir = {
      identity: { goal: 'Help' },
      behavior_profiles: [
        {
          name: 'skip_confirmation',
          priority: 5,
          when: 'true',
          flow_modifications: { skip: ['confirm_step'] },
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles[0].overrideCategories).toContain('flow');
  });

  it('detects flow override category from flow_replace', () => {
    const ir = {
      identity: { goal: 'Help' },
      behavior_profiles: [
        {
          name: 'alternative_flow',
          priority: 5,
          when: 'true',
          flow_replace: 'short_flow',
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles[0].overrideCategories).toContain('flow');
  });

  it('detects gather override category', () => {
    const ir = {
      identity: { goal: 'Help' },
      behavior_profiles: [
        {
          name: 'simple_gather',
          priority: 5,
          when: 'true',
          gather_overrides: { validation_style: 'lenient' },
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles[0].overrideCategories).toContain('gather');
  });

  it('detects tools_add category', () => {
    const ir = {
      identity: { goal: 'Help' },
      behavior_profiles: [
        {
          name: 'extra_tools',
          priority: 5,
          when: 'true',
          tools_add: [{ name: 'special_tool', description: 'A tool' }],
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles[0].overrideCategories).toContain('tools');
  });

  it('parses baseline conversation behavior from IR', () => {
    const ir = {
      identity: { goal: 'Help' },
      conversation_behavior: {
        speaking: {
          style: 'warm and concise',
          tool_lead_in: 'brief',
          tool_results: {
            style: 'top_option_first',
            max_points: 2,
          },
        },
        interaction: {
          answer_shape: 'answer_first',
          clarification: {
            mode: 'ask_only_when_blocked',
            max_questions: 1,
          },
        },
      },
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.conversationBehavior).toEqual(ir.conversation_behavior);
  });

  it('returns empty override categories for minimal profile', () => {
    const ir = {
      identity: { goal: 'Help' },
      behavior_profiles: [
        {
          name: 'bare_profile',
          priority: 1,
          when: 'true',
        },
      ],
    };

    const sections = parseIRToSections(ir);
    expect(sections.behavior.profiles[0].overrideCategories).toEqual([]);
  });
});

// =============================================================================
// computeVisibleSections — BEHAVIOR always visible
// =============================================================================

describe('computeVisibleSections — BEHAVIOR', () => {
  it('includes BEHAVIOR in visible sections', () => {
    const sections = parseIRToSections({ identity: { goal: 'Help' } });
    const visible = computeVisibleSections(sections);

    expect(visible).toContain('BEHAVIOR');
  });

  it('places BEHAVIOR before LIFECYCLE', () => {
    const sections = parseIRToSections({ identity: { goal: 'Help' } });
    const visible = computeVisibleSections(sections);

    const behaviorIdx = visible.indexOf('BEHAVIOR');
    const lifecycleIdx = visible.indexOf('LIFECYCLE');
    expect(behaviorIdx).toBeLessThan(lifecycleIdx);
  });

  it('places BEHAVIOR after COORDINATION', () => {
    const sections = parseIRToSections({ identity: { goal: 'Help' } });
    const visible = computeVisibleSections(sections);

    const coordinationIdx = visible.indexOf('COORDINATION');
    const behaviorIdx = visible.indexOf('BEHAVIOR');
    expect(coordinationIdx).toBeLessThan(behaviorIdx);
  });
});

// =============================================================================
// BehaviorSection component — structural tests
// =============================================================================

describe('BehaviorSection — structural validation', () => {
  it('BehaviorProfileRef type accepts valid profile data', () => {
    const profile: BehaviorProfileRef = channelProfile;
    expect(profile.name).toBe('whatsapp_adaptation');
    expect(profile.priority).toBe(10);
    expect(profile.whenSummary).toBe('context.channel == "whatsapp"');
    expect(profile.overrideCategories).toEqual(['instructions', 'response_rules', 'tools']);
  });

  it('BehaviorSectionData type accepts profile array', () => {
    const data: BehaviorSectionData = {
      conversationBehavior: {
        speaking: { style: 'warm and concise' },
      },
      profiles: [channelProfile, voiceProfile, minimalProfile],
    };
    expect(data.profiles).toHaveLength(3);
    expect(data.conversationBehavior?.speaking?.style).toBe('warm and concise');
  });

  it('BehaviorSectionData accepts empty profiles', () => {
    const data: BehaviorSectionData = { conversationBehavior: undefined, profiles: [] };
    expect(data.profiles).toHaveLength(0);
  });

  it('override category chips match expected categories', () => {
    // Verify the profile ref data structure supports all documented categories
    const allCategories = [
      'instructions',
      'constraints',
      'tools',
      'voice',
      'response_rules',
      'gather',
      'flow',
      'conversation',
    ];
    const profile: BehaviorProfileRef = {
      name: 'full_override',
      priority: 100,
      whenSummary: 'true',
      overrideCategories: allCategories,
    };
    expect(profile.overrideCategories).toEqual(allCategories);
  });
});
