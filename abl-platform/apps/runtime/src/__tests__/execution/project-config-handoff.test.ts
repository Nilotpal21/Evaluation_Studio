/**
 * Tests for F5: Project runtime config survives handoff/delegate IR switch.
 *
 * The _projectRuntimeConfig field is cached on session at init and reapplied
 * whenever session.agentIR is replaced during handoff or delegate operations.
 */

import { describe, it, expect } from 'vitest';
import type { AgentIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import { resolveMultiIntentConfig } from '../../services/execution/routing-executor.js';

// =============================================================================
// FIXTURES
// =============================================================================

function buildAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'test-hash',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'reasoning', max_turns: 10, max_tool_iterations: 5 },
    identity: { name: 'Test Agent', goal: 'Help users', persona: '' },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    ...overrides,
  } as AgentIR;
}

function buildProjectConfig(
  overrides: Partial<ProjectRuntimeConfigIR> = {},
): ProjectRuntimeConfigIR {
  return {
    extraction_strategy: 'auto',
    nlu_provider: 'standard',
    multi_intent: {
      enabled: true,
      strategy: 'primary_queue',
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 600_000,
    },
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast',
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' },
    lookup_tables: [],
    ...overrides,
  };
}

function buildSession(overrides: Record<string, unknown> = {}): RuntimeSession {
  return {
    id: 'session-config-test',
    agentName: 'test_agent',
    agentIR: buildAgentIR(),
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: true,
    threads: [
      {
        agentName: 'test_agent',
        agentIR: null,
        status: 'active',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
        startedAt: Date.now(),
        returnExpected: false,
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  } as unknown as RuntimeSession;
}

// Simulate the config reapplication pattern from routing-executor.ts
function simulateHandoffIRSwitch(session: RuntimeSession, targetIR: AgentIR): void {
  session.agentIR = targetIR;
  if (session._projectRuntimeConfig && session.agentIR) {
    session.agentIR.project_runtime_config = session._projectRuntimeConfig;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('F5: Project config survives handoff', () => {
  it('config reapplied after handoff IR switch', () => {
    const projectConfig = buildProjectConfig({ extraction_strategy: 'hybrid' });
    const session = buildSession({
      _projectRuntimeConfig: projectConfig,
    });
    session.agentIR!.project_runtime_config = projectConfig;

    // Simulate handoff to new agent
    const targetIR = buildAgentIR({
      metadata: {
        name: 'target_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'target',
        compiler_version: '1.0.0',
      },
    });

    simulateHandoffIRSwitch(session, targetIR);

    expect(session.agentIR!.project_runtime_config).toBeDefined();
    expect(session.agentIR!.project_runtime_config!.extraction_strategy).toBe('hybrid');
  });

  it('config reapplied after delegate IR switch', () => {
    const projectConfig = buildProjectConfig({
      multi_intent: {
        enabled: true,
        strategy: 'sequential',
        max_intents: 5,
        confidence_threshold: 0.7,
        queue_max_age_ms: 300_000,
      },
    });
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    const delegateIR = buildAgentIR({
      metadata: {
        name: 'delegate_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'delegate',
        compiler_version: '1.0.0',
      },
    });

    simulateHandoffIRSwitch(session, delegateIR);

    expect(session.agentIR!.project_runtime_config!.multi_intent.strategy).toBe('sequential');
    expect(session.agentIR!.project_runtime_config!.multi_intent.max_intents).toBe(5);
  });

  it('no _projectRuntimeConfig — target IR not mutated', () => {
    const session = buildSession();
    const targetIR = buildAgentIR();

    simulateHandoffIRSwitch(session, targetIR);

    expect(session.agentIR!.project_runtime_config).toBeUndefined();
  });

  it('cached config is same reference as original', () => {
    const projectConfig = buildProjectConfig();
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    const targetIR = buildAgentIR();
    simulateHandoffIRSwitch(session, targetIR);

    expect(session.agentIR!.project_runtime_config).toBe(projectConfig);
  });

  it('config survives multiple chained handoffs', () => {
    const projectConfig = buildProjectConfig({
      extraction_strategy: 'llm',
      multi_intent: {
        enabled: false,
        strategy: 'disambiguate',
        max_intents: 2,
        confidence_threshold: 0.9,
        queue_max_age_ms: 120_000,
      },
    });
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    // First handoff
    simulateHandoffIRSwitch(
      session,
      buildAgentIR({
        metadata: {
          name: 'agent_b',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '',
          source_hash: 'b',
          compiler_version: '1.0.0',
        },
      }),
    );
    expect(session.agentIR!.project_runtime_config!.extraction_strategy).toBe('llm');

    // Second handoff
    simulateHandoffIRSwitch(
      session,
      buildAgentIR({
        metadata: {
          name: 'agent_c',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '',
          source_hash: 'c',
          compiler_version: '1.0.0',
        },
      }),
    );
    expect(session.agentIR!.project_runtime_config!.extraction_strategy).toBe('llm');
    expect(session.agentIR!.project_runtime_config!.multi_intent.enabled).toBe(false);

    // Third handoff
    simulateHandoffIRSwitch(
      session,
      buildAgentIR({
        metadata: {
          name: 'agent_d',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '',
          source_hash: 'd',
          compiler_version: '1.0.0',
        },
      }),
    );
    expect(session.agentIR!.project_runtime_config).toBe(projectConfig);
  });

  it('resolveMultiIntentConfig works after handoff with preserved config', () => {
    const projectConfig = buildProjectConfig({
      multi_intent: {
        enabled: true,
        strategy: 'parallel',
        max_intents: 4,
        confidence_threshold: 0.5,
        queue_max_age_ms: 900_000,
      },
    });
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    const targetIR = buildAgentIR();
    simulateHandoffIRSwitch(session, targetIR);

    // resolveMultiIntentConfig should use the preserved project config
    const config = resolveMultiIntentConfig(session.agentIR!);
    expect(config.strategy).toBe('parallel');
    expect(config.max_intents).toBe(4);
    expect(config.confidence_threshold).toBe(0.5);
  });

  it('agent-level config still overrides preserved project config after handoff', () => {
    const projectConfig = buildProjectConfig({
      multi_intent: {
        enabled: true,
        strategy: 'sequential',
        max_intents: 5,
        confidence_threshold: 0.7,
        queue_max_age_ms: 300_000,
      },
    });
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    // Target agent has its own intent_handling config
    const targetIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 2,
          confidence_threshold: 0.9,
          queue_max_age_ms: 120_000,
        },
      },
    });

    simulateHandoffIRSwitch(session, targetIR);

    const config = resolveMultiIntentConfig(session.agentIR!);
    // Agent-level wins over project-level
    expect(config.strategy).toBe('disambiguate');
    expect(config.max_intents).toBe(2);
  });

  it('handoff to agent with null IR does not crash', () => {
    const projectConfig = buildProjectConfig();
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    // Simulate handoff where agentIR is set to null
    session.agentIR = null;
    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    // Should not crash — the guard prevents null dereference
    expect(session.agentIR).toBeNull();
  });

  it('sidecar config fields survive handoff', () => {
    const projectConfig = buildProjectConfig({
      correction_detection: 'llm',
      sidecar_timeout_ms: 1000,
      sidecar_circuit_breaker_threshold: 3,
    });
    const session = buildSession({ _projectRuntimeConfig: projectConfig });

    simulateHandoffIRSwitch(session, buildAgentIR());

    expect(session.agentIR!.project_runtime_config!.correction_detection).toBe('llm');
    expect(session.agentIR!.project_runtime_config!.sidecar_timeout_ms).toBe(1000);
    expect(session.agentIR!.project_runtime_config!.sidecar_circuit_breaker_threshold).toBe(3);
  });
});
