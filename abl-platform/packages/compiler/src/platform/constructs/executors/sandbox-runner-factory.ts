/**
 * Sandbox Runner Factory
 *
 * Creates the appropriate SandboxRunner based on SANDBOX_BACKEND config.
 * Strategy pattern: gvisor → GvisorSandboxRunner, lambda → LambdaSandboxRunner.
 */

import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { SandboxRunner } from './sandbox-tool-executor.js';
import { GvisorSandboxRunner } from './gvisor-sandbox-runner.js';
import type {
  GvisorSandboxConfig,
  GvisorSessionContext,
  JwtSigner,
} from './gvisor-sandbox-runner.js';
import { LambdaSandboxRunner } from './lambda-sandbox-runner.js';
import type { LambdaSandboxConfig, LambdaDeploymentStore } from './lambda-sandbox-runner.js';
import { MockSandboxRunner } from './mock-sandbox-runner.js';
import { NoOpSandboxRunner } from './noop-sandbox-runner.js';
import { createLogger } from '../../logger.js';

const log = createLogger('sandbox-runner-factory');

export interface SandboxRunnerConfig {
  gvisor: GvisorSandboxConfig;
  lambda: LambdaSandboxConfig;
  deploymentStore?: LambdaDeploymentStore;
  lambdaClient?: LambdaClient;
}

export function createSandboxRunner(
  backend: 'gvisor' | 'lambda' | 'mock',
  config: SandboxRunnerConfig,
  sessionContext?: GvisorSessionContext,
  jwtSigner?: JwtSigner,
): SandboxRunner {
  if (backend === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      log.error(
        'SANDBOX_BACKEND=mock in production — using NoOpSandboxRunner. Set SANDBOX_BACKEND to gvisor or lambda.',
      );
      return new NoOpSandboxRunner();
    }
    return new MockSandboxRunner(sessionContext);
  }

  if (backend === 'gvisor') {
    return new GvisorSandboxRunner(config.gvisor, sessionContext, jwtSigner);
  }

  if (backend === 'lambda') {
    if (!config.deploymentStore) {
      throw new Error('LambdaDeploymentStore required when SANDBOX_BACKEND=lambda');
    }
    if (!config.lambdaClient) {
      throw new Error('LambdaClient required when SANDBOX_BACKEND=lambda');
    }
    return new LambdaSandboxRunner(
      config.lambda,
      config.deploymentStore,
      config.lambdaClient,
      sessionContext,
      jwtSigner,
    );
  }

  throw new Error(`Unknown SANDBOX_BACKEND: "${backend}"`);
}
