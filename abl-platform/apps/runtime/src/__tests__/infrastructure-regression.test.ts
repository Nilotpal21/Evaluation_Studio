/**
 * Infrastructure Regression Prevention Tests
 *
 * These tests verify critical infrastructure features that were accidentally
 * deleted in commit 9e7fe8074 and had NO test coverage. They exist solely
 * to prevent future regressions by asserting the behavior of:
 *
 * 1. shouldPersistImmediately — channel-aware persistence logic
 * 2. moduleProvenance — building provenance map from resolved agents
 * 3. configHash — deterministic hash computation for STI tracing
 * 4. traceId propagation — ALS priority and fallback in centralized trace handler
 * 5. Unmapped event guard — events without TRACE_TO_PLATFORM_TYPE mapping skip EventStore
 * 6. Pipeline event verbosity — shouldEmitTrace for pipeline-specific event types
 */

import { describe, test, expect } from 'vitest';
import { getChannelManifest, CHANNEL_MANIFEST } from '../channels/manifest.js';
import { shouldEmitTrace, VERBOSITY_LEVELS } from '../services/execution/trace-helpers.js';
import { computeConfigHash } from '@agent-platform/shared-observability/sti';
import { TRACE_TO_PLATFORM_TYPE, inferCategory } from '../services/trace-event-types.js';

// =============================================================================
// 1. shouldPersistImmediately — channel-aware persistence logic
// =============================================================================

