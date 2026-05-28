/**
 * Preflight Checks for Benchmark Orchestrator
 *
 * Verifies that required tools (kubectl, k6) are available, the namespace
 * exists, and optionally that Coroot is reachable. Records original replica
 * counts for later restoration.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  errors: string[];
  warnings: string[];
  originalReplicas: Record<string, number>;
}

export interface PreflightOptions {
  namespace: string;
  services: string[];
  deploymentNames: string[];
  requireCoroot: boolean;
  corootUrl?: string;
}

async function checkCommand(
  name: string,
  command: string,
  args: string[],
): Promise<PreflightCheck> {
  try {
    await execFile(command, args);
    return { name, passed: true, message: `${command} is available` };
  } catch {
    return { name, passed: false, message: `${command} is not available or not in PATH` };
  }
}

async function checkNamespace(namespace: string): Promise<PreflightCheck> {
  try {
    await execFile('kubectl', ['get', 'namespace', namespace]);
    return {
      name: 'namespace',
      passed: true,
      message: `Namespace "${namespace}" exists`,
    };
  } catch {
    return {
      name: 'namespace',
      passed: false,
      message: `Namespace "${namespace}" not found or kubectl cannot reach the cluster`,
    };
  }
}

async function checkCoroot(url: string): Promise<PreflightCheck> {
  try {
    // Use kubectl or curl to check Coroot health endpoint
    await execFile('curl', ['-sf', '--max-time', '5', `${url}/api/health`]);
    return { name: 'coroot', passed: true, message: `Coroot reachable at ${url}` };
  } catch {
    return {
      name: 'coroot',
      passed: false,
      message: `Coroot not reachable at ${url}/api/health`,
    };
  }
}

async function getReplicaCount(deploymentName: string, namespace: string): Promise<number> {
  try {
    const { stdout } = await execFile('kubectl', [
      'get',
      'deployment',
      deploymentName,
      '-n',
      namespace,
      '-o',
      'jsonpath={.spec.replicas}',
    ]);
    const count = parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? 1 : count;
  } catch {
    return 1;
  }
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const originalReplicas: Record<string, number> = {};

  // Check required tools
  const kubectlCheck = await checkCommand('kubectl', 'kubectl', ['version', '--client']);
  checks.push(kubectlCheck);
  if (!kubectlCheck.passed) {
    errors.push(kubectlCheck.message);
  }

  const k6Check = await checkCommand('k6', 'k6', ['version']);
  checks.push(k6Check);
  if (!k6Check.passed) {
    errors.push(k6Check.message);
  }

  // Check namespace
  const nsCheck = await checkNamespace(opts.namespace);
  checks.push(nsCheck);
  if (!nsCheck.passed) {
    errors.push(nsCheck.message);
  }

  // Check Coroot (optional or required)
  if (opts.requireCoroot && opts.corootUrl) {
    const corootCheck = await checkCoroot(opts.corootUrl);
    checks.push(corootCheck);
    if (!corootCheck.passed) {
      errors.push(corootCheck.message);
    }
  } else if (opts.corootUrl) {
    const corootCheck = await checkCoroot(opts.corootUrl);
    checks.push(corootCheck);
    if (!corootCheck.passed) {
      warnings.push(`${corootCheck.message} (metrics will be unavailable)`);
    }
  }

  // Record original replica counts
  for (let i = 0; i < opts.deploymentNames.length; i++) {
    const deploymentName = opts.deploymentNames[i];
    const serviceName = opts.services[i];
    const replicas = await getReplicaCount(deploymentName, opts.namespace);
    originalReplicas[serviceName] = replicas;
  }

  return {
    passed: errors.length === 0,
    checks,
    errors,
    warnings,
    originalReplicas,
  };
}
