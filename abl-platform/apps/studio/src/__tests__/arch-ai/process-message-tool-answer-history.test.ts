import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveArchVercelModelMock,
  createProductionTurnEngineMock,
  handleBuildActionMock,
  extractBuildResultsFromPendingWidgetPayloadMock,
  getByIdMock,
  appendMessageMock,
  setPendingInteractionMock,
  setToolResultMock,
  setLastCollectFileContentMock,
  buildServiceBagForTurnMock,
  finalizeProjectMock,
} = vi.hoisted(() => ({
  resolveArchVercelModelMock: vi.fn(),
  createProductionTurnEngineMock: vi.fn(),
  handleBuildActionMock: vi.fn(),
  extractBuildResultsFromPendingWidgetPayloadMock: vi.fn(),
  getByIdMock: vi.fn(),
  appendMessageMock: vi.fn(),
  setPendingInteractionMock: vi.fn(),
  setToolResultMock: vi.fn(),
  setLastCollectFileContentMock: vi.fn(),
  buildServiceBagForTurnMock: vi.fn(),
  finalizeProjectMock: vi.fn(),
}));

vi.mock('@/lib/arch-llm', () => ({
  resolveArchVercelModel: (...args: unknown[]) => resolveArchVercelModelMock(...args),
}));

vi.mock('@/lib/arch-ai/engine-factory', () => ({
  createProductionTurnEngine: (...args: unknown[]) => createProductionTurnEngineMock(...args),
  buildServiceBagForTurn: (...args: unknown[]) => buildServiceBagForTurnMock(...args),
}));

vi.mock('@/lib/arch-ai/build-completion', () => ({
  handleBuildAction: (...args: unknown[]) => handleBuildActionMock(...args),
  isBuildCreateAction: (action: string) =>
    ['create', 'create_project', 'confirm_create', 'yes_create', 'create_now'].includes(
      action.trim().toLowerCase(),
    ),
}));

vi.mock('@/lib/arch-ai/build-result-reconciliation', () => ({
  extractBuildResultsFromPendingWidgetPayload: (...args: unknown[]) =>
    extractBuildResultsFromPendingWidgetPayloadMock(...args),
}));

vi.mock('@/lib/arch-ai/build-parallel-gen', () => ({
  runParallelGeneration: vi.fn(),
}));

vi.mock('@/lib/arch-ai/processors/finalize-project', () => ({
  finalizeProject: (...args: unknown[]) => finalizeProjectMock(...args),
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  sessionService: {
    getById: (...args: unknown[]) => getByIdMock(...args),
    appendMessage: (...args: unknown[]) => appendMessageMock(...args),
    setPendingInteraction: (...args: unknown[]) => setPendingInteractionMock(...args),
    setToolResult: (...args: unknown[]) => setToolResultMock(...args),
    setLastCollectFileContent: (...args: unknown[]) => setLastCollectFileContentMock(...args),
  },
  journalService: {
    append: vi.fn(),
    archiveSession: vi.fn(),
  },
  specDocumentService: {},
  projectMemoryService: {},
  fileStoreService: {
    getActiveFiles: vi.fn().mockResolvedValue([]),
  },
}));

import {
  processMessage,
  type ProcessMessageDeps,
} from '../../../../../packages/arch-ai/src/processors/process-message';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };
const nowIso = new Date().toISOString();

