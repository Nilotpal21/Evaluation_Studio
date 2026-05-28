/**
 * kubectl Metrics Fallback
 *
 * Collects basic CPU and memory metrics via `kubectl top pods` when
 * Coroot is unavailable. Provides a degraded but useful alternative.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type {
  InfraMetricsFile,
  ServiceInfraResult,
  DeploymentInfo,
  NodeInfo,
  PodPlacement,
} from './coroot-collector.js';

const execFile = promisify(execFileCb);

/**
 * Parse `kubectl top pods` output into per-deployment metrics.
 *
 * Output format:
 *   NAME                          CPU(cores)   MEMORY(bytes)
 *   abl-runtime-7f8b9c5d4-x2k4j  250m         512Mi
 */
interface PodMetric {
  podName: string;
  cpuMillicores: number;
  memoryMi: number;
}

function parseKubectlTopOutput(stdout: string): PodMetric[] {
  const lines = stdout.trim().split('\n');
  // Skip header line
  const dataLines = lines.slice(1);
  const metrics: PodMetric[] = [];

  for (const line of dataLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const podName = parts[0];
    const cpuStr = parts[1];
    const memStr = parts[2];

    let cpuMillicores = 0;
    if (cpuStr.endsWith('m')) {
      cpuMillicores = parseInt(cpuStr.slice(0, -1), 10);
    } else if (cpuStr.endsWith('n')) {
      cpuMillicores = parseInt(cpuStr.slice(0, -1), 10) / 1_000_000;
    } else {
      // Assume cores
      cpuMillicores = parseFloat(cpuStr) * 1000;
    }

    let memoryMi = 0;
    if (memStr.endsWith('Gi')) {
      memoryMi = parseFloat(memStr.slice(0, -2)) * 1024;
    } else if (memStr.endsWith('Mi')) {
      memoryMi = parseFloat(memStr.slice(0, -2));
    } else if (memStr.endsWith('Ki')) {
      memoryMi = parseFloat(memStr.slice(0, -2)) / 1024;
    }

    if (!Number.isNaN(cpuMillicores) && !Number.isNaN(memoryMi)) {
      metrics.push({ podName, cpuMillicores, memoryMi });
    }
  }

  return metrics;
}

/**
 * Match pod names to deployment names.
 * Pod names follow: {deploymentName}-{replicaset-hash}-{pod-hash}
 */
function findPodsForDeployment(pods: PodMetric[], deploymentName: string): PodMetric[] {
  return pods.filter((p) => p.podName.startsWith(deploymentName + '-'));
}

/**
 * Background metrics sampler that periodically runs kubectl top.
 * Start before a test, stop after — gives peak/avg during the test window.
 */
export interface MetricsSampler {
  stop: () => void;
  getSamples: () => PodMetric[][];
}

export function startMetricsSampler(
  namespace: string,
  intervalMs: number = 30_000,
): MetricsSampler {
  const samples: PodMetric[][] = [];
  let stopped = false;

  const sample = async (): Promise<void> => {
    try {
      const { stdout } = await execFile(
        'kubectl',
        ['top', 'pods', '-n', namespace, '--no-headers'],
        { timeout: 15_000 },
      );
      samples.push(parseKubectlTopOutput(`NAME CPU MEMORY\n${stdout}`));
    } catch {
      // best-effort sampling — skip on failure
    }
  };

  // Take initial sample immediately
  sample();

  const timer = setInterval(() => {
    if (!stopped) sample();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      // Take a final sample
      sample();
    },
    getSamples: () => samples,
  };
}

/**
 * Collect basic infra metrics via kubectl top for all specified services.
 * If a sampler is provided, uses its samples for peak/avg instead of a single snapshot.
 */
