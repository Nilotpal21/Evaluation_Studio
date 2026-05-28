import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentSDK } from '../core/AgentSDK.js';
import type {
  SDKConfig,
  WSServerMessage,
  WebSocketCloseEventLike,
  WebSocketConstructor,
  WebSocketLike,
} from '../core/types.js';

class FakeWebSocket implements WebSocketLike {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sentFrames: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  serverMessage(message: WSServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function createConfig(): SDKConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'http://localhost:3112',
    webSocketConstructor: FakeWebSocket as unknown as WebSocketConstructor,
  };
}

function createJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function createSdkSessionResponse(): Response {
  return createJsonResponse({
    token: 'sdk_token_1',
    expiresIn: 300,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    permissions: ['session:send_message'],
    showActivityUpdates: false,
  });
}

async function flushAsyncWork(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('LLM response provenance full data flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    FakeWebSocket.instances = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/api/v1/sdk/init')) {
        return createSdkSessionResponse();
      }

      if (url.endsWith('/api/v1/sdk/ws-ticket')) {
        return createJsonResponse({
          ticket: 'ws-ticket-1',
          expiresIn: 60,
        });
      }

      if (
        url ===
        'http://localhost:3112/api/projects/project-1/sessions/session-1/messages?direction=asc&limit=200'
      ) {
        return createJsonResponse({
          messages: [
            {
              id: 'persisted-user-1',
              role: 'user',
              content: 'What changed in my coverage?',
              timestamp: '2026-05-02T10:00:00.000Z',
            },
            {
              id: 'persisted-assistant-1',
              role: 'assistant',
              content: 'Your coverage changed yesterday.',
              timestamp: '2026-05-02T10:00:01.000Z',
              metadata: {
                isLlmGenerated: true,
                responseProvenance: {
                  schemaVersion: 1,
                  kind: 'llm',
                  disclaimerRequired: true,
                  usedLlmInternally: true,
                },
              },
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('carries provenance from runtime history, live websocket messages, and transcript fan-out into Message.metadata', async () => {
    const sdk = new AgentSDK(createConfig());
    const chat = sdk.chat();
    const receivedMessages: Array<{
      id: string;
      role: string;
      metadata?: Record<string, unknown>;
    }> = [];

    chat.on('message', (message) => {
      receivedMessages.push({
        id: message.id,
        role: message.role,
        metadata: message.metadata,
      });
    });

    const unsubscribeTranscript = chat.subscribeLiveTranscript();

    const connectPromise = sdk.connect();
    await flushAsyncWork();

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket.protocols).toEqual(['sdk-ticket', 'ws-ticket-1']);
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-1',
    });

    await connectPromise;
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(chat.getMessages()).toHaveLength(2);
    });

    socket.serverMessage({
      type: 'response_start',
      messageId: 'live-assistant-1',
    });
    socket.serverMessage({
      type: 'response_end',
      messageId: 'live-assistant-1',
      fullText: 'I used LLM reasoning and a scripted post-processor.',
      sourceChannel: 'text',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'mixed',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    });
    socket.serverMessage({
      type: 'transcript_item',
      id: 'transcript-assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'This transcript item was replayed from live sync.',
      channel: 'text',
      sourceChannel: 'text',
      inputMode: 'system',
      sequence: 3,
      timestamp: '2026-05-02T10:00:03.000Z',
      final: true,
      metadata: {
        isLlmGenerated: false,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'scripted',
          disclaimerRequired: false,
          usedLlmInternally: true,
        },
      },
    });

    await vi.waitFor(() => {
      expect(chat.getMessages()).toHaveLength(4);
    });

    const historyAssistant = chat
      .getMessages()
      .find((message) => message.id === 'persisted-assistant-1');
    const liveAssistant = chat.getMessages().find((message) => message.id === 'live-assistant-1');
    const transcriptAssistant = chat
      .getMessages()
      .find((message) => message.id === 'transcript-assistant-1');

    expect(historyAssistant?.metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
    expect(liveAssistant?.metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'mixed',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
    expect(transcriptAssistant?.metadata).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: true,
      },
    });

    expect(receivedMessages).toEqual([
      {
        id: 'persisted-user-1',
        role: 'user',
        metadata: undefined,
      },
      {
        id: 'persisted-assistant-1',
        role: 'assistant',
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      },
      {
        id: 'live-assistant-1',
        role: 'assistant',
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'mixed',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      },
      {
        id: 'transcript-assistant-1',
        role: 'assistant',
        metadata: {
          isLlmGenerated: false,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'scripted',
            disclaimerRequired: false,
            usedLlmInternally: true,
          },
        },
      },
    ]);

    expect(fetchMock.mock.calls).toEqual([
      [
        'http://localhost:3112/api/v1/sdk/init',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Public-Key': 'pk_test',
          }),
        }),
      ],
      [
        'http://localhost:3112/api/v1/sdk/ws-ticket',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-SDK-Token': 'sdk_token_1',
          }),
          body: '{}',
        }),
      ],
      [
        'http://localhost:3112/api/projects/project-1/sessions/session-1/messages?direction=asc&limit=200',
        {
          headers: {
            'X-SDK-Token': 'sdk_token_1',
          },
        },
      ],
    ]);

    unsubscribeTranscript();
    sdk.disconnect();
  });
});
