/**
 * Voice Config Resolver Integration Tests (INT-7)
 *
 * Tests resolveVoiceConfig merge priority:
 * - Profile voice override > IR base voice > undefined (external provisioning)
 * - Field-level shallow merge: profile overrides only the fields it sets
 * - No IR voice + no profile → undefined (caller uses connection defaults)
 */

import { describe, it, expect } from 'vitest';
import { resolveVoiceConfig } from '../../services/voice/voice-config-resolver.js';
import type { AgentIR, VoiceConfigIR } from '@abl/compiler';
import type { EffectiveAgentConfig } from '../../services/execution/profile-resolver.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeAgentIR(voice?: VoiceConfigIR): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test_agent', version: '1.0.0' },
    execution: {
      hints: { reasoning: false, scripted: false },
      timeouts: {},
      voice,
    },
    identity: { goal: 'Test', persona: 'Test' },
    tools: [],
    gather: { fields: [] },
    constraints: { rules: [], guardrails: [] },
    handoffs: [],
  } as unknown as AgentIR;
}

function makeEffectiveConfig(voiceConfig?: VoiceConfigIR): EffectiveAgentConfig {
  return {
    additionalInstructions: [],
    tools: [],
    additionalConstraints: [],
    activeProfileNames: ['test_profile'],
    voiceConfig,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('VoiceConfigResolver (INT-7)', () => {
  describe('merge priority', () => {
    it('profile voice override wins over IR base voice', () => {
      const ir = makeAgentIR({ provider: 'google', voice_id: 'en-US-Standard-A', speed: 1.0 });
      const config = makeEffectiveConfig({ provider: 'elevenlabs', voice_id: 'aria' });

      const result = resolveVoiceConfig(ir, config);

      expect(result).toBeDefined();
      expect(result!.ttsVendor).toBe('elevenlabs');
      expect(result!.ttsVoice).toBe('aria');
      // Speed not overridden by profile → falls through from IR
      expect(result!.ttsSpeed).toBe(1.0);
    });

    it('IR base voice used when no profile override', () => {
      const ir = makeAgentIR({ provider: 'azure', voice_id: 'en-US-JennyNeural' });

      const result = resolveVoiceConfig(ir, undefined);

      expect(result).toBeDefined();
      expect(result!.ttsVendor).toBe('azure');
      expect(result!.ttsVoice).toBe('en-US-JennyNeural');
    });

    it('profile-only voice config (no IR base) returns profile values', () => {
      const ir = makeAgentIR(); // no voice
      const config = makeEffectiveConfig({ provider: 'elevenlabs', voice_id: 'adam', speed: 1.2 });

      const result = resolveVoiceConfig(ir, config);

      expect(result).toBeDefined();
      expect(result!.ttsVendor).toBe('elevenlabs');
      expect(result!.ttsVoice).toBe('adam');
      expect(result!.ttsSpeed).toBe(1.2);
    });
  });

  describe('IR-gating', () => {
    it('returns undefined when no voice config at any level', () => {
      const ir = makeAgentIR(); // no voice
      const result = resolveVoiceConfig(ir, undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined when IR is null', () => {
      const result = resolveVoiceConfig(null, undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined with effectiveConfig but no voiceConfig field', () => {
      const ir = makeAgentIR();
      const config = makeEffectiveConfig(); // no voiceConfig
      const result = resolveVoiceConfig(ir, config);
      expect(result).toBeUndefined();
    });
  });

  describe('field-level merge', () => {
    it('profile overrides only specific fields, IR provides the rest', () => {
      const ir = makeAgentIR({
        provider: 'google',
        voice_id: 'en-US-Standard-B',
        speed: 0.9,
      });
      // Profile only overrides speed
      const config = makeEffectiveConfig({ speed: 1.5 });

      const result = resolveVoiceConfig(ir, config);

      expect(result!.ttsVendor).toBe('google');
      expect(result!.ttsVoice).toBe('en-US-Standard-B');
      expect(result!.ttsSpeed).toBe(1.5);
    });

    it('empty fields in result are omitted (not set to undefined)', () => {
      const ir = makeAgentIR({ provider: 'elevenlabs' });

      const result = resolveVoiceConfig(ir, undefined);

      expect(result).toBeDefined();
      expect(result!.ttsVendor).toBe('elevenlabs');
      expect(result!.ttsVoice).toBeUndefined();
      expect(result!.ttsSpeed).toBeUndefined();
    });
  });
});
