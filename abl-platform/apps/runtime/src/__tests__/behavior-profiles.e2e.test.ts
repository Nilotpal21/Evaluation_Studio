/**
 * Behavior Profiles Per-Turn E2E Tests
 *
 * Tests per-turn profile re-evaluation through the full RuntimeExecutor stack.
 * Uses mock LLM client to isolate profile behavior from LLM variability.
 * Profiles are injected onto agentIR after session creation.
 *
 * Verifies:
 * - Profile with WHEN: session.turn_count > 1 activates on turn 2
 * - behavior_profile_applied trace event emitted with profile names
 * - Tools change per-turn when profiles activate/deactivate
 * - Agent without profiles runs normally (no overhead)
 * - turnCount increments correctly across turns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { injectMockClient } from './execution/pre-refactor/helpers/mock-llm-client.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { BehaviorProfileIR, ToolDefinition, VoiceConfigIR } from '@abl/compiler';

// =============================================================================
// DSL FIXTURES
// =============================================================================

const BASIC_AGENT = `
AGENT: Profile_Agent

GOAL: "Test per-turn profile re-evaluation"
PERSONA: "Helpful assistant"
`;

const PLAIN_AGENT = `
AGENT: Plain_Agent

GOAL: "Agent without profiles"
PERSONA: "Helpful assistant"
`;

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
  overrides: Partial<BehaviorProfileIR> & { name: string; when: string },
): BehaviorProfileIR {
  return {
    priority: 10,
    ...overrides,
  } as BehaviorProfileIR;
}

function makeMockResponse(text: string) {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn' as const,
    rawContent: [{ type: 'text' as const, text }],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Behavior Profiles Per-Turn E2E', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('per-turn activation', () => {
    it('profile with WHEN: session.turn_count > 1 activates on turn 2', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Hello!'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      // Inject tools and a turn-gated profile
      session.agentIR!.tools = [makeTool('base_tool'), makeTool('advanced_tool')];
      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'advanced_mode',
          when: 'session.turn_count > 1',
          tools_hide: ['advanced_tool'],
          instructions: 'Use simplified responses after turn 1.',
        }),
      ];

      const tc1 = createTraceCollector();
      await executor.executeMessage(session.id, 'Turn 1', undefined, tc1.callback);

      // Turn 1: session.turn_count = 1, condition "turn_count > 1" is false
      // No profile should be applied
      const profileTraces1 = filterTraces(tc1.traces, 'behavior_profile_applied');
      expect(profileTraces1).toHaveLength(0);
      expect(session._activeProfileNames ?? []).toHaveLength(0);

      const tc2 = createTraceCollector();
      await executor.executeMessage(session.id, 'Turn 2', undefined, tc2.callback);

      // Turn 2: session.turn_count = 2, condition "turn_count > 1" is true
      // Profile should now activate
      const profileTraces2 = filterTraces(tc2.traces, 'behavior_profile_applied');
      expect(profileTraces2.length).toBeGreaterThanOrEqual(1);
      expect(profileTraces2[0].data.activeProfiles).toContain('advanced_mode');
      expect(session._activeProfileNames).toContain('advanced_mode');
    });

    it('turnCount increments correctly across multiple turns', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      // No profiles needed — just verify turnCount
      expect(session.turnCount).toBeUndefined();

      await executor.executeMessage(session.id, 'Turn 1');
      expect(session.turnCount).toBe(1);

      await executor.executeMessage(session.id, 'Turn 2');
      expect(session.turnCount).toBe(2);

      await executor.executeMessage(session.id, 'Turn 3');
      expect(session.turnCount).toBe(3);
    });
  });

  describe('trace events', () => {
    it('behavior_profile_applied trace includes profile names and override counts', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Hello!'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      // Inject profile that activates immediately (turn_count > 0 is true on turn 1)
      session.agentIR!.tools = [makeTool('search'), makeTool('sms')];
      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'immediate_profile',
          when: 'session.turn_count > 0',
          tools_hide: ['sms'],
          voice: { provider: 'elevenlabs', voice_id: 'aria' },
          conversation_behavior: {
            speaking: {
              max_sentences: 1,
            },
          },
        }),
      ];

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      const profileTraces = filterTraces(tc.traces, 'behavior_profile_applied');
      expect(profileTraces.length).toBeGreaterThanOrEqual(1);

      const trace = profileTraces[0];
      expect(trace.data.activeProfiles).toContain('immediate_profile');
      expect(trace.data.previousProfiles).toEqual([]);
      expect(trace.data.turnCount).toBe(1);
      expect(trace.data.hasVoiceOverride).toBe(true);
      expect(trace.data.hasConversationBehavior).toBe(true);
      expect(trace.data.conversationBehaviorSourceChain).toEqual(['profile:immediate_profile']);
      expect(trace.data.conversationBehaviorCapabilityDrops).toBe(0);
      expect(trace.data.conversationBehaviorCapabilityDropDetails).toEqual([]);
      expect(trace.data.toolsHidden).toBeGreaterThanOrEqual(1);
    });
  });

  describe('no profiles (IR-gated)', () => {
    it('agent without profiles runs normally with no profile trace events', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Plain response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([PLAIN_AGENT], 'Plain_Agent'),
      );

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      expect(result.response).toContain('Plain response');

      // No behavior_profile_applied trace events
      const profileTraces = filterTraces(tc.traces, 'behavior_profile_applied');
      expect(profileTraces).toHaveLength(0);
    });
  });

  describe('profile with voice override', () => {
    it('voice override in profile sets _effectiveConfig.voiceConfig', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Voice response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      const voiceOverride: VoiceConfigIR = {
        provider: 'elevenlabs',
        voice_id: 'aria',
        speed: 1.1,
      };

      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'voice_profile',
          when: 'session.turn_count > 0',
          voice: voiceOverride,
        }),
      ];

      await executor.executeMessage(session.id, 'Hello');

      // Profile should have set voice config on _effectiveConfig
      expect(session._effectiveConfig).toBeDefined();
      expect(session._effectiveConfig!.voiceConfig).toBeDefined();
      expect(session._effectiveConfig!.voiceConfig!.provider).toBe('elevenlabs');
      expect(session._effectiveConfig!.voiceConfig!.voice_id).toBe('aria');
      expect(session._effectiveConfig!.voiceConfig!.speed).toBe(1.1);
    });
  });

  describe('frustration empathy activation', () => {
    it('activates frustration_empathy only when sentiment crosses the empathy threshold', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('I can help with that.'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'frustration_empathy',
          when: 'interaction.sentiment_score < -0.3',
          instructions:
            'Lead with one brief empathy acknowledgment, then move to the concrete next step.',
        }),
      ];

      const scriptedTurns = [
        { message: 'Can you check my order?', sentiment_score: 0.1, expectedProfiles: null },
        {
          message: 'This is really frustrating, it was supposed to arrive yesterday.',
          sentiment_score: -0.45,
          expectedProfiles: ['frustration_empathy'],
        },
        {
          message: 'I am still upset that nobody warned me.',
          sentiment_score: -0.7,
          expectedProfiles: null,
        },
        {
          message: 'Okay, that replacement date works.',
          sentiment_score: -0.1,
          expectedProfiles: [],
        },
        {
          message: 'Actually no, this is unacceptable again.',
          sentiment_score: -0.62,
          expectedProfiles: ['frustration_empathy'],
        },
      ];

      for (const turn of scriptedTurns) {
        const traceCollector = createTraceCollector();
        await executor.executeMessage(
          session.id,
          turn.message,
          undefined,
          traceCollector.callback,
          {
            interactionContext: {
              sentiment_score: turn.sentiment_score,
            },
          },
        );

        const profileTraces = filterTraces(traceCollector.traces, 'behavior_profile_applied');
        if (turn.expectedProfiles === null) {
          expect(profileTraces, turn.message).toHaveLength(0);
        } else {
          expect(profileTraces, turn.message).toHaveLength(1);
          expect(profileTraces[0].data.activeProfiles).toEqual(turn.expectedProfiles);
        }
      }
    });
  });

  describe('profile TOOLS_HIDE verified in LLM call (E2E-7)', () => {
    it('tools_hide removes tool from LLM call tool list', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      // Set base tools on agent
      session.agentIR!.tools = [makeTool('search'), makeTool('send_sms'), makeTool('lookup')];

      // Profile that hides send_sms and adds show_carousel
      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'sdk_profile',
          when: 'session.turn_count > 0',
          tools_hide: ['send_sms'],
          tools_add: [makeTool('show_carousel')],
        }),
      ];

      await executor.executeMessage(session.id, 'Hello');

      // Mock LLM client records all calls — inspect the tools sent
      expect(mockClient.calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = mockClient.calls[mockClient.calls.length - 1];
      const toolNames = (lastCall.tools as Array<{ name: string }>).map((t) => t.name);

      // send_sms should be hidden
      expect(toolNames).not.toContain('send_sms');
      // search should still be present
      expect(toolNames).toContain('search');
      // show_carousel should be added
      expect(toolNames).toContain('show_carousel');
    });

    it('tools are not hidden when profile condition is false', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      session.agentIR!.tools = [makeTool('search'), makeTool('send_sms')];

      // Profile with condition that won't be true on turn 1 (turn_count > 5)
      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'late_profile',
          when: 'session.turn_count > 5',
          tools_hide: ['send_sms'],
        }),
      ];

      await executor.executeMessage(session.id, 'Hello');

      expect(mockClient.calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = mockClient.calls[mockClient.calls.length - 1];
      const toolNames = (lastCall.tools as Array<{ name: string }>).map((t) => t.name);

      // Profile not active — send_sms should still be present
      expect(toolNames).toContain('send_sms');
      expect(toolNames).toContain('search');
    });
  });

  describe('system tool protection (E2E-8)', () => {
    it('system tools cannot be hidden by profiles', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => makeMockResponse('Response'));

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Profile_Agent'),
      );

      session.agentIR!.tools = [makeTool('search')];

      // Add escalation config so buildTools() includes __escalate__ system tool
      session.agentIR!.coordination = {
        delegates: [],
        handoffs: [],
        escalation: {
          triggers: [{ when: 'true', reason: 'test', priority: 'low' }],
          context_for_human: [],
          on_human_complete: [],
        },
      };

      // Attempt to hide system tool __escalate__
      session.agentIR!.behavior_profiles = [
        makeProfile({
          name: 'hide_system',
          when: 'session.turn_count > 0',
          tools_hide: ['__escalate__', 'search'],
        }),
      ];

      await executor.executeMessage(session.id, 'Hello');

      expect(mockClient.calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = mockClient.calls[mockClient.calls.length - 1];
      const toolNames = (lastCall.tools as Array<{ name: string }>).map((t) => t.name);

      // __escalate__ is a system tool — it should still be in the tool list
      // (buildTools adds system tools independently of IR tools)
      expect(toolNames).toContain('__escalate__');
      // search should be hidden (it's a user tool)
      expect(toolNames).not.toContain('search');
    });
  });
});
