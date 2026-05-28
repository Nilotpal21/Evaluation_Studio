/**
 * Lambda Deployment Trigger
 *
 * Fire-and-forget trigger for per-tenant Lambda runner deployment.
 * Called from Studio API routes when sandbox tools are created/updated.
 * Deploys directly via LambdaDeploymentService (no runtime HTTP call).
 */

import {
  LambdaDeploymentService,
  RedisLambdaDeploymentStore,
} from '@agent-platform/shared/services/lambda';
import {
  NODEJS_RUNNER_HANDLER_TEMPLATE,
  NODEJS_MEMORY_MANAGER_TEMPLATE,
  PYTHON_RUNNER_HANDLER_TEMPLATE,
} from '@abl/compiler/platform/constructs/executors/lambda-handler-templates.js';
import { getRedisClient } from '@/lib/redis-client';

let _service: LambdaDeploymentService | null = null;

function getService(): LambdaDeploymentService | null {
  if (_service) return _service;

  const redis = getRedisClient();
  const roleArn = process.env.LAMBDA_RUNNER_ROLE_ARN;
  if (!redis || !roleArn) return null;

  _service = new LambdaDeploymentService({
    store: new RedisLambdaDeploymentStore(redis),
    region: process.env.LAMBDA_RUNNER_REGION || 'us-east-1',
    roleArn,
    memoryMb: parseInt(process.env.LAMBDA_RUNNER_MEMORY_MB || '256', 10),
    timeoutSec: parseInt(process.env.LAMBDA_RUNNER_TIMEOUT_SEC || '120', 10),
    nodeLayerArn: process.env.LAMBDA_RUNNER_NODE_LAYER_ARN,
    pythonLayerArn: process.env.LAMBDA_RUNNER_PYTHON_LAYER_ARN,
    deployTimeoutMs: parseInt(process.env.LAMBDA_RUNNER_DEPLOY_TIMEOUT_MS || '60000', 10),
    handlerTemplates: {
      nodejsRunnerHandler: NODEJS_RUNNER_HANDLER_TEMPLATE,
      nodejsMemoryManager: NODEJS_MEMORY_MANAGER_TEMPLATE,
      pythonRunnerHandler: PYTHON_RUNNER_HANDLER_TEMPLATE,
    },
  });
  return _service;
}

export async function triggerLambdaDeployment(
  tenantId: string,
  runtime: 'javascript' | 'python' = 'javascript',
): Promise<void> {
  const service = getService();
  if (!service) {
    console.warn(
      '[lambda-deploy] Service not configured (Redis or LAMBDA_RUNNER_ROLE_ARN missing)',
    );
    return;
  }
  try {
    await service.ensureRunnerDeployed(tenantId, runtime);
  } catch (err) {
    console.error(
      '[lambda-deploy] deployment failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Test helper — reset singleton state */
export function _resetLambdaDeployTrigger(): void {
  _service = null;
}
