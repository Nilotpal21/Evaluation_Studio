import { describe, it, expect, vi } from 'vitest';
import { createSandboxRunner } from '../../platform/constructs/executors/sandbox-runner-factory.js';
import { GvisorSandboxRunner } from '../../platform/constructs/executors/gvisor-sandbox-runner.js';
import { LambdaSandboxRunner } from '../../platform/constructs/executors/lambda-sandbox-runner.js';
import { MockSandboxRunner } from '../../platform/constructs/executors/mock-sandbox-runner.js';

// Mock AWS SDK for LambdaSandboxRunner — must use `function` (not arrow) so `new` works
vi.mock('@aws-sdk/client-lambda', () => {
  const MockLambdaClient = vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn();
  });
  const MockInvokeCommand = vi.fn().mockImplementation(function (this: any, input: any) {
    this.input = input;
  });
  return { LambdaClient: MockLambdaClient, InvokeCommand: MockInvokeCommand };
});

const gvisorConfig = {
  pythonPodUrl: 'http://python-svc',
  javascriptPodUrl: 'http://js-svc',
  podPath: '/execute-script',
};
const lambdaConfig = {
  region: 'us-east-1',
  memoryApiBaseUrl: 'https://api.test.com',
  healthTtlMs: 300000,
};
const session = { tenantId: 'tenant-1' };
const mockStore = {
  get: vi.fn(),
  upsert: vi.fn(),
  updateStatus: vi.fn(),
  delete: vi.fn(),
  listByTenant: vi.fn(),
};
const mockLambdaClient = { send: vi.fn() };

describe('createSandboxRunner', () => {
  it('returns GvisorSandboxRunner for gvisor backend', () => {
    const runner = createSandboxRunner(
      'gvisor',
      { gvisor: gvisorConfig, lambda: lambdaConfig },
      session,
    );
    expect(runner).toBeInstanceOf(GvisorSandboxRunner);
  });

  it('returns LambdaSandboxRunner for lambda backend', () => {
    const runner = createSandboxRunner(
      'lambda',
      {
        gvisor: gvisorConfig,
        lambda: lambdaConfig,
        deploymentStore: mockStore,
        lambdaClient: mockLambdaClient as any,
      },
      session,
    );
    expect(runner).toBeInstanceOf(LambdaSandboxRunner);
  });

  it('throws when lambda backend has no deploymentStore', () => {
    expect(() =>
      createSandboxRunner(
        'lambda',
        { gvisor: gvisorConfig, lambda: lambdaConfig, lambdaClient: mockLambdaClient as any },
        session,
      ),
    ).toThrow('LambdaDeploymentStore');
  });

  it('throws when lambda backend has no lambdaClient', () => {
    expect(() =>
      createSandboxRunner(
        'lambda',
        { gvisor: gvisorConfig, lambda: lambdaConfig, deploymentStore: mockStore },
        session,
      ),
    ).toThrow('LambdaClient');
  });

  it('returns MockSandboxRunner for mock backend', () => {
    const runner = createSandboxRunner(
      'mock',
      { gvisor: gvisorConfig, lambda: lambdaConfig },
      session,
    );
    expect(runner).toBeInstanceOf(MockSandboxRunner);
  });

  it('throws for unknown backend', () => {
    expect(() =>
      createSandboxRunner('docker' as any, { gvisor: gvisorConfig, lambda: lambdaConfig }, session),
    ).toThrow('Unknown SANDBOX_BACKEND');
  });
});
