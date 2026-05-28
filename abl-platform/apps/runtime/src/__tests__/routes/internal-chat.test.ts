import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceTokenPayload } from '@agent-platform/shared-auth';

const mockExecutor = {
  isConfigured: vi.fn(),
  getSession: vi.fn(),
  rehydrateSession: vi.fn(),
  createSessionFromResolved: vi.fn(),
  executeMessage: vi.fn(),
};
const mockCompileToResolvedAgent = vi.fn();
const mockCompileProjectWorkingCopy = vi.fn();
const mockFindProjectWithAgents = vi.fn();
const mockFindProjectRuntimeConfig = vi.fn();
const mockResolveProjectEntryAgentName = vi.fn();
const mockEvaluateProjectExecutionReadiness = vi.fn();

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: () => mockExecutor,
  compileToResolvedAgent: (...args: unknown[]) => mockCompileToResolvedAgent(...args),
}));

vi.mock('../../services/project-working-copy-compiler.js', () => ({
  buildProjectWorkingCopyAgentSources: (agents: Array<Record<string, unknown>>) =>
    agents
      .filter(
        (agent): agent is { name: string; dslContent: string; systemPromptLibraryRef?: unknown } =>
          typeof agent.name === 'string' && typeof agent.dslContent === 'string',
      )
      .map((agent) => ({
        name: agent.name,
        dslContent: agent.dslContent,
        systemPromptLibraryRef:
          agent.systemPromptLibraryRef &&
          typeof agent.systemPromptLibraryRef === 'object' &&
          typeof (agent.systemPromptLibraryRef as { promptId?: unknown }).promptId === 'string' &&
          typeof (agent.systemPromptLibraryRef as { versionId?: unknown }).versionId === 'string'
            ? {
                promptId: (agent.systemPromptLibraryRef as { promptId: string }).promptId,
                versionId: (agent.systemPromptLibraryRef as { versionId: string }).versionId,
              }
            : null,
      })),
  compileProjectWorkingCopy: (...args: unknown[]) => mockCompileProjectWorkingCopy(...args),
  extractSearchInstructionsFromDsl: () => new Map(),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectWithAgents: (...args: unknown[]) => mockFindProjectWithAgents(...args),
  findProjectRuntimeConfig: (...args: unknown[]) => mockFindProjectRuntimeConfig(...args),
  resolveProjectEntryAgentName: (...args: unknown[]) => mockResolveProjectEntryAgentName(...args),
}));

vi.mock('../../services/session/project-agent-dsl-readiness.js', () => ({
  buildProjectDslReadinessError: vi.fn(
    () =>
      'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
  ),
  evaluateProjectExecutionReadiness: (...args: unknown[]) =>
    mockEvaluateProjectExecutionReadiness(...args),
}));