export async function collectKubectlMetrics(
  services: Array<{ name: string; deploymentName: string; category: string }>,
  namespace: string,
  sampler?: MetricsSampler,
): Promise<InfraMetricsFile> {
  const result: InfraMetricsFile = {
    source: 'kubectl-top',
    project: '',
    collectedAt: new Date().toISOString(),
    testWindow: { from: 0, to: 0 },
    services: {},
  };

  let allPodSnapshots: PodMetric[][] = [];

  if (sampler) {
    // Use sampler data — multiple snapshots for better peak/avg
    allPodSnapshots = sampler.getSamples();
    if (allPodSnapshots.length === 0) {
      // Fallback to a single snapshot
      try {
        const { stdout } = await execFile(
          'kubectl',
          ['top', 'pods', '-n', namespace, '--no-headers'],
          { timeout: 30_000 },
        );
        allPodSnapshots = [parseKubectlTopOutput(`NAME CPU MEMORY\n${stdout}`)];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  kubectl top pods failed: ${message}\n`);
        return result;
      }
    }
    process.stdout.write(
      `    Using ${allPodSnapshots.length} kubectl top sample(s) for peak/avg\n`,
    );
  } else {
    // Single snapshot fallback
    try {
      const { stdout } = await execFile(
        'kubectl',
        ['top', 'pods', '-n', namespace, '--no-headers'],
        { timeout: 30_000 },
      );
      allPodSnapshots = [parseKubectlTopOutput(`NAME CPU MEMORY\n${stdout}`)];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  kubectl top pods failed: ${message}\n`);
      return result;
    }
  }

  // Flatten all snapshots into per-deployment time series
  const allPods = allPodSnapshots[allPodSnapshots.length - 1] ?? [];

  for (const svc of services) {
    const pods = findPodsForDeployment(allPods, svc.deploymentName);
    if (pods.length === 0) {
      process.stderr.write(`    ${svc.name}: no pods found for ${svc.deploymentName}\n`);
      continue;
    }

    // Aggregate across ALL snapshots for this deployment (peak = max across all, avg = mean across all)
    const allCpuValues: number[] = [];
    const allMemValues: number[] = [];
    for (const snapshot of allPodSnapshots) {
      const snapshotPods = findPodsForDeployment(snapshot, svc.deploymentName);
      for (const p of snapshotPods) {
        allCpuValues.push(p.cpuMillicores);
        allMemValues.push(p.memoryMi);
      }
    }
    // Fallback to single snapshot if no time-series data
    if (allCpuValues.length === 0) {
      for (const p of pods) {
        allCpuValues.push(p.cpuMillicores);
        allMemValues.push(p.memoryMi);
      }
    }

    const cpuPeak = Math.max(...allCpuValues);
    const cpuAvg = allCpuValues.reduce((a, b) => a + b, 0) / allCpuValues.length;
    const memPeak = Math.max(...allMemValues);
    const memAvg = allMemValues.reduce((a, b) => a + b, 0) / allMemValues.length;

    const entry: ServiceInfraResult = {};

    const isDataStore = [
      'mongodb',
      'redis',
      'clickhouse',
      'opensearch',
      'qdrant',
      'neo4j',
      'restate',
    ].includes(svc.name);

    if (isDataStore) {
      // Probe connections and disk usage for the datastore
      const connInfo = await probeDataStoreConnections(svc.name, svc.deploymentName, namespace);
      const diskGB = await getPvcDiskUsageGB(svc.deploymentName, namespace);

      entry.dataStore = {
        connections: connInfo,
        connectionBreakdown: [],
        resources: {
          cpuUsage: `${Math.round(cpuPeak)}m`,
          memoryUsage:
            memPeak >= 1024 ? `${(memPeak / 1024).toFixed(1)}Gi` : `${Math.round(memPeak)}Mi`,
          diskUsageGB: diskGB,
          diskGrowthRateGBPerDay: null,
        },
      };
    } else {
      entry.infra = {
        cpuPeak: `${Math.round(cpuPeak)}m`,
        cpuAvg: `${Math.round(cpuAvg)}m`,
        memoryPeak:
          memPeak >= 1024 ? `${(memPeak / 1024).toFixed(1)}Gi` : `${Math.round(memPeak)}Mi`,
        memoryAvg: memAvg >= 1024 ? `${(memAvg / 1024).toFixed(1)}Gi` : `${Math.round(memAvg)}Mi`,
        podRestarts: 0,
        oomKills: 0,
        observedRps: 0,
        observedErrorRate: 0,
      };
    }

    result.services[svc.name] = entry;
    process.stdout.write(`    ${svc.name}: kubectl metrics collected (${pods.length} pod(s))\n`);
  }

  return result;
}

/**
 * Probe datastore connections via kubectl exec.
 * Returns { used, max, utilizationPercent } or zeroed values on failure.
 */
