/**
 * kubectl Operations for Benchmark Orchestrator
 *
 * Provides scale-down, restore, resource inspection, and pod-readiness
 * operations for Kubernetes deployments.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const DEFAULT_ROLLOUT_TIMEOUT_MS = 120_000;

export interface PodResources {
  cpu: string;
  memory: string;
}

/**
 * Scale a deployment down to 1 replica and wait for the rollout to complete.
 */
export async function scaleDown(deploymentName: string, namespace: string): Promise<void> {
  await execFile('kubectl', [
    'scale',
    'deployment',
    deploymentName,
    '--replicas=1',
    '-n',
    namespace,
  ]);

  await execFile(
    'kubectl',
    ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace, '--timeout=120s'],
    { timeout: DEFAULT_ROLLOUT_TIMEOUT_MS + 5_000 },
  );
}

/**
 * Restore a deployment to its original replica count.
 */
export async function restoreReplicas(
  deploymentName: string,
  replicas: number,
  namespace: string,
): Promise<void> {
  await execFile('kubectl', [
    'scale',
    'deployment',
    deploymentName,
    `--replicas=${replicas}`,
    '-n',
    namespace,
  ]);
}

/**
 * Get the CPU and memory resource requests from the first container of a deployment's pod spec.
 */
export async function getPodResources(
  deploymentName: string,
  namespace: string,
): Promise<PodResources> {
  const { stdout: cpuOut } = await execFile('kubectl', [
    'get',
    'deployment',
    deploymentName,
    '-n',
    namespace,
    '-o',
    'jsonpath={.spec.template.spec.containers[0].resources.requests.cpu}',
  ]);

  const { stdout: memOut } = await execFile('kubectl', [
    'get',
    'deployment',
    deploymentName,
    '-n',
    namespace,
    '-o',
    'jsonpath={.spec.template.spec.containers[0].resources.requests.memory}',
  ]);

  return {
    cpu: cpuOut.trim() || 'unknown',
    memory: memOut.trim() || 'unknown',
  };
}

/**
 * Wait for a deployment's pods to be ready.
 */
export async function waitForPodReady(
  deploymentName: string,
  namespace: string,
  timeoutMs: number = DEFAULT_ROLLOUT_TIMEOUT_MS,
): Promise<void> {
  const timeoutSec = Math.ceil(timeoutMs / 1000);
  await execFile(
    'kubectl',
    [
      'rollout',
      'status',
      `deployment/${deploymentName}`,
      '-n',
      namespace,
      `--timeout=${timeoutSec}s`,
    ],
    { timeout: timeoutMs + 5_000 },
  );
}
