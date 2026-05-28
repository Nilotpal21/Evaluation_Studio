/**
 * Voice Mode Resolver Tests
 *
 * Tests the voice mode resolution logic — the priority chain:
 *   1. Feature flag kill switch (env + config)
 *   2. Deployment explicit config
 *   3. Agent voice_optimized hint + tenant model
 *   4. Global config
 *   5. Default: pipeline
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  resolveVoiceMode,
  type VoiceModeContext,
} from '../../services/voice/voice-mode-resolver.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.REALTIME_VOICE_ENABLED;
  delete process.env.REALTIME_VOICE_ENABLED;
});

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.REALTIME_VOICE_ENABLED = savedEnv;
  } else {
    delete process.env.REALTIME_VOICE_ENABLED;
  }
});

function makeMinimalAgentIR(overrides?: Partial<AgentIR>): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test-agent', version: '1.0.0', description: '', tags: [], source_hash: '' },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
    },
    identity: { goal: '', persona: '', limitations: [], system_prompt: { template: '' } },
    tools: [],
    gather: { fields: [], strategy: 'conversational' },
    memory: {
      persistence: 'session',
      context_window: { max_turns: 20, strategy: 'sliding_window' },
    },
    constraints: { constraints: [], guardrails: [] },
    coordination: { handoffs: [], escalation: { enabled: false } },
    completion: { conditions: [], message: '' },
    error_handling: { strategy: 'retry', max_retries: 3, fallback_message: '' },
    ...overrides,
  } as AgentIR;
}

// =============================================================================
// FEATURE FLAG KILL SWITCH
// =============================================================================

describe('Feature flag kill switch', () => {
  test('returns pipeline when env not set', () => {
    const result = resolveVoiceMode({});
    expect(result).toBe('pipeline');
  });

  test('returns pipeline when env is "false"', () => {
    process.env.REALTIME_VOICE_ENABLED = 'false';
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('returns pipeline when env is "0"', () => {
    process.env.REALTIME_VOICE_ENABLED = '0';
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('allows realtime when env is "true"', () => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });

  test('allows realtime when env is "1"', () => {
    process.env.REALTIME_VOICE_ENABLED = '1';
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });

  test('env overrides config realtime.enabled', () => {
    process.env.REALTIME_VOICE_ENABLED = 'false';
    const result = resolveVoiceMode({
      globalConfig: { voice: { realtime: { enabled: true } } },
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('config realtime.enabled=true enables realtime when env not set', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { realtime: { enabled: true } } },
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });

  test('config realtime.enabled=false blocks realtime', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { realtime: { enabled: false } } },
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });
});

// =============================================================================
// PRIORITY 1: DEPLOYMENT CONFIG
// =============================================================================

describe('Priority 1: Deployment config', () => {
  beforeEach(() => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
  });

  test('deployment mode=realtime + tenant model → realtime', () => {
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });

  test('deployment mode=realtime without tenant model → pipeline', () => {
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      tenantHasRealtimeModel: false,
    });
    expect(result).toBe('pipeline');
  });

  test('deployment mode=pipeline → pipeline regardless of tenant model', () => {
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'pipeline' },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('deployment mode=auto → falls through to agent hint', () => {
    const agentIR = makeMinimalAgentIR({
      execution: {
        mode: 'reasoning',
        hints: {
          voice_optimized: true,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
      },
    });
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'auto' },
      agentIR,
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });
});

// =============================================================================
// PRIORITY 2: AGENT HINT
// =============================================================================

describe('Priority 2: Agent voice_optimized hint', () => {
  beforeEach(() => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
  });

  test('voice_optimized=true + tenant model → realtime', () => {
    const agentIR = makeMinimalAgentIR({
      execution: {
        mode: 'reasoning',
        hints: {
          voice_optimized: true,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
      },
    });
    const result = resolveVoiceMode({ agentIR, tenantHasRealtimeModel: true });
    expect(result).toBe('realtime');
  });

  test('voice_optimized=true without tenant model → pipeline', () => {
    const agentIR = makeMinimalAgentIR({
      execution: {
        mode: 'reasoning',
        hints: {
          voice_optimized: true,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
      },
    });
    const result = resolveVoiceMode({ agentIR, tenantHasRealtimeModel: false });
    expect(result).toBe('pipeline');
  });

  test('voice_optimized=false → pipeline', () => {
    const agentIR = makeMinimalAgentIR();
    const result = resolveVoiceMode({ agentIR, tenantHasRealtimeModel: true });
    expect(result).toBe('pipeline');
  });

  test('no agentIR → pipeline', () => {
    const result = resolveVoiceMode({ tenantHasRealtimeModel: true });
    expect(result).toBe('pipeline');
  });
});

// =============================================================================
// PRIORITY 3: GLOBAL CONFIG
// =============================================================================

describe('Priority 3: Global config', () => {
  beforeEach(() => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
  });

  test('global voice.mode=realtime + tenant model → realtime', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { mode: 'realtime' } },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('realtime');
  });

  test('global voice.mode=realtime without tenant model → pipeline', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { mode: 'realtime' } },
      tenantHasRealtimeModel: false,
    });
    expect(result).toBe('pipeline');
  });

  test('global voice.mode=pipeline → pipeline', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { mode: 'pipeline' } },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('global voice.mode=auto → pipeline (no agent hint)', () => {
    const result = resolveVoiceMode({
      globalConfig: { voice: { mode: 'auto' } },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });
});

// =============================================================================
// DEFAULT
// =============================================================================

describe('Default behavior', () => {
  beforeEach(() => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
  });

  test('empty context → pipeline', () => {
    const result = resolveVoiceMode({});
    expect(result).toBe('pipeline');
  });

  test('only tenantHasRealtimeModel → pipeline', () => {
    const result = resolveVoiceMode({ tenantHasRealtimeModel: true });
    expect(result).toBe('pipeline');
  });
});

// =============================================================================
// PRIORITY ORDERING
// =============================================================================

describe('Priority ordering', () => {
  beforeEach(() => {
    process.env.REALTIME_VOICE_ENABLED = 'true';
  });

  test('deployment overrides agent hint', () => {
    const agentIR = makeMinimalAgentIR({
      execution: {
        mode: 'reasoning',
        hints: {
          voice_optimized: true,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
      },
    });
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'pipeline' },
      agentIR,
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('deployment overrides global config', () => {
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'pipeline' },
      globalConfig: { voice: { mode: 'realtime' } },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });

  test('feature flag overrides all', () => {
    process.env.REALTIME_VOICE_ENABLED = 'false';
    const agentIR = makeMinimalAgentIR({
      execution: {
        mode: 'reasoning',
        hints: {
          voice_optimized: true,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
      },
    });
    const result = resolveVoiceMode({
      deploymentVoiceConfig: { mode: 'realtime' },
      agentIR,
      globalConfig: { voice: { mode: 'realtime', realtime: { enabled: true } } },
      tenantHasRealtimeModel: true,
    });
    expect(result).toBe('pipeline');
  });
});