const processMessageDeps = {
  sessionService: {
    getById: (...args: unknown[]) => getByIdMock(...args),
    appendMessage: (...args: unknown[]) => appendMessageMock(...args),
    setPendingInteraction: (...args: unknown[]) => setPendingInteractionMock(...args),
    setToolResult: (...args: unknown[]) => setToolResultMock(...args),
    setLastCollectFileContent: (...args: unknown[]) => setLastCollectFileContentMock(...args),
  },
  journalService: {
    append: vi.fn(),
    archiveSession: vi.fn(),
  },
  specDocumentService: {},
  projectMemoryService: {},
  fileStoreService: {
    getActiveFiles: vi.fn().mockResolvedValue([]),
  },
  resolveModel: (...args: [string]) => resolveArchVercelModelMock(...args),
  createTurnEngine: (...args: Parameters<ProcessMessageDeps['createTurnEngine']>) =>
    createProductionTurnEngineMock(...args),
  buildServiceBagForTurn: (...args: unknown[]) => buildServiceBagForTurnMock(...args),
  buildSuggestionGenerator: () => async () => [],
  buildTurnPlanLoaders: () => ({}),
  augmentUserInputWithFileRefs: async (_ctx, _sessionId, userText) => userText,
  buildUserContentFromFileRefs: async () => undefined,
  transitionSessionToIdle: vi.fn(),
  closeAndResetIfActive: vi.fn(),
  projectExistsByName: vi.fn().mockResolvedValue(false),
  finalizeProject: vi.fn(),
  runParallelGeneration: vi.fn(),
  buildCompletionSummary: vi.fn().mockReturnValue('build summary'),
  buildCompletionWidgetPayload: vi.fn().mockReturnValue({ widgetType: 'BuildComplete' }),
  extractBuildResultsFromPendingWidgetPayload: (...args: [Record<string, unknown>]) =>
    extractBuildResultsFromPendingWidgetPayloadMock(...args),
  handleBuildAction: (...args: Parameters<ProcessMessageDeps['handleBuildAction']>) =>
    handleBuildActionMock(...args),
  executePhaseTransition: vi.fn(),
} as unknown as ProcessMessageDeps;

function makeSession(overrides: { phase?: 'BUILD' | 'CREATE'; projectId?: string } = {}) {
  const phase = overrides.phase ?? 'BUILD';
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase,
      mode: 'ONBOARDING',
      ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
      specification: {
        version: 1,
        projectName: 'BookingHub',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-build-complete-1',
        payload: {
          widgetType: 'BuildComplete',
          question: 'What should we do next?',
          options: [
            { label: 'Create project', value: 'create' },
            { label: 'Modify an agent', value: 'modify' },
          ],
        },
        createdAt: nowIso,
      },
      topology: {
        agents: [{ name: 'SupportAgent' }],
        edges: [],
        entryPoint: 'SupportAgent',
      },
      files: {
        SupportAgent: {
          path: 'agents/SupportAgent.abl.yaml',
          content: 'AGENT: SupportAgent\nGOAL: "Help customers"\n',
        },
      },
      messages: [],
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  } as const;
}

function makeSessionWithLostBuildCompletePending() {
  const session = makeSession();
  const payload = {
    widgetType: 'BuildComplete',
    question: 'What should we do next?',
    options: [
      { label: 'Create project', value: 'create' },
      { label: 'Modify an agent', value: 'modify' },
    ],
  };

  return {
    ...session,
    metadata: {
      ...session.metadata,
      pendingInteraction: null,
      buildProgress: { stage: 'agents_complete' },
      messages: [
        {
          id: 'assistant-build-complete-1',
          role: 'assistant',
          content: '',
          timestamp: nowIso,
          phase: 'BUILD',
          toolCalls: [
            {
              toolCallId: 'tool-build-complete-1',
              toolName: 'ask_user',
              input: payload,
              result: null,
            },
          ],
        },
      ],
    },
  } as const;
}

function makeInterviewSession(answer?: unknown) {
  const toolCall = {
    toolCallId: 'tool-question-1',
    toolName: 'ask_user',
    input: {
      widgetType: 'TextInput',
      question: 'Which workflows should the bot handle?',
      multiline: true,
    },
    ...(answer === undefined ? {} : { result: answer }),
  };

  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: '',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-question-1',
        payload: toolCall.input,
        createdAt: nowIso,
      },
      messages: [
        {
          id: 'assistant-question-1',
          role: 'assistant',
          content: '',
          timestamp: nowIso,
          phase: 'INTERVIEW',
          toolCalls: [toolCall],
        },
      ],
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  } as const;
}