async function probeDataStoreConnections(
  serviceName: string,
  deploymentName: string,
  namespace: string,
): Promise<{ used: number; max: number; utilizationPercent: number }> {
  const zero = { used: 0, max: 0, utilizationPercent: 0 };

  try {
    // Find a running pod for this service
    const { stdout: podStdout } = await execFile(
      'kubectl',
      [
        'get',
        'pods',
        '-n',
        namespace,
        '-l',
        `app.kubernetes.io/name=${deploymentName}`,
        '--field-selector=status.phase=Running',
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ],
      { timeout: 10_000 },
    );
    const podName = podStdout.trim();
    if (!podName) return zero;

    let used = 0;
    let max = 0;

    if (serviceName === 'mongodb') {
      // db.serverStatus().connections → { current, available, totalCreated }
      const { stdout } = await execFile(
        'kubectl',
        [
          'exec',
          '-n',
          namespace,
          podName,
          '--',
          'mongosh',
          '--quiet',
          '--eval',
          'JSON.stringify(db.serverStatus().connections)',
        ],
        { timeout: 15_000 },
      );
      const conns = JSON.parse(stdout.trim()) as { current?: number; available?: number };
      used = conns.current ?? 0;
      max = used + (conns.available ?? 0);
    } else if (serviceName === 'redis') {
      // INFO clients → connected_clients:N / INFO server → maxclients (from config)
      const { stdout } = await execFile(
        'kubectl',
        ['exec', '-n', namespace, podName, '--', 'redis-cli', 'INFO', 'clients'],
        { timeout: 10_000 },
      );
      const usedMatch = stdout.match(/connected_clients:(\d+)/);
      used = usedMatch ? parseInt(usedMatch[1], 10) : 0;

      const { stdout: configOut } = await execFile(
        'kubectl',
        ['exec', '-n', namespace, podName, '--', 'redis-cli', 'CONFIG', 'GET', 'maxclients'],
        { timeout: 10_000 },
      );
      const maxMatch = configOut.match(/(\d+)/);
      max = maxMatch ? parseInt(maxMatch[1], 10) : 10000;
    } else if (serviceName === 'clickhouse') {
      const { stdout } = await execFile(
        'kubectl',
        [
          'exec',
          '-n',
          namespace,
          podName,
          '--',
          'clickhouse-client',
          '--query',
          'SELECT count() FROM system.processes FORMAT TabSeparated',
        ],
        { timeout: 10_000 },
      );
      used = parseInt(stdout.trim(), 10) || 0;
      max = 100; // clickhouse default max_concurrent_queries
    } else if (serviceName === 'opensearch') {
      // _cat/thread_pool/search?format=json → active connections
      const { stdout } = await execFile(
        'kubectl',
        [
          'exec',
          '-n',
          namespace,
          podName,
          '--',
          'curl',
          '-s',
          'http://localhost:9200/_nodes/stats/http?pretty',
        ],
        { timeout: 10_000 },
      );
      const stats = JSON.parse(stdout) as {
        nodes?: Record<string, { http?: { current_open?: number; total_opened?: number } }>;
      };
      for (const node of Object.values(stats.nodes ?? {})) {
        used += node.http?.current_open ?? 0;
      }
      max = 1000; // default http.max_content_length connections
    } else if (serviceName === 'neo4j') {
      // CALL dbms.listConnections() → count
      const { stdout } = await execFile(
        'kubectl',
        [
          'exec',
          '-n',
          namespace,
          podName,
          '--',
          'cypher-shell',
          '-u',
          'neo4j',
          '-p',
          'neo4j',
          'CALL dbms.listConnections() YIELD connectionId RETURN count(connectionId) AS cnt',
        ],
        { timeout: 10_000 },
      );
      const match = stdout.match(/(\d+)/);
      used = match ? parseInt(match[1], 10) : 0;
      max = 400; // default bolt.max_connections
    } else if (serviceName === 'restate') {
      // Restate admin API on port 9070 — query health/invocations
      const { stdout } = await execFile(
        'kubectl',
        ['exec', '-n', namespace, podName, '--', 'curl', '-s', 'http://localhost:9070/health'],
        { timeout: 10_000 },
      );
      // Restate doesn't expose connection counts directly; use health probe
      // to confirm reachability, report 0/0 for connections (Coroot provides richer data)
      used = stdout.trim() ? 0 : 0;
      max = 0;
    }

    const utilizationPercent = max > 0 ? Math.round((used / max) * 100) : 0;
    return { used, max, utilizationPercent };
  } catch {
    // Connection probing is best-effort — return zero on any failure
    return zero;
  }
}

