import { describe, expect, test, vi } from 'vitest';
import {
  ChannelDispatcher,
  type DispatchableResult,
} from '../../services/execution/channel-dispatcher.js';

describe('ChannelDispatcher', () => {
  const responseMetadata = {
    isLlmGenerated: true,
    responseProvenance: {
      schemaVersion: 1 as const,
      kind: 'llm' as const,
      disclaimerRequired: true,
      usedLlmInternally: true,
    },
  };

  test('delivers web_chat async results over the shared websocket registry when connected', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const pendingDeliveryStore = {
      store: vi.fn(async () => {}),
      retrieve: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => ws),
      } as any,
      pendingDeliveryStore,
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-1',
      },
      'sdk-session-1',
      {
        response: 'Pending async reply',
        richContent: { markdown: '**Pending async reply**' },
        actions: { elements: [{ type: 'button', id: 'ack', label: 'Acknowledge' }] },
        voiceConfig: { plain_text: 'Pending async reply' },
        responseMetadata,
      },
    );

    expect(ws.send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: 'response_start',
      sessionId: 'sdk-session-1',
    });
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({
      type: 'response_chunk',
      sessionId: 'sdk-session-1',
      chunk: 'Pending async reply',
    });
    expect(JSON.parse(ws.send.mock.calls[2][0])).toMatchObject({
      type: 'response_end',
      sessionId: 'sdk-session-1',
      fullText: 'Pending async reply',
      metadata: responseMetadata,
    });
    expect(pendingDeliveryStore.store).not.toHaveBeenCalled();
  });

  test('preserves structured child response fields on the first web_chat message after handoff', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const pendingDeliveryStore = {
      store: vi.fn(async () => {}),
      retrieve: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => ws),
      } as any,
      pendingDeliveryStore,
    });

    const childEntryResponse = [
      '## Plan ready',
      '',
      '**Choose** one of these next steps from the child agent.',
    ].join('\n');
    const actions = {
      elements: [
        {
          type: 'button',
          id: 'approve_handoff_plan',
          label: 'Approve plan',
          value: 'approve',
        },
        {
          type: 'button',
          id: 'revise_handoff_plan',
          label: 'Revise plan',
          value: 'revise',
        },
      ],
    };
    const richContent = {
      markdown: childEntryResponse,
      cards: [
        {
          id: 'handoff-summary',
          title: 'Child agent summary',
          body: 'The child agent prepared a structured plan.',
        },
      ],
    };
    const voiceConfig = {
      plain_text: 'Plan ready. Choose one of these next steps.',
    };

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-1',
      },
      'sdk-session-1',
      {
        response: childEntryResponse,
        handoffProgress: {
          phase: 'completed',
          targetAgent: 'child-agent',
          taskId: 'handoff-task-1',
        },
        actions,
        richContent,
        voiceConfig,
      },
    );

    expect(ws.send).toHaveBeenCalledTimes(4);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: 'handoff_progress',
      sessionId: 'sdk-session-1',
      progress: {
        phase: 'completed',
        targetAgent: 'child-agent',
        taskId: 'handoff-task-1',
      },
    });
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({
      type: 'response_start',
      sessionId: 'sdk-session-1',
    });
    expect(JSON.parse(ws.send.mock.calls[2][0])).toMatchObject({
      type: 'response_chunk',
      sessionId: 'sdk-session-1',
      chunk: childEntryResponse,
      actions,
      richContent,
      voiceConfig,
    });
    expect(JSON.parse(ws.send.mock.calls[3][0])).toMatchObject({
      type: 'response_end',
      sessionId: 'sdk-session-1',
      fullText: childEntryResponse,
      actions,
      richContent,
      voiceConfig,
    });
    expect(pendingDeliveryStore.store).not.toHaveBeenCalled();
  });

  test('stores web_chat async results for later pickup when no websocket is connected', async () => {
    const pendingDeliveryStore = {
      store: vi.fn(async () => {}),
      retrieve: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore,
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-1',
      },
      'sdk-session-1',
      { response: 'Pending async reply' },
    );

    expect(pendingDeliveryStore.store).toHaveBeenCalledWith(
      'sdk-session-1',
      expect.objectContaining({
        channelType: 'web_chat',
        tenantId: 'tenant-1',
      }),
      expect.objectContaining({
        response: 'Pending async reply',
      }),
    );
  });

  test('publishes provenance metadata for cross-pod websocket delivery', async () => {
    const redisPubSub = {
      publish: vi.fn(async () => 1),
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      redisPubSub,
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-2',
      },
      'sdk-session-2',
      {
        response: 'Pending async reply',
        voiceConfig: { plain_text: 'Pending async reply' },
        responseMetadata,
      },
    );

    expect(redisPubSub.publish).toHaveBeenCalledWith(
      'ws:deliver:sdk-session-2',
      expect.any(String),
    );
    const payload = JSON.parse(redisPubSub.publish.mock.calls[0][1]) as Record<string, unknown>;
    expect(payload.responseMetadata).toEqual(responseMetadata);
    expect(payload.voiceConfig).toEqual({ plain_text: 'Pending async reply' });
  });

  test('preserves localization metadata through async websocket delivery surfaces', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const redisPubSub = {
      publish: vi.fn(async () => 1),
    };
    const pendingDeliveryStore = {
      store: vi.fn(async () => {}),
      retrieve: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'async.reply',
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => ws),
      } as any,
      pendingDeliveryStore,
      redisPubSub,
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-localized',
      },
      'sdk-session-localized',
      {
        response: 'Localized async reply',
        localization,
      },
    );

    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({
      type: 'response_chunk',
      localization,
    });
    expect(JSON.parse(ws.send.mock.calls[2][0])).toMatchObject({
      type: 'response_end',
      localization,
    });
    expect(pendingDeliveryStore.store).not.toHaveBeenCalled();
  });

  test('persists async delivery provenance metadata when message persistence is configured', async () => {
    const persistMessage = vi.fn(async () => {});
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      messagePersister: {
        persistMessage,
      },
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-3',
        dbSessionId: 'db-session-1',
      },
      'sdk-session-3',
      {
        response: 'Pending async reply',
        richContent: { markdown: '**Pending async reply**' },
        actions: { elements: [{ type: 'button', id: 'ack', label: 'Acknowledge' }] },
        voiceConfig: { plain_text: 'Pending async reply' },
        responseMetadata,
      },
    );

    expect(persistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Pending async reply',
      'web_chat',
      'tenant-1',
      undefined,
      {
        richContent: { markdown: '**Pending async reply**' },
        actions: { elements: [{ type: 'button', id: 'ack', label: 'Acknowledge' }] },
        voiceConfig: { plain_text: 'Pending async reply' },
      },
      responseMetadata,
    );
  });

  test('persists async delivery localization metadata in canonical structured content', async () => {
    const persistMessage = vi.fn(async () => {});
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'async.localized',
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      messagePersister: {
        persistMessage,
      },
    });

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-3',
        dbSessionId: 'db-session-1',
      },
      'sdk-session-3',
      {
        response: 'Pending async reply',
        localization,
        responseMetadata,
      },
    );

    expect(persistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Pending async reply',
      'web_chat',
      'tenant-1',
      undefined,
      {
        localization,
      },
      responseMetadata,
    );
  });

  test('persists structured-only async delivery payloads through canonical content fields', async () => {
    const persistMessage = vi.fn(async () => {});
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      messagePersister: {
        persistMessage,
      },
    });
    const structuredOnlyResult = {
      response: '',
      richContent: { markdown: '**Choose next step**' },
      actions: { elements: [{ type: 'button', id: 'ack', label: 'Acknowledge' }] },
      voiceConfig: { plain_text: 'Choose next step' },
      responseMetadata,
    } satisfies DispatchableResult;

    await dispatcher.deliver(
      {
        channelType: 'web_chat',
        tenantId: 'tenant-1',
        wsSessionId: 'sdk-session-4',
        dbSessionId: 'db-session-2',
      },
      'sdk-session-4',
      structuredOnlyResult,
    );

    expect(persistMessage).toHaveBeenCalledWith(
      'db-session-2',
      'assistant',
      '',
      'web_chat',
      'tenant-1',
      undefined,
      {
        richContent: { markdown: '**Choose next step**' },
        actions: { elements: [{ type: 'button', id: 'ack', label: 'Acknowledge' }] },
        voiceConfig: { plain_text: 'Choose next step' },
      },
      responseMetadata,
    );
  });

  test('delivers A2A async updates with structured data parts', async () => {
    const deliverTaskUpdate = vi.fn(async () => {});
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      pushNotificationSender: {
        deliverTaskUpdate,
      },
    });

    await dispatcher.deliver(
      {
        channelType: 'a2a',
        tenantId: 'tenant-1',
        pushNotificationConfig: { url: 'https://a2a.example.com/push', token: 'push-token' },
      } as any,
      'a2a-session-1',
      {
        response: 'Choose one',
        richContent: { markdown: '**Choose one**' },
        actions: { elements: [{ type: 'button', id: 'pick_1', label: 'Pick one' }] },
        voiceConfig: { plain_text: 'Choose one' },
      },
    );

    expect(deliverTaskUpdate).toHaveBeenCalledWith(
      { url: 'https://a2a.example.com/push', token: 'push-token' },
      'a2a-session-1',
      'completed',
      expect.objectContaining({
        kind: 'message',
        role: 'agent',
        parts: [
          { kind: 'text', text: 'Choose one' },
          {
            kind: 'data',
            data: {
              richContent: { markdown: '**Choose one**' },
              actions: { elements: [{ type: 'button', id: 'pick_1', label: 'Pick one' }] },
              voiceConfig: { plain_text: 'Choose one' },
            },
          },
        ],
      }),
    );
  });

  test('delivers A2A async updates with localization metadata in structured data parts', async () => {
    const deliverTaskUpdate = vi.fn(async () => {});
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'a2a.localized',
    };
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      pushNotificationSender: {
        deliverTaskUpdate,
      },
    });

    await dispatcher.deliver(
      {
        channelType: 'a2a',
        tenantId: 'tenant-1',
        pushNotificationConfig: { url: 'https://a2a.example.com/push', token: 'push-token' },
      } as any,
      'a2a-session-localized',
      {
        response: 'Localized update',
        localization,
      },
    );

    expect(deliverTaskUpdate).toHaveBeenCalledWith(
      { url: 'https://a2a.example.com/push', token: 'push-token' },
      'a2a-session-localized',
      'completed',
      expect.objectContaining({
        parts: [
          { kind: 'text', text: 'Localized update' },
          {
            kind: 'data',
            data: { localization },
          },
        ],
      }),
    );
  });

  test('delivers structured-only A2A async updates without forcing empty text parts', async () => {
    const deliverTaskUpdate = vi.fn(async () => {});
    const dispatcher = new ChannelDispatcher({
      wsRegistry: {
        getConnectionForSession: vi.fn(() => undefined),
      } as any,
      pendingDeliveryStore: {
        store: vi.fn(async () => {}),
        retrieve: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
      } as any,
      pushNotificationSender: {
        deliverTaskUpdate,
      },
    });

    await dispatcher.deliver(
      {
        channelType: 'a2a',
        tenantId: 'tenant-1',
        pushNotificationConfig: { url: 'https://a2a.example.com/push' },
      } as any,
      'a2a-session-2',
      {
        response: '',
        richContent: { adaptive_card: '{"type":"AdaptiveCard"}' },
        voiceConfig: { plain_text: 'Choose from the adaptive card' },
      },
    );

    expect(deliverTaskUpdate).toHaveBeenCalledWith(
      { url: 'https://a2a.example.com/push' },
      'a2a-session-2',
      'completed',
      expect.objectContaining({
        parts: [
          {
            kind: 'data',
            data: {
              richContent: { adaptive_card: '{"type":"AdaptiveCard"}' },
              voiceConfig: { plain_text: 'Choose from the adaptive card' },
            },
          },
        ],
      }),
    );
  });
});
