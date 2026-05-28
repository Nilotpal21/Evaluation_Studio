import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentExecutorAdapter,
  a2aContextStorage,
} from '../infrastructure/agent-executor-adapter.js';
import type { AgentExecutorAdapterConfig } from '../infrastructure/agent-executor-adapter.js';
import type { A2ATracingPort, AgentExecutionPort, A2ARequestContext } from '../domain/ports.js';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message, Part } from '@a2a-js/sdk';

describe('AgentExecutorAdapter', () => {
  let tracing: A2ATracingPort;
  let executionPort: AgentExecutionPort;
  let eventBus: ExecutionEventBus;
  let adapter: AgentExecutorAdapter;

  const AGENT_NAME = 'test-agent';
  const TENANT_ID = 'tenant-1';
  const TASK_ID = 'task-42';
  const CONTEXT_ID = 'ctx-1';

  const TEST_CONTEXT: A2ARequestContext = {
    tenantId: TENANT_ID,
    projectId: 'proj-1',
    connectionId: 'conn-1',
  };

  /** Wrap adapter calls in AsyncLocalStorage context */
  function withContext<T>(fn: () => Promise<T>): Promise<T> {
    return a2aContextStorage.run(TEST_CONTEXT, fn);
  }

  function makeRequestContext(text: string): RequestContext {
    return {
      userMessage: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'user',
        parts: [{ kind: 'text', text }],
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;
  }

  /** Helper to get all published events from eventBus.publish calls */
  function getPublishedEvents(): unknown[] {
    return (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    executionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello from the platform',
        action: { type: 'complete' },
      }),
      getSessionDetail: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockResolvedValue('new-session-id'),
    };
    eventBus = {
      publish: vi.fn(),
      finished: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
    } as unknown as ExecutionEventBus;

    adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort,
      tracing,
    });
  });

  // =========================================================================
  // SYNC PATH (no executeMessageStreaming on port)
  // =========================================================================

  it('extracts text from message parts and passes to executeMessage', async () => {
    await withContext(() => adapter.execute(makeRequestContext('Hello remote'), eventBus));

    expect(executionPort.executeMessage).toHaveBeenCalledWith(
      expect.any(String),
      'Hello remote',
      TEST_CONTEXT,
    );
  });

  it('extracts and concatenates multiple text parts with file attachment reference', async () => {
    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-2',
        role: 'user',
        parts: [
          { kind: 'text', text: 'Line one' },
          {
            kind: 'file',
            file: { uri: 'http://example.com/file.pdf', name: 'contract.pdf' },
          } as Part,
          { kind: 'text', text: 'Line two' },
        ],
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => adapter.execute(ctx, eventBus));

    // Text parts concatenated, file part appended as attachment reference
    const callArgs = (executionPort.executeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toContain('Line one\nLine two');
    expect(callArgs[1]).toContain('[Attachments: contract.pdf]');
  });

  it('passes ingested A2A file parts as attachmentIds in the execution context', async () => {
    const attachmentIngestor = vi.fn().mockResolvedValue(['att-a2a-1']);
    adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort,
      tracing,
      attachmentIngestor,
    });

    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-2b',
        role: 'user',
        parts: [
          { kind: 'text', text: 'Review the attachment' },
          {
            kind: 'file',
            file: {
              bytes: Buffer.from('pdf-body').toString('base64'),
              mimeType: 'application/pdf',
              name: 'contract.pdf',
            },
          } as Part,
        ],
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => adapter.execute(ctx, eventBus));

    expect(attachmentIngestor).toHaveBeenCalledWith({
      attachments: [
        {
          bytes: Buffer.from('pdf-body').toString('base64'),
          mimeType: 'application/pdf',
          name: 'contract.pdf',
        },
      ],
      sessionId: expect.any(String),
      context: TEST_CONTEXT,
    });

    expect(executionPort.executeMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Review the attachment'),
      {
        ...TEST_CONTEXT,
        attachmentIds: ['att-a2a-1'],
      },
    );
  });

  it('passes custom per-message metadata without leaking reserved history metadata', async () => {
    const history = [
      { role: 'user', content: 'What is the weather?' },
      { role: 'agent', content: 'It is sunny today.' },
    ];
    const messageMetadata = {
      accountId: 'acct-123',
      context: { tier: 'gold' },
    };
    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-meta-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Will it rain tomorrow?' }],
        metadata: {
          history,
          messageMetadata,
        },
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => adapter.execute(ctx, eventBus));

    const callArgs = (executionPort.executeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const messageText = callArgs[1] as string;
    expect(messageText).toContain('[Conversation History]');
    expect(messageText).toContain('[Current Message]');
    expect(callArgs[2]).toEqual({
      ...TEST_CONTEXT,
      messageMetadata,
    });
    expect((callArgs[2] as A2ARequestContext).messageMetadata).not.toEqual(
      expect.objectContaining({ history }),
    );
  });

  it('passes sessionMetadata through both session bootstrap and turn execution', async () => {
    const resolverPort: AgentExecutionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello from the platform',
        action: { type: 'complete' },
      }),
      getSessionDetail: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockResolvedValue('session-with-metadata'),
    };
    const sessionResolver = {
      resolveSession: vi.fn().mockResolvedValue({ sessionId: '', isNew: true }),
      registerSession: vi.fn().mockResolvedValue(undefined),
      touchSession: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    const resolverAdapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: resolverPort,
      tracing,
      sessionResolver,
    });

    const sessionMetadata = {
      token: 'abc',
      profile: { tier: 'gold' },
    };
    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-session-meta-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
        metadata: {
          sessionMetadata,
        },
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => resolverAdapter.execute(ctx, eventBus));

    expect(resolverPort.createSession).toHaveBeenCalledWith({
      ...TEST_CONTEXT,
      metadata: sessionMetadata,
    });
    expect(resolverPort.executeMessage).toHaveBeenCalledWith('session-with-metadata', 'hello', {
      ...TEST_CONTEXT,
      metadata: sessionMetadata,
    });
  });

  it('passes interactionContext through both session bootstrap and turn execution', async () => {
    const resolverPort: AgentExecutionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello from the platform',
        action: { type: 'complete' },
      }),
      getSessionDetail: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockResolvedValue('session-with-interaction-context'),
    };
    const sessionResolver = {
      resolveSession: vi.fn().mockResolvedValue({ sessionId: '', isNew: true }),
      registerSession: vi.fn().mockResolvedValue(undefined),
      touchSession: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    const resolverAdapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: resolverPort,
      tracing,
      sessionResolver,
    });

    const interactionContext = {
      language: 'es',
      locale: 'es-MX',
      timezone: 'America/Mexico_City',
    };
    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-interaction-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hola' }],
        metadata: {
          interactionContext,
        },
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => resolverAdapter.execute(ctx, eventBus));

    expect(resolverPort.createSession).toHaveBeenCalledWith({
      ...TEST_CONTEXT,
      interactionContext,
    });
    expect(resolverPort.executeMessage).toHaveBeenCalledWith(
      'session-with-interaction-context',
      'hola',
      {
        ...TEST_CONTEXT,
        interactionContext,
      },
    );
  });

  it('includes data parts as JSON in the message text', async () => {
    const ctx: RequestContext = {
      userMessage: {
        kind: 'message',
        messageId: 'msg-3',
        role: 'user',
        parts: [
          { kind: 'text', text: 'Process this' },
          { kind: 'data', data: { amount: 500, currency: 'USD' } } as Part,
        ],
      } as Message,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as RequestContext;

    await withContext(() => adapter.execute(ctx, eventBus));

    const callArgs = (executionPort.executeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toContain('Process this');
    expect(callArgs[1]).toContain('"amount":500');
    expect(callArgs[1]).toContain('"currency":"USD"');
  });

  it('injects reference task context into the message text', async () => {
    const ctx = {
      ...makeRequestContext('Summarize previous results'),
      referenceTasks: [
        {
          id: 'ref-task-1',
          contextId: 'ctx-ref',
          kind: 'task',
          status: { state: 'completed' },
          history: [
            {
              kind: 'message',
              messageId: 'ref-msg-1',
              role: 'agent',
              parts: [{ kind: 'text', text: 'Risk score: 0.72 (HIGH)' }],
            },
          ],
        },
        {
          id: 'ref-task-2',
          contextId: 'ctx-ref',
          kind: 'task',
          status: { state: 'completed' },
          history: [
            {
              kind: 'message',
              messageId: 'ref-msg-2',
              role: 'user',
              parts: [{ kind: 'text', text: 'user input' }],
            },
            {
              kind: 'message',
              messageId: 'ref-msg-3',
              role: 'agent',
              parts: [{ kind: 'text', text: 'Compliance: PASS' }],
            },
          ],
        },
      ],
    } as unknown as RequestContext;

    await withContext(() => adapter.execute(ctx, eventBus));

    const callArgs = (executionPort.executeMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const messageText = callArgs[1] as string;
    expect(messageText).toContain('Summarize previous results');
    expect(messageText).toContain('[Referenced Tasks]');
    expect(messageText).toContain('[Task ref-task-1 (completed)]: Risk score: 0.72 (HIGH)');
    expect(messageText).toContain('[Task ref-task-2 (completed)]: Compliance: PASS');
    // User messages from reference tasks should NOT be included (only agent responses)
    expect(messageText).not.toContain('user input');
  });

  it('publishes working status, response message, and final status on the event bus', async () => {
    await withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus));

    const events = getPublishedEvents();

    // First: working status
    expect(events[0]).toMatchObject({
      kind: 'status-update',
      taskId: TASK_ID,
      status: { state: 'working' },
      final: false,
    });

    // Second: completed Task (populates InMemoryTaskStore)
    expect(events[1]).toMatchObject({
      kind: 'task',
      id: TASK_ID,
      status: { state: 'completed' },
    });

    // Third: response Message (sync fallback)
    expect(events[2]).toMatchObject({
      kind: 'message',
      role: 'agent',
    });
    expect((events[2] as any).parts[0].text).toBe('Hello from the platform');

    // Fourth: final status
    expect(events[3]).toMatchObject({
      kind: 'status-update',
      taskId: TASK_ID,
      status: { state: 'completed' },
      final: true,
    });

    expect(eventBus.finished).toHaveBeenCalledOnce();
  });

  it('preserves structured rich content and actions as data parts', async () => {
    (executionPort.executeMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: 'Choose an option',
      richContent: { markdown: '**Choose an option**' },
      actions: { elements: [{ type: 'button', id: 'pick_1', label: 'Pick me' }] },
      action: { type: 'complete' },
    });

    await withContext(() => adapter.execute(makeRequestContext('Show choices'), eventBus));

    const events = getPublishedEvents();
    const completedTask = events[1] as any;
    const responseMessage = events[2] as any;

    expect(completedTask.kind).toBe('task');
    expect(completedTask.artifacts[0].parts).toEqual([
      { kind: 'text', text: 'Choose an option' },
      {
        kind: 'data',
        data: {
          richContent: { markdown: '**Choose an option**' },
          actions: { elements: [{ type: 'button', id: 'pick_1', label: 'Pick me' }] },
        },
      },
    ]);

    expect(responseMessage.kind).toBe('message');
    expect(responseMessage.parts).toEqual([
      { kind: 'text', text: 'Choose an option' },
      {
        kind: 'data',
        data: {
          richContent: { markdown: '**Choose an option**' },
          actions: { elements: [{ type: 'button', id: 'pick_1', label: 'Pick me' }] },
        },
      },
    ]);
  });

  it('emits structured-only payloads even when response text is empty', async () => {
    (executionPort.executeMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: '',
      richContent: { adaptive_card: '{"type":"AdaptiveCard"}' },
      action: { type: 'complete' },
    });

    await withContext(() => adapter.execute(makeRequestContext('Show card'), eventBus));

    const events = getPublishedEvents();
    const completedTask = events[1] as any;
    const responseMessage = events[2] as any;

    expect(completedTask.kind).toBe('task');
    expect(completedTask.artifacts[0].parts).toEqual([
      {
        kind: 'data',
        data: {
          richContent: { adaptive_card: '{"type":"AdaptiveCard"}' },
        },
      },
    ]);

    expect(responseMessage.kind).toBe('message');
    expect(responseMessage.parts).toEqual([
      {
        kind: 'data',
        data: {
          richContent: { adaptive_card: '{"type":"AdaptiveCard"}' },
        },
      },
    ]);

    expect(events[3]).toMatchObject({
      kind: 'status-update',
      status: { state: 'completed' },
      final: true,
    });
  });

  it('includes response metadata in structured A2A payloads', async () => {
    (executionPort.executeMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: 'Choose an option',
      responseMetadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
      action: { type: 'complete' },
    });

    await withContext(() => adapter.execute(makeRequestContext('Show choices'), eventBus));

    const events = getPublishedEvents();
    const completedTask = events[1] as any;
    const responseMessage = events[2] as any;

    expect(completedTask.artifacts[0].parts).toEqual([
      { kind: 'text', text: 'Choose an option' },
      {
        kind: 'data',
        data: {
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        },
      },
    ]);

    expect(responseMessage.parts).toEqual([
      { kind: 'text', text: 'Choose an option' },
      {
        kind: 'data',
        data: {
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        },
      },
    ]);
  });

  it('publishes completed final state even when action type is not complete', async () => {
    // Per A2A spec, 'working' is non-terminal — all finished executions emit 'completed'
    (executionPort.executeMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: 'Still working...',
      action: { type: 'handoff' },
    });

    await withContext(() => adapter.execute(makeRequestContext('Do something'), eventBus));

    const events = getPublishedEvents();
    const finalStatus = events[events.length - 1] as any;
    expect(finalStatus.kind).toBe('status-update');
    expect(finalStatus.status.state).toBe('completed');
    expect(finalStatus.final).toBe(true);
  });

  it('traces inbound calls with success status', async () => {
    await withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus));

    expect(tracing.traceInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIp: 'a2a-protocol',
        taskId: TASK_ID,
        tenantId: TENANT_ID,
        agentName: AGENT_NAME,
        status: 'success',
      }),
    );
    const call = (tracing.traceInbound as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.durationMs).toBe('number');
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('traces inbound calls with error status on failure and re-throws', async () => {
    const executionError = new Error('Agent execution failed');
    (executionPort.executeMessage as ReturnType<typeof vi.fn>).mockRejectedValue(executionError);

    await expect(
      withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus)),
    ).rejects.toThrow('Agent execution failed');

    expect(tracing.traceInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        tenantId: TENANT_ID,
        agentName: AGENT_NAME,
        status: 'error',
        error: 'Agent execution failed',
      }),
    );

    // Should publish working status then failed status
    const events = getPublishedEvents();
    expect(events[0]).toMatchObject({
      kind: 'status-update',
      status: { state: 'working' },
      final: false,
    });
    expect(events[1]).toMatchObject({
      kind: 'status-update',
      status: { state: 'failed' },
      final: true,
    });
    expect(eventBus.finished).toHaveBeenCalledOnce();
  });

  it('cancelTask publishes canceled status-update and finishes', async () => {
    await adapter.cancelTask(TASK_ID, eventBus);

    const published = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.kind).toBe('status-update');
    expect(published.taskId).toBe(TASK_ID);
    expect(published.status.state).toBe('canceled');
    expect(published.final).toBe(true);
    expect(eventBus.finished).toHaveBeenCalledOnce();
  });

  // =========================================================================
  // STREAMING PATH (executeMessageStreaming available on port)
  // =========================================================================

  describe('streaming execution', () => {
    let streamingPort: AgentExecutionPort;
    let streamingAdapter: AgentExecutorAdapter;

    beforeEach(() => {
      streamingPort = {
        executeMessage: vi.fn().mockResolvedValue({
          response: 'Hello world',
          action: { type: 'complete' },
        }),
        executeMessageStreaming: vi.fn(async (_sessionId, _message, onChunk) => {
          onChunk('Hello');
          onChunk(' world');
          return { response: 'Hello world', action: { type: 'complete' } };
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      streamingAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: streamingPort,
        tracing,
      });
    });

    it('emits working status, artifact chunks, last-chunk marker, and final status', async () => {
      await withContext(() => streamingAdapter.execute(makeRequestContext('Hi'), eventBus));

      const events = getPublishedEvents();

      // 1. working status
      expect(events[0]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: false,
      });

      // 2. first artifact chunk (append: false)
      expect(events[1]).toMatchObject({
        kind: 'artifact-update',
        taskId: TASK_ID,
        append: false,
        lastChunk: false,
      });
      expect((events[1] as any).artifact.parts[0].text).toBe('Hello');

      // 3. second artifact chunk (append: true)
      expect(events[2]).toMatchObject({
        kind: 'artifact-update',
        taskId: TASK_ID,
        append: true,
        lastChunk: false,
      });
      expect((events[2] as any).artifact.parts[0].text).toBe(' world');

      // 4. last-chunk marker
      expect(events[3]).toMatchObject({
        kind: 'artifact-update',
        taskId: TASK_ID,
        append: true,
        lastChunk: true,
      });

      // 5. completed Task (populates InMemoryTaskStore)
      expect(events[4]).toMatchObject({
        kind: 'task',
        id: TASK_ID,
        status: { state: 'completed' },
      });

      // 6. response Message (SDK ResultManager requires this for blocking path)
      expect(events[5]).toMatchObject({
        kind: 'message',
        role: 'agent',
      });
      expect((events[5] as any).parts[0].text).toBe('Hello world');

      // 7. final status
      expect(events[6]).toMatchObject({
        kind: 'status-update',
        status: { state: 'completed' },
        final: true,
      });

      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('uses executeMessageStreaming instead of executeMessage', async () => {
      await withContext(() => streamingAdapter.execute(makeRequestContext('Hi'), eventBus));

      expect(streamingPort.executeMessageStreaming).toHaveBeenCalledWith(
        expect.any(String),
        'Hi',
        expect.any(Function),
        expect.any(Function),
        TEST_CONTEXT,
      );
      expect(streamingPort.executeMessage).not.toHaveBeenCalled();
    });

    it('falls back to sync path when executeMessageStreaming is not available', async () => {
      // Default adapter has no executeMessageStreaming on its port
      await withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus));

      const events = getPublishedEvents();
      // Sync path: working status → Task → Message → final status
      expect(events[0]).toMatchObject({ kind: 'status-update', final: false });
      expect((events[1] as any).kind).toBe('task');
      expect((events[2] as any).kind).toBe('message');
      expect(events[3]).toMatchObject({ kind: 'status-update', final: true });
    });

    it('emits failed status on streaming error', async () => {
      const failingPort: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(async () => {
          throw new Error('Stream failed');
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const failAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: failingPort,
        tracing,
      });

      await expect(
        withContext(() => failAdapter.execute(makeRequestContext('Hi'), eventBus)),
      ).rejects.toThrow('Stream failed');

      const events = getPublishedEvents();
      // working status → failed status
      expect(events[0]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: false,
      });
      const failedEvent = events.find(
        (e: any) => e.kind === 'status-update' && e.final === true,
      ) as any;
      expect(failedEvent.status.state).toBe('failed');
      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('skips artifact events when streaming produces zero chunks', async () => {
      const noChunkPort: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(async () => {
          // No onChunk calls — tool-only response
          return { response: 'Done', action: { type: 'complete' } };
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const noChunkAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: noChunkPort,
        tracing,
      });

      await withContext(() => noChunkAdapter.execute(makeRequestContext('Hi'), eventBus));

      const events = getPublishedEvents();
      // working status → Task → response message → final status (no artifact events)
      expect(events).toHaveLength(4);
      expect(events[0]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: false,
      });
      // Task event (populates InMemoryTaskStore)
      expect(events[1]).toMatchObject({
        kind: 'task',
        status: { state: 'completed' },
      });
      // Message event with the response (SDK ResultManager requires this)
      expect(events[2]).toMatchObject({
        kind: 'message',
        role: 'agent',
      });
      expect((events[2] as any).parts[0].text).toBe('Done');
      expect(events[3]).toMatchObject({
        kind: 'status-update',
        status: { state: 'completed' },
        final: true,
      });
    });

    it('preserves structured payloads on streaming completion', async () => {
      const structuredStreamingPort: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(async (_sessionId, _message, onChunk) => {
          onChunk('Choose');
          return {
            response: 'Choose',
            richContent: { markdown: '**Choose**' },
            actions: { elements: [{ type: 'button', id: 'opt_1', label: 'Option 1' }] },
            action: { type: 'complete' },
          };
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const structuredAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: structuredStreamingPort,
        tracing,
      });

      await withContext(() =>
        structuredAdapter.execute(makeRequestContext('Stream choices'), eventBus),
      );

      const events = getPublishedEvents();
      const completedTask = events[3] as any;
      const responseMessage = events[4] as any;

      expect(completedTask.kind).toBe('task');
      expect(completedTask.artifacts[0].parts).toEqual([
        { kind: 'text', text: 'Choose' },
        {
          kind: 'data',
          data: {
            richContent: { markdown: '**Choose**' },
            actions: { elements: [{ type: 'button', id: 'opt_1', label: 'Option 1' }] },
          },
        },
      ]);

      expect(responseMessage.kind).toBe('message');
      expect(responseMessage.parts).toEqual([
        { kind: 'text', text: 'Choose' },
        {
          kind: 'data',
          data: {
            richContent: { markdown: '**Choose**' },
            actions: { elements: [{ type: 'button', id: 'opt_1', label: 'Option 1' }] },
          },
        },
      ]);
    });

    it('traces streaming calls with success status', async () => {
      await withContext(() => streamingAdapter.execute(makeRequestContext('Hello'), eventBus));

      expect(tracing.traceInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          tenantId: TENANT_ID,
          agentName: AGENT_NAME,
          status: 'success',
        }),
      );
    });
  });

  // =========================================================================
  // SESSION RESOLUTION (contextId → RuntimeSession)
  // =========================================================================

  describe('session resolution', () => {
    it('uses contextId via session resolver when available', async () => {
      const resolverPort = {
        ...executionPort,
      };
      const sessionResolver = {
        resolveSession: vi
          .fn()
          .mockResolvedValue({ sessionId: 'persistent-session-1', isNew: false }),
        registerSession: vi.fn().mockResolvedValue(undefined),
        touchSession: vi.fn().mockResolvedValue(undefined),
        closeSession: vi.fn().mockResolvedValue(undefined),
      };

      const resolverAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: resolverPort,
        tracing,
        sessionResolver,
      });

      await withContext(() => resolverAdapter.execute(makeRequestContext('Hello'), eventBus));

      // executeMessage should be called with resolved session ID, not taskId
      expect(resolverPort.executeMessage).toHaveBeenCalledWith(
        'persistent-session-1',
        'Hello',
        TEST_CONTEXT,
      );
      expect(sessionResolver.resolveSession).toHaveBeenCalledWith(CONTEXT_ID, TENANT_ID);
    });

    it('falls back to taskId when no session resolver is set', async () => {
      // Default adapter has no sessionResolver
      await withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus));

      // executeMessage should be called with taskId as sessionId
      expect(executionPort.executeMessage).toHaveBeenCalledWith(
        expect.any(String),
        'Hello',
        TEST_CONTEXT,
      );
    });

    it('supports setSessionResolver for post-construction injection', async () => {
      const sessionResolver = {
        resolveSession: vi.fn().mockResolvedValue({ sessionId: 'injected-session', isNew: false }),
        registerSession: vi.fn().mockResolvedValue(undefined),
        touchSession: vi.fn().mockResolvedValue(undefined),
        closeSession: vi.fn().mockResolvedValue(undefined),
      };

      // Start without resolver
      adapter.setSessionResolver(sessionResolver);

      await withContext(() => adapter.execute(makeRequestContext('Hello'), eventBus));

      expect(executionPort.executeMessage).toHaveBeenCalledWith(
        'injected-session',
        'Hello',
        TEST_CONTEXT,
      );
    });

    it('uses resolved session for streaming path too', async () => {
      const streamingWithResolver: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(async () => {
          return { response: 'Streamed', action: { type: 'complete' } };
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const sessionResolver = {
        resolveSession: vi.fn().mockResolvedValue({ sessionId: 'stream-session-1', isNew: false }),
        registerSession: vi.fn().mockResolvedValue(undefined),
        touchSession: vi.fn().mockResolvedValue(undefined),
        closeSession: vi.fn().mockResolvedValue(undefined),
      };

      const streamResolverAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: streamingWithResolver,
        tracing,
        sessionResolver,
      });

      await withContext(() => streamResolverAdapter.execute(makeRequestContext('Hi'), eventBus));

      expect(streamingWithResolver.executeMessageStreaming).toHaveBeenCalledWith(
        'stream-session-1', // resolved session ID, not taskId
        'Hi',
        expect.any(Function),
        expect.any(Function),
        TEST_CONTEXT,
      );
    });

    it('rejects tasks in terminal state', async () => {
      const ctx = {
        ...makeRequestContext('Hello'),
        task: {
          id: TASK_ID,
          contextId: CONTEXT_ID,
          kind: 'task' as const,
          status: { state: 'completed' as const },
        },
      } as unknown as RequestContext;

      await expect(withContext(() => adapter.execute(ctx, eventBus))).rejects.toThrow(
        `Task ${TASK_ID} is in terminal state: completed`,
      );
    });
  });

  // =========================================================================
  // STATE TRANSITIONS (suspension, input-required)
  // =========================================================================

  describe('state transitions', () => {
    it('emits input-required when sync execution suspends with human_approval', async () => {
      const suspendingPort: AgentExecutionPort = {
        executeMessage: vi.fn().mockResolvedValue({
          response: 'Approve expense?',
          action: { type: 'suspend', reason: { type: 'human_approval' } },
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const suspendAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: suspendingPort,
        tracing,
      });

      await withContext(() =>
        suspendAdapter.execute(makeRequestContext('Process expense'), eventBus),
      );

      const events = getPublishedEvents();

      // working status → input-required (final)
      expect(events[0]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: false,
      });
      expect(events[1]).toMatchObject({
        kind: 'status-update',
        status: { state: 'input-required' },
        final: true,
      });
      expect(eventBus.finished).toHaveBeenCalledOnce();
      // No Message event emitted — just status transitions
      expect(events.filter((e: any) => e.kind === 'message')).toHaveLength(0);
    });

    it('emits working (not input-required) when sync execution suspends with async_tool', async () => {
      const suspendingPort: AgentExecutionPort = {
        executeMessage: vi.fn().mockResolvedValue({
          response: 'Processing...',
          action: { type: 'suspend', reason: { type: 'async_tool' } },
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const suspendAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: suspendingPort,
        tracing,
      });

      await withContext(() => suspendAdapter.execute(makeRequestContext('Run tool'), eventBus));

      const events = getPublishedEvents();
      // Second event should be 'working' (final), not 'input-required'
      expect(events[1]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: true,
      });
    });

    it('emits input-required via Promise.race when streaming execution suspends', async () => {
      // Streaming port that never resolves but fires execution_suspended trace event
      const hangingPort: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(
          async (
            _sessionId: string,
            _message: string,
            onChunk: (chunk: string) => void,
            onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          ) => {
            onChunk('Processing ');
            // Fire suspension event (coordinator does this before promise hangs)
            onTraceEvent?.({
              type: 'execution_suspended',
              data: {
                reason: { type: 'human_input' },
                suspensionId: 'susp-1',
              },
            });
            // Never resolve — simulates coordinator's hanging deferred
            return new Promise<never>(() => {});
          },
        ),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const hangAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: hangingPort,
        tracing,
      });

      await withContext(() => hangAdapter.execute(makeRequestContext('Need approval'), eventBus));

      const events = getPublishedEvents();

      // working → artifact chunk → input-required (final)
      expect(events[0]).toMatchObject({
        kind: 'status-update',
        status: { state: 'working' },
        final: false,
      });
      // Partial chunk emitted before suspension
      expect(events[1]).toMatchObject({
        kind: 'artifact-update',
      });
      expect((events[1] as any).artifact.parts[0].text).toBe('Processing ');
      // input-required terminates stream
      const inputRequired = events.find(
        (e: any) => e.kind === 'status-update' && e.status?.state === 'input-required',
      );
      expect(inputRequired).toBeDefined();
      expect((inputRequired as any).final).toBe(true);
      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('emits working state when streaming suspends with remote_handoff', async () => {
      const hangingPort: AgentExecutionPort = {
        executeMessage: vi.fn(),
        executeMessageStreaming: vi.fn(
          async (
            _sessionId: string,
            _message: string,
            _onChunk: (chunk: string) => void,
            onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          ) => {
            onTraceEvent?.({
              type: 'execution_suspended',
              data: { reason: { type: 'remote_handoff' } },
            });
            return new Promise<never>(() => {});
          },
        ),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const hangAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: hangingPort,
        tracing,
      });

      await withContext(() => hangAdapter.execute(makeRequestContext('Handoff'), eventBus));

      const events = getPublishedEvents();
      const finalEvent = events.find(
        (e: any) => e.kind === 'status-update' && e.final === true,
      ) as any;
      expect(finalEvent.status.state).toBe('working');
    });

    it('traces suspension as success (not error)', async () => {
      const suspendingPort: AgentExecutionPort = {
        executeMessage: vi.fn().mockResolvedValue({
          response: '',
          action: { type: 'suspend', reason: { type: 'human_approval' } },
        }),
        getSessionDetail: vi.fn().mockReturnValue(null),
        createSession: vi.fn().mockResolvedValue('new-session'),
      };

      const suspendAdapter = new AgentExecutorAdapter({
        agentName: AGENT_NAME,
        executionPort: suspendingPort,
        tracing,
      });

      await withContext(() => suspendAdapter.execute(makeRequestContext('Suspend'), eventBus));

      expect(tracing.traceInbound).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success' }),
      );
    });
  });
});
