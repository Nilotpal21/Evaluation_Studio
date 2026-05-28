import { describe, expect, it, vi } from 'vitest';
import {
  ActionTestConfigError,
  ActionTestNotFoundError,
  ActionTestService,
  type ActionTestDeps,
} from '../services/action-test-service.js';
import { DESIGN_TIME_TEST_TIMEOUT_MS, MAX_SAMPLE_PAYLOAD_BYTES } from '../constants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIntegrationNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node-1',
    nodeType: 'integration',
    config: {
      connectorId: 'slack',
      actionName: 'send_message',
      connectionId: 'conn-abc',
      ...overrides,
    },
  };
}

function makeDeps(overrides: Partial<ActionTestDeps> = {}): ActionTestDeps {
  const mockAction = {
    props: [
      { name: 'channel', required: true, displayName: 'Channel' },
      { name: 'text', required: false, displayName: 'Text' },
    ],
    run: vi.fn().mockResolvedValue({ ts: '123.456', ok: true }),
  };
  const mockRegistry = {
    getAction: vi.fn().mockResolvedValue(mockAction),
  };
  const mockConnection = { id: 'conn-abc', connectorName: 'slack', scope: 'user' };
  const mockConnectionResolver = {
    resolve: vi.fn().mockResolvedValue({ connection: mockConnection, scope: 'user' }),
    resolveAuth: vi.fn().mockResolvedValue({ accessToken: 'tok-test' }),
  };
  const mockWorkflowModel = {
    findOne: vi.fn().mockResolvedValue({
      _id: 'wf-1',
      nodes: [makeIntegrationNode()],
    }),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
  };
  return {
    registry: mockRegistry as unknown as ActionTestDeps['registry'],
    connectionResolver: mockConnectionResolver as unknown as ActionTestDeps['connectionResolver'],
    workflowModel: mockWorkflowModel,
    ...overrides,
  };
}

const baseInput = {
  workflowId: 'wf-1',
  nodeId: 'node-1',
  tenantId: 't-1',
  projectId: 'p-1',
  params: { channel: '#general', text: 'hello' },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ActionTestService.testAction', () => {
  it('throws ActionTestNotFoundError when workflow is not found', async () => {
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue(null),
        findOneAndUpdate: vi.fn(),
      },
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction(baseInput)).rejects.toBeInstanceOf(ActionTestNotFoundError);
  });

  it('throws ActionTestNotFoundError when node is not found in workflow', async () => {
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', nodes: [] }),
        findOneAndUpdate: vi.fn(),
      },
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction(baseInput)).rejects.toBeInstanceOf(ActionTestNotFoundError);
  });

  it('throws ActionTestConfigError for non-integration node type', async () => {
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [{ id: 'node-1', nodeType: 'function', config: {} }],
        }),
        findOneAndUpdate: vi.fn(),
      },
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction(baseInput)).rejects.toBeInstanceOf(ActionTestConfigError);
  });

  it('throws ActionTestConfigError when connectionId is missing', async () => {
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [makeIntegrationNode({ connectionId: '' })],
        }),
        findOneAndUpdate: vi.fn(),
      },
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction({ ...baseInput, connectionId: undefined })).rejects.toBeInstanceOf(
      ActionTestConfigError,
    );
  });

  it('throws ActionTestNotFoundError when connector action is unknown', async () => {
    const deps = makeDeps({
      registry: {
        getAction: vi.fn().mockResolvedValue(null),
      } as unknown as ActionTestDeps['registry'],
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction(baseInput)).rejects.toBeInstanceOf(ActionTestNotFoundError);
  });

  it('throws ActionTestConfigError when a required param is missing', async () => {
    const deps = makeDeps();
    const svc = new ActionTestService(deps);
    await expect(
      svc.testAction({ ...baseInput, params: { text: 'no channel' } }),
    ).rejects.toBeInstanceOf(ActionTestConfigError);
  });

  it('returns output and persists sampleOutput on happy path', async () => {
    const persistSpy = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', nodes: [makeIntegrationNode()] }),
        findOneAndUpdate: persistSpy,
      },
    });
    const svc = new ActionTestService(deps);
    const result = await svc.testAction(baseInput);

    expect(result.output).toEqual({ ts: '123.456', ok: true });
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'wf-1', tenantId: 't-1', projectId: 'p-1' }),
      expect.objectContaining({
        $set: expect.objectContaining({ 'nodes.$.config.sampleOutput': expect.any(String) }),
      }),
    );
  });

  it('encrypts sampleOutput before persisting when encryptField is provided', async () => {
    const encryptFn = vi.fn().mockImplementation((v: string) => Promise.resolve(`enc:${v}`));
    const persistSpy = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', nodes: [makeIntegrationNode()] }),
        findOneAndUpdate: persistSpy,
      },
      encryptField: encryptFn,
    });
    const svc = new ActionTestService(deps);
    await svc.testAction(baseInput);

    expect(encryptFn).toHaveBeenCalledWith(expect.any(String), 't-1');
    const storedValue = (persistSpy.mock.calls[0][1] as Record<string, unknown>)['$set'] as Record<
      string,
      unknown
    >;
    expect((storedValue['nodes.$.config.sampleOutput'] as string).startsWith('enc:')).toBe(true);
  });

  it('enforces tenant+project isolation (findOne scoped to tenantId+projectId)', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      workflowModel: { findOne, findOneAndUpdate: vi.fn() },
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction(baseInput)).rejects.toBeInstanceOf(ActionTestNotFoundError);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't-1', projectId: 'p-1' }),
    );
  });

  it('truncates output exceeding MAX_SAMPLE_PAYLOAD_BYTES and stores truncation marker', async () => {
    const bigOutput = { data: 'x'.repeat(MAX_SAMPLE_PAYLOAD_BYTES + 100) };
    const mockAction = {
      props: [],
      run: vi.fn().mockResolvedValue(bigOutput),
    };
    const persistSpy = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      registry: {
        getAction: vi.fn().mockResolvedValue(mockAction),
      } as unknown as ActionTestDeps['registry'],
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [makeIntegrationNode({ connectorId: 'test', actionName: 'run' })],
        }),
        findOneAndUpdate: persistSpy,
      },
    });
    const svc = new ActionTestService(deps);
    // Big output without required params is fine since mockAction has empty props
    const result = await svc.testAction({ ...baseInput, params: {} });
    // The returned output is the real connector output (not truncated in response)
    expect((result.output as Record<string, unknown>).data).toBeDefined();
    // But the persisted value should be the truncation marker
    const persisted = (persistSpy.mock.calls[0][1] as Record<string, unknown>)['$set'] as Record<
      string,
      unknown
    >;
    const stored = persisted['nodes.$.config.sampleOutput'] as string;
    expect(stored).toContain('_truncated');
  });

  it('returns output even when persistence fails', async () => {
    const deps = makeDeps({
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', nodes: [makeIntegrationNode()] }),
        findOneAndUpdate: vi.fn().mockRejectedValue(new Error('DB failure')),
      },
    });
    const svc = new ActionTestService(deps);
    const result = await svc.testAction(baseInput);
    expect(result.output).toEqual({ ts: '123.456', ok: true });
  });
});

