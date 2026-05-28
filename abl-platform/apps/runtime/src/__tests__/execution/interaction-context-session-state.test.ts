import { describe, expect, it, vi } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { RuntimeSession } from '../../services/execution/types.js';

const REASONING_AGENT_DSL = `AGENT: Locale_Profile

GOAL: "Help the user"

PERSONA: "A helpful assistant"
`;

const FLOW_AGENT_DSL = `AGENT: Locale_Flow

GOAL: "Collect a city"

FLOW:
  ask_city:
    REASONING: false
    GATHER:
      - city: required
    THEN: COMPLETE
`;

const TOOL_FLOW_AGENT_DSL = `AGENT: Locale_Tool_Flow

GOAL: "Inspect session interaction context"

TOOLS:
  inspect_session() -> { ok: boolean }
    description: "Inspect session metadata"

FLOW:
  run_tool:
    REASONING: false
    CALL: inspect_session()
    THEN: COMPLETE
`;

function makeCallerContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    tenantId: 'tenant-1',
    channel: 'web',
    identityTier: 0,
    verificationMethod: 'none',
    ...overrides,
  };
}

function readInteractionState(session: RuntimeSession): {
  current: {
    language: string | null;
    locale: string | null;
    timezone: string | null;
    source: string;
    confidence: string;
  };
  preference?: {
    language?: string;
    locale?: string;
    timezone?: string;
    source: string;
    confidence: string;
  };
} {
  const sessionNamespace = session.data.values.session as Record<string, unknown>;
  return (sessionNamespace.interactionContext ?? sessionNamespace.interaction) as {
    current: {
      language: string | null;
      locale: string | null;
      timezone: string | null;
      source: string;
      confidence: string;
    };
    preference?: {
      language?: string;
      locale?: string;
      timezone?: string;
      source: string;
      confidence: string;
    };
  };
}

function createMockReasoningClient(): NonNullable<RuntimeSession['llmClient']> {
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      resolvedModel: {
        modelId: 'test-model',
        provider: 'test',
        source: 'test',
      },
    }),
    chatWithToolUseStreamable: vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      resolvedModel: {
        modelId: 'test-model',
        provider: 'test',
        source: 'test',
      },
    }),
  } as unknown as NonNullable<RuntimeSession['llmClient']>;
}