function makeCollectFileSession(answer?: unknown) {
  const toolCall = {
    toolCallId: 'tool-file-1',
    toolName: 'collect_file',
    input: {
      widgetType: 'FileUpload',
      message: 'Upload the requested source file.',
      accept: ['.md', '.json', '.txt', 'text/*', 'application/json'],
      maxFiles: 1,
    },
    ...(answer === undefined ? {} : { result: answer }),
  };

  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: '',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-file-1',
        payload: toolCall.input,
        createdAt: nowIso,
      },
      messages: [
        {
          id: 'assistant-file-1',
          role: 'assistant',
          content: '',
          timestamp: nowIso,
          phase: 'INTERVIEW',
          toolCalls: [toolCall],
        },
      ],
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  } as const;
}

describe('processMessage deterministic tool_answer persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveArchVercelModelMock.mockResolvedValue({ model: null });
    handleBuildActionMock.mockResolvedValue({ continueToLLM: false });
    extractBuildResultsFromPendingWidgetPayloadMock.mockReturnValue([]);
    getByIdMock.mockResolvedValue(makeSession());
    appendMessageMock.mockResolvedValue(undefined);
    setPendingInteractionMock.mockResolvedValue(undefined);
    setToolResultMock.mockResolvedValue(undefined);
    setLastCollectFileContentMock.mockResolvedValue(undefined);
    buildServiceBagForTurnMock.mockReturnValue({});
    finalizeProjectMock.mockResolvedValue(undefined);
  });

  it('persists a user-history message when BuildComplete resolves without returning to the LLM', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processMessage(
      ctx,
      makeSession() as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-build-complete-1',
        answer: 'create',
      },
      emit,
      close,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      processMessageDeps,
    );

    expect(setPendingInteractionMock).toHaveBeenCalledWith(ctx, 'session-1', null);
    expect(setToolResultMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      'tool-build-complete-1',
      'create',
    );
    expect(handleBuildActionMock).toHaveBeenCalled();
    expect(resolveArchVercelModelMock).not.toHaveBeenCalled();
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        phase: 'BUILD',
        content: 'Answer to "What should we do next?": create',
        messageMetadata: {
          source: 'deterministic_tool_answer',
          toolCallId: 'tool-build-complete-1',
        },
      }),
    );
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('recovers BuildComplete actions from message history when pendingInteraction was lost', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const recoveredSession = makeSessionWithLostBuildCompletePending();
    getByIdMock.mockResolvedValue(recoveredSession);

    await processMessage(
      ctx,
      recoveredSession as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-build-complete-1',
        answer: 'create',
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(extractBuildResultsFromPendingWidgetPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ widgetType: 'BuildComplete' }),
    );
    expect(handleBuildActionMock).toHaveBeenCalledWith(
      'create',
      ctx,
      expect.anything(),
      [],
      emit,
      close,
      expect.anything(),
      'BookingHub',
    );
    expect(appendMessageMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      expect.objectContaining({
        role: 'user',
        phase: 'BUILD',
        content: 'Answer to "What should we do next?": create',
      }),
    );
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
  });

  it('treats create_project BuildComplete answers as create without resolving a model', async () => {
    const emit = vi.fn();
    const close = vi.fn();

    await processMessage(
      ctx,
      makeSession() as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-build-complete-1',
        answer: 'create_project',
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(handleBuildActionMock).toHaveBeenCalledWith(
      'create_project',
      ctx,
      expect.anything(),
      [],
      emit,
      close,
      expect.objectContaining({
        runParallelGeneration: undefined,
      }),
      'BookingHub',
    );
    expect(resolveArchVercelModelMock).not.toHaveBeenCalled();
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
  });

  it('routes free-text create intent after BuildComplete directly to project finalization', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const createReadySession = makeSession({ phase: 'CREATE' });
    getByIdMock.mockResolvedValue(createReadySession);

    await processMessage(
      ctx,
      createReadySession as never,
      {
        sessionId: 'session-1',
        type: 'message',
        text: 'Yes go ahead and create the project now.',
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(finalizeProjectMock).toHaveBeenCalledWith(
      ctx,
      createReadySession,
      emit,
      close,
      expect.objectContaining({
        sessionService: expect.any(Object),
        journalService: expect.any(Object),
        specDocumentService: expect.any(Object),
        projectMemoryService: expect.any(Object),
      }),
      undefined,
    );
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
    expect(handleBuildActionMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes free-text create intent from completed BUILD state even after pendingInteraction is cleared', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const createReadySession = makeSessionWithLostBuildCompletePending();
    getByIdMock.mockResolvedValue(createReadySession);

    await processMessage(
      ctx,
      createReadySession as never,
      {
        sessionId: 'session-1',
        type: 'message',
        text: 'Create the project now',
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(finalizeProjectMock).toHaveBeenCalledWith(
      ctx,
      createReadySession,
      emit,
      close,
      expect.objectContaining({
        sessionService: expect.any(Object),
        journalService: expect.any(Object),
        specDocumentService: expect.any(Object),
        projectMemoryService: expect.any(Object),
      }),
      undefined,
    );
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
  });

  it('routes CREATE-phase confirmation widget answers directly to project finalization', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const createReadySession = {
      ...makeSession({ phase: 'CREATE' }),
      metadata: {
        ...makeSession({ phase: 'CREATE' }).metadata,
        pendingInteraction: {
          kind: 'widget',
          id: 'create-confirm-1',
          payload: {
            widgetType: 'Confirmation',
            question: 'Confirm: create the ABL project now?',
            confirmLabel: 'Create project',
          },
          createdAt: nowIso,
        },
      },
    } as const;
    getByIdMock.mockResolvedValue(createReadySession);

    await processMessage(
      ctx,
      createReadySession as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'create-confirm-1',
        answer: true,
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(finalizeProjectMock).toHaveBeenCalledWith(
      ctx,
      createReadySession,
      emit,
      close,
      expect.objectContaining({
        sessionService: expect.any(Object),
        journalService: expect.any(Object),
        specDocumentService: expect.any(Object),
        projectMemoryService: expect.any(Object),
      }),
      undefined,
    );
    expect(handleBuildActionMock).not.toHaveBeenCalled();
    expect(createProductionTurnEngineMock).not.toHaveBeenCalled();
  });

  it('does not finalize when the free-text message asks for changes before creation', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const createReadySession = makeSession({ phase: 'CREATE' });
    getByIdMock.mockResolvedValue(createReadySession);
    createProductionTurnEngineMock.mockResolvedValue({
      engine: {
        runTurn: async function* () {
          yield { type: 'turn_ended', reason: 'natural' };
        },
      },
      toolRegistry: {
        listByNames: () => [],
        subset: () => ({ list: () => [], get: () => undefined }),
      },
    });

    await processMessage(
      ctx,
      createReadySession as never,
      {
        sessionId: 'session-1',
        type: 'message',
        text: 'Before creating, add a dispute handler agent.',
      },
      emit,
      close,
      new AbortController().signal,
    );

    expect(finalizeProjectMock).not.toHaveBeenCalled();
    expect(createProductionTurnEngineMock).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reloads the answered widget result before preparing the next LLM history', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const answeredSession = makeInterviewSession('chargebacks and evidence collection');
    let runTurnInput: { history?: Array<{ role: string; content: string }> } | null = null;

    getByIdMock.mockReset();
    getByIdMock
      .mockResolvedValueOnce(makeInterviewSession())
      .mockResolvedValueOnce(answeredSession)
      .mockResolvedValueOnce(answeredSession);
    createProductionTurnEngineMock.mockResolvedValue({
      engine: {
        runTurn: async function* (input: { history?: Array<{ role: string; content: string }> }) {
          runTurnInput = input;
          yield { type: 'turn_ended', reason: 'complete' };
        },
      },
      toolRegistry: {
        listByNames: () => [],
        subset: () => ({ list: () => [], get: () => undefined }),
      },
    });

    await processMessage(
      ctx,
      makeInterviewSession() as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-question-1',
        answer: 'chargebacks and evidence collection',
      },
      emit,
      close,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      processMessageDeps,
    );

    expect(setToolResultMock).toHaveBeenCalledWith(
      ctx,
      'session-1',
      'tool-question-1',
      'chargebacks and evidence collection',
    );
    expect(runTurnInput?.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining(
            'Which workflows should the bot handle?: chargebacks and evidence collection',
          ),
        }),
      ]),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('resumes collect_file answers with decoded file content instead of raw base64 JSON', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const fileContent = JSON.stringify(
      {
        project: 'Claims Concierge',
        workflows: ['policy lookup', 'escalation'],
      },
      null,
      2,
    );
    const answer = [
      {
        name: 'source-architecture.json',
        size: fileContent.length,
        type: 'application/json',
        content: Buffer.from(fileContent, 'utf-8').toString('base64'),
      },
    ];
    const answeredSession = makeCollectFileSession([
      {
        name: 'source-architecture.json',
        size: fileContent.length,
        type: 'application/json',
        contentStored: true,
        summary: fileContent,
      },
    ]);
    let runTurnInput: { userInput?: string } | null = null;

    getByIdMock.mockReset();
    getByIdMock
      .mockResolvedValueOnce(makeCollectFileSession())
      .mockResolvedValueOnce(answeredSession)
      .mockResolvedValueOnce(answeredSession);
    createProductionTurnEngineMock.mockResolvedValue({
      engine: {
        runTurn: async function* (input: { userInput?: string }) {
          runTurnInput = input;
          yield { type: 'turn_ended', reason: 'complete' };
        },
      },
      toolRegistry: {
        listByNames: () => [],
        subset: () => ({ list: () => [], get: () => undefined }),
      },
    });

    await processMessage(
      ctx,
      makeCollectFileSession() as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-file-1',
        answer,
      },
      emit,
      close,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      processMessageDeps,
    );

    expect(setLastCollectFileContentMock).toHaveBeenCalledWith(ctx, 'session-1', answer);
    expect(setToolResultMock).toHaveBeenCalledWith(ctx, 'session-1', 'tool-file-1', [
      expect.objectContaining({
        name: 'source-architecture.json',
        contentStored: true,
        summary: fileContent,
      }),
    ]);
    expect(runTurnInput?.userInput).toContain('[Uploaded file: source-architecture.json]');
    expect(runTurnInput?.userInput).toContain(fileContent);
    expect(runTurnInput?.userInput).not.toContain(answer[0]!.content);
    expect(close).toHaveBeenCalledOnce();
  });

  it('resumes collect_file answers for non-text uploads without exposing raw base64', async () => {
    const emit = vi.fn();
    const close = vi.fn();
    const pdfBytes = '%PDF-1.7 fake binary payload';
    const answer = [
      {
        name: 'source-architecture.pdf',
        size: pdfBytes.length,
        type: 'application/pdf',
        content: Buffer.from(pdfBytes, 'utf-8').toString('base64'),
      },
    ];
    const answeredSession = makeCollectFileSession([
      {
        name: 'source-architecture.pdf',
        size: pdfBytes.length,
        type: 'application/pdf',
        contentStored: true,
      },
    ]);
    let runTurnInput: { userInput?: string } | null = null;

    getByIdMock.mockReset();
    getByIdMock
      .mockResolvedValueOnce(makeCollectFileSession())
      .mockResolvedValueOnce(answeredSession)
      .mockResolvedValueOnce(answeredSession);
    createProductionTurnEngineMock.mockResolvedValue({
      engine: {
        runTurn: async function* (input: { userInput?: string }) {
          runTurnInput = input;
          yield { type: 'turn_ended', reason: 'complete' };
        },
      },
      toolRegistry: {
        listByNames: () => [],
        subset: () => ({ list: () => [], get: () => undefined }),
      },
    });

    await processMessage(
      ctx,
      makeCollectFileSession() as never,
      {
        sessionId: 'session-1',
        type: 'tool_answer',
        toolCallId: 'tool-file-1',
        answer,
      },
      emit,
      close,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      processMessageDeps,
    );

    expect(setToolResultMock).toHaveBeenCalledWith(ctx, 'session-1', 'tool-file-1', [
      expect.objectContaining({
        name: 'source-architecture.pdf',
        contentStored: true,
      }),
    ]);
    expect(runTurnInput?.userInput).toContain('[Uploaded file: source-architecture.pdf]');
    expect(runTurnInput?.userInput).toContain(
      'Content for source-architecture.pdf is not available as readable text.',
    );
    expect(runTurnInput?.userInput).not.toContain(answer[0]!.content);
    expect(close).toHaveBeenCalledOnce();
  });
});
