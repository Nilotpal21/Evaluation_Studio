/**
 * Lambda Deploy Trigger Tests
 *
 * Tests the Studio-side singleton that deploys Lambda runners directly
 * via LambdaDeploymentService (no Runtime HTTP call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// HOISTED MOCKS
// =============================================================================

const { mockGetRedisClient, mockEnsureRunnerDeployed } = vi.hoisted(() => ({
  mockGetRedisClient: vi.fn().mockReturnValue(null),
  mockEnsureRunnerDeployed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
}));

vi.mock('@abl/compiler', () => ({
  NODEJS_RUNNER_HANDLER_TEMPLATE: 'mock-nodejs-handler',
  NODEJS_MEMORY_MANAGER_TEMPLATE: 'mock-nodejs-memory-manager',
  PYTHON_RUNNER_HANDLER_TEMPLATE: 'mock-python-handler',
}));

vi.mock('@agent-platform/shared/services/lambda', () => {
  const MockLambdaDeploymentService = vi.fn(function (this: any) {
    this.ensureRunnerDeployed = mockEnsureRunnerDeployed;
  }) as any;
  const MockRedisLambdaDeploymentStore = vi.fn(function (this: any) {
    // empty mock store
  }) as any;
  return {
    LambdaDeploymentService: MockLambdaDeploymentService,
    RedisLambdaDeploymentStore: MockRedisLambdaDeploymentStore,
  };
});

// =============================================================================
// IMPORT MODULE UNDER TEST
// =============================================================================

import {
  triggerLambdaDeployment,
  _resetLambdaDeployTrigger,
} from '@/services/lambda-deploy-trigger';

// =============================================================================
// TESTS
// =============================================================================

describe('triggerLambdaDeployment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetLambdaDeployTrigger();
    delete process.env.LAMBDA_RUNNER_ROLE_ARN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('does nothing when Redis is unavailable', async () => {
    mockGetRedisClient.mockReturnValue(null);
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';

    await triggerLambdaDeployment('tenant-1', 'javascript');

    expect(mockEnsureRunnerDeployed).not.toHaveBeenCalled();
  });

  it('does nothing when LAMBDA_RUNNER_ROLE_ARN is not set', async () => {
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });

    await triggerLambdaDeployment('tenant-1', 'javascript');

    expect(mockEnsureRunnerDeployed).not.toHaveBeenCalled();
  });

  it('calls ensureRunnerDeployed when configured', async () => {
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';

    await triggerLambdaDeployment('tenant-1', 'javascript');

    expect(mockEnsureRunnerDeployed).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('defaults runtime to javascript', async () => {
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';

    await triggerLambdaDeployment('tenant-1');

    expect(mockEnsureRunnerDeployed).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('passes python runtime correctly', async () => {
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';

    await triggerLambdaDeployment('tenant-2', 'python');

    expect(mockEnsureRunnerDeployed).toHaveBeenCalledWith('tenant-2', 'python');
  });

  it('does not throw when ensureRunnerDeployed rejects', async () => {
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';
    mockEnsureRunnerDeployed.mockRejectedValue(new Error('IAM role not found'));

    // Should not throw — fire-and-forget semantics
    await expect(triggerLambdaDeployment('tenant-1', 'javascript')).resolves.toBeUndefined();
  });

  it('reuses singleton service on repeated calls', async () => {
    const { LambdaDeploymentService } = await import('@agent-platform/shared/services/lambda');
    mockGetRedisClient.mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn(), keys: vi.fn() });
    process.env.LAMBDA_RUNNER_ROLE_ARN = 'arn:aws:iam::123:role/test';

    await triggerLambdaDeployment('tenant-1', 'javascript');
    await triggerLambdaDeployment('tenant-1', 'javascript');

    // Service constructor should only be called once (singleton)
    expect(LambdaDeploymentService).toHaveBeenCalledTimes(1);
  });
});
