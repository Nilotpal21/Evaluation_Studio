import { describe, expect, it } from 'vitest';
import { mapProjectRuntimeConfigDocumentToIR } from '@abl/compiler/platform/ir/project-runtime-config.js';
import { runtimeConfigUpdateSchema } from '@agent-platform/shared/validation';
import { resolveFillerConfig as resolveFillerRuntimeConfig } from '../../services/filler/config.js';
import { resolveFillerConfig as resolveChannelFillerConfig } from '../../services/filler/config-resolver.js';

describe('filler config cross-layer parity', () => {
  it('preserves voiceDelayMs through shared validation, compiler IR mapping, and runtime resolution', () => {
    const parsed = runtimeConfigUpdateSchema.parse({
      filler: {
        enabled: true,
        chatEnabled: true,
        voiceEnabled: true,
        chatDelayMs: 1200,
        voiceDelayMs: 500,
        cooldownMs: 5000,
        maxPerTurn: 3,
        piggybackEnabled: true,
        pipelineGenerationEnabled: true,
        modelSource: 'system',
      },
    });

    expect(parsed.filler?.voiceDelayMs).toBe(500);

    const ir = mapProjectRuntimeConfigDocumentToIR(parsed);
    expect(ir.filler?.voiceDelayMs).toBe(500);

    const resolved = resolveFillerRuntimeConfig({
      projectFiller: ir.filler,
      isVoiceChannel: true,
      channelDefaults: resolveChannelFillerConfig('voice_pipeline'),
    });

    expect(resolved.serviceConfig.voiceDelayMs).toBe(500);
    expect(resolved.serviceConfig.chatDelayMs).toBe(500);
    expect(resolved.serviceConfig.cooldownMs).toBe(5000);
    expect(resolved.serviceConfig.maxPerTurn).toBe(3);
  });

  it('rejects zero voiceDelayMs at the shared config boundary', () => {
    expect(() =>
      runtimeConfigUpdateSchema.parse({
        filler: {
          voiceDelayMs: 0,
        },
      }),
    ).toThrow();
  });
});
