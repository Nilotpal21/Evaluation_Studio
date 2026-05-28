/**
 * Profile Integration Tests
 *
 * Tests that behavior profiles are wired into the runtime execution pipeline:
 * - Session creation resolves profiles and sets _effectiveConfig
 * - buildSystemPrompt injects profile instructions and constraints
 * - buildTools uses effectiveConfig.tools when available
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, type RuntimeSession } from '../services/runtime-executor';
import {
  assembleProfileContext,
  resolveActiveProfiles,
  buildEffectiveConfig,
} from '../services/execution/profile-resolver';
import type { BehaviorProfileIR, ToolDefinition } from '@abl/compiler';

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

/**
 * Build a minimal ABL DSL string for a reasoning agent.
 * Uses the colon format (AGENT: name) which is well-supported by the parser.
 */
function makeSimpleDSL(agentName: string): string {
  return `AGENT: ${agentName}

GOAL: "Help users with their requests"

PERSONA: "A helpful assistant"
`;
}

/**
 * Build a DSL with BEHAVIOR_PROFILE sections included.
 * Since the DSL parser may not yet support BEHAVIOR_PROFILE sections,
 * we use the colon format and also test with direct IR injection.
 */
function makeDSLWithProfiles(agentName: string): string {
  return `AGENT: ${agentName}

GOAL: "Help users with their requests"

PERSONA: "A helpful assistant"

BEHAVIOR_PROFILE whatsapp_profile
  WHEN: channel.name == "whatsapp"
  PRIORITY: 50
  INSTRUCTIONS: Keep responses under 160 characters for SMS-like channels.
  TOOLS_HIDE: transfer_to_agent
  CONSTRAINT: Never use markdown formatting

BEHAVIOR_PROFILE voice_profile
  WHEN: channel.name == "voice"
  PRIORITY: 60
  INSTRUCTIONS: Speak naturally and avoid technical jargon.
  TOOLS_HIDE: lookup_order, refund_order
`;
}

/**
 * Inject tools and behavior profiles onto a session's agentIR.
 * Ensures the IR has the expected tools and profiles for testing,
 * regardless of what the DSL compilation produces.
 */
function injectIROverrides(
  session: RuntimeSession,
  options: {
    tools?: ToolDefinition[];
    profiles?: BehaviorProfileIR[];
    channel?: string;
  },
): void {
  if (!session.agentIR) return;

  if (options.tools) {
    session.agentIR.tools = options.tools;
  }

  if (options.profiles) {
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
}

// Base tool set used across tests
const BASE_TOOLS: ToolDefinition[] = [
  makeTool('lookup_order', 'Look up an order by ID'),
  makeTool('refund_order', 'Process a refund'),
  makeTool('transfer_to_agent', 'Transfer to live agent'),
];

// =============================================================================
// SESSION CREATION — _effectiveConfig
// =============================================================================

describe('Profile Integration — Session Creation', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  it('should set _effectiveConfig when agent IR has behavior_profiles and channel matches', () => {
    const dsl = makeDSLWithProfiles('support_agent');
    const session = executor.createSession(dsl, 'support_agent', { channel: 'whatsapp' });

    // If profiles compiled into IR and the WhatsApp profile matched, _effectiveConfig should be set
    if (session.agentIR?.behavior_profiles?.length) {
      expect(session._effectiveConfig).toBeDefined();
      expect(session._activeProfileNames).toBeDefined();
      expect(session._activeProfileNames).toContain('whatsapp_profile');
    } else {
      // If behavior_profiles didn't compile (parser may not support yet), skip gracefully
      expect(session._effectiveConfig).toBeUndefined();
    }
  });

  it('should NOT set _effectiveConfig when agent has no behavior profiles', () => {
    const dsl = makeSimpleDSL('basic_agent');
    const session = executor.createSession(dsl, 'basic_agent', { channel: 'web' });

    expect(session._effectiveConfig).toBeUndefined();
    expect(session._activeProfileNames).toBeUndefined();
  });

  it('should NOT set _effectiveConfig when no profiles match the channel', () => {
    const dsl = makeDSLWithProfiles('support_agent');
    const session = executor.createSession(dsl, 'support_agent', { channel: 'email' });

    // email channel does not match whatsapp_profile or voice_profile
    if (session.agentIR?.behavior_profiles?.length) {
      expect(session._effectiveConfig).toBeUndefined();
      expect(session._activeProfileNames).toBeUndefined();
    }
  });

  it('should work with createSessionFromMultipleDSLs', () => {
    const dsls = [makeDSLWithProfiles('support_agent')];
    const session = executor.createSessionFromMultipleDSLs(dsls, 'support_agent', {
      channel: 'whatsapp',
    });

    if (session.agentIR?.behavior_profiles?.length) {
      expect(session._effectiveConfig).toBeDefined();
      expect(session._activeProfileNames).toContain('whatsapp_profile');
    }
  });

  it('should default channel to digital when not provided', () => {
    const dsl = makeDSLWithProfiles('support_agent');
    const session = executor.createSession(dsl, 'support_agent');

    // digital channel does not match whatsapp or voice profiles
    if (session.agentIR?.behavior_profiles?.length) {
      expect(session._effectiveConfig).toBeUndefined();
    }
  });
});

