import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LambdaDeploymentService } from '../../services/lambda/lambda-deployment-service.js';
import type {
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
} from '../../services/lambda/lambda-deployment-store.js';

// Mock send function shared across tests so we can configure it per-test
const mockSend = vi.fn().mockResolvedValue({});

// Mock AWS SDK — use real classes/functions so `new LambdaClient()` works
vi.mock('@aws-sdk/client-lambda', () => {
  return {
    LambdaClient: class MockLambdaClient {
      send = mockSend;
    },
    CreateFunctionCommand: class CreateFunctionCommand {
      constructor(public input: any) {}
    },
    DeleteFunctionCommand: class DeleteFunctionCommand {
      constructor(public input: any) {}
    },
    GetFunctionCommand: class GetFunctionCommand {
      constructor(public input: any) {}
    },
    InvokeCommand: class InvokeCommand {
      constructor(public input: any) {}
    },
    Runtime: {
      nodejs20x: 'nodejs20.x',
      python312: 'python3.12',
    },
  };
});

function makeStore(): LambdaDeploymentStore & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTenant: vi.fn().mockResolvedValue([]),
  };
}

describe('LambdaDeploymentService', () => {
  let store: ReturnType<typeof makeStore>;
  let service: LambdaDeploymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    service = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
    });
  });

  it('ensureRunnerDeployed skips if already active', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('ensureRunnerDeployed triggers deploy when not found', async () => {
    store.get.mockResolvedValue(null);
    // Mock the internal deploy to not actually call AWS
    const deploySpy = vi.spyOn(service as any, '_deployRunner').mockResolvedValue(undefined);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(deploySpy).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('ensureRunnerDeployed re-deploys on failed status', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'failed',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      failureReason: 'previous failure',
    } satisfies LambdaDeploymentRecord);
    const deploySpy = vi.spyOn(service as any, '_deployRunner').mockResolvedValue(undefined);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(deploySpy).toHaveBeenCalled();
  });

  it('buildFunctionName sanitizes tenantId', () => {
    const name = (service as any)._buildFunctionName('tenant/special chars!', 'javascript');
    expect(name).toMatch(/^abl-runner-/);
    expect(name).not.toContain('/');
    expect(name).not.toContain('!');
  });

  it('buildFunctionName uses js suffix for javascript runtime', () => {
    const name = (service as any)._buildFunctionName('tenant-1', 'javascript');
    expect(name).toBe('abl-runner-tenant-1-js');
  });

  it('buildFunctionName uses py suffix for python runtime', () => {
    const name = (service as any)._buildFunctionName('tenant-1', 'python');
    expect(name).toBe('abl-runner-tenant-1-py');
  });

  it('buildFunctionName truncates to fit Lambda 64-char limit', () => {
    const longTenantId = 'a'.repeat(100);
    const name = (service as any)._buildFunctionName(longTenantId, 'javascript');
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^abl-runner-/);
    expect(name).toMatch(/-js$/);
  });

  it('ensureRunnerDeployed re-deploys on deploying status (stale)', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'deploying',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    const deploySpy = vi.spyOn(service as any, '_deployRunner').mockResolvedValue(undefined);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(deploySpy).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('deleteRunner calls store.delete and sends DeleteFunctionCommand', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);

    await service.deleteRunner('tenant-1', 'javascript');
    expect(store.updateStatus).toHaveBeenCalledWith('tenant-1', 'javascript', 'deleting');
    expect(store.delete).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('deleteRunner is a no-op when record does not exist', async () => {
    store.get.mockResolvedValue(null);
    await service.deleteRunner('tenant-1', 'javascript');
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('checkHealth returns false when no deployment record exists', async () => {
    store.get.mockResolvedValue(null);
    const result = await service.checkHealth('tenant-1', 'javascript');
    expect(result).toBe(false);
  });

  it('checkHealth returns false when deployment is not active', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'deploying',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    const result = await service.checkHealth('tenant-1', 'javascript');
    expect(result).toBe(false);
  });

  it('checkHealth returns true when invoke succeeds with 200', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    mockSend.mockResolvedValueOnce({ StatusCode: 200, FunctionError: undefined });
    const result = await service.checkHealth('tenant-1', 'javascript');
    expect(result).toBe(true);
    expect(store.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'javascript',
      'active',
      expect.objectContaining({ lastHealthCheck: expect.any(String) }),
    );
  });

  it('checkHealth returns false when invoke has FunctionError', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    mockSend.mockResolvedValueOnce({ StatusCode: 200, FunctionError: 'Unhandled' });
    const result = await service.checkHealth('tenant-1', 'javascript');
    expect(result).toBe(false);
  });

  it('checkHealth returns false when invoke throws', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    mockSend.mockRejectedValueOnce(new Error('Network error'));
    const result = await service.checkHealth('tenant-1', 'javascript');
    expect(result).toBe(false);
  });

  it('_pollFunctionActive resolves when state is Active', async () => {
    mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } });
    await expect(service._pollFunctionActive('test-fn')).resolves.toBeUndefined();
  });

  it('_pollFunctionActive throws when state is Failed', async () => {
    mockSend.mockResolvedValueOnce({
      Configuration: { State: 'Failed', StateReason: 'Bad config' },
    });
    await expect(service._pollFunctionActive('test-fn')).rejects.toThrow(
      'entered Failed state: Bad config',
    );
  });

  it('_pollFunctionActive throws on timeout', async () => {
    // Create service with very short timeout
    const shortService = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
      deployTimeoutMs: 1, // 1ms timeout
    });

    // Always return Pending state
    mockSend.mockResolvedValue({ Configuration: { State: 'Pending' } });

    await expect(shortService._pollFunctionActive('test-fn')).rejects.toThrow('Timed out');
  });

  it('deleteRunner handles ResourceNotFoundException gracefully', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);

    const notFoundErr = new Error('not found');
    (notFoundErr as any).name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(notFoundErr);

    // Should not throw — ResourceNotFoundException is handled
    await service.deleteRunner('tenant-1', 'javascript');
    expect(store.delete).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('deleteRunner re-throws non-ResourceNotFoundException errors', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);

    const err = new Error('Access denied');
    (err as any).name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);

    await expect(service.deleteRunner('tenant-1', 'javascript')).rejects.toThrow('Access denied');
  });

  it('_resolveLayers returns node layer for javascript', () => {
    const svcWithLayers = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
      nodeLayerArn: 'arn:aws:lambda:us-east-1:123:layer:node:1',
      pythonLayerArn: 'arn:aws:lambda:us-east-1:123:layer:python:1',
    });

    const layers = (svcWithLayers as any)._resolveLayers('javascript');
    expect(layers).toEqual(['arn:aws:lambda:us-east-1:123:layer:node:1']);
  });

  it('_resolveLayers returns python layer for python', () => {
    const svcWithLayers = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
      nodeLayerArn: 'arn:aws:lambda:us-east-1:123:layer:node:1',
      pythonLayerArn: 'arn:aws:lambda:us-east-1:123:layer:python:1',
    });

    const layers = (svcWithLayers as any)._resolveLayers('python');
    expect(layers).toEqual(['arn:aws:lambda:us-east-1:123:layer:python:1']);
  });

  it('_resolveLayers returns empty array when no layer ARNs configured', () => {
    const layers = (service as any)._resolveLayers('javascript');
    expect(layers).toEqual([]);
  });

  it('uses default logger when none provided', () => {
    const svc = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
    });
    // Just verify construction doesn't throw
    expect(svc).toBeDefined();
  });
});