/**
 * Get PVC disk usage for a datastore by querying kubectl df-pv or PVC capacity.
 * Returns disk usage in GB or null if unavailable.
 */
async function getPvcDiskUsageGB(
  deploymentName: string,
  namespace: string,
): Promise<number | null> {
  try {
    // Query PVCs matching the deployment name
    const { stdout } = await execFile('kubectl', ['get', 'pvc', '-n', namespace, '-o', 'json'], {
      timeout: 15_000,
    });
    const pvcData = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: { name?: string };
        status?: { capacity?: { storage?: string } };
      }>;
    };

    let totalGB = 0;
    let found = false;
    for (const pvc of pvcData.items ?? []) {
      const pvcName = pvc.metadata?.name ?? '';
      if (!pvcName.includes(deploymentName)) continue;
      found = true;
      const storage = pvc.status?.capacity?.storage ?? '';
      if (storage.endsWith('Gi')) {
        totalGB += parseFloat(storage.slice(0, -2));
      } else if (storage.endsWith('Ti')) {
        totalGB += parseFloat(storage.slice(0, -2)) * 1024;
      } else if (storage.endsWith('Mi')) {
        totalGB += parseFloat(storage.slice(0, -2)) / 1024;
      }
    }

    return found ? Math.round(totalGB * 100) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * Parse kubectl JSON output for deployments/statefulsets into DeploymentInfo records.
 */
function parseKubectlResourceJson(
  jsonStr: string,
  kind: 'Deployment' | 'StatefulSet',
): Map<string, DeploymentInfo> {
  const result = new Map<string, DeploymentInfo>();
  const data = JSON.parse(jsonStr) as {
    items?: Array<{
      metadata?: { name?: string };
      spec?: {
        replicas?: number;
        template?: {
          spec?: {
            containers?: Array<{
              resources?: {
                requests?: { cpu?: string; memory?: string };
                limits?: { cpu?: string; memory?: string };
              };
            }>;
          };
        };
      };
      status?: { readyReplicas?: number };
    }>;
  };

  for (const item of data.items ?? []) {
    const name = item.metadata?.name ?? '';
    if (!name) continue;

    const container = item.spec?.template?.spec?.containers?.[0];
    result.set(name, {
      replicas: item.spec?.replicas ?? 0,
      readyReplicas: item.status?.readyReplicas ?? 0,
      cpuRequest: container?.resources?.requests?.cpu ?? null,
      memoryRequest: container?.resources?.requests?.memory ?? null,
      cpuLimit: container?.resources?.limits?.cpu ?? null,
      memoryLimit: container?.resources?.limits?.memory ?? null,
      kind,
    });
  }

  return result;
}

/**
 * Collect deployment info (replicas, resource requests/limits) for all services
 * in the namespace via kubectl get deployments/statefulsets.
 */
export async function collectDeploymentInfo(
  services: Array<{ name: string; deploymentName: string }>,
  namespace: string,
): Promise<Map<string, DeploymentInfo>> {
  const allResources = new Map<string, DeploymentInfo>();

  // Fetch deployments and statefulsets in parallel
  const [deploymentsResult, statefulSetsResult] = await Promise.allSettled([
    execFile('kubectl', ['get', 'deployments', '-n', namespace, '-o', 'json'], {
      timeout: 30_000,
    }),
    execFile('kubectl', ['get', 'statefulsets', '-n', namespace, '-o', 'json'], {
      timeout: 30_000,
    }),
  ]);

  if (deploymentsResult.status === 'fulfilled') {
    const parsed = parseKubectlResourceJson(deploymentsResult.value.stdout, 'Deployment');
    for (const [k, v] of parsed) allResources.set(k, v);
  }

  if (statefulSetsResult.status === 'fulfilled') {
    const parsed = parseKubectlResourceJson(statefulSetsResult.value.stdout, 'StatefulSet');
    for (const [k, v] of parsed) allResources.set(k, v);
  }

  // Match services to their deployment/statefulset info
  // Try exact match first, then common suffixed variants (e.g., redis → redis-master)
  const SUFFIXED_VARIANTS = ['-master', '-shard-0'];
  const result = new Map<string, DeploymentInfo>();
  for (const svc of services) {
    let info = allResources.get(svc.deploymentName);
    if (!info) {
      for (const suffix of SUFFIXED_VARIANTS) {
        info = allResources.get(svc.deploymentName + suffix);
        if (info) break;
      }
    }
    if (info) {
      result.set(svc.name, info);
    }
  }

  return result;
}