describe('ActionTestService.testAction — F-3: fileWriter wiring', () => {
  it('passes fileWriter from fileWriterFactory into the ActionContext', async () => {
    const fakeWriter = vi.fn().mockResolvedValue('https://wf.example/attachments/123?token=t');
    const capturedCtx: Record<string, unknown> = {};

    const attachmentAction = {
      props: [],
      run: vi.fn().mockImplementation(async (ctx: unknown) => {
        Object.assign(capturedCtx, ctx as Record<string, unknown>);
        return { downloaded: true };
      }),
    };

    const deps = makeDeps({
      registry: {
        getAction: vi.fn().mockResolvedValue(attachmentAction),
      } as unknown as ActionTestDeps['registry'],
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [makeIntegrationNode({ connectorId: 'gmail', actionName: 'find_email' })],
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
      fileWriterFactory: (_tenantId: string) => fakeWriter,
    });

    const svc = new ActionTestService(deps);
    await svc.testAction({ ...baseInput, params: {} });

    expect(capturedCtx['fileWriter']).toBe(fakeWriter);
  });

  it('does not set fileWriter in ActionContext when fileWriterFactory is not provided', async () => {
    const capturedCtx: Record<string, unknown> = {};

    const attachmentAction = {
      props: [],
      run: vi.fn().mockImplementation(async (ctx: unknown) => {
        Object.assign(capturedCtx, ctx as Record<string, unknown>);
        return { downloaded: true };
      }),
    };

    const deps = makeDeps({
      registry: {
        getAction: vi.fn().mockResolvedValue(attachmentAction),
      } as unknown as ActionTestDeps['registry'],
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [makeIntegrationNode({ connectorId: 'gmail', actionName: 'find_email' })],
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });

    const svc = new ActionTestService(deps);
    await svc.testAction({ ...baseInput, params: {} });

    expect(capturedCtx['fileWriter']).toBeUndefined();
  });
});

describe('ActionTestService.testAction — timeout', () => {
  it('rejects with a timeout error when connector action exceeds the timeout', async () => {
    const hangingAction = {
      props: [],
      run: vi.fn().mockImplementation(() => new Promise<never>(() => {})),
    };
    const deps = makeDeps({
      registry: {
        getAction: vi.fn().mockResolvedValue(hangingAction),
      } as unknown as ActionTestDeps['registry'],
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          nodes: [makeIntegrationNode({ connectorId: 'test', actionName: 'run' })],
        }),
        findOneAndUpdate: vi.fn(),
      },
      // 1 ms timeout so the test completes instantly
      _testTimeoutMs: 1,
    });
    const svc = new ActionTestService(deps);
    await expect(svc.testAction({ ...baseInput, params: {} })).rejects.toThrow(/timed out/i);
  });
});