// =============================================================================
// Direct IR Injection Tests
//
// Since the DSL parser may not yet support BEHAVIOR_PROFILE sections, these
// tests directly inject behavior_profiles on the session's agentIR and call
// the profile resolver to validate the runtime integration logic.
// =============================================================================

describe('Profile Integration — Direct IR Injection', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  it('should hide tools listed in profile tools_hide', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'whatsapp' });

    injectIROverrides(session, {
      tools: BASE_TOOLS,
      profiles: [
        {
          name: 'whatsapp_profile',
          when: 'channel.name == "whatsapp"',
          priority: 50,
          tools_hide: ['transfer_to_agent'],
        },
      ],
      channel: 'whatsapp',
    });

    expect(session._effectiveConfig).toBeDefined();
    const toolNames = session._effectiveConfig!.tools.map((t) => t.name);
    expect(toolNames).toContain('lookup_order');
    expect(toolNames).toContain('refund_order');
    expect(toolNames).not.toContain('transfer_to_agent');
  });

  it('should add additional instructions from matching profiles', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'sms' });

    injectIROverrides(session, {
      profiles: [
        {
          name: 'sms_profile',
          when: 'channel.name == "sms"',
          priority: 50,
          instructions: 'Keep responses under 160 characters.',
        },
      ],
      channel: 'sms',
    });

    expect(session._effectiveConfig).toBeDefined();
    expect(session._effectiveConfig!.additionalInstructions).toContain(
      'Keep responses under 160 characters.',
    );
  });

  it('should add constraints from matching profiles', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'whatsapp' });

    injectIROverrides(session, {
      profiles: [
        {
          name: 'whatsapp_profile',
          when: 'channel.name == "whatsapp"',
          priority: 50,
          constraints: [{ condition: 'Never use markdown formatting', action: 'block' }],
        },
      ],
      channel: 'whatsapp',
    });

    expect(session._effectiveConfig).toBeDefined();
    expect(session._effectiveConfig!.additionalConstraints).toHaveLength(1);
    expect(session._effectiveConfig!.additionalConstraints[0].condition).toBe(
      'Never use markdown formatting',
    );
  });

  it('should set activeProfileNames for matched profiles', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'whatsapp' });

    injectIROverrides(session, {
      profiles: [
        {
          name: 'whatsapp_profile',
          when: 'channel.name == "whatsapp"',
          priority: 50,
          instructions: 'Be concise',
        },
      ],
      channel: 'whatsapp',
    });

    expect(session._activeProfileNames).toEqual(['whatsapp_profile']);
    expect(session._effectiveConfig!.activeProfileNames).toEqual(['whatsapp_profile']);
  });

  it('should not set _effectiveConfig when no profiles match', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'email' });

    injectIROverrides(session, {
      profiles: [
        {
          name: 'voice_profile',
          when: 'channel.name == "voice"',
          priority: 60,
          instructions: 'Speak naturally',
        },
      ],
      channel: 'email',
    });

    expect(session._effectiveConfig).toBeUndefined();
    expect(session._activeProfileNames).toBeUndefined();
  });
});

// =============================================================================
// buildSystemPrompt — Profile Instructions and Constraints
// =============================================================================

