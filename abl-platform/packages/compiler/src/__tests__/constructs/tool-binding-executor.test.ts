import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DNS-pinning safeFetch to delegate to globalThis.fetch so tests
// that stub `globalThis.fetch` continue to work without requiring real DNS.
const mockSafeFetch = vi.hoisted(() => vi.fn());
const mockAssertUrlSafeForFetch = vi.hoisted(() => vi.fn());
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-platform/shared-kernel/security/safe-fetch')>();
  return {
    ...actual,
    assertUrlSafeForFetch: mockAssertUrlSafeForFetch,
    safeFetch: mockSafeFetch,
  };
});
beforeEach(() => {
  mockAssertUrlSafeForFetch.mockReset().mockResolvedValue(undefined);
  mockSafeFetch
    .mockReset()
    .mockImplementation((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init));
});

import { ToolBindingExecutor } from '../../platform/constructs/executors/tool-binding-executor.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';
import type {
  McpClientProvider,
  McpClient,
} from '../../platform/constructs/executors/mcp-tool-executor.js';
import type { SandboxRunner } from '../../platform/constructs/executors/sandbox-tool-executor.js';
import type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';
import type { ToolExecutor } from '../../platform/constructs/types.js';

const defaultHints = {
  cacheable: false,
  latency: 'medium' as const,
  parallelizable: false,
  side_effects: true,
  requires_auth: false,
};

function getHeaderValue(
  headers: RequestInit['headers'] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers ?? {}).get(name) ?? undefined;
}

const mcpTool: ToolDefinition = {
  name: 'mcp_tool',
  description: 'MCP tool',
  parameters: [],
  returns: { type: 'object' },
  hints: defaultHints,
  tool_type: 'mcp',
  mcp_binding: { server: 'test-server', tool: 'test_tool' },
};

const sandboxTool: ToolDefinition = {
  name: 'sandbox_tool',
  description: 'Sandbox tool',
  parameters: [],
  returns: { type: 'object' },
  hints: defaultHints,
  tool_type: 'sandbox',
  sandbox_binding: { runtime: 'javascript', code_content: 'function run() {}' },
};

const contractTool: ToolDefinition = {
  name: 'contract_tool',
  description: 'Contract-only tool',
  parameters: [],
  returns: { type: 'string' },
  hints: defaultHints,
};