describe('interaction-context session state', () => {
  it('persists canonical interaction state, syncs aliases, and resolves bootstrap profiles from it', () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([REASONING_AGENT_DSL], 'Locale_Profile');
    resolved.agents[resolved.entryAgent].behavior_profiles = [
      {
        name: 'french_profile',
        when: 'session.language == "fr"',
        priority: 10,
        instructions: 'Respond in French.',
      },
      {
        name: 'spanish_profile',
        when: 'session.language == "es"',
        priority: 20,
        instructions: 'Respond in Spanish.',
      },
    ];

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'web',
      interactionContext: {
        locale: 'fr-FR',
        timezone: 'Europe/Paris',
      },
      callerContext: makeCallerContext({
        contactPreferences: {
          language: 'fr',
        },
      }),
    });

    const interaction = readInteractionState(session);
    expect(interaction.current).toMatchObject({
      language: 'fr',
      locale: 'fr-FR',
      timezone: 'Europe/Paris',
      source: 'message',
      confidence: 'explicit',
    });
    expect(interaction.preference).toMatchObject({
      language: 'fr',
      locale: 'fr-FR',
      timezone: 'Europe/Paris',
      source: 'message',
      confidence: 'explicit',
    });
    expect(session.data.values).toMatchObject({
      _language: 'fr',
      _locale: 'fr-FR',
      _timezone: 'Europe/Paris',
    });
    expect(session.data.values).not.toHaveProperty('language');
    expect(session._activeProfileNames).toEqual(['french_profile']);

    const sessionNamespace = session.data.values.session as Record<string, unknown>;
    expect(sessionNamespace.interactionContext).toEqual(sessionNamespace.interaction);

    const prompt = executor.buildSystemPrompt(session);
    expect(prompt).toContain('"interactionContext"');
    expect(prompt).toContain('"language": "fr"');
    expect(prompt).toContain('"locale": "fr-FR"');
    expect(prompt).toContain('"timezone": "Europe/Paris"');
  });

  it('updates canonical interaction state from message-level compatibility inputs', async () => {
    const executor = new RuntimeExecutor();
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_AGENT_DSL], 'Locale_Flow'),
      {
        channelType: 'web',
        callerContext: makeCallerContext({
          contactPreferences: {
            language: 'fr',
          },
        }),
      },
    );

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'Paris', undefined, undefined, {
      messageMetadata: {
        locale: 'es-MX',
      },
      sessionMetadata: {
        clientInfo: {
          timezone: 'America/Mexico_City',
        },
      },
    });

    const interaction = readInteractionState(session);
    expect(interaction.current).toMatchObject({
      language: 'fr',
      locale: 'es-MX',
      timezone: 'America/Mexico_City',
      source: 'message',
      confidence: 'explicit',
    });
    expect(interaction.preference).toMatchObject({
      language: 'fr',
      locale: 'es-MX',
      timezone: 'America/Mexico_City',
      source: 'message',
      confidence: 'explicit',
    });
    expect(session.data.values).toMatchObject({
      _language: 'fr',
      _locale: 'es-MX',
      _timezone: 'America/Mexico_City',
    });
    expect(session.data.values).not.toHaveProperty('language');
  });

  it('re-evaluates reasoning profiles from the canonical interaction language on a later turn', async () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([REASONING_AGENT_DSL], 'Locale_Profile');
    resolved.agents[resolved.entryAgent].behavior_profiles = [
      {
        name: 'french_profile',
        when: 'session.language == "fr"',
        priority: 10,
        instructions: 'Respond in French.',
      },
      {
        name: 'spanish_profile',
        when: 'session.language == "es"',
        priority: 20,
        instructions: 'Respond in Spanish.',
      },
    ];

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'web',
      callerContext: makeCallerContext({
        contactPreferences: {
          language: 'fr',
        },
      }),
    });
    session.llmClient = createMockReasoningClient();

    await executor.executeMessage(session.id, 'Hola', undefined, undefined, {
      interactionContext: {
        language: 'es',
      },
    });

    const interaction = readInteractionState(session);
    expect(interaction.current.language).toBe('es');
    expect(interaction.preference?.language).toBe('es');
    expect(session._activeProfileNames).toEqual(['spanish_profile']);
  });

  it('re-evaluates reasoning profiles from current-turn classifier interaction hints', async () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([REASONING_AGENT_DSL], 'Locale_Profile');
    resolved.agents[resolved.entryAgent].behavior_profiles = [
      {
        name: 'empathy_profile',
        when: 'interaction.sentiment_score < -0.5 AND interaction.emotion_label == "frustrated" AND interaction.turn_topic == "billing"',
        priority: 10,
        instructions: 'Acknowledge frustration before solving the billing issue.',
      },
    ];

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'web',
    });
    session.llmClient = createMockReasoningClient();

    await executor.executeMessage(session.id, 'This charge is wrong', undefined, undefined, {
      messageMetadata: {
        sentiment: { score: -0.82, label: 'negative' },
        emotion: { label: 'frustrated' },
        turn: { topic: 'billing' },
      },
    });

    expect(session._activeProfileNames).toEqual(['empathy_profile']);
    expect(executor.buildSystemPrompt(session)).toContain(
      'Acknowledge frustration before solving the billing issue.',
    );

    await executor.executeMessage(session.id, 'Thanks', undefined, undefined);

    expect(session._activeProfileNames).toEqual([]);
    expect(executor.buildSystemPrompt(session)).not.toContain(
      'Acknowledge frustration before solving the billing issue.',
    );
  });

  it('treats inferred language switches as current-turn state without overwriting preference', async () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([REASONING_AGENT_DSL], 'Locale_Profile');
    resolved.agents[resolved.entryAgent].behavior_profiles = [
      {
        name: 'french_profile',
        when: 'session.language == "fr"',
        priority: 10,
        instructions: 'Respond in French.',
      },
      {
        name: 'spanish_profile',
        when: 'session.language == "es"',
        priority: 20,
        instructions: 'Respond in Spanish.',
      },
    ];

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'web',
      callerContext: makeCallerContext({
        contactPreferences: {
          language: 'fr',
          locale: 'fr-FR',
        },
      }),
    });
    session.llmClient = createMockReasoningClient();

    await executor.executeMessage(session.id, 'Hola, necesito ayuda con mi reserva');

    const interaction = readInteractionState(session);
    expect(interaction.current).toMatchObject({
      language: 'es',
      locale: 'fr-FR',
      source: 'message',
      confidence: 'medium',
    });
    expect(interaction.preference).toMatchObject({
      language: 'fr',
      locale: 'fr-FR',
      source: 'contact',
      confidence: 'high',
    });
    expect(session.data.values).toMatchObject({
      _language: 'es',
      _locale: 'fr-FR',
    });
    expect(session._activeProfileNames).toEqual(['spanish_profile']);

    const prompt = executor.buildSystemPrompt(session);
    expect(prompt).toContain('"interactionContext"');
    expect(prompt).toContain('"language": "es"');
    expect(prompt).toContain('"locale": "fr-FR"');
  });

  it('exposes interactionContext as the canonical custom-prompt object while keeping legacy aliases', () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([REASONING_AGENT_DSL], 'Locale_Profile');
    resolved.agents[resolved.entryAgent].identity.system_prompt = {
      custom: true,
      template:
        'ctx={{interactionContext.locale}} session={{session.interactionContext.current.locale}} legacy={{runtime_interaction.locale}} flat={{interaction_locale}}',
      sections: {},
    };

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'web',
      interactionContext: {
        language: 'fr',
        locale: 'fr-FR',
        timezone: 'Europe/Paris',
      },
    });

    const prompt = executor.buildSystemPrompt(session);
    expect(prompt).toContain('ctx=fr-FR');
    expect(prompt).toContain('session=fr-FR');
    expect(prompt).toContain('legacy=fr-FR');
    expect(prompt).toContain('flat=fr-FR');
  });

  it('injects interactionContext into tool session templates with backward-compatible aliases', async () => {
    const executor = new RuntimeExecutor();
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([TOOL_FLOW_AGENT_DSL], 'Locale_Tool_Flow'),
      {
        channelType: 'web',
        interactionContext: {
          language: 'fr',
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
        },
      },
    );

    let capturedParams: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: vi.fn(async (_toolName: string, params: Record<string, unknown>) => {
        capturedParams = params;
        return { ok: true };
      }),
      executeParallel: vi.fn(async () => []),
    };

    await executor.initializeSession(session.id);

    const toolSession = capturedParams?._session as Record<string, unknown> | undefined;
    expect(toolSession).toBeDefined();
    expect(toolSession?.interactionContext).toEqual(toolSession?.interaction);
    expect(
      (toolSession?.interactionContext as { current?: { locale?: string } } | undefined)?.current
        ?.locale,
    ).toBe('fr-FR');
  });
});
