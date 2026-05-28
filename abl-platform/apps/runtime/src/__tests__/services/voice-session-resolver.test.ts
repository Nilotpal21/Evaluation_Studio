import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../../services/execution/types.js';

const realtimeSession = {
  getCapabilityProfile: vi.fn(() => ({
    providerType: 'openai_realtime',
    capabilities: {
      supportsPromptRefresh: true,
      supportsToolRefresh: true,
      supportsToolResultInjection: true,
      supportsPartialAssistantTranscript: true,
      supportsProviderTurnDetection: true,
      supportsBargeInSignal: true,
    },
    notes: ['OpenAI Realtime supports tool-result injection.'],
  })),
} as object;

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@abl/compiler/platform/llm/realtime/index.js', () => ({
  createRealtimeSession: vi.fn(() => realtimeSession),
}));

vi.mock('../../repos/llm-resolution-repo.js', () => ({
  findDefaultTenantModelForVoice: vi.fn(),
}));

vi.mock('../../services/voice/voice-service-factory.js', () => ({
  VoiceServiceFactory: class {
    async resolveVoiceMode(): Promise<'realtime'> {
      return 'realtime';
    }
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: vi.fn().mockResolvedValue('decrypted-api-key'),
}));

import { resolveVoiceSession } from '../../services/voice/voice-session-resolver.js';
import { findDefaultTenantModelForVoice } from '../../repos/llm-resolution-repo.js';

const ORIGINAL_MODE = process.env.VOICE_SEMANTIC_CONVERGENCE_MODE;
const ORIGINAL_FAMILIES = process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;

function makeAgentIR(): AgentIR {
  return {
    metadata: {
      name: 'voice-agent',
      version: '1.0.0',
      description: '',
      tags: [],
      source_hash: 'hash',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: true,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        turn_timeout: 30_000,
        total_timeout: 60_000,
        tool_timeout: 30_000,
      },
    },
  } as AgentIR;
}

describe('resolveVoiceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = 'enforce';
    process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES = 'sdk_voice_realtime';
    vi.mocked(findDefaultTenantModelForVoice).mockResolvedValue({
      modelId: 'gpt-realtime-1.5',
      provider: 'openai',
      connections: [{ encryptedApiKey: 'encrypted-key' }],
      realtimeConfig: {},
    });
  });

  afterEach(() => {
    if (ORIGINAL_MODE === undefined) {
      delete process.env.VOICE_SEMANTIC_CONVERGENCE_MODE;
    } else {
      process.env.VOICE_SEMANTIC_CONVERGENCE_MODE = ORIGINAL_MODE;
    }

    if (ORIGINAL_FAMILIES === undefined) {
      delete process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES;
    } else {
      process.env.VOICE_SEMANTIC_CONVERGENCE_FAMILIES = ORIGINAL_FAMILIES;
    }
  });

  test('passes the shared tool executors and semantic convergence plan into the realtime executor config', async () => {
    const toolExecutor = vi.fn();
    const voiceTurnExecutor = vi.fn();
    const runtimeSession = { id: 'runtime-session-1' } as RuntimeSession;

    const result = await resolveVoiceSession({
      tenantId: 'tenant-1',
      sessionId: 'runtime-session-1',
      agentIR: makeAgentIR(),
      runtimeSession,
      toolExecutor,
      voiceTurnExecutor,
      semanticFamily: 'sdk_voice_realtime',
    });

    expect(result.mode).toBe('realtime');
    expect(result.executor).toBeDefined();
    expect(result.semanticConvergence).toMatchObject({
      family: 'sdk_voice_realtime',
      mode: 'enforce',
      strategy: 'coordinator_tool',
      reason: 'enforce_coordinator_tool',
    });

    const config = (
      result.executor as unknown as {
        config: {
          runtimeSession?: object;
          toolExecutor?: unknown;
          voiceTurnExecutor?: unknown;
          semanticConvergence?: { strategy: string };
        };
      }
    ).config;
    expect(config.runtimeSession).toBe(runtimeSession);
    expect(config.toolExecutor).toBe(toolExecutor);
    expect(config.voiceTurnExecutor).toBe(voiceTurnExecutor);
    expect(config.semanticConvergence).toMatchObject({
      strategy: 'coordinator_tool',
    });
  });
});
