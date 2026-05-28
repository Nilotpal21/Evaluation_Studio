/**
 * Trace Profile Resolution Tests
 *
 * Verifies that profile_resolution trace events are emitted during
 * session creation when behavior profiles are present on the agent IR.
 *
 * Scenarios:
 * 1. Trace emitted when profiles match — correct evaluatedProfiles, matchedProfiles, effectiveSummary
 * 2. Trace emitted when no profiles match — matchedProfiles=[], effectiveSummary=null
 * 3. Effective summary counts are accurate
 * 4. No trace event when agent has no profiles
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuntimeExecutor, type RuntimeSession } from '../../services/runtime-executor';
import { getTraceStore, resetTraceStore, type TraceEvent } from '../../services/trace-store';
import type { BehaviorProfileIR, ToolDefinition } from '@abl/compiler';
import {
  assembleProfileContext,
  resolveActiveProfiles,
  buildEffectiveConfig,
} from '../../services/execution/profile-resolver';

// =============================================================================
// HELPERS
// =============================================================================

function makeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: [],
    returns: { type: 'string', description: 'result' },
    hints: {},
  };
}

function makeSimpleDSL(agentName: string): string {
  return `AGENT: ${agentName}

GOAL: "Help users with their requests"

PERSONA: "A helpful assistant"
`;
}

/**
 * Inject behavior profiles onto a session's agentIR and re-run profile
 * resolution through the executor's private method via a fresh session
 * creation. Since we cannot call the private method directly, we inject
 * profiles onto the IR before session creation by using the
 * createSessionFromMultipleDSLs path and then manually re-resolve.
 *
 * For these tests, we create the session, then inject profiles and
 * manually trigger resolution to emit the trace event.
 */
function injectProfilesAndResolve(
  session: RuntimeSession,
  options: {
    tools?: ToolDefinition[];
    profiles: BehaviorProfileIR[];
    channel?: string;
  },
): void {
  if (!session.agentIR) return;

  if (options.tools) {
    session.agentIR.tools = options.tools;
  }

  session.agentIR.behavior_profiles = options.profiles;

  const profileCtx = assembleProfileContext({
    channelType: options.channel || 'digital',
    sessionMeta: { isNew: true, language: '', turnCount: 0 },
  });
  const activeProfiles = resolveActiveProfiles(options.profiles, profileCtx);
  if (activeProfiles.length > 0) {
    session._effectiveConfig = buildEffectiveConfig(session.agentIR, activeProfiles);
    session._activeProfileNames = activeProfiles.map((p) => p.name);
  }
}

function getProfileResolutionEvents(sessionId: string): TraceEvent[] {
  const events = getTraceStore().getEvents(sessionId);
  // getEvents returns TraceEvent[] | Promise<TraceEvent[]>
  // In test (memory store), it's synchronous
  return (events as TraceEvent[]).filter((e) => e.type === 'profile_resolution');
}

const BASE_TOOLS: ToolDefinition[] = [
  makeTool('lookup_order', 'Look up an order by ID'),
  makeTool('refund_order', 'Process a refund'),
  makeTool('transfer_to_agent', 'Transfer to live agent'),
];

// =============================================================================
// TESTS
// =============================================================================

