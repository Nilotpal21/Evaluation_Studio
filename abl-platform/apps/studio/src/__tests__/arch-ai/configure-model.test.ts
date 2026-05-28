import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { checkToolPermissionMock, getModelRecommendationMock, projectAgentFindOneMock } = vi.hoisted(
  () => ({
    checkToolPermissionMock: vi.fn(),
    getModelRecommendationMock: vi.fn(),
    projectAgentFindOneMock: vi.fn(),
  }),
);

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../lib/arch-ai/guards', () => ({
  checkToolPermission: checkToolPermissionMock,
  isDangerousAction: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/arch-ai/helpers/get-model-recommendation', () => ({
  getModelRecommendation: getModelRecommendationMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    findOne: projectAgentFindOneMock,
  },
}));

import {
  ensureProjectModelConfig,
  executeConfigureModel,
} from '@/lib/arch-ai/tools/configure-model';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('configure_model project model creation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    checkToolPermissionMock.mockReset();
    getModelRecommendationMock.mockReset();
    projectAgentFindOneMock.mockReset();
    checkToolPermissionMock.mockResolvedValue({ allowed: true });
    getModelRecommendationMock.mockReturnValue({
      primary: {
        model: 'complex-model',
        provider: 'openai',
        reason: 'Complex tool use',
      },
      executionConfig: {
        temperature: 0.2,
        maxTokens: 4000,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves tenant model tier when Arch AI creates a project model config', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/models?projectId=')) {
        return Promise.resolve(jsonResponse({ models: [] }));
      }

      if (url.endsWith('/api/tenant-models')) {
        return Promise.resolve(
          jsonResponse({
            models: [
              {
                id: 'tm-voice-1',
                modelId: 'gpt-4o-realtime-preview-2025-06-03',
                provider: 'openai',
                tier: 'voice',
                isActive: true,
                inferenceEnabled: true,
                connections: [{ id: 'conn-1' }],
                supportsTools: true,
                supportsVision: false,
                supportsStreaming: true,
                contextWindow: 128000,
              },
            ],
          }),
        );
      }

      if (url.endsWith('/api/models') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'mc-voice-1' }, 201));
      }

      return Promise.resolve(jsonResponse({}, 404));
    });

    const result = await ensureProjectModelConfig(
      { projectId: 'proj-1', tenantId: 'tenant-1', authToken: 'token-1' },
      'gpt-4o-realtime-preview-2025-06-03',
      'openai',
    );

    expect(result).toEqual({ success: true });

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/models') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      tenantModelId: 'tm-voice-1',
      tier: 'voice',
    });
  });

  it('derives recommendations from dslContent tools instead of a missing ProjectAgent tools field', async () => {
    projectAgentFindOneMock.mockResolvedValue({
      name: 'LeadIntake',
      dslContent: `AGENT: LeadIntake
GOAL: "Qualify inbound leads"

TOOLS:
  lookup_lead(email: string) -> object
  enrich_company(domain: string) -> object
  score_lead(lead_id: string) -> object
  create_crm_task(lead_id: string) -> object
  notify_sales_owner(lead_id: string) -> object
`,
    });
    fetchMock.mockResolvedValue(
      jsonResponse({
        defaultModel: 'simple-model',
        operationModels: null,
        temperature: 0.7,
        maxTokens: 1000,
        hyperParameters: null,
        useResponsesApi: null,
        useStreaming: null,
      }),
    );

    const result = await executeConfigureModel(
      { action: 'diff', agentName: 'LeadIntake' },
      {
        projectId: 'proj-1',
        authToken: 'token-1',
        user: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permissions: ['agent:read'],
        },
      },
      'proj-1',
    );

    expect(result.success).toBe(true);
    expect(getModelRecommendationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'reasoning',
        requiresToolCalling: true,
        complexityTier: 'complex',
      }),
    );
  });
});
