/**
 * Voice IR Resolution E2E Tests
 *
 * Tests voice config resolution from IR through the RuntimeExecutor stack.
 * Verifies the resolveVoiceConfig function correctly prioritizes:
 *   profile override > IR base voice > external provisioning (undefined)
 *
 * Since Korevg voice sessions require real WebSocket connections and TTS providers,
 * these tests verify the resolver integration via session state inspection rather
 * than actual TTS delivery. The resolver is wired in korevg-router.ts at session
 * creation time.
 *
 * Verifies:
 * - Agent with execution.voice IR → resolveVoiceConfig returns TTS params
 * - Profile voice override → takes priority over IR base
 * - Agent without voice IR → returns undefined (external provisioning preserved)
 * - Per-turn profile change with voice → _effectiveConfig.voiceConfig updates
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { injectMockClient } from '../execution/pre-refactor/helpers/mock-llm-client.js';
import { resolveVoiceConfig } from '../../services/voice/voice-config-resolver.js';
import type { VoiceConfigIR } from '@abl/compiler';

// =============================================================================
// DSL FIXTURES
// =============================================================================

const VOICE_AGENT = `
AGENT: Voice_Agent

GOAL: "Handle voice calls with custom TTS"
PERSONA: "Friendly voice assistant"
`;

const PLAIN_AGENT = `
AGENT: Plain_Agent

GOAL: "Digital-only agent"
PERSONA: "Text assistant"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Voice IR Resolution E2E', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('IR base voice config', () => {
    it('execution.voice IR resolves to TTS params', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([VOICE_AGENT], 'Voice_Agent'),
      );

      // Inject voice config onto IR execution block
      session.agentIR!.execution.voice = {
        provider: 'elevenlabs',
        voice_id: 'aria',
        speed: 1.0,
      };

      const voiceParams = resolveVoiceConfig(session.agentIR, session._effectiveConfig);

      expect(voiceParams).toBeDefined();
      expect(voiceParams!.ttsVendor).toBe('elevenlabs');
      expect(voiceParams!.ttsVoice).toBe('aria');
      expect(voiceParams!.ttsSpeed).toBe(1.0);
    });

    it('partial voice config maps only set fields', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([VOICE_AGENT], 'Voice_Agent'),
      );

      session.agentIR!.execution.voice = {
        provider: 'google',
      };

      const voiceParams = resolveVoiceConfig(session.agentIR, session._effectiveConfig);

      expect(voiceParams).toBeDefined();
      expect(voiceParams!.ttsVendor).toBe('google');
      expect(voiceParams!.ttsVoice).toBeUndefined();
      expect(voiceParams!.ttsSpeed).toBeUndefined();
    });
  });

  describe('profile voice override', () => {
    it('profile voice takes priority over IR base', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Hello!',
        toolCalls: [],
        stopReason: 'end_turn' as const,
        rawContent: [{ type: 'text' as const, text: 'Hello!' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([VOICE_AGENT], 'Voice_Agent'),
      );

      // IR base voice
      session.agentIR!.execution.voice = {
        provider: 'google',
        voice_id: 'en-US-Standard-A',
        speed: 1.0,
      };

      // Profile with voice override — activates immediately
      session.agentIR!.behavior_profiles = [
        {
          name: 'premium_voice',
          priority: 10,
          when: 'session.turn_count > 0',
          voice: {
            provider: 'elevenlabs',
            voice_id: 'rachel',
          },
        },
      ];

      // Execute a turn to trigger profile resolution
      await executor.executeMessage(session.id, 'Hello');

      // Profile should be active
      expect(session._activeProfileNames).toContain('premium_voice');

      // Resolve voice config with active profile
      const voiceParams = resolveVoiceConfig(session.agentIR, session._effectiveConfig);

      expect(voiceParams!.ttsVendor).toBe('elevenlabs');
      expect(voiceParams!.ttsVoice).toBe('rachel');
      // Speed not overridden by profile → falls through from IR base
      expect(voiceParams!.ttsSpeed).toBe(1.0);
    });
  });

  describe('no voice config', () => {
    it('agent without voice IR returns undefined (external provisioning preserved)', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([PLAIN_AGENT], 'Plain_Agent'),
      );

      const voiceParams = resolveVoiceConfig(session.agentIR, session._effectiveConfig);

      expect(voiceParams).toBeUndefined();
    });

    it('null agentIR returns undefined', () => {
      const voiceParams = resolveVoiceConfig(null, undefined);
      expect(voiceParams).toBeUndefined();
    });
  });

  describe('per-turn voice config change', () => {
    it('voice config updates when profile activates mid-session', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => ({
        text: 'Response',
        toolCalls: [],
        stopReason: 'end_turn' as const,
        rawContent: [{ type: 'text' as const, text: 'Response' }],
      }));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([VOICE_AGENT], 'Voice_Agent'),
      );

      // IR base voice
      session.agentIR!.execution.voice = {
        provider: 'google',
        voice_id: 'en-US-Standard-A',
      };

      // Profile activates after turn 1
      session.agentIR!.behavior_profiles = [
        {
          name: 'turn2_voice',
          priority: 10,
          when: 'session.turn_count > 1',
          voice: {
            provider: 'elevenlabs',
            voice_id: 'adam',
            speed: 1.3,
          },
        },
      ];

      // Turn 1: profile not yet active
      await executor.executeMessage(session.id, 'Turn 1');
      const params1 = resolveVoiceConfig(session.agentIR, session._effectiveConfig);
      // No profile active → just IR base
      expect(params1!.ttsVendor).toBe('google');

      // Turn 2: profile activates
      await executor.executeMessage(session.id, 'Turn 2');
      const params2 = resolveVoiceConfig(session.agentIR, session._effectiveConfig);
      expect(params2!.ttsVendor).toBe('elevenlabs');
      expect(params2!.ttsVoice).toBe('adam');
      expect(params2!.ttsSpeed).toBe(1.3);
    });
  });
});