/**
 * Collect node information (instance type, capacity, usage) via kubectl.
 */
export async function collectNodeInfo(): Promise<NodeInfo[]> {
  const nodes: NodeInfo[] = [];

  try {
    // Get node details and top in parallel
    const [nodesResult, topResult] = await Promise.allSettled([
      execFile('kubectl', ['get', 'nodes', '-o', 'json'], { timeout: 30_000 }),
      execFile('kubectl', ['top', 'nodes', '--no-headers'], { timeout: 30_000 }),
    ]);

    if (nodesResult.status !== 'fulfilled') return nodes;

    const nodeData = JSON.parse(nodesResult.value.stdout) as {
      items?: Array<{
        metadata?: { name?: string; labels?: Record<string, string> };
        status?: {
          capacity?: { cpu?: string; memory?: string };
          allocatable?: { cpu?: string; memory?: string };
        };
      }>;
    };

    // Parse top output for usage percentages
    const usageMap = new Map<string, { cpuPercent: number; memPercent: number }>();
    if (topResult.status === 'fulfilled') {
      for (const line of topResult.value.stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          usageMap.set(parts[0], {
            cpuPercent: parseInt(parts[2], 10) || 0,
            memPercent: parseInt(parts[4], 10) || 0,
          });
        }
      }
    }

    for (const item of nodeData.items ?? []) {
      const name = item.metadata?.name ?? '';
      if (!name) continue;

      const labels = item.metadata?.labels ?? {};
      const cap = item.status?.capacity ?? {};
      const alloc = item.status?.allocatable ?? {};
      const usage = usageMap.get(name) ?? { cpuPercent: 0, memPercent: 0 };

      // Detect cloud provider from labels
      let cloudProvider = 'unknown';
      if (labels['kubernetes.azure.com/cluster']) cloudProvider = 'Azure';
      else if (labels['cloud.google.com/gke-nodepool']) cloudProvider = 'GCP';
      else if (labels['eks.amazonaws.com/nodegroup']) cloudProvider = 'AWS';

      nodes.push({
        name,
        instanceType: labels['node.kubernetes.io/instance-type'] ?? 'unknown',
        pool: labels['agentpool'] ?? labels['node.kubernetes.io/nodepool'] ?? 'default',
        region: labels['topology.kubernetes.io/region'] ?? 'unknown',
        availabilityZone:
          labels['topology.kubernetes.io/zone'] ??
          labels['failure-domain.beta.kubernetes.io/zone'] ??
          'unknown',
        cloudProvider,
        cpuCapacity: parseCpuCores(cap.cpu),
        memoryCapacityGi: parseMemoryGi(cap.memory),
        cpuAllocatable: parseCpuCores(alloc.cpu),
        memoryAllocatableGi: parseMemoryGi(alloc.memory),
        cpuUsagePercent: usage.cpuPercent,
        memoryUsagePercent: usage.memPercent,
      });
    }
  } catch {
    // best-effort — return empty on failure
  }

  return nodes;
}

/**
 * Collect pod-to-node placement for services in the given namespace.
 */