describe('ToolBindingExecutor', () => {
  const secrets: SecretsProvider = { getSecret: vi.fn().mockResolvedValue(undefined) };

  it('should route MCP tool to McpToolExecutor', async () => {
    const mockClient: McpClient = { callTool: vi.fn().mockResolvedValue({ data: 'mcp-result' }) };
    const mcpClients: McpClientProvider = { getClient: vi.fn().mockResolvedValue(mockClient) };

    const executor = new ToolBindingExecutor({
      tools: [mcpTool],
      secrets,
      mcpClients,
    });

    const result = await executor.execute('mcp_tool', {}, 5000);
    expect(result).toEqual({ data: 'mcp-result' });
    expect(mcpClients.getClient).toHaveBeenCalledWith('test-server', undefined);
  });

  it('should route Sandbox tool to SandboxToolExecutor', async () => {
    const sandboxRunner: SandboxRunner = { run: vi.fn().mockResolvedValue({ score: 42 }) };

    const executor = new ToolBindingExecutor({
      tools: [sandboxTool],
      secrets,
      sandboxRunner,
    });

    const result = await executor.execute('sandbox_tool', {}, 5000);
    expect(result).toEqual({ score: 42 });
    expect(sandboxRunner.run).toHaveBeenCalled();
  });

  it('should use fallback executor for contract-only tools', async () => {
    const fallback: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('fallback-result'),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
    });

    const result = await executor.execute('contract_tool', {}, 5000);
    expect(result).toBe('fallback-result');
    expect(fallback.execute).toHaveBeenCalledWith('contract_tool', {}, 5000);
  });

  it('should throw for unknown tool without fallback', async () => {
    const executor = new ToolBindingExecutor({ tools: [], secrets });
    await expect(executor.execute('unknown', {}, 5000)).rejects.toThrow('Tool not found');
  });

  it('should throw for contract-only tool without fallback', async () => {
    const executor = new ToolBindingExecutor({ tools: [contractTool], secrets });
    await expect(executor.execute('contract_tool', {}, 5000)).rejects.toThrow('fallbackExecutor');
  });

  it('should execute parallel calls', async () => {
    const fallback: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('ok'),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
    });

    const results = await executor.executeParallel(
      [
        { name: 'contract_tool', params: { a: 1 } },
        { name: 'contract_tool', params: { b: 2 } },
      ],
      5000,
    );

    expect(results).toHaveLength(2);
    expect(results[0].result).toBe('ok');
    expect(results[1].result).toBe('ok');
  });

  it('should capture errors in parallel execution', async () => {
    const fallback: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('fail')),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
    });

    const results = await executor.executeParallel([{ name: 'contract_tool', params: {} }], 5000);

    expect(results[0].error).toContain('fail');
  });

  it('should reject null value for required parameter without default', async () => {
    const tool: ToolDefinition = {
      name: 'test_tool',
      description: 'Test',
      parameters: [{ name: 'required_field', type: 'string', required: true }],
      returns: { type: 'string' },
      hints: defaultHints,
    };
    const fallback: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('ok'),
      executeParallel: vi.fn(),
    };
    const executor = new ToolBindingExecutor({
      tools: [tool],
      secrets,
      fallbackExecutor: fallback,
    });

    await expect(executor.execute('test_tool', { required_field: null }, 5000)).rejects.toThrow(
      "missing required parameter 'required_field'",
    );
  });

  it('should allow null for optional parameter', async () => {
    const tool: ToolDefinition = {
      name: 'test_tool',
      description: 'Test',
      parameters: [{ name: 'optional_field', type: 'string', required: false }],
      returns: { type: 'string' },
      hints: defaultHints,
    };
    const fallback: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('ok'),
      executeParallel: vi.fn(),
    };
    const executor = new ToolBindingExecutor({
      tools: [tool],
      secrets,
      fallbackExecutor: fallback,
    });

    const result = await executor.execute('test_tool', { optional_field: null }, 5000);
    expect(result).toBe('ok');
  });

  it('should throw descriptive error for lambda tool type', async () => {
    const lambdaTool: ToolDefinition = {
      name: 'lambda_tool',
      description: 'Lambda tool',
      parameters: [],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'lambda',
    };
    const executor = new ToolBindingExecutor({ tools: [lambdaTool], secrets });

    await expect(executor.execute('lambda_tool', {}, 5000)).rejects.toThrow(
      'Lambda tool execution not yet implemented',
    );
  });

  it('should propagate callerContext through middleware metadata', async () => {
    const fallback: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('result'),
      executeParallel: vi.fn(),
    };

    let capturedMetadata: Record<string, unknown> | undefined;
    const spyMiddleware = async (ctx: any, next: any) => {
      capturedMetadata = ctx.metadata;
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [spyMiddleware],
      sessionContext: {
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        callerContext: {
          channel: 'voice',
          channelId: 'ch-123',
          identityTier: 2,
          verificationMethod: 'otp',
          contactId: 'contact-456',
          customerId: 'cust-789',
          sourceIp: '10.0.0.1',
          userAgent: 'ABL-SDK/1.0',
        },
      },
    });

    await executor.execute('contract_tool', {}, 5000);

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.sessionId).toBe('sess-1');
    expect(capturedMetadata!.tenantId).toBe('tenant-1');
    expect(capturedMetadata!.userId).toBe('user-1');
    const cc = capturedMetadata!.callerContext as any;
    expect(cc.channel).toBe('voice');
    expect(cc.channelId).toBe('ch-123');
    expect(cc.identityTier).toBe(2);
    expect(cc.verificationMethod).toBe('otp');
    expect(cc.contactId).toBe('contact-456');
    expect(cc.customerId).toBe('cust-789');
    expect(cc.sourceIp).toBe('10.0.0.1');
    expect(cc.userAgent).toBe('ABL-SDK/1.0');
  });

  it('should propagate workflow version metadata through middleware metadata', async () => {
    const workflowTool: ToolDefinition = {
      name: 'workflow_tool',
      description: 'Workflow tool',
      parameters: [],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'workflow',
      workflow_binding: {
        workflowId: 'wf-123',
        workflowVersionId: 'wfv-456',
        triggerId: 'trigger-789',
        mode: 'sync',
        paramMapping: {},
      },
    };
    const workflowToolExecutor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue({ status: 'completed' }),
      executeParallel: vi.fn(),
    };

    let capturedMetadata: Record<string, unknown> | undefined;
    const spyMiddleware = async (ctx: ToolCallContext, next: ToolMiddlewareNext) => {
      capturedMetadata = ctx.metadata;
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [workflowTool],
      secrets,
      workflowToolExecutor,
      middleware: [spyMiddleware],
      sessionContext: {
        workflowToolVersions: {
          workflow_tool: {
            workflowId: 'wf-123',
            workflowVersion: 'v2.0.0',
          },
        },
      },
    });

    await executor.execute('workflow_tool', {}, 5000);

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata).toMatchObject({
      workflow_id: 'wf-123',
      workflow_version_id: 'wfv-456',
      workflow_version: 'v2.0.0',
    });
  });

  it('should fall back to binding workflowVersion when session resolution metadata is absent', async () => {
    const workflowTool: ToolDefinition = {
      name: 'workflow_tool',
      description: 'Workflow tool',
      parameters: [],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'workflow',
      workflow_binding: {
        workflowId: 'wf-123',
        workflowVersion: 'v4.1.0',
        triggerId: 'trigger-789',
        mode: 'sync',
        paramMapping: {},
      },
    };
    const workflowToolExecutor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue({ status: 'completed' }),
      executeParallel: vi.fn(),
    };

    let capturedMetadata: Record<string, unknown> | undefined;
    const spyMiddleware = async (ctx: ToolCallContext, next: ToolMiddlewareNext) => {
      capturedMetadata = ctx.metadata;
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [workflowTool],
      secrets,
      workflowToolExecutor,
      middleware: [spyMiddleware],
      sessionContext: {
        workflowToolVersions: {
          workflow_tool: {
            workflowId: 'wf-123',
          },
        },
      },
    });

    await executor.execute('workflow_tool', {}, 5000);

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata).toMatchObject({
      workflow_id: 'wf-123',
      workflow_version: 'v4.1.0',
    });
  });

  it('resolves config-backed workflow binding timeout before dispatch', async () => {
    const workflowTool: ToolDefinition = {
      name: 'workflow_tool',
      description: 'Workflow tool',
      parameters: [],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'workflow',
      workflow_binding: {
        workflowId: 'wf-123',
        triggerId: 'trigger-789',
        mode: 'sync',
        paramMapping: {},
        timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
      } as unknown as ToolDefinition['workflow_binding'],
    };
    const workflowToolExecutor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue({ status: 'completed' }),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [workflowTool],
      secrets: {
        ...secrets,
        getConfigVar: vi.fn().mockResolvedValue('2500'),
      },
      workflowToolExecutor,
    });

    await executor.execute('workflow_tool', {}, 30_000);

    expect(workflowToolExecutor.execute).toHaveBeenCalledWith('workflow_tool', {}, 2500);
  });

  it('should execute HTTP tools with middleware-patched bindings', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: async () => JSON.stringify({ ok: true }),
      body: undefined,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const httpTool: ToolDefinition = {
        name: 'http_tool',
        description: 'HTTP tool',
        parameters: [],
        returns: { type: 'object' },
        hints: defaultHints,
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com/data',
          method: 'GET',
          headers: {},
          auth: { type: 'none' },
        },
      };

      const patchAuthHeader = async (
        ctx: ToolCallContext,
        next: (nextCtx: ToolCallContext) => Promise<ToolCallResult>,
      ): Promise<ToolCallResult> => {
        const tool = ctx.tool;
        if (!tool?.http_binding) {
          return next(ctx);
        }

        return next({
          ...ctx,
          tool: {
            ...tool,
            http_binding: {
              ...tool.http_binding,
              headers: {
                ...(tool.http_binding.headers ?? {}),
                Authorization: 'Bearer patched-token',
              },
            },
          },
        });
      };

      const executor = new ToolBindingExecutor({
        tools: [httpTool],
        secrets,
        middleware: [patchAuthHeader],
      });

      await executor.execute('http_tool', {}, 5000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe('https://api.example.com/data');
      expect(getHeaderValue(init.headers, 'Authorization')).toBe('Bearer patched-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should dispatch SOAP protocol tools through HttpToolExecutor (no protocol-aware dispatch)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: async () => JSON.stringify({ result: 'soap-ok' }),
      body: undefined,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const soapTool: ToolDefinition = {
        name: 'soap_lookup',
        description: 'SOAP tool via HTTP binding',
        parameters: [{ name: 'policy_id', type: 'string', required: true }],
        returns: { type: 'object' },
        hints: defaultHints,
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://soap.example.com/policy',
          method: 'POST',
          auth: { type: 'none' },
          protocol: 'soap',
          soap_version: '1.1',
          soap_action: 'http://example.com/LookupPolicy',
          on_soap_fault: 'error',
        },
      };

      const executor = new ToolBindingExecutor({
        tools: [soapTool],
        secrets,
      });

      const result = await executor.execute('soap_lookup', { policy_id: 'P123' }, 5000);
      // SOAP tools dispatch through the same HTTP executor as REST tools
      expect(result).toEqual({ result: 'soap-ok' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://soap.example.com/policy');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