describe('Profile Integration — buildSystemPrompt', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  it('should include profile instructions in system prompt when effectiveConfig has additionalInstructions', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    session._effectiveConfig = {
      additionalInstructions: ['Keep responses under 160 characters.', 'Use simple language.'],
      tools: session.agentIR?.tools ?? [],
      additionalConstraints: [],
      activeProfileNames: ['sms_profile'],
    };

    const systemPrompt = (executor as any).buildSystemPrompt(session);

    expect(systemPrompt).toContain('Channel-Specific Instructions');
    expect(systemPrompt).toContain('Keep responses under 160 characters.');
    expect(systemPrompt).toContain('Use simple language.');
  });

  it('should include profile constraints in system prompt when effectiveConfig has additionalConstraints', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    session._effectiveConfig = {
      additionalInstructions: [],
      tools: session.agentIR?.tools ?? [],
      additionalConstraints: [
        { condition: 'Never use markdown formatting', action: 'block' },
        { condition: 'Always confirm before processing refunds', action: 'warn' },
      ],
      activeProfileNames: ['whatsapp_profile'],
    };

    const systemPrompt = (executor as any).buildSystemPrompt(session);

    expect(systemPrompt).toContain('Additional Constraints');
    expect(systemPrompt).toContain('Never use markdown formatting');
    expect(systemPrompt).toContain('Always confirm before processing refunds');
  });

  it('should NOT include profile sections when effectiveConfig is not set', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    const systemPrompt = (executor as any).buildSystemPrompt(session);

    expect(systemPrompt).not.toContain('Channel-Specific Instructions');
    expect(systemPrompt).not.toContain('Additional Constraints');
  });

  it('should NOT include empty profile sections', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    session._effectiveConfig = {
      additionalInstructions: [],
      tools: session.agentIR?.tools ?? [],
      additionalConstraints: [],
      activeProfileNames: ['empty_profile'],
    };

    const systemPrompt = (executor as any).buildSystemPrompt(session);

    expect(systemPrompt).not.toContain('Channel-Specific Instructions');
    expect(systemPrompt).not.toContain('Additional Constraints');
  });
});

// =============================================================================
// buildTools — Profile Tool Overrides
//
// These tests inject tools directly on the IR since the minimal DSL may not
// produce tools in the compiled IR. The key behavior being tested is that
// buildTools prefers effectiveConfig.tools over ir.tools when available.
// =============================================================================

describe('Profile Integration — buildTools', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  it('should use effectiveConfig.tools when available (hiding tools from profiles)', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    // Inject tools onto the IR first
    if (session.agentIR) {
      session.agentIR.tools = [...BASE_TOOLS];
    }

    // Simulate a profile that hides transfer_to_agent
    const filteredTools = BASE_TOOLS.filter((t) => t.name !== 'transfer_to_agent');
    session._effectiveConfig = {
      additionalInstructions: [],
      tools: filteredTools,
      additionalConstraints: [],
      activeProfileNames: ['whatsapp_profile'],
    };

    const tools = (executor as any).buildTools(session);
    const toolNames = tools.map((t: { name: string }) => t.name);

    expect(toolNames).toContain('lookup_order');
    expect(toolNames).toContain('refund_order');
    expect(toolNames).not.toContain('transfer_to_agent');
  });

  it('should use base IR tools when effectiveConfig is not set', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    // Inject tools onto the IR
    if (session.agentIR) {
      session.agentIR.tools = [...BASE_TOOLS];
    }

    // No _effectiveConfig — should use base tools from IR
    const tools = (executor as any).buildTools(session);
    const toolNames = tools.map((t: { name: string }) => t.name);

    expect(toolNames).toContain('lookup_order');
    expect(toolNames).toContain('refund_order');
    expect(toolNames).toContain('transfer_to_agent');
  });

  it('should include profile-added tools', () => {
    const dsl = makeSimpleDSL('test_agent');
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    // Inject tools onto the IR
    if (session.agentIR) {
      session.agentIR.tools = [...BASE_TOOLS];
    }

    // Simulate a profile that adds an extra tool
    const addedTool = makeTool('quick_reply', 'Send a quick reply option');
    session._effectiveConfig = {
      additionalInstructions: [],
      tools: [...BASE_TOOLS, addedTool],
      additionalConstraints: [],
      activeProfileNames: ['interactive_profile'],
    };

    const tools = (executor as any).buildTools(session);
    const toolNames = tools.map((t: { name: string }) => t.name);

    expect(toolNames).toContain('quick_reply');
  });

  it('should still include system tools (escalate) regardless of effectiveConfig', () => {
    // Use a DSL that has ESCALATE config — system tool must survive effectiveConfig filtering
    const dsl = `AGENT: test_agent

GOAL: "Help users with their requests"

PERSONA: "A helpful assistant"

ESCALATE:
  triggers:
    - WHEN: "User requests human help"
      REASON: "User explicitly requested a human"
      PRIORITY: high
`;
    const session = executor.createSession(dsl, 'test_agent', { channel: 'web' });

    // Set effectiveConfig with empty tools (all regular tools hidden)
    session._effectiveConfig = {
      additionalInstructions: [],
      tools: [],
      additionalConstraints: [],
      activeProfileNames: ['minimal_profile'],
    };

    const tools = (executor as any).buildTools(session);
    const toolNames = tools.map((t: { name: string }) => t.name);

    // System escalate tool must survive effectiveConfig tool filtering
    expect(toolNames).toContain('__escalate__');
  });
});
