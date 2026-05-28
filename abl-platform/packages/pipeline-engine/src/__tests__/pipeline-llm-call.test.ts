import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateVercelProvider = vi.fn(() => ({ provider: 'mock-model' }));
const mockGenerateText = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock('@agent-platform/llm', () => ({
  createVercelProvider: (...args: unknown[]) => mockCreateVercelProvider(...args),
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('mongoose', () => ({
  default: { connection: { readyState: 1 } },
  connection: { readyState: 1 },
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        pii_redaction: { enabled: true, redact_input: true, redact_output: true },
      }),
    }),
  },
  PIIPattern: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

const { pipelineGenerateText } = await import('../pipeline/services/pipeline-llm-call.js');

describe('pipelineGenerateText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoggerInfo.mockClear();
    mockGenerateText.mockResolvedValue({
      text: 'Guardrail check passed',
      usage: { inputTokens: 24, outputTokens: 12 },
    });
  });

  it('passes provider authConfig through to createVercelProvider', async () => {
    await expect(
      pipelineGenerateText(
        {
          provider: 'azure',
          modelId: 'azure/gpt-4o-mini',
          apiKey: 'sk-azure',
          baseUrl: 'https://tenant-azure.example.com/openai',
          authConfig: {
            resourceName: 'tenant-azure-openai',
            deploymentId: 'gpt-4o-mini-prod',
            apiVersion: '2024-10-21',
          },
          source: 'tenant',
        },
        {
          system: 'Check the response',
          messages: [{ role: 'user', content: 'Score this sample' }],
        },
        {
          service: 'pipeline-eval',
          tenantId: 'tenant-1',
          sessionId: 'session-1',
        },
      ),
    ).resolves.toEqual({
      content: 'Guardrail check passed',
      inputTokens: 24,
      outputTokens: 12,
      model: 'azure/gpt-4o-mini',
    });

    expect(mockCreateVercelProvider).toHaveBeenCalledWith(
      'azure',
      'sk-azure',
      'https://tenant-azure.example.com/openai',
      'azure/gpt-4o-mini',
      undefined,
      {
        resourceName: 'tenant-azure-openai',
        deploymentId: 'gpt-4o-mini-prod',
        apiVersion: '2024-10-21',
      },
    );
  });

  it('renders raw prompt PII through the pipeline LLM boundary before generateText', async () => {
    await pipelineGenerateText(
      {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test',
        source: 'tenant',
      },
      {
        system: 'Do not reveal john.doe@gmail.com',
        messages: [{ role: 'user', content: 'Score john.doe@gmail.com' }],
      },
      {
        service: 'pipeline-eval',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
    );

    const request = mockGenerateText.mock.calls[0][0];
    expect(request.system).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(request.messages[0].content).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(JSON.stringify(request)).not.toContain('john.doe@gmail.com');
  });

  it('renders raw model output PII before logging or returning it to downstream steps', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Evaluation mentions jane.doe@gmail.com',
      usage: { inputTokens: 24, outputTokens: 12 },
    });

    const result = await pipelineGenerateText(
      {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test',
        source: 'tenant',
      },
      {
        system: 'Evaluate safely',
        messages: [{ role: 'user', content: 'Score this sample' }],
      },
      {
        service: 'pipeline-eval',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
    );

    expect(result.content).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(result.content).not.toContain('jane.doe@gmail.com');

    const outputLog = mockLoggerInfo.mock.calls.find((call) => call[0] === 'LLM call — output');
    expect(outputLog).toBeDefined();
    expect(JSON.stringify(outputLog)).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(JSON.stringify(outputLog)).not.toContain('jane.doe@gmail.com');
  });
});