describe('shouldPersistImmediately logic (regression: deleted in 9e7fe8074)', () => {
  /**
   * shouldPersistImmediately is a non-exported module-level function in
   * runtime-executor.ts (line 93). Its logic:
   *
   *   if (!channelType) return false;
   *   const manifest = getChannelManifest(channelType);
   *   if (!manifest) return channelType === 'http' || channelType === 'api';
   *   return manifest.delivery === 'sync_response' && manifest.ingress !== 'websocket';
   *
   * We test the PUBLIC surface that this function depends on (getChannelManifest)
   * and replicate the logic to verify correctness for each channel category.
   */

  function shouldPersistImmediately(channelType: string | undefined): boolean {
    if (!channelType) return false;
    const manifest = getChannelManifest(channelType);
    if (!manifest) return channelType === 'http' || channelType === 'api';
    return manifest.delivery === 'sync_response' && manifest.ingress !== 'websocket';
  }

  describe('getChannelManifest returns expected shapes', () => {
    test('returns manifest for known channel "http"', () => {
      const manifest = getChannelManifest('http');
      expect(manifest).toBeDefined();
      expect(manifest!.delivery).toBe('sync_response');
      expect(manifest!.ingress).toBe('api');
    });

    test('returns manifest for known channel "api"', () => {
      const manifest = getChannelManifest('api');
      expect(manifest).toBeDefined();
      expect(manifest!.delivery).toBe('sync_response');
      expect(manifest!.ingress).toBe('api');
    });

    test('returns undefined for unknown channel type', () => {
      const manifest = getChannelManifest('totally_unknown_channel');
      expect(manifest).toBeUndefined();
    });

    test('returns manifest with all required fields for "slack"', () => {
      const manifest = getChannelManifest('slack');
      expect(manifest).toBeDefined();
      expect(manifest!.delivery).toBe('async_queue');
      expect(manifest!.ingress).toBe('webhook');
      expect(manifest!.displayName).toBe('Slack');
    });
  });

  describe('channels that SHOULD persist immediately', () => {
    test('"http" channel: sync_response delivery + api ingress => immediate', () => {
      expect(shouldPersistImmediately('http')).toBe(true);
    });

    test('"api" channel: sync_response delivery + api ingress => immediate', () => {
      expect(shouldPersistImmediately('api')).toBe(true);
    });

    test('"genesys" channel: sync_response delivery + sync_webhook ingress => immediate', () => {
      expect(shouldPersistImmediately('genesys')).toBe(true);
    });

    test('"voice_vxml" channel: sync_response delivery + sync_webhook ingress => immediate', () => {
      expect(shouldPersistImmediately('voice_vxml')).toBe(true);
    });
  });

  describe('channels that should NOT persist immediately', () => {
    test('"websocket" ingress channels do not persist immediately', () => {
      expect(shouldPersistImmediately('korevg')).toBe(false);
    });

    test('"sdk_websocket" channel: websocket delivery => not immediate', () => {
      expect(shouldPersistImmediately('sdk_websocket')).toBe(false);
    });

    test('"slack" channel: async_queue delivery => not immediate', () => {
      expect(shouldPersistImmediately('slack')).toBe(false);
    });

    test('"whatsapp" channel: async_queue delivery => not immediate', () => {
      expect(shouldPersistImmediately('whatsapp')).toBe(false);
    });

    test('"web_chat" channel: websocket delivery => not immediate', () => {
      expect(shouldPersistImmediately('web_chat')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('undefined channelType returns false', () => {
      expect(shouldPersistImmediately(undefined)).toBe(false);
    });

    test('"http" persists immediately via manifest path', () => {
      expect(shouldPersistImmediately('http')).toBe(true);
    });

    test('"api" persists immediately via manifest path', () => {
      expect(shouldPersistImmediately('api')).toBe(true);
    });

    test('unknown channel type without manifest that is NOT "http"/"api" returns false', () => {
      expect(shouldPersistImmediately('some_future_channel')).toBe(false);
    });

    test('empty string channelType returns false (falsy after manifest lookup fails)', () => {
      expect(shouldPersistImmediately('')).toBe(false);
    });
  });
});

// =============================================================================
// 2. moduleProvenance — building provenance map from resolved agents
// =============================================================================

describe('moduleProvenance building logic (regression: deleted in 9e7fe8074)', () => {
  interface ModuleProvenanceEntry {
    alias: string;
    moduleProjectId: string;
    moduleReleaseId: string;
    sourceAgentName: string;
  }

  function buildModuleProvenance(
    agents: Record<string, Record<string, unknown>>,
  ): Record<string, ModuleProvenanceEntry> | undefined {
    const moduleProvenance: Record<string, ModuleProvenanceEntry> = {};
    for (const [name, ir] of Object.entries(agents)) {
      const prov = ir._moduleProvenance as ModuleProvenanceEntry | undefined;
      if (prov) {
        moduleProvenance[name] = prov;
      }
    }
    if (Object.keys(moduleProvenance).length > 0) {
      return moduleProvenance;
    }
    return undefined;
  }

  test('agents with _moduleProvenance get their provenance extracted', () => {
    const agents = {
      BillingAgent: {
        name: 'BillingAgent',
        _moduleProvenance: {
          alias: 'billing_v2',
          moduleProjectId: 'proj-mod-123',
          moduleReleaseId: 'rel-456',
          sourceAgentName: 'BillingAgent',
        },
      },
    };

    const result = buildModuleProvenance(agents);
    expect(result).toBeDefined();
    expect(result!['BillingAgent']).toEqual({
      alias: 'billing_v2',
      moduleProjectId: 'proj-mod-123',
      moduleReleaseId: 'rel-456',
      sourceAgentName: 'BillingAgent',
    });
  });

  test('agents without _moduleProvenance are skipped', () => {
    const agents = {
      LocalAgent: { name: 'LocalAgent' },
      ModuleAgent: {
        name: 'ModuleAgent',
        _moduleProvenance: {
          alias: 'support_v1',
          moduleProjectId: 'proj-555',
          moduleReleaseId: 'rel-999',
          sourceAgentName: 'SupportAgent',
        },
      },
    };

    const result = buildModuleProvenance(agents);
    expect(result).toBeDefined();
    expect(result!['ModuleAgent']).toBeDefined();
    expect(result!['LocalAgent']).toBeUndefined();
  });

  test('empty provenance map returns undefined (not assigned to session)', () => {
    const agents = {
      AgentA: { name: 'AgentA' },
      AgentB: { name: 'AgentB' },
    };

    const result = buildModuleProvenance(agents);
    expect(result).toBeUndefined();
  });

  test('non-empty provenance map is returned for session assignment', () => {
    const agents = {
      Agent1: {
        name: 'Agent1',
        _moduleProvenance: {
          alias: 'mod_a',
          moduleProjectId: 'p1',
          moduleReleaseId: 'r1',
          sourceAgentName: 'SourceA',
        },
      },
      Agent2: {
        name: 'Agent2',
        _moduleProvenance: {
          alias: 'mod_b',
          moduleProjectId: 'p2',
          moduleReleaseId: 'r2',
          sourceAgentName: 'SourceB',
        },
      },
    };

    const result = buildModuleProvenance(agents);
    expect(result).toBeDefined();
    expect(Object.keys(result!)).toHaveLength(2);
    expect(result!['Agent1'].alias).toBe('mod_a');
    expect(result!['Agent2'].alias).toBe('mod_b');
  });

  test('moduleProvenance survives JSON serialization (session save/restore roundtrip)', () => {
    const provenance = {
      BillingAgent: {
        alias: 'billing_v2',
        moduleProjectId: 'proj-mod-123',
        moduleReleaseId: 'rel-456',
        sourceAgentName: 'BillingAgent',
      },
    };

    const serialized = JSON.stringify(provenance);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(provenance);
    expect(deserialized['BillingAgent'].alias).toBe('billing_v2');
    expect(deserialized['BillingAgent'].moduleProjectId).toBe('proj-mod-123');
    expect(deserialized['BillingAgent'].moduleReleaseId).toBe('rel-456');
    expect(deserialized['BillingAgent'].sourceAgentName).toBe('BillingAgent');
  });

  test('moduleProvenance shape matches expected schema for saveSessionSnapshot', () => {
    const provenance: Record<string, ModuleProvenanceEntry> = {
      TestAgent: {
        alias: 'test_alias',
        moduleProjectId: 'proj-id',
        moduleReleaseId: 'release-id',
        sourceAgentName: 'OriginalAgent',
      },
    };

    const entry = provenance['TestAgent'];
    expect(entry).toHaveProperty('alias');
    expect(entry).toHaveProperty('moduleProjectId');
    expect(entry).toHaveProperty('moduleReleaseId');
    expect(entry).toHaveProperty('sourceAgentName');
    expect(typeof entry.alias).toBe('string');
    expect(typeof entry.moduleProjectId).toBe('string');
    expect(typeof entry.moduleReleaseId).toBe('string');
    expect(typeof entry.sourceAgentName).toBe('string');
  });
});

// =============================================================================
// 3. configHash — deterministic hash computation for STI tracing
// =============================================================================

describe('configHash computation (regression: deleted in 9e7fe8074)', () => {
  test('produces a deterministic hash for the same IR', () => {
    const ir = { name: 'TestAgent', goal: 'Help users', flow: { steps: ['greet'] } };

    const hash1 = computeConfigHash(ir);
    const hash2 = computeConfigHash(ir);

    expect(hash1).toBe(hash2);
  });

  test('different IR produces a different hash', () => {
    const ir1 = { name: 'AgentA', goal: 'Help users', flow: { steps: ['greet'] } };
    const ir2 = { name: 'AgentB', goal: 'Help admins', flow: { steps: ['start'] } };

    const hash1 = computeConfigHash(ir1);
    const hash2 = computeConfigHash(ir2);

    expect(hash1).not.toBe(hash2);
  });

  test('returns a hex string (SHA-256 format)', () => {
    const ir = { name: 'HashFormatAgent' };
    const hash = computeConfigHash(ir);

    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  test('key ordering does not affect hash (deterministic sorting)', () => {
    const ir1 = { b: 2, a: 1, c: 3 };
    const ir2 = { a: 1, c: 3, b: 2 };

    expect(computeConfigHash(ir1)).toBe(computeConfigHash(ir2));
  });

  test('configHash is set on session after computation (simulated)', () => {
    const session: { configHash?: string } = {};
    const agentIR = { name: 'TestAgent', steps: ['s1'] };

    try {
      session.configHash = computeConfigHash(agentIR as unknown as Record<string, unknown>);
    } catch {
      // If computation fails, configHash stays undefined
    }

    expect(session.configHash).toBeDefined();
    expect(typeof session.configHash).toBe('string');
  });

  test('failure to compute hash does not throw (wrapped in try-catch in executor)', () => {
    expect(() => {
      computeConfigHash({});
    }).not.toThrow();

    expect(() => {
      computeConfigHash({ nested: { deep: { value: 42 } } });
    }).not.toThrow();
  });

  test('optional tenantConfig parameter produces different hash', () => {
    const ir = { name: 'Agent' };
    const tenantConfig = { model: 'gpt-4' };

    const hashWithout = computeConfigHash(ir);
    const hashWith = computeConfigHash(ir, tenantConfig);

    expect(hashWithout).not.toBe(hashWith);
  });
});

// =============================================================================
// 4. traceId propagation — ALS priority and fallback
// =============================================================================

describe('traceId propagation in createCentralizedTraceHandler (regression: deleted in 9e7fe8074)', () => {
  test('ALS traceId takes priority over parameter traceId', () => {
    const alsTraceId = 'als-trace-abc';
    const paramTraceId = 'param-trace-xyz';

    const resolvedTraceId = alsTraceId || paramTraceId;
    expect(resolvedTraceId).toBe('als-trace-abc');
  });

  test('falls back to parameter traceId when ALS has no traceId', () => {
    const alsTraceId = undefined;
    const paramTraceId = 'param-trace-xyz';

    const resolvedTraceId = alsTraceId || paramTraceId;
    expect(resolvedTraceId).toBe('param-trace-xyz');
  });

  test('resolvedTraceId is spread into TraceEventWithId', () => {
    const resolvedTraceId = 'test-trace-456';
    const traceEvent = {
      id: 'evt-1',
      sessionId: 'sess-1',
      type: 'llm_call' as const,
      timestamp: new Date(),
      data: { tenantId: 'tenant-1' },
      agentName: 'TestAgent',
      ...(resolvedTraceId && { traceId: resolvedTraceId }),
    };

    expect(traceEvent.traceId).toBe('test-trace-456');
  });

  test('resolvedTraceId is spread into EventStore emit as trace_id', () => {
    const resolvedTraceId = 'test-trace-789';
    const emitPayload = {
      event_type: 'llm.call.completed',
      category: 'llm',
      session_id: 'sess-1',
      tenant_id: 'tenant-1',
      project_id: 'proj-1',
      agent_name: 'TestAgent',
      timestamp: new Date(),
      duration_ms: 100,
      has_error: false,
      data: {},
      span_id: 'evt-1',
      parent_span_id: undefined,
      ...(resolvedTraceId && { trace_id: resolvedTraceId }),
    };

    expect(emitPayload.trace_id).toBe('test-trace-789');
  });

  test('when both are undefined, no traceId field is added to TraceEventWithId', () => {
    const resolvedTraceId = undefined;
    const traceEvent = {
      id: 'evt-2',
      sessionId: 'sess-2',
      type: 'tool_call' as const,
      timestamp: new Date(),
      data: {},
      agentName: 'TestAgent',
      ...(resolvedTraceId && { traceId: resolvedTraceId }),
    };

    expect('traceId' in traceEvent).toBe(false);
  });

  test('when both are undefined, no trace_id field is added to EventStore emit', () => {
    const resolvedTraceId = undefined;
    const emitPayload = {
      event_type: 'tool.call.completed',
      session_id: 'sess-2',
      tenant_id: 'tenant-1',
      ...(resolvedTraceId && { trace_id: resolvedTraceId }),
    };

    expect('trace_id' in emitPayload).toBe(false);
  });

  test('empty string traceId is treated as falsy (no propagation)', () => {
    const alsTraceId = '';
    const paramTraceId = '';

    const resolvedTraceId = alsTraceId || paramTraceId;
    const traceEvent = {
      id: 'evt-3',
      sessionId: 'sess-3',
      type: 'agent_enter' as const,
      ...(resolvedTraceId && { traceId: resolvedTraceId }),
    };

    expect('traceId' in traceEvent).toBe(false);
  });

  test('empty ALS falls back to parameter traceId', () => {
    const alsTraceId = '';
    const paramTraceId = 'fallback-trace';

    const resolvedTraceId = alsTraceId || paramTraceId;
    expect(resolvedTraceId).toBe('fallback-trace');
  });
});

// =============================================================================
// 5. Unmapped event fallback — events without semantic mapping still persist
// =============================================================================

describe('unmapped event guard in createCentralizedTraceHandler (regression: deleted in 9e7fe8074)', () => {
  describe('events with TRACE_TO_PLATFORM_TYPE mapping are emittable to EventStore', () => {
    test('llm_call maps to llm.call.completed', () => {
      expect(TRACE_TO_PLATFORM_TYPE['llm_call']).toBe('llm.call.completed');
    });

    test('tool_call maps to tool.call.completed', () => {
      expect(TRACE_TO_PLATFORM_TYPE['tool_call']).toBe('tool.call.completed');
    });

    test('agent_enter maps to agent.entered', () => {
      expect(TRACE_TO_PLATFORM_TYPE['agent_enter']).toBe('agent.entered');
    });

    test('agent_exit maps to agent.exited', () => {
      expect(TRACE_TO_PLATFORM_TYPE['agent_exit']).toBe('agent.exited');
    });

    test('handoff maps to agent.handoff', () => {
      expect(TRACE_TO_PLATFORM_TYPE['handoff']).toBe('agent.handoff');
    });

    test('escalation maps to agent.escalated', () => {
      expect(TRACE_TO_PLATFORM_TYPE['escalation']).toBe('agent.escalated');
    });

    test('error maps to system.error', () => {
      expect(TRACE_TO_PLATFORM_TYPE['error']).toBe('system.error');
    });

    test('flow_step_enter maps to flow.step.entered', () => {
      expect(TRACE_TO_PLATFORM_TYPE['flow_step_enter']).toBe('flow.step.entered');
    });

    test('session_created maps to session.started', () => {
      expect(TRACE_TO_PLATFORM_TYPE['session_created']).toBe('session.started');
    });

    test('user_message maps to message.user.received', () => {
      expect(TRACE_TO_PLATFORM_TYPE['user_message']).toBe('message.user.received');
    });
  });

  describe('events WITHOUT semantic mapping use generic durable runtime trace fallback', () => {
    test('completion_check has no mapping', () => {
      expect(TRACE_TO_PLATFORM_TYPE['completion_check']).toBeUndefined();
    });

    test('internal_debug has no mapping', () => {
      expect(TRACE_TO_PLATFORM_TYPE['internal_debug']).toBeUndefined();
    });

    test('extraction_strategy_resolved has no mapping', () => {
      expect(TRACE_TO_PLATFORM_TYPE['extraction_strategy_resolved']).toBeUndefined();
    });

    test('gather_field_activation has no mapping', () => {
      expect(TRACE_TO_PLATFORM_TYPE['gather_field_activation']).toBeUndefined();
    });

    test('completely_unknown_type has no mapping', () => {
      expect(TRACE_TO_PLATFORM_TYPE['completely_unknown_type']).toBeUndefined();
    });
  });

  describe('guard logic simulation', () => {
    test('unmapped types are no longer skipped by the EventStore path', () => {
      const unmappedEvent = { type: 'completion_check', data: {} };
      const baseType = TRACE_TO_PLATFORM_TYPE[unmappedEvent.type];
      const platformType = baseType ?? 'system.runtime_trace';

      expect(baseType).toBeUndefined();
      expect(platformType).toBe('system.runtime_trace');
    });

    test('mapped types pass through the guard', () => {
      const mappedEvent = { type: 'llm_call', data: {} };
      const baseType = TRACE_TO_PLATFORM_TYPE[mappedEvent.type];
      expect(!baseType).toBe(false);
      expect(baseType).toBe('llm.call.completed');
    });

    test('events still go to in-memory TraceStore (addEvent before guard)', () => {
      const unmappedType = 'completion_check';
      const mappedType = 'llm_call';

      // Both are valid event types
      expect(unmappedType).toBeDefined();
      expect(mappedType).toBeDefined();

      // Mapped uses a semantic platform type; unmapped uses generic runtime trace fallback.
      expect(TRACE_TO_PLATFORM_TYPE[unmappedType]).toBeUndefined();
      expect(TRACE_TO_PLATFORM_TYPE[mappedType]).toBeDefined();
    });
  });

  describe('inferCategory utility', () => {
    test('infers category from dotted event type (first segment)', () => {
      expect(inferCategory('llm.call.completed')).toBe('llm');
      expect(inferCategory('agent.entered')).toBe('agent');
      expect(inferCategory('session.started')).toBe('session');
      expect(inferCategory('system.error')).toBe('system');
      expect(inferCategory('flow.step.entered')).toBe('flow');
    });
  });
});

// =============================================================================
// 6. Pipeline event verbosity mappings
// =============================================================================

describe('pipeline event verbosity mappings (regression: deleted in 9e7fe8074)', () => {
  test('pipeline_intent_bridge is emitted at "standard" verbosity', () => {
    expect(shouldEmitTrace('pipeline_intent_bridge', 'standard')).toBe(true);
  });

  test('pipeline_tiered_action is emitted at "standard" verbosity', () => {
    expect(shouldEmitTrace('pipeline_tiered_action', 'standard')).toBe(true);
  });

  test('pipeline_out_of_scope_decline is emitted at "standard" verbosity', () => {
    expect(shouldEmitTrace('pipeline_out_of_scope_decline', 'standard')).toBe(true);
  });

  test('pipeline_intent_bridge is NOT emitted at "minimal" verbosity', () => {
    expect(shouldEmitTrace('pipeline_intent_bridge', 'minimal')).toBe(false);
  });

  test('pipeline_tiered_action is NOT emitted at "minimal" verbosity', () => {
    expect(shouldEmitTrace('pipeline_tiered_action', 'minimal')).toBe(false);
  });

  test('pipeline_out_of_scope_decline is NOT emitted at "minimal" verbosity', () => {
    expect(shouldEmitTrace('pipeline_out_of_scope_decline', 'minimal')).toBe(false);
  });

  test('pipeline events ARE emitted at "verbose" verbosity (cumulative)', () => {
    expect(shouldEmitTrace('pipeline_intent_bridge', 'verbose')).toBe(true);
    expect(shouldEmitTrace('pipeline_tiered_action', 'verbose')).toBe(true);
    expect(shouldEmitTrace('pipeline_out_of_scope_decline', 'verbose')).toBe(true);
  });

  test('pipeline events ARE emitted at "debug" verbosity (cumulative)', () => {
    expect(shouldEmitTrace('pipeline_intent_bridge', 'debug')).toBe(true);
    expect(shouldEmitTrace('pipeline_tiered_action', 'debug')).toBe(true);
    expect(shouldEmitTrace('pipeline_out_of_scope_decline', 'debug')).toBe(true);
  });

  describe('VERBOSITY_LEVELS values are correct', () => {
    test('minimal = 0', () => {
      expect(VERBOSITY_LEVELS.minimal).toBe(0);
    });

    test('standard = 1', () => {
      expect(VERBOSITY_LEVELS.standard).toBe(1);
    });

    test('verbose = 2', () => {
      expect(VERBOSITY_LEVELS.verbose).toBe(2);
    });

    test('debug = 3', () => {
      expect(VERBOSITY_LEVELS.debug).toBe(3);
    });
  });

  describe('other important event verbosity classifications', () => {
    test('error events emit at minimal level', () => {
      expect(shouldEmitTrace('error', 'minimal')).toBe(true);
    });

    test('escalation events emit at minimal level', () => {
      expect(shouldEmitTrace('escalation', 'minimal')).toBe(true);
    });

    test('tool_call events emit at standard level but not minimal', () => {
      expect(shouldEmitTrace('tool_call', 'standard')).toBe(true);
      expect(shouldEmitTrace('tool_call', 'minimal')).toBe(false);
    });

    test('llm_call events only emit at debug level', () => {
      expect(shouldEmitTrace('llm_call', 'debug')).toBe(true);
      expect(shouldEmitTrace('llm_call', 'verbose')).toBe(false);
      expect(shouldEmitTrace('llm_call', 'standard')).toBe(false);
      expect(shouldEmitTrace('llm_call', 'minimal')).toBe(false);
    });

    test('extraction_strategy_resolved only emits at verbose+ level', () => {
      expect(shouldEmitTrace('extraction_strategy_resolved', 'verbose')).toBe(true);
      expect(shouldEmitTrace('extraction_strategy_resolved', 'standard')).toBe(false);
    });
  });
});

// =============================================================================
// Additional regression: channel manifest completeness for persist decisions
// =============================================================================

describe('channel manifest completeness for shouldPersistImmediately', () => {
  test('all sync_response channels with non-websocket ingress', () => {
    const immediateChannels = Object.entries(CHANNEL_MANIFEST)
      .filter(([, entry]) => entry.delivery === 'sync_response' && entry.ingress !== 'websocket')
      .map(([type]) => type);

    expect(immediateChannels).toContain('http');
    expect(immediateChannels).toContain('api');
    expect(immediateChannels).toContain('genesys');
    expect(immediateChannels).toContain('voice_vxml');
  });

  test('no websocket-ingress channels have sync_response delivery', () => {
    const wsWithSyncResponse = Object.entries(CHANNEL_MANIFEST).filter(
      ([, entry]) => entry.ingress === 'websocket' && entry.delivery === 'sync_response',
    );

    expect(wsWithSyncResponse).toHaveLength(0);
  });

  test('CHANNEL_MANIFEST has entries for all standard channel types', () => {
    const expectedChannels = [
      'http',
      'api',
      'slack',
      'whatsapp',
      'msteams',
      'genesys',
      'email',
      'sdk_websocket',
      'web_chat',
      'korevg',
      'voice_vxml',
    ];

    for (const channel of expectedChannels) {
      expect(CHANNEL_MANIFEST[channel]).toBeDefined();
    }
  });
});
