import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyPlatformAccessToken, type ServiceTokenPayload } from '@agent-platform/shared-auth';
import internalToolsRouter from '../internal-tools.js';
import type { InternalServiceRequest } from '../../middleware/internal-service-auth.js';

const mockLoadProjectToolsAsIR = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();
const mockToolBindingExecutorExecute = vi.fn();
const mockToolBindingExecutorConfigs: Array<Record<string, unknown>> = [];
const mockSearchAIExecutorConfigs: Array<Record<string, unknown>> = [];
const mockSearchAIRegisterBinding = vi.fn();
const mockWorkflowExecutorConfigs: Array<Record<string, unknown>> = [];
const mockWorkflowRegisterBinding = vi.fn();
const mockResolveWorkflowToolVersionMetadata = vi.fn();

vi.mock('../../tools/load-project-tools-as-ir.js', () => ({
  loadProjectToolsAsIR: (...args: unknown[]) => mockLoadProjectToolsAsIR(...args),
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: (...args: unknown[]) => mockLoadConfigVariablesMap(...args),
}));

vi.mock('@abl/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler')>();
  return {
    ...actual,
    ToolBindingExecutor: class ToolBindingExecutor {
      constructor(config: Record<string, unknown>) {
        mockToolBindingExecutorConfigs.push(config);
      }

      execute(...args: unknown[]) {
        return mockToolBindingExecutorExecute(...args);
      }
    },
  };
});

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsByProject: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/search-ai/searchai-kb-tool-executor.js', () => ({
  SearchAIKBToolExecutor: class SearchAIKBToolExecutor {
    constructor(config: Record<string, unknown>) {
      mockSearchAIExecutorConfigs.push(config);
    }

    registerBinding(...args: unknown[]) {
      return mockSearchAIRegisterBinding(...args);
    }
  },
}));

vi.mock('../../services/workflow/workflow-tool-executor.js', () => ({
  WorkflowToolExecutor: class WorkflowToolExecutor {
    constructor(config: Record<string, unknown>) {
      mockWorkflowExecutorConfigs.push(config);
    }

    registerBinding(...args: unknown[]) {
      return mockWorkflowRegisterBinding(...args);
    }
  },
}));

vi.mock('../../services/workflow/workflow-tool-version-metadata.js', () => ({
  resolveWorkflowToolVersionMetadata: (...args: unknown[]) =>
    mockResolveWorkflowToolVersionMetadata(...args),
}));

vi.mock('../../config/loader.js', () => ({
  getConfig: () => ({ jwt: { secret: 'j'.repeat(64) } }),
}));

function buildApp(serviceToken: ServiceTokenPayload) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as InternalServiceRequest).serviceToken = serviceToken;
    next();
  });
  app.use('/api/internal/tools', internalToolsRouter);
  return app;
}

