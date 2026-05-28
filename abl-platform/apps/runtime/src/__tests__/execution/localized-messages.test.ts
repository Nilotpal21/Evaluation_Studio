import { describe, expect, it } from 'vitest';
import type { RuntimeSession } from '../../services/execution/types.js';
import {
  buildLocalizedMessageResolver,
  buildSessionLocalizationCatalog,
  renderAuthoredLocalizedTemplate,
  renderQueuedIntentNoticeMessage,
  resolveLocalizedAgentMessage,
  resolveLocalizedAgentMessageWithMetadata,
  resolveLocalizedErrorHandlerResponseWithMetadata,
  storeRuntimeSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';

function createSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'session-localized-messages',
    agentName: 'TestAgent',
    agentIR: {
      metadata: { name: 'TestAgent' },
      messages: {
        conversation_complete: 'Fallback complete',
        out_of_scope: 'Fallback out of scope',
      },
    } as RuntimeSession['agentIR'],
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };

  return session;
}

describe('localized-messages', () => {
  it('initializes missing session data values before storing a catalog', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:de/_shared.json': JSON.stringify({
        conversation_complete: 'Unterhaltung abgeschlossen.',
      }),
    });
    const session = createSession({
      data: {} as RuntimeSession['data'],
    });

    expect(() => storeSessionLocalizationCatalog(session.data, catalog)).not.toThrow();
    expect(session.data).toMatchObject({
      values: {
        session: {
          _localizedMessageCatalog: catalog,
        },
      },
    });
  });

  it('does not throw when the session data store is missing entirely', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:de/_shared.json': JSON.stringify({
        conversation_complete: 'Unterhaltung abgeschlossen.',
      }),
    });
    const session = createSession({
      data: undefined as unknown as RuntimeSession['data'],
    });

    expect(() => storeSessionLocalizationCatalog(session.data, catalog)).not.toThrow();
  });

  it('materializes a missing runtime session data store before storing a catalog', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:de/_shared.json': JSON.stringify({
        conversation_complete: 'Unterhaltung abgeschlossen.',
      }),
    });
    const session = createSession({
      data: undefined as unknown as RuntimeSession['data'],
    });

    expect(() => storeRuntimeSessionLocalizationCatalog(session, catalog)).not.toThrow();
    expect(session.data.gatheredKeys).toBeInstanceOf(Set);
    expect(session.data).toMatchObject({
      values: {
        session: {
          _localizedMessageCatalog: catalog,
        },
      },
    });
  });

  it('resolves agent-specific locale assets before IR fallbacks', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:fr-FR/testagent.json': JSON.stringify({
        conversation_complete: 'Conversation terminee en francais.',
      }),
    });
    const session = createSession();
    session.data.values._locale = 'fr-FR';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(resolveLocalizedAgentMessage({ session, messageKey: 'conversation_complete' })).toBe(
      'Conversation terminee en francais.',
    );
  });

  it('falls back from a regional locale to the base-language shared asset', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:fr/_shared.json': JSON.stringify({
        out_of_scope: 'Je ne peux pas vous aider avec cette demande.',
      }),
    });
    const session = createSession();
    session.data.values._locale = 'fr-CA';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(resolveLocalizedAgentMessage({ session, messageKey: 'out_of_scope' })).toBe(
      'Je ne peux pas vous aider avec cette demande.',
    );
  });

  it('returns localization ownership metadata for catalog-backed fallbacks', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:fr/_shared.json': JSON.stringify({
        out_of_scope: 'Je ne peux pas vous aider avec cette demande.',
      }),
    });
    const session = createSession();
    session.data.values._locale = 'fr-CA';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(
      resolveLocalizedAgentMessageWithMetadata({ session, messageKey: 'out_of_scope' }),
    ).toEqual({
      text: 'Je ne peux pas vous aider avec cette demande.',
      localization: {
        domain: 'project',
        locale: 'fr-CA',
        fallbackLocale: 'fr',
        messageKey: 'out_of_scope',
        catalogId: '_shared',
      },
    });
  });

  it('prefers script-specific locale candidates before the base language', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:zh/_shared.json': JSON.stringify({
        out_of_scope: '这是基础语言回退。',
      }),
      'locale:zh-Hans/_shared.json': JSON.stringify({
        out_of_scope: '我现在不能处理这个请求。',
      }),
    });
    const session = createSession();
    session.data.values._locale = 'zh-Hans-CN';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(resolveLocalizedAgentMessage({ session, messageKey: 'out_of_scope' })).toBe(
      '我现在不能处理这个请求。',
    );
  });

  it('keeps agent and platform fallbacks when no locale asset matches', () => {
    const session = createSession();

    expect(resolveLocalizedAgentMessage({ session, messageKey: 'conversation_complete' })).toBe(
      'Fallback complete',
    );

    session.agentIR = null;
    expect(
      resolveLocalizedAgentMessage({
        session,
        messageKey: 'conversation_complete',
      }),
    ).toBe('This conversation has been completed.');
  });

  it('tracks project-owned DSL message fallbacks separately from platform defaults', () => {
    const session = createSession();

    expect(
      resolveLocalizedAgentMessageWithMetadata({
        session,
        messageKey: 'conversation_complete',
      }),
    ).toEqual({
      text: 'Fallback complete',
      localization: {
        domain: 'project',
        messageKey: 'conversation_complete',
      },
    });

    session.agentIR = null;
    expect(
      resolveLocalizedAgentMessageWithMetadata({
        session,
        messageKey: 'conversation_complete',
      }),
    ).toEqual({
      text: 'This conversation has been completed.',
      localization: {
        domain: 'platform',
        messageKey: 'conversation_complete',
      },
    });
  });

  it('preserves custom default-handler respond text instead of replacing it with error_default', () => {
    const session = createSession({
      agentIR: {
        metadata: { name: 'TestAgent' },
        messages: {
          error_default: 'Localized generic failure.',
        },
        error_handling: {
          handlers: [],
          default_handler: {
            type: 'DEFAULT',
            then: 'escalate',
            respond: 'I need to transfer you to a human agent.',
          },
        },
      } as RuntimeSession['agentIR'],
    });

    expect(
      resolveLocalizedErrorHandlerResponseWithMetadata({
        session,
        resolution: {
          handler: session.agentIR!.error_handling!.default_handler,
          respond: 'I need to transfer you to a human agent.',
        },
      }),
    ).toEqual({
      text: 'I need to transfer you to a human agent.',
    });
  });

  it('builds reusable message resolvers from the session catalog', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:es/testagent.json': JSON.stringify({
        empty_input: 'Te escucho.',
      }),
    });
    const session = createSession();
    session.data.values._language = 'es';
    storeSessionLocalizationCatalog(session.data, catalog);

    const resolveMessage = buildLocalizedMessageResolver(session);
    expect(resolveMessage('empty_input')).toBe('Te escucho.');
  });

  it('renders authored message_key templates through the locale catalog before literal fallback', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:es/testagent.json': JSON.stringify({
        ask_phone_id: 'Ingrese su Phone ID, {{name}}.',
      }),
    });
    const session = createSession({
      agentIR: {
        metadata: { name: 'TestAgent' },
        messages: {
          ask_phone_id: 'Please enter your Phone ID, {{name}}.',
        },
      } as RuntimeSession['agentIR'],
    });
    session.data.values._locale = 'es-ES';
    session.data.values.name = 'Ana';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(
      renderAuthoredLocalizedTemplate({
        session,
        messageKey: 'ask_phone_id',
        fallbackTemplate: 'Phone ID?',
      }),
    ).toBe('Ingrese su Phone ID, Ana.');
  });

  it('falls back to agent messages and then the authored literal for message_key templates', () => {
    const session = createSession({
      agentIR: {
        metadata: { name: 'TestAgent' },
        messages: {
          explain_phone_id: 'Agent default for {{name}}.',
        },
      } as RuntimeSession['agentIR'],
    });
    session.data.values.name = 'Ana';

    expect(
      renderAuthoredLocalizedTemplate({
        session,
        messageKey: 'explain_phone_id',
        fallbackTemplate: 'Literal for {{name}}.',
      }),
    ).toBe('Agent default for Ana.');

    expect(
      renderAuthoredLocalizedTemplate({
        session,
        messageKey: 'missing_key',
        fallbackTemplate: 'Literal for {{name}}.',
      }),
    ).toBe('Literal for Ana.');
  });

  it('renders queued intent notices with a localized follow-up template', () => {
    const catalog = buildSessionLocalizationCatalog({
      'locale:fr/testagent.json': JSON.stringify({
        multi_intent_queued_notice: 'Je traiterai vos autres demandes apres celle-ci.',
        multi_intent_queued_follow_up:
          'Ensuite : {{next_intent}}. Voulez-vous que je m’en occupe ?',
      }),
    });
    const session = createSession();
    session.data.values._locale = 'fr-FR';
    storeSessionLocalizationCatalog(session.data, catalog);

    expect(
      renderQueuedIntentNoticeMessage({
        intentLabel: 'expedition',
        resolveMessage: buildLocalizedMessageResolver(session),
      }),
    ).toBe(
      'Je traiterai vos autres demandes apres celle-ci. Ensuite : expedition. Voulez-vous que je m’en occupe ?',
    );
  });

  it('keeps single-template queued notice overrides backward compatible', () => {
    expect(
      renderQueuedIntentNoticeMessage({
        intentLabel: 'shipping',
        resolveMessage: (messageKey, fallbackMessage) => {
          if (messageKey === 'multi_intent_queued_notice') {
            return 'Despues atendere {{next_intent}}. Deseas que continúe?';
          }

          return fallbackMessage ?? '';
        },
      }),
    ).toBe('Despues atendere shipping. Deseas que continúe?');
  });
});
