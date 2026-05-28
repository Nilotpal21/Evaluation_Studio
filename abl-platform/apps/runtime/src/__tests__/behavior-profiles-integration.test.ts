/**
 * Behavior Profiles Per-Turn Integration Tests (INT-4)
 *
 * Tests profile resolver per-turn re-evaluation with direct function calls.
 * Verifies:
 * - assembleProfileContext + resolveActiveProfiles with different turnCount values
 * - Turn-gated WHEN conditions activate/deactivate at correct turn boundaries
 * - buildEffectiveConfig produces correct voice, tools, instructions overlays
 * - Multiple profiles with different turn thresholds
 */

import { describe, it, expect } from 'vitest';
import {
  assembleProfileContext,
  resolveActiveProfiles,
  buildEffectiveConfig,
} from '../services/execution/profile-resolver.js';
import type { AgentIR, BehaviorProfileIR, ToolDefinition, VoiceConfigIR } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: [],
    returns: { type: 'string', description: 'result' },
    hints: {},
  };
}

function makeProfile(
  name: string,
  when: string,
  overrides?: Partial<BehaviorProfileIR>,
): BehaviorProfileIR {
  return {
    name,
    priority: 10,
    when,
    ...overrides,
  } as BehaviorProfileIR;
}

function makeBaseIR(tools?: ToolDefinition[], voice?: VoiceConfigIR): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test_agent', version: '1.0.0' },
    execution: {
      hints: { reasoning: false, scripted: false },
      timeouts: {},
      voice,
    },
    identity: { goal: 'Test agent', persona: 'Helpful' },
    tools: tools ?? [makeTool('search'), makeTool('sms'), makeTool('email')],
    gather: { fields: [] },
    constraints: { rules: [], guardrails: [] },
    handoffs: [],
  } as unknown as AgentIR;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Profile Per-Turn Re-Evaluation (INT-4)', () => {
  describe('turn-gated activation', () => {
    it('profile with turn_count > 2 is inactive on turns 1-2, active on turn 3', () => {
      const profile = makeProfile('late_mode', 'session.turn_count > 2', {
        tools_hide: ['sms'],
      });

      // Turn 1
      const ctx1 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 1 },
      });
      const active1 = resolveActiveProfiles([profile], ctx1);
      expect(active1).toHaveLength(0);

      // Turn 2
      const ctx2 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 2 },
      });
      const active2 = resolveActiveProfiles([profile], ctx2);
      expect(active2).toHaveLength(0);

      // Turn 3
      const ctx3 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 3 },
      });
      const active3 = resolveActiveProfiles([profile], ctx3);
      expect(active3).toHaveLength(1);
      expect(active3[0].name).toBe('late_mode');
    });

    it('profile with turn_count > 0 activates immediately on turn 1', () => {
      const profile = makeProfile('immediate', 'session.turn_count > 0');

      const ctx = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 1 },
      });
      const active = resolveActiveProfiles([profile], ctx);
      expect(active).toHaveLength(1);
    });
  });

  describe('multiple profiles with different thresholds', () => {
    it('profiles activate at their respective turn thresholds', () => {
      const profiles = [
        makeProfile('early', 'session.turn_count > 0', { priority: 10 }),
        makeProfile('mid', 'session.turn_count > 3', { priority: 20 }),
        makeProfile('late', 'session.turn_count > 5', { priority: 30 }),
      ];

      // Turn 1: only 'early'
      const ctx1 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 1 },
      });
      expect(resolveActiveProfiles(profiles, ctx1).map((p) => p.name)).toEqual(['early']);

      // Turn 4: 'early' + 'mid'
      const ctx4 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 4 },
      });
      expect(resolveActiveProfiles(profiles, ctx4).map((p) => p.name)).toEqual(['early', 'mid']);

      // Turn 6: all three
      const ctx6 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 6 },
      });
      expect(resolveActiveProfiles(profiles, ctx6).map((p) => p.name)).toEqual([
        'early',
        'mid',
        'late',
      ]);
    });
  });

  describe('buildEffectiveConfig with per-turn profiles', () => {
    it('tools_hide removes tools from base set', () => {
      const baseIR = makeBaseIR([makeTool('search'), makeTool('sms'), makeTool('email')]);
      const profiles: BehaviorProfileIR[] = [
        makeProfile('hide_sms', 'session.turn_count > 0', { tools_hide: ['sms'] }),
      ];

      const config = buildEffectiveConfig(baseIR, profiles);

      const toolNames = config.tools.map((t) => t.name);
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('email');
      expect(toolNames).not.toContain('sms');
    });

    it('voice override in profile sets voiceConfig on effective config', () => {
      const baseIR = makeBaseIR(undefined, { provider: 'google', voice_id: 'standard-a' });
      const profiles: BehaviorProfileIR[] = [
        makeProfile('premium_voice', 'session.turn_count > 0', {
          voice: { provider: 'elevenlabs', voice_id: 'aria' },
        }),
      ];

      const config = buildEffectiveConfig(baseIR, profiles);

      expect(config.voiceConfig).toBeDefined();
      expect(config.voiceConfig!.provider).toBe('elevenlabs');
      expect(config.voiceConfig!.voice_id).toBe('aria');
    });

    it('instructions from profile are included in additionalInstructions', () => {
      const baseIR = makeBaseIR();
      const profiles: BehaviorProfileIR[] = [
        makeProfile('verbose', 'session.turn_count > 0', {
          instructions: 'Provide detailed explanations.',
        }),
      ];

      const config = buildEffectiveConfig(baseIR, profiles);

      expect(config.additionalInstructions).toContain('Provide detailed explanations.');
    });

    it('activeProfileNames lists all active profiles', () => {
      const baseIR = makeBaseIR();
      const profiles: BehaviorProfileIR[] = [
        makeProfile('profile_a', 'session.turn_count > 0', { priority: 10 }),
        makeProfile('profile_b', 'session.turn_count > 0', { priority: 20 }),
      ];

      const config = buildEffectiveConfig(baseIR, profiles);

      expect(config.activeProfileNames).toContain('profile_a');
      expect(config.activeProfileNames).toContain('profile_b');
    });
  });

  describe('channel + turn compound conditions', () => {
    it('profile with channel AND turn condition requires both', () => {
      const profile = makeProfile(
        'voice_late',
        'channel.name == "voice" && session.turn_count > 2',
      );

      // Voice channel, turn 1: not active (turn condition fails)
      const ctx1 = assembleProfileContext({
        channelType: 'voice',
        sessionMeta: { isNew: false, turnCount: 1 },
      });
      expect(resolveActiveProfiles([profile], ctx1)).toHaveLength(0);

      // Digital channel, turn 3: not active (channel condition fails)
      const ctx2 = assembleProfileContext({
        channelType: 'digital',
        sessionMeta: { isNew: false, turnCount: 3 },
      });
      expect(resolveActiveProfiles([profile], ctx2)).toHaveLength(0);

      // Voice channel, turn 3: active (both conditions pass)
      const ctx3 = assembleProfileContext({
        channelType: 'voice',
        sessionMeta: { isNew: false, turnCount: 3 },
      });
      expect(resolveActiveProfiles([profile], ctx3)).toHaveLength(1);
    });
  });
});