describe('internal tools project scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToolBindingExecutorConfigs.length = 0;
    mockSearchAIExecutorConfigs.length = 0;
    mockWorkflowExecutorConfigs.length = 0;
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockResolveWorkflowToolVersionMetadata.mockResolvedValue({});
    mockToolBindingExecutorExecute.mockResolvedValue({ ok: true });
  });

  it('rejects tenant-scoped service tokens before loading project tools', async () => {
    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app).post('/api/internal/tools/execute').send({
      projectId: 'project-1',
      toolName: 'lookup_ticket',
      params: {},
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Service token must carry a projectId for project-scoped operations',
      },
    });
    expect(mockLoadProjectToolsAsIR).not.toHaveBeenCalled();
  });

  it('rejects project id mismatches before loading project tools', async () => {
    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-token',
      serviceName: 'workflow-engine',
    });

    const response = await request(app).post('/api/internal/tools/execute').send({
      projectId: 'project-body',
      toolName: 'lookup_ticket',
      params: {},
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      code: 'FORBIDDEN',
      message: 'Project ID mismatch with service token',
    });
    expect(mockLoadProjectToolsAsIR).not.toHaveBeenCalled();
  });

  it('returns sanitized execution errors without leaking internal details to Studio', async () => {
    mockLoadProjectToolsAsIR.mockRejectedValue(
      new Error(
        'workflow executor failed at http://workflow-engine.internal tenant-1 project-1 with token hint',
      ),
    );
    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app).post('/api/internal/tools/execute').send({
      projectId: 'project-1',
      toolName: 'lookup_ticket',
      params: {},
    });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: 'Tool execution failed. Check the tool configuration and try again.',
      },
    });
    expect(response.body.error.message).not.toContain('workflow-engine.internal');
    expect(response.body.error.message).not.toContain('tenant-1');
    expect(response.body.error.message).not.toContain('project-1');
  });

  it('mints workflow-engine auth with the execution actor user id for workflow tools', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'testing',
          description: 'Workflow tool',
          tool_type: 'workflow',
          parameters: [],
          workflow_binding: {
            workflowId: 'wf-1',
            triggerId: 'trg-1',
            mode: 'sync',
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app).post('/api/internal/tools/execute').send({
      projectId: 'project-1',
      toolName: 'testing',
      params: {},
      actorUserId: 'user-123',
    });

    expect(response.status).toBe(200);
    expect(mockWorkflowExecutorConfigs).toHaveLength(1);
    const authToken = mockWorkflowExecutorConfigs[0].authToken;
    expect(typeof authToken).toBe('string');
    const payload = verifyPlatformAccessToken(String(authToken), 'j'.repeat(64));
    expect(payload?.sub).toBe('user-123');
    expect(payload?.tenantId).toBe('tenant-1');
  });

  it('passes completion callback metadata into the workflow tool executor', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'testing',
          description: 'Workflow tool',
          tool_type: 'workflow',
          parameters: [],
          workflow_binding: {
            workflowId: 'wf-1',
            triggerId: 'trg-1',
            mode: 'sync',
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'testing',
        params: {},
        callback: {
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
          secret: 'callback-secret-1',
        },
      });

    expect(response.status).toBe(200);
    expect(mockWorkflowExecutorConfigs[0].triggerType).toBe('workflow');
    expect(mockWorkflowExecutorConfigs[0].completionCallback).toEqual({
      url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
      secret: 'callback-secret-1',
    });
  });

  it('rejects async wait mode for unsupported tool types', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'search_support',
          description: 'Search support KB',
          tool_type: 'searchai',
          parameters: [],
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'search_support',
        params: {},
        executionMode: 'async_wait',
        callback: {
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
          secret: 'callback-secret-1',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'TOOL_CALLBACK_UNSUPPORTED',
      message: 'Async tool execution is currently supported only for workflow and HTTP tools.',
    });
  });

  it('defaults blank callback injection keys for async wait HTTP tools', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'notify_customer',
          description: 'Notify customer',
          tool_type: 'http',
          parameters: [],
          http_binding: {
            method: 'POST',
            endpoint: 'https://api.example.com/jobs',
            auth: { type: 'none' },
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'notify_customer',
        params: {},
        executionMode: 'async_wait',
        callbackConfig: {
          enabled: true,
          location: 'body',
          callbackUrlKey: '',
          callbackSecretKey: 'callbackSecret',
        },
        callback: {
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
          secret: 'callback-secret-1',
        },
      });

    expect(response.status).toBe(200);
    expect(mockToolBindingExecutorExecute).toHaveBeenCalledWith(
      'notify_customer',
      {},
      30000,
      expect.objectContaining({
        executionMode: 'async_wait',
        callbackConfig: {
          enabled: true,
          location: 'body',
          callbackUrlKey: 'callbackUrl',
          callbackSecretKey: 'callbackSecret',
        },
      }),
    );
  });

  it('rejects disabled callback injection config for async wait HTTP tools', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'notify_customer',
          description: 'Notify customer',
          tool_type: 'http',
          parameters: [],
          http_binding: {
            method: 'POST',
            endpoint: 'https://api.example.com/jobs',
            auth: { type: 'none' },
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'notify_customer',
        params: {},
        executionMode: 'async_wait',
        callbackConfig: {
          enabled: false,
          location: 'body',
          callbackUrlKey: 'callbackUrl',
          callbackSecretKey: 'callbackSecret',
        },
        callback: {
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
          secret: 'callback-secret-1',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'TOOL_CALLBACK_CONFIG_INVALID',
      message:
        'Async HTTP tool execution requires enabled callback injection with URL and secret keys.',
    });
  });

  it('rejects async_continue for HTTP tools with TOOL_EXECUTION_MODE_UNSUPPORTED', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'notify_customer',
          description: 'Notify customer',
          tool_type: 'http',
          parameters: [],
          http_binding: {
            method: 'POST',
            endpoint: 'https://api.example.com/jobs',
            auth: { type: 'none' },
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'notify_customer',
        params: { customerId: 'cust-1' },
        executionMode: 'async_continue',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'TOOL_EXECUTION_MODE_UNSUPPORTED',
      message:
        'HTTP tools support sync and async_wait execution modes only. Use async_wait to have the tool call back on completion.',
    });
  });

  it('normalizes async accepted workflow tool results without callback config for async_continue', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'notify_customer',
          description: 'Notify customer',
          tool_type: 'workflow',
          parameters: [],
          workflow_binding: {
            workflowId: 'wf-1',
            triggerId: 'trg-1',
            mode: 'async',
          },
        },
      ],
    });
    mockToolBindingExecutorExecute.mockResolvedValue({
      executionId: 'exec-1',
      status: 'running',
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'notify_customer',
        params: { customerId: 'cust-1' },
        executionMode: 'async_continue',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        success: true,
      },
    });
  });

  it('preserves scoped runtime config fields and passes namespace-scoped secrets to executor', async () => {
    mockLoadConfigVariablesMap.mockResolvedValue({ HTTP_TIMEOUT_MS: '7000' });
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'lookup_ticket',
          description: 'Lookup ticket',
          tool_type: 'http',
          parameters: [],
          variable_namespace_ids: ['ns-tools'],
          http_binding: {
            method: 'GET',
            endpoint: 'https://api.example.com/tickets',
            timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'lookup_ticket',
        params: { id: 'T-1' },
      });

    expect(response.status).toBe(200);
    expect(mockLoadConfigVariablesMap).toHaveBeenCalledWith('project-1', 'tenant-1');
    expect(mockToolBindingExecutorConfigs).toHaveLength(1);
    expect(mockToolBindingExecutorConfigs[0].tools).toEqual([
      expect.objectContaining({
        name: 'lookup_ticket',
        variable_namespace_ids: ['ns-tools'],
        http_binding: expect.objectContaining({ timeout_ms: '{{config.HTTP_TIMEOUT_MS}}' }),
      }),
    ]);
    expect(mockToolBindingExecutorConfigs[0].namespaceScopedSecretsFactory).toEqual(
      expect.any(Function),
    );
  });

  it('resolves unscoped runtime config fields before executor construction', async () => {
    mockLoadConfigVariablesMap.mockResolvedValue({ HTTP_TIMEOUT_MS: '7000' });
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'lookup_ticket',
          description: 'Lookup ticket',
          tool_type: 'http',
          parameters: [],
          http_binding: {
            method: 'GET',
            endpoint: 'https://api.example.com/tickets',
            timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:workflow-engine',
      email: 'workflow-engine@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'workflow-engine',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'lookup_ticket',
        params: { id: 'T-1' },
      });

    expect(response.status).toBe(200);
    expect(mockToolBindingExecutorConfigs[0].tools).toEqual([
      expect.objectContaining({
        name: 'lookup_ticket',
        http_binding: expect.objectContaining({ timeout_ms: 7000 }),
      }),
    ]);
  });

  it('registers concrete SearchAI bindings with the runtime SearchAI executor', async () => {
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'search_support',
          description: 'Search support KB',
          tool_type: 'searchai',
          parameters: [{ name: 'query', type: 'string', required: true }],
          searchai_binding: {
            tenantId: 'tenant-1',
            indexId: 'idx-support',
          },
        },
      ],
    });

    const app = buildApp({
      sub: 'service:studio',
      email: 'studio@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'studio-tool-test',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'search_support',
        params: { query: 'refund policy' },
      });

    expect(response.status).toBe(200);
    expect(mockSearchAIExecutorConfigs).toEqual([
      expect.objectContaining({
        runtimeUrl: expect.any(String),
        authToken: expect.any(String),
      }),
    ]);
    expect(mockSearchAIRegisterBinding).toHaveBeenCalledWith('search_support', {
      tenantId: 'tenant-1',
      indexId: 'idx-support',
    });
    expect(mockToolBindingExecutorConfigs[0].searchaiToolExecutor).toEqual(expect.any(Object));
    expect(mockToolBindingExecutorExecute).toHaveBeenCalledWith(
      'search_support',
      { query: 'refund policy' },
      30000,
      expect.objectContaining({ executionMode: 'sync' }),
    );
  });

  it('registers workflow version pins and param mapping with the runtime workflow executor', async () => {
    const workflowBinding = {
      workflowId: 'wf-support',
      workflowVersionId: 'version-123',
      workflowVersion: 'v2.0.0',
      triggerId: 'tr-open-ticket',
      mode: 'sync',
      timeoutMs: 45000,
      paramMapping: {
        summary: '$.summary',
        priority: '$.metadata.priority',
      },
    };
    mockLoadProjectToolsAsIR.mockResolvedValue({
      tools: [
        {
          name: 'open_ticket',
          description: 'Open ticket',
          tool_type: 'workflow',
          parameters: [
            { name: 'summary', type: 'string', required: true, description: 'Ticket summary' },
            { name: 'metadata', type: 'object', required: false },
          ],
          workflow_binding: workflowBinding,
        },
      ],
    });
    mockResolveWorkflowToolVersionMetadata.mockResolvedValue({
      open_ticket: {
        workflowId: 'wf-support',
        workflowVersionId: 'version-123',
        workflowVersion: 'v2.0.0',
      },
    });

    const app = buildApp({
      sub: 'service:studio',
      email: 'studio@internal',
      type: 'service',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      serviceName: 'studio-tool-test',
    });

    const response = await request(app)
      .post('/api/internal/tools/execute')
      .send({
        projectId: 'project-1',
        toolName: 'open_ticket',
        params: { summary: 'Printer offline', metadata: { priority: 'high' } },
      });

    expect(response.status).toBe(200);
    expect(mockResolveWorkflowToolVersionMetadata).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      tools: [expect.objectContaining({ name: 'open_ticket', workflow_binding: workflowBinding })],
    });
    expect(mockWorkflowExecutorConfigs).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        sessionId: 'internal-tool-open_ticket',
        resolvedWorkflowVersions: {
          open_ticket: {
            workflowId: 'wf-support',
            workflowVersionId: 'version-123',
            workflowVersion: 'v2.0.0',
          },
        },
      }),
    ]);
    expect(mockWorkflowRegisterBinding).toHaveBeenCalledWith(
      'open_ticket',
      workflowBinding,
      expect.objectContaining({
        name: 'open_ticket',
        triggerMode: 'sync',
        inputVariables: [
          { name: 'summary', type: 'string', required: true, description: 'Ticket summary' },
          { name: 'metadata', type: 'json', required: false },
        ],
      }),
    );
    expect(mockToolBindingExecutorConfigs[0].workflowToolExecutor).toEqual(expect.any(Object));
    expect(mockToolBindingExecutorExecute).toHaveBeenCalledWith(
      'open_ticket',
      { summary: 'Printer offline', metadata: { priority: 'high' } },
      30000,
      expect.objectContaining({ executionMode: 'sync' }),
    );
  });
});