vi.mock('../../services/execution/localized-messages.js', () => ({
  buildSessionLocalizationCatalog: vi.fn(() => ({})),
  storeRuntimeSessionLocalizationCatalog: vi.fn(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import internalChatRouter from '../../routes/internal-chat.js';

const serviceToken: ServiceTokenPayload = {
  sub: 'service:pipeline-engine',
  email: 'pipeline-engine@internal.service',
  type: 'service',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  serviceName: 'pipeline-engine',
};

function createApp(token: ServiceTokenPayload = serviceToken) {
  const app = express();
  app.use(express.json());
  app.use(
    (req: Request & { serviceToken?: ServiceTokenPayload }, _res: Response, next: NextFunction) => {
      req.serviceToken = token;
      next();
    },
  );
  app.use('/api/internal/chat', internalChatRouter);
  return app;
}

describe('internal chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor.isConfigured.mockReturnValue(true);
    mockExecutor.getSession.mockReturnValue(undefined);
    mockExecutor.rehydrateSession.mockResolvedValue(null);
    mockResolveProjectEntryAgentName.mockReturnValue('AgentOne');
    mockFindProjectRuntimeConfig.mockResolvedValue(null);
    mockEvaluateProjectExecutionReadiness.mockImplementation(async ({ agents }) => ({
      executableAgents: agents,
      blockedAgents: [],
      hasBlockingErrors: false,
      issues: [],
    }));
    mockCompileToResolvedAgent.mockReturnValue({ entryAgent: 'AgentOne' });
    mockCompileProjectWorkingCopy.mockResolvedValue({
      resolved: { entryAgent: 'AgentOne' },
      configVariables: {},
      warnings: [],
      documents: [],
      profileDocuments: [],
    });
  });

  it('returns 404 and skips execution when a resumed session is outside token scope', async () => {
    mockExecutor.getSession.mockReturnValue({
      id: 'session-1',
      tenantId: 'tenant-2',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      sessionId: 'session-1',
      message: 'hello',
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'SESSION_NOT_FOUND' },
    });
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  it('applies eval session variables from testContext before the first internal turn', async () => {
    const createdSession = {
      id: 'session-new',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        onChunk: (chunk: string) => void,
      ): Promise<{ response: string; action: { type: string } }> => {
        expect(createdSession.data.values).toMatchObject({ customerTier: 'gold' });
        onChunk('ok');
        return { response: '', action: { type: 'complete' } };
      },
    );

    const response = await request(createApp())
      .post('/api/internal/chat/agent')
      .send({
        projectId: 'project-1',
        message: 'hello',
        testContext: {
          sessionVariables: { customerTier: 'gold' },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        sessionId: 'session-new',
        response: 'ok',
        sessionEnded: true,
      },
    });
  });

  it('passes synthetic knownSource from eval runtime requests into session creation', async () => {
    const createdSession = {
      id: 'session-synthetic',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      knownSource: 'synthetic',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'ok',
      action: { type: 'continue' },
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
      knownSource: 'synthetic',
    });

    expect(response.status).toBe(200);
    expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ knownSource: 'synthetic' }),
    );
  });

  it('does not end eval conversations for normal continued agent_exit lifecycle events', async () => {
    const createdSession = {
      id: 'session-continued',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        onChunk: (chunk: string) => void,
        onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void,
      ): Promise<{ response: string; action: { type: string } }> => {
        onChunk('Would you prefer a replacement or refund?');
        onTraceEvent({
          type: 'agent_exit',
          data: {
            agentName: 'AgentOne',
            result: 'continue',
            terminalAction: 'continue',
            responseDisposition: 'continued',
          },
        });
        return { response: '', action: { type: 'continue' } };
      },
    );

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'My order is late',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        sessionId: 'session-continued',
        response: 'Would you prefer a replacement or refund?',
        action: 'continue',
        sessionEnded: false,
      },
    });
  });

  it('resolves agentId by agent name (eval-scenario contract)', async () => {
    const createdSession = {
      id: 'session-by-name',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'FourLeaf_Router',
          dslContent: 'agent FourLeaf_Router',
        },
      ],
    });
    mockCompileProjectWorkingCopy.mockResolvedValue({
      resolved: { entryAgent: 'FourLeaf_Router' },
      configVariables: {},
      warnings: [],
      documents: [],
      profileDocuments: [],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'ok',
      action: { type: 'continue' },
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      agentId: 'FourLeaf_Router',
      message: 'hello',
    });

    expect(response.status).toBe(200);
    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith(
      expect.objectContaining({ entryAgentName: 'FourLeaf_Router' }),
    );
    expect(mockResolveProjectEntryAgentName).not.toHaveBeenCalled();
  });

  it('returns 404 AGENT_NOT_FOUND when agentId matches no _id, id, or name', async () => {
    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      agentId: 'does-not-exist',
      message: 'hello',
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'AGENT_NOT_FOUND' },
    });
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  it('renders inline trace events through the PII read boundary', async () => {
    const createdSession = {
      id: 'session-trace-boundary',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        onChunk: (chunk: string) => void,
        onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void,
      ): Promise<{ response: string; action: { type: string } }> => {
        onChunk('ok');
        onTraceEvent({
          type: 'tool_call',
          data: {
            response: 'Email jane.doe@example.com',
            requestHeaders: { authorization: 'Bearer internal-secret-token' },
          },
        });
        return { response: '', action: { type: 'complete' } };
      },
    );

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
    });

    const serializedTraceEvents = JSON.stringify(response.body.data.traceEvents);
    expect(response.status).toBe(200);
    expect(serializedTraceEvents).toContain('[REDACTED_EMAIL]');
    expect(serializedTraceEvents).not.toContain('jane.doe@example.com');
    expect(serializedTraceEvents).not.toContain('internal-secret-token');
  });

  it('blocks working-copy internal chat before compile when execution readiness fails', async () => {
    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
          dslValidationStatus: 'valid',
        },
      ],
    });
    mockFindProjectRuntimeConfig.mockResolvedValue({
      extraction: { nlu_provider: 'advanced' },
    });
    mockEvaluateProjectExecutionReadiness.mockResolvedValue({
      executableAgents: [],
      blockedAgents: [],
      hasBlockingErrors: true,
      issues: [{ kind: 'runtime_config', diagnostics: [] }],
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'PROJECT_DSL_NOT_READY',
        message:
          'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
      },
      issues: [{ kind: 'runtime_config', diagnostics: [] }],
    });
    expect(mockFindProjectRuntimeConfig).toHaveBeenCalledWith('project-1', 'tenant-1');
    expect(mockCompileProjectWorkingCopy).not.toHaveBeenCalled();
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
  });

  it('uses the canonical project working-copy compiler for persisted agent metadata', async () => {
    const createdSession = {
      id: 'session-library-ref',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
          systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'compiled',
      action: { type: 'continue' },
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
    });

    expect(response.status).toBe(200);
    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entryAgentName: 'AgentOne',
      agents: [
        {
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
          systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
        },
      ],
    });
  });

  it('surfaces responseMetadata from runtime execution for internal consumers', async () => {
    const createdSession = {
      id: 'session-provenance',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: { customerTier: 'gold' },
    };

    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'mixed' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'AI-generated answer',
      action: { type: 'continue' },
      responseMetadata,
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        sessionId: 'session-provenance',
        response: 'AI-generated answer',
        responseMetadata,
        state: { customerTier: 'gold' },
      },
    });
  });

  it('surfaces structured runtime output for internal consumers', async () => {
    const createdSession = {
      id: 'session-structured-output',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: { customerTier: 'gold' },
    };
    const richContent = { markdown: '**Choose a card**' };
    const actions = {
      elements: [{ type: 'button', id: 'card_9876', label: 'Platinum Rewards' }],
    };
    const voiceConfig = { plain_text: 'Choose a card.' };
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'cards.choose',
    };

    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'AgentOne',
      agents: [
        {
          _id: 'agent-1',
          id: 'agent-1',
          name: 'AgentOne',
          dslContent: 'agent AgentOne',
        },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue(createdSession);
    mockExecutor.getSession.mockReturnValue(createdSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Choose a card.',
      action: { type: 'continue' },
      richContent,
      actions,
      voiceConfig,
      localization,
    });

    const response = await request(createApp()).post('/api/internal/chat/agent').send({
      projectId: 'project-1',
      message: 'hello',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        sessionId: 'session-structured-output',
        response: 'Choose a card.',
        richContent,
        actions,
        voiceConfig,
        localization,
        contentEnvelope: {
          version: 2,
          format: 'message_envelope',
          text: 'Choose a card.',
          richContent,
          actions,
          voiceConfig,
          localization,
        },
        outcome: {
          status: 'ok',
          usedFallback: false,
        },
      },
    });
  });
});