export async function collectPodPlacement(
  services: Array<{ name: string; deploymentName: string }>,
  namespace: string,
): Promise<PodPlacement[]> {
  const placements: PodPlacement[] = [];

  try {
    const { stdout } = await execFile('kubectl', ['get', 'pods', '-n', namespace, '-o', 'json'], {
      timeout: 30_000,
    });

    const podData = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: {
          nodeName?: string;
          containers?: Array<{
            resources?: {
              requests?: { cpu?: string; memory?: string };
              limits?: { cpu?: string; memory?: string };
            };
          }>;
        };
      }>;
    };

    // Build lookup: deploymentName prefix → service name
    const prefixToService = new Map<string, string>();
    const SUFFIXED_VARIANTS = ['', '-master', '-shard-0'];
    for (const svc of services) {
      for (const suffix of SUFFIXED_VARIANTS) {
        prefixToService.set(svc.deploymentName + suffix + '-', svc.name);
      }
    }

    for (const pod of podData.items ?? []) {
      const podName = pod.metadata?.name ?? '';
      const nodeName = pod.spec?.nodeName ?? '';
      if (!podName || !nodeName) continue;

      // Match pod to service
      let matchedService: string | undefined;
      for (const [prefix, svcName] of prefixToService) {
        if (podName.startsWith(prefix)) {
          matchedService = svcName;
          break;
        }
      }
      if (!matchedService) continue;

      // Aggregate resources across all containers in the pod
      const containers = pod.spec?.containers ?? [];
      let totalCpuReq = '';
      let totalCpuLim = '';
      let totalMemReq = '';
      let totalMemLim = '';
      if (containers.length === 1) {
        const r = containers[0].resources ?? {};
        totalCpuReq = r.requests?.cpu ?? 'N/A';
        totalCpuLim = r.limits?.cpu ?? 'N/A';
        totalMemReq = r.requests?.memory ?? 'N/A';
        totalMemLim = r.limits?.memory ?? 'N/A';
      } else if (containers.length > 1) {
        // Sum across sidecars
        let cpuReqM = 0;
        let cpuLimM = 0;
        let memReqMi = 0;
        let memLimMi = 0;
        for (const c of containers) {
          const r = c.resources ?? {};
          cpuReqM += parseCpuMillicoresRaw(r.requests?.cpu);
          cpuLimM += parseCpuMillicoresRaw(r.limits?.cpu);
          memReqMi += parseMemMi(r.requests?.memory);
          memLimMi += parseMemMi(r.limits?.memory);
        }
        totalCpuReq = cpuReqM > 0 ? `${cpuReqM}m` : 'N/A';
        totalCpuLim = cpuLimM > 0 ? `${cpuLimM}m` : 'N/A';
        totalMemReq = memReqMi > 0 ? formatMemMi(memReqMi) : 'N/A';
        totalMemLim = memLimMi > 0 ? formatMemMi(memLimMi) : 'N/A';
      }

      placements.push({
        service: matchedService,
        pod: podName,
        node: nodeName,
        cpuRequest: totalCpuReq,
        cpuLimit: totalCpuLim,
        memoryRequest: totalMemReq,
        memoryLimit: totalMemLim,
      });
    }
  } catch {
    // best-effort
  }

  return placements;
}

/** Parse CPU string to whole cores (e.g., "4" → 4, "3860m" → 3.86). */
function parseCpuCores(cpu: string | undefined): number {
  if (!cpu) return 0;
  if (cpu.endsWith('m')) return parseFloat(cpu) / 1000;
  return parseFloat(cpu) || 0;
}

/** Parse memory string to GiB (e.g., "16370448Ki" → 15.6). */
function parseMemoryGi(mem: string | undefined): number {
  if (!mem) return 0;
  if (mem.endsWith('Ki')) return parseFloat(mem) / (1024 * 1024);
  if (mem.endsWith('Mi')) return parseFloat(mem) / 1024;
  if (mem.endsWith('Gi')) return parseFloat(mem);
  return parseFloat(mem) / (1024 * 1024 * 1024);
}

/** Parse CPU string to millicores for aggregation. */
function parseCpuMillicoresRaw(cpu: string | undefined): number {
  if (!cpu) return 0;
  if (cpu.endsWith('m')) return parseFloat(cpu) || 0;
  return (parseFloat(cpu) || 0) * 1000;
}

/** Parse memory string to MiB for aggregation. */
function parseMemMi(mem: string | undefined): number {
  if (!mem) return 0;
  if (mem.endsWith('Gi')) return parseFloat(mem) * 1024;
  if (mem.endsWith('Mi')) return parseFloat(mem);
  if (mem.endsWith('Ki')) return parseFloat(mem) / 1024;
  if (mem.endsWith('M')) return parseFloat(mem);
  if (mem.endsWith('G')) return parseFloat(mem) * 1024;
  return parseFloat(mem) / (1024 * 1024);
}

/** Format MiB value as human-readable string. */
function formatMemMi(mi: number): string {
  if (mi >= 1024) return `${(mi / 1024).toFixed(1)}Gi`;
  return `${Math.round(mi)}Mi`;
}
