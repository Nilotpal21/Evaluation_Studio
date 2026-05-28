/**
 * Infrastructure Metrics Collector — Orchestrator
 *
 * Tries Coroot first for rich metrics (CPU, memory, connections, disk, OOM,
 * restarts, RPS). Falls back to kubectl top for basic CPU/memory.
 *
 * Produces an InfraMetricsFile JSON compatible with the existing
 * `mergeInfraMetrics()` function in sizing-report.ts.
 */

import { writeFile } from 'fs/promises';
import {
  loadCorootConfig,
  checkCorootHealth,
  collectCorootMetrics,
  type InfraMetricsFile,
} from './coroot-collector.js';
import {
  collectKubectlMetrics,
  collectDeploymentInfo,
  collectNodeInfo,
  collectPodPlacement,
  type MetricsSampler,
} from './kubectl-metrics.js';
import { SERVICE_REGISTRY } from './service-registry.js';

export type { InfraMetricsFile } from './coroot-collector.js';

export interface InfraCollectorOptions {
  services: Array<{ name: string; deploymentName: string; category: string }>;
  namespace: string;
  fromTimestamp: number;
  toTimestamp: number;
  outputPath: string;
  sampler?: MetricsSampler;
}

/**
 * Collect infra metrics: try Coroot first, fall back to kubectl top.
 *
 * Returns the file path where the metrics JSON was written (or null if
 * both sources failed).
 */
export async function collectInfraMetrics(opts: InfraCollectorOptions): Promise<string | null> {
  process.stdout.write('\n--- Infrastructure Metrics Collection ---\n');

  let metrics: InfraMetricsFile | null = null;

  // Try Coroot first
  const corootConfig = loadCorootConfig();
  if (corootConfig) {
    process.stdout.write(`  Trying Coroot at ${corootConfig.baseUrl}...\n`);
    const healthResult = await checkCorootHealth(corootConfig);

    if (healthResult.healthy) {
      process.stdout.write('  Coroot connected. Collecting metrics...\n');
      try {
        metrics = await collectCorootMetrics(
          corootConfig,
          opts.services,
          opts.fromTimestamp,
          opts.toTimestamp,
          opts.namespace,
        );

        const serviceCount = Object.keys(metrics.services).length;
        if (serviceCount > 0) {
          process.stdout.write(`  Coroot: ${serviceCount} service(s) collected\n`);
        } else {
          process.stderr.write(
            '  Coroot returned no service metrics, falling back to kubectl...\n',
          );
          metrics = null;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Coroot collection failed: ${message}\n`);
        process.stderr.write('  Falling back to kubectl top...\n');
      }
    } else {
      const reason = healthResult.error ?? 'unknown error';
      process.stderr.write(`  Coroot not reachable: ${reason}\n`);
      process.stderr.write('  Falling back to kubectl top...\n');
    }
  } else {
    process.stdout.write(
      '  Coroot not configured (set COROOT_BASE_URL, COROOT_USERNAME, COROOT_PASSWORD, COROOT_PROJECT_ID).\n',
    );
    process.stdout.write('  Falling back to kubectl top...\n');
  }

  // Fallback: kubectl top (if Coroot didn't produce metrics)
  if (!metrics) {
    try {
      metrics = await collectKubectlMetrics(opts.services, opts.namespace, opts.sampler);
      metrics.testWindow = { from: opts.fromTimestamp, to: opts.toTimestamp };

      const serviceCount = Object.keys(metrics.services).length;
      if (serviceCount > 0) {
        process.stdout.write(`  kubectl: ${serviceCount} service(s) collected\n`);
      } else {
        process.stderr.write('  kubectl top returned no metrics (is the cluster reachable?)\n');
        metrics = null;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  kubectl top failed: ${message}\n`);
    }
  }

  // Collect deployment info (replicas, resource requests/limits) for ALL platform services
  try {
    const allServices = Object.entries(SERVICE_REGISTRY).map(([name, entry]) => ({
      name,
      deploymentName: entry.deploymentName,
    }));
    const deploymentInfoMap = await collectDeploymentInfo(allServices, opts.namespace);

    if (deploymentInfoMap.size > 0) {
      if (!metrics) {
        metrics = {
          source: 'kubectl-deployment-info',
          project: '',
          collectedAt: new Date().toISOString(),
          testWindow: { from: opts.fromTimestamp, to: opts.toTimestamp },
          services: {},
        };
      }

      for (const [svcName, depInfo] of deploymentInfoMap) {
        if (!metrics.services[svcName]) {
          metrics.services[svcName] = {};
        }
        metrics.services[svcName].deployment = depInfo;
      }

      process.stdout.write(`  Deployment info: ${deploymentInfoMap.size} service(s) collected\n`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Deployment info collection failed: ${message}\n`);
  }

  // Collect node info and pod-to-node placement
  if (metrics) {
    try {
      const allServices = Object.entries(SERVICE_REGISTRY).map(([name, entry]) => ({
        name,
        deploymentName: entry.deploymentName,
      }));

      const [nodeInfoList, podPlacementList] = await Promise.all([
        collectNodeInfo(),
        collectPodPlacement(allServices, opts.namespace),
      ]);

      if (nodeInfoList.length > 0) {
        metrics.nodes = nodeInfoList;
        process.stdout.write(`  Node info: ${nodeInfoList.length} node(s) collected\n`);
      }
      if (podPlacementList.length > 0) {
        metrics.podPlacement = podPlacementList;
        process.stdout.write(`  Pod placement: ${podPlacementList.length} pod(s) mapped\n`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  Node/pod placement collection failed: ${message}\n`);
    }
  }

  if (metrics && Object.keys(metrics.services).length > 0) {
    await writeFile(opts.outputPath, JSON.stringify(metrics, null, 2));
    process.stdout.write(`  Written to ${opts.outputPath}\n`);
    return opts.outputPath;
  }

  process.stderr.write(
    '  No infra metrics collected — report will not include infrastructure section.\n',
  );
  return null;
}