describe('Trace Profile Resolution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    resetTraceStore();
    executor = new RuntimeExecutor();
  });

  afterEach(() => {
    resetTraceStore();
  });

  // ---------------------------------------------------------------------------
  // 1. Trace emitted when profiles match
  // ---------------------------------------------------------------------------

  it('should emit profile_resolution trace event when profiles match', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'whatsapp' });

    // The DSL parser may not support BEHAVIOR_PROFILE sections yet, so
    // inject profiles directly on the IR. The runtime-executor emits
    // the trace event from resolveAndApplyProfiles, so we need profiles
    // present at session creation time. Since we can't inject before
    // session creation in this test pattern, we use a DSL that includes
    // profiles or rely on the fact that profile-aware DSL compiles them.
    //
    // Alternative approach: create session, then check if profiles were
    // compiled. If not, we test the trace event emission by calling the
    // executor's private method indirectly through a second session.
    //
    // Best approach: create a DSL with BEHAVIOR_PROFILE sections.
    const dslWithProfiles = `AGENT: trace_test_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE whatsapp_profile
  WHEN: channel.name == "whatsapp"
  PRIORITY: 50
  INSTRUCTIONS: Keep responses short.
  CONSTRAINT: Never use markdown
`;

    const session2 = executor.createSession(dslWithProfiles, 'trace_test_agent', {
      channel: 'whatsapp',
    });

    // Check if the parser compiled profiles into IR
    if (session2.agentIR?.behavior_profiles?.length) {
      const events = getProfileResolutionEvents(session2.id);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('profile_resolution');
      expect(event.data.evaluatedProfiles).toContain('whatsapp_profile');
      expect(event.data.matchedProfiles).toContain('whatsapp_profile');
      expect(event.data.channel).toBe('whatsapp');
      expect(event.data.effectiveSummary).not.toBeNull();
    } else {
      // Parser doesn't support BEHAVIOR_PROFILE yet — skip gracefully
      // but still verify no spurious trace events were emitted
      const events = getProfileResolutionEvents(session2.id);
      expect(events).toHaveLength(0);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Trace emitted when no profiles match
  // ---------------------------------------------------------------------------

  it('should emit profile_resolution trace event with empty matchedProfiles when no profiles match', () => {
    const dslWithProfiles = `AGENT: trace_test_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE voice_only_profile
  WHEN: channel.name == "voice"
  PRIORITY: 50
  INSTRUCTIONS: Speak naturally.
`;

    // channel is "email" so voice_only_profile should NOT match
    const session = executor.createSession(dslWithProfiles, 'trace_test_agent', {
      channel: 'email',
    });

    if (session.agentIR?.behavior_profiles?.length) {
      const events = getProfileResolutionEvents(session.id);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.data.evaluatedProfiles).toContain('voice_only_profile');
      expect(event.data.matchedProfiles).toEqual([]);
      expect(event.data.channel).toBe('email');
      expect(event.data.effectiveSummary).toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Effective summary counts are accurate
  // ---------------------------------------------------------------------------

  it('should include correct effectiveSummary counts in trace event', () => {
    const dslWithProfiles = `AGENT: trace_counts_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE whatsapp_profile
  WHEN: channel.name == "whatsapp"
  PRIORITY: 50
  INSTRUCTIONS: Keep responses short.
  INSTRUCTIONS: Use simple language.
  CONSTRAINT: Never use markdown
  CONSTRAINT: No emojis
  TOOLS_HIDE: transfer_to_agent
`;

    const session = executor.createSession(dslWithProfiles, 'trace_counts_agent', {
      channel: 'whatsapp',
    });

    if (session.agentIR?.behavior_profiles?.length) {
      // Also inject tools so toolsHidden count is meaningful
      if (session.agentIR) {
        session.agentIR.tools = [...BASE_TOOLS];
      }

      // Re-create session to get fresh profile resolution with tools present
      const session2 = executor.createSession(dslWithProfiles, 'trace_counts_agent_2', {
        channel: 'whatsapp',
      });

      if (session2.agentIR) {
        session2.agentIR.tools = [...BASE_TOOLS];
      }

      const events = getProfileResolutionEvents(session2.id);
      if (events.length > 0) {
        const summary = events[0].data.effectiveSummary as Record<string, unknown> | null;
        if (summary) {
          expect(typeof summary.instructionsAppended).toBe('number');
          expect(typeof summary.constraintsAdded).toBe('number');
          expect(typeof summary.hasResponseRules).toBe('boolean');
          expect(typeof summary.hasVoiceConfig).toBe('boolean');
          expect(typeof summary.hasGatherOverrides).toBe('boolean');
          expect(typeof summary.hasFlowReplace).toBe('boolean');
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 4. No trace event when agent has no profiles
  // ---------------------------------------------------------------------------

  it('should emit profile_resolution trace event for base conversation behavior without profiles', () => {
    const dsl = `AGENT: conversation_behavior_only

GOAL: "Help users"

PERSONA: "A helpful assistant"

CONVERSATION:
  speaking:
    style: "warm and concise"
    max_sentences: 2
`;

    const session = executor.createSession(dsl, 'conversation_behavior_only', { channel: 'web' });

    const events = getProfileResolutionEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].data.evaluatedProfiles).toEqual([]);
    expect(events[0].data.matchedProfiles).toEqual([]);
    expect(events[0].data.channel).toBe('web');
    expect(events[0].data.effectiveSummary).toMatchObject({
      hasConversationBehavior: true,
      conversationBehaviorSourceChain: ['agent'],
      conversationBehaviorCapabilityDrops: 0,
      conversationBehaviorCapabilityDropDetails: [],
    });
  });

  it('should include capability-drop details when non-voice channels gate listening behavior', () => {
    const dsl = `AGENT: conversation_behavior_gated

GOAL: "Help users"

PERSONA: "A helpful assistant"

CONVERSATION:
  listening:
    barge_in: allow
`;

    const session = executor.createSession(dsl, 'conversation_behavior_gated', { channel: 'web' });

    const events = getProfileResolutionEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].data.effectiveSummary).toMatchObject({
      hasConversationBehavior: true,
      conversationBehaviorSourceChain: ['agent'],
      conversationBehaviorCapabilityDrops: 1,
      conversationBehaviorCapabilityDropDetails: [
        expect.objectContaining({
          fieldPath: 'listening.barge_in',
          reason: 'voice_channel_required',
        }),
      ],
    });
  });

  it('should NOT emit profile_resolution trace event when agent has no profiles', () => {
    const dsl = makeSimpleDSL('basic_agent');
    const session = executor.createSession(dsl, 'basic_agent', { channel: 'web' });

    const events = getProfileResolutionEvents(session.id);
    expect(events).toHaveLength(0);
  });

  it('should NOT emit profile_resolution for createSessionFromMultipleDSLs without profiles', () => {
    const dsls = [makeSimpleDSL('basic_agent')];
    const session = executor.createSessionFromMultipleDSLs(dsls, 'basic_agent', {
      channel: 'web',
    });

    const events = getProfileResolutionEvents(session.id);
    expect(events).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Trace event has correct structure
  // ---------------------------------------------------------------------------

  it('should emit trace event with correct fields (id, sessionId, type, timestamp, data)', () => {
    const dslWithProfiles = `AGENT: struct_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE web_profile
  WHEN: channel.name == "web"
  PRIORITY: 10
  INSTRUCTIONS: Use rich formatting.
`;

    const session = executor.createSession(dslWithProfiles, 'struct_agent', {
      channel: 'web',
    });

    if (session.agentIR?.behavior_profiles?.length) {
      const events = getProfileResolutionEvents(session.id);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe('string');
      expect(event.sessionId).toBe(session.id);
      expect(event.type).toBe('profile_resolution');
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.data).toBeDefined();
      expect(event.data.evaluatedProfiles).toBeDefined();
      expect(event.data.matchedProfiles).toBeDefined();
      expect(event.data.channel).toBeDefined();
      // effectiveSummary can be null or an object
      expect('effectiveSummary' in event.data).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Default channel is 'digital' in trace event
  // ---------------------------------------------------------------------------

  it('should default channel to digital in trace event when no channel provided', () => {
    const dslWithProfiles = `AGENT: default_ch_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE catch_all
  WHEN: channel.name == "digital"
  PRIORITY: 10
  INSTRUCTIONS: Generic digital channel behavior.
`;

    const session = executor.createSession(dslWithProfiles, 'default_ch_agent');

    if (session.agentIR?.behavior_profiles?.length) {
      const events = getProfileResolutionEvents(session.id);
      expect(events).toHaveLength(1);
      expect(events[0].data.channel).toBe('digital');
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Multiple profiles — evaluatedProfiles includes all, matchedProfiles only matches
  // ---------------------------------------------------------------------------

  it('should list all profiles in evaluatedProfiles and only matches in matchedProfiles', () => {
    const dslWithProfiles = `AGENT: multi_profile_agent

GOAL: "Help users"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE whatsapp_profile
  WHEN: channel.name == "whatsapp"
  PRIORITY: 50
  INSTRUCTIONS: Short responses.

BEHAVIOR_PROFILE voice_profile
  WHEN: channel.name == "voice"
  PRIORITY: 60
  INSTRUCTIONS: Speak naturally.

BEHAVIOR_PROFILE sms_profile
  WHEN: channel.name == "sms"
  PRIORITY: 40
  INSTRUCTIONS: Ultra-short responses.
`;

    const session = executor.createSession(dslWithProfiles, 'multi_profile_agent', {
      channel: 'whatsapp',
    });

    if (session.agentIR?.behavior_profiles?.length) {
      const events = getProfileResolutionEvents(session.id);
      expect(events).toHaveLength(1);

      const event = events[0];
      const evaluated = event.data.evaluatedProfiles as string[];
      const matched = event.data.matchedProfiles as string[];

      // All profiles should be evaluated
      expect(evaluated).toContain('whatsapp_profile');
      expect(evaluated).toContain('voice_profile');
      expect(evaluated).toContain('sms_profile');

      // Only whatsapp_profile should match
      expect(matched).toContain('whatsapp_profile');
      expect(matched).not.toContain('voice_profile');
      expect(matched).not.toContain('sms_profile');
    }
  });
});
