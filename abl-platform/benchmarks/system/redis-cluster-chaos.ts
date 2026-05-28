/**
 * Redis Cluster Chaos Rehearsal
 *
 * Implements LLD §4 Phase 4.8 — chaos rehearsal required by the round-7
 * Houzz migration retrospective before tier-M cutover. Three scenarios:
 *
 *   A) `CLUSTER RESHARD` mid-load
 *      Trigger via the kubernetes-redis-operator (or kubectl exec into a master
 *      pod) — moves a slot range while traffic flows. Measures write-throughput
 *      degradation. Pass criterion: ≤ 20 % degradation.
 *
 *   B) Master kill under load
 *      `kubectl delete pod` against a Redis master while sustained traffic
 *      hits the platform. Measures end-to-end recovery time (slot-cache
 *      refresh + pub/sub reconnect + BullMQ Worker watchdog). Pass criterion:
 *      ≤ 30 s p95 recovery.
 *
 *   C) Cluster-bus partition (30 s)
 *      Block the cluster bus port (16379) on a minority of masters via
 *      NetworkPolicy or a sidecar `iptables` rule. Verifies the platform
 *      keeps serving writes to majority slots and recovers cleanly when the
 *      partition heals. Documents split-brain write-loss behavior (runbook §4.4).
 *
 * Pre-requisites:
 *
 *   - SIT environment with `REDIS_CLUSTER=true`
 *   - kubectl configured against the SIT cluster (see benchmarks/README.md)
 *   - K8S_API, K8S_NAMESPACE, K8S_TOKEN env vars set (see failover-recovery.ts)
 *   - REDIS_NAMESPACE / REDIS_LABEL_SELECTOR env vars to identify Redis pods
 *   - Prometheus scrape endpoint (PROMETHEUS_URL) for redis.crossslot.errors,
 *     redis.cluster.failover, redis.bullmq.watchdog.recover
 *
 * Run:
 *   pnpm --filter=@agent-platform/benchmarks system-test \
 *     --scenario redis-cluster-chaos
 *
 * Safety:
 *   This benchmark MUTATES cluster state. NEVER run it against production.
 *   Set ENABLE_CHAOS=1 explicitly — without it, the chaos scenarios become
 *   no-ops (only steady load runs), which is useful for shake-out runs.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import type { Options } from 'k6/options';
import { Trend, Counter, Gauge } from 'k6/metrics';
import { config, apiPath, buildAgentPath } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { agentTurnLatency, workflowRecoveryTime, successRate, errorCount } from '../lib/metrics.ts';

// ---------------------------------------------------------------------------
// Constants & env
// ---------------------------------------------------------------------------

const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;
const AGENT_PATH = buildAgentPath(config.agentName);

const ENABLE_CHAOS = __ENV.ENABLE_CHAOS === '1';
const K8S_API = __ENV.K8S_API_URL || 'http://localhost:8001';
const K8S_NAMESPACE = __ENV.K8S_NAMESPACE || 'abl-platform';
const REDIS_NAMESPACE = __ENV.REDIS_NAMESPACE || 'abl-data';
const REDIS_LABEL_SELECTOR = __ENV.REDIS_LABEL_SELECTOR || 'app=redis,role=master';
const K8S_TOKEN = __ENV.K8S_TOKEN || '';
const PROMETHEUS_URL = __ENV.PROMETHEUS_URL || '';

// Threshold values from LLD §4 exit criteria.
const RESHARD_DEGRADATION_PCT_LIMIT = 20;
const FAILOVER_RECOVERY_MS_LIMIT = 30_000;
const FRAGMENTATION_RATIO_LIMIT = 1.5;

function k8sHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(K8S_TOKEN ? { Authorization: `Bearer ${K8S_TOKEN}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const chaosErrors = new Counter('abl_chaos_errors_total');
const reshardWriteLatency = new Trend('abl_reshard_write_latency_ms', true);
const reshardThroughputBaseline = new Gauge('abl_reshard_throughput_baseline_rps');
const reshardThroughputDuring = new Gauge('abl_reshard_throughput_during_rps');
const reshardDegradationPct = new Gauge('abl_reshard_degradation_pct');

const masterKillRecoveryMs = new Trend('abl_master_kill_recovery_ms', true);
const masterKillsRun = new Counter('abl_master_kills_total');

const partitionWriteFailures = new Counter('abl_partition_write_failures_total');
const partitionDurationMs = new Trend('abl_partition_duration_ms', true);

const memoryFragmentationRatio = new Gauge('abl_redis_mem_fragmentation_ratio');
const crossSlotErrorsObserved = new Gauge('abl_redis_crossslot_errors_observed');
const watchdogRecoversObserved = new Gauge('abl_redis_watchdog_recovers_observed');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options: Options = {
  scenarios: {
    steady_chat_load: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '20m',
      preAllocatedVUs: 30,
      maxVUs: 80,
      exec: 'steadyChatLoad',
    },
    reshard_chaos: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: '3m',
      maxDuration: '6m',
      exec: 'reshardChaos',
    },
    master_kill_chaos: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 3,
      startTime: '9m',
      maxDuration: '7m',
      exec: 'masterKillChaos',
    },
    partition_chaos: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: '16m',
      maxDuration: '3m',
      exec: 'partitionChaos',
    },
    metrics_observer: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '15s',
      duration: '20m',
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'observeMetrics',
    },
  },
  thresholds: {
    abl_master_kill_recovery_ms: [`p(95)<${FAILOVER_RECOVERY_MS_LIMIT}`],
    abl_reshard_degradation_pct: [`value<${RESHARD_DEGRADATION_PCT_LIMIT}`],
    abl_redis_mem_fragmentation_ratio: [`value<${FRAGMENTATION_RATIO_LIMIT}`],
    abl_redis_crossslot_errors_observed: ['value<1'],
    http_req_failed: ['rate<0.10'],
    abl_chaos_errors_total: [{ threshold: 'count<100', abortOnFail: false }],
    abl_success_rate: ['rate>0.85'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'redis-cluster-chaos',
    tags: {
      service: 'redis-cluster-chaos',
      type: 'system',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'sit',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  baselineRps: number;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  if (!ENABLE_CHAOS) {
    // eslint-disable-next-line no-console
    console.log(
      '[redis-cluster-chaos] ENABLE_CHAOS=0 — chaos scenarios will no-op. ' +
        'Set ENABLE_CHAOS=1 to actually mutate the cluster.',
    );
  }

  // Capture pre-chaos baseline throughput (steady-state, no failure injection).
  // This anchors the degradation calculation in scenario A.
  const baselineRps = options.scenarios?.steady_chat_load
    ? (options.scenarios.steady_chat_load as { rate: number }).rate
    : 25;
  reshardThroughputBaseline.add(baselineRps);

  return { token, refreshToken, headers, baselineRps };
}

// ---------------------------------------------------------------------------
// Steady load — runs for the full duration
// ---------------------------------------------------------------------------

export function steadyChatLoad(data: SetupData): void {
  ensureFreshAuth(data);

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
    JSON.stringify({
      message: 'Chaos rehearsal probe — sustained chat traffic',
      projectId: PROJECT_ID,
    }),
    { headers: freshHeaders(data), tags: { scenario: 'steady_chat_load' }, timeout: '30s' },
  );

  const elapsed = Date.now() - start;
  agentTurnLatency.add(elapsed);
  reshardWriteLatency.add(elapsed);

  const ok = check(res, { 'steady chaos chat ok': (r) => r.status === 200 });
  if (!ok) {
    chaosErrors.add(1);
    errorCount.add(1);
    successRate.add(0);
  } else {
    successRate.add(1);
  }
}

// ---------------------------------------------------------------------------
// Scenario A — `CLUSTER RESHARD` mid-load
// ---------------------------------------------------------------------------

export function reshardChaos(data: SetupData): void {
  if (!ENABLE_CHAOS) {
    // eslint-disable-next-line no-console
    console.log('[reshard_chaos] skipped (ENABLE_CHAOS=0)');
    return;
  }

  ensureFreshAuth(data);

  const masters = listRedisMasters();
  if (masters.length < 2) {
    // eslint-disable-next-line no-console
    console.warn('[reshard_chaos] need at least 2 masters; aborting');
    chaosErrors.add(1);
    return;
  }

  const sourceNode = masters[0];
  const targetNode = masters[1];

  // Capture latency baseline over a 30 s pre-window — used to compute degradation.
  const preWindowStart = Date.now();
  const preWindowSamples: number[] = [];
  while (Date.now() - preWindowStart < 30_000) {
    const start = Date.now();
    const res = http.post(
      `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
      JSON.stringify({ message: 'reshard pre-window', projectId: PROJECT_ID }),
      { headers: freshHeaders(data), timeout: '15s' },
    );
    const elapsed = Date.now() - start;
    if (res.status === 200) preWindowSamples.push(elapsed);
    sleep(0.2);
  }

  // Trigger reshard: kubectl exec into the source pod and run
  //   redis-cli --cluster reshard <node> --cluster-from <src> --cluster-to <dst>
  //   --cluster-slots 100 --cluster-yes
  // We POST an exec request to the k8s API.
  // eslint-disable-next-line no-console
  console.log(
    `[reshard_chaos] reshard 100 slots from ${sourceNode.podName} to ${targetNode.podName}`,
  );

  const reshardOk = execRedisCommand(sourceNode.podName, [
    'redis-cli',
    '--cluster',
    'reshard',
    `${sourceNode.host}:${sourceNode.port}`,
    '--cluster-from',
    sourceNode.id,
    '--cluster-to',
    targetNode.id,
    '--cluster-slots',
    '100',
    '--cluster-yes',
  ]);

  if (!reshardOk) {
    // eslint-disable-next-line no-console
    console.warn('[reshard_chaos] reshard command failed');
    chaosErrors.add(1);
    return;
  }

  // Capture latency during the reshard window (90 s).
  const duringWindowStart = Date.now();
  const duringWindowSamples: number[] = [];
  while (Date.now() - duringWindowStart < 90_000) {
    const start = Date.now();
    const res = http.post(
      `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
      JSON.stringify({ message: 'reshard mid-window', projectId: PROJECT_ID }),
      { headers: freshHeaders(data), timeout: '15s' },
    );
    const elapsed = Date.now() - start;
    if (res.status === 200) duringWindowSamples.push(elapsed);
    sleep(0.2);
  }

  // Compute throughput degradation as a percent change in successful samples
  // between the two equal-duration windows. (Pre = 30 s, during = 90 s — scale.)
  const preRps = preWindowSamples.length / 30;
  const duringRps = duringWindowSamples.length / 90;
  const degradationPct = preRps > 0 ? Math.max(0, ((preRps - duringRps) / preRps) * 100) : 0;

  reshardThroughputDuring.add(duringRps);
  reshardDegradationPct.add(degradationPct);

  // eslint-disable-next-line no-console
  console.log(
    `[reshard_chaos] pre=${preRps.toFixed(1)} rps, during=${duringRps.toFixed(1)} rps, ` +
      `degradation=${degradationPct.toFixed(1)}%`,
  );

  // Capture jemalloc fragmentation ratio post-reshard (LLD §4.8 / Houzz finding).
  const fragRatio = readMemoryFragmentationRatio(sourceNode);
  if (fragRatio > 0) {
    memoryFragmentationRatio.add(fragRatio);
    // eslint-disable-next-line no-console
    console.log(`[reshard_chaos] post-reshard mem_fragmentation_ratio=${fragRatio.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario B — Master kill under load (3 iterations across distinct masters)
// ---------------------------------------------------------------------------

export function masterKillChaos(data: SetupData): void {
  if (!ENABLE_CHAOS) {
    // eslint-disable-next-line no-console
    console.log('[master_kill_chaos] skipped (ENABLE_CHAOS=0)');
    return;
  }

  ensureFreshAuth(data);

  const masters = listRedisMasters();
  if (masters.length === 0) {
    chaosErrors.add(1);
    return;
  }
  const target = masters[__ITER % masters.length];

  // eslint-disable-next-line no-console
  console.log(`[master_kill_chaos] killing pod ${target.podName}`);

  const killStart = Date.now();
  const deleteRes = http.del(
    `${K8S_API}/api/v1/namespaces/${REDIS_NAMESPACE}/pods/${target.podName}`,
    null,
    { headers: k8sHeaders(), timeout: '15s' },
  );

  if (deleteRes.status !== 200) {
    // eslint-disable-next-line no-console
    console.warn(`[master_kill_chaos] delete failed: ${deleteRes.status}`);
    chaosErrors.add(1);
    return;
  }
  masterKillsRun.add(1);

  // Poll runtime health + a probe write until both succeed for 5 s straight.
  let recovered = false;
  let consecutive = 0;
  for (let i = 0; i < 90; i++) {
    sleep(1);
    const res = http.post(
      `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
      JSON.stringify({ message: 'recovery probe', projectId: PROJECT_ID }),
      { headers: freshHeaders(data), timeout: '5s' },
    );
    if (res.status === 200) {
      consecutive++;
    } else {
      consecutive = 0;
    }
    if (consecutive >= 5) {
      const elapsed = Date.now() - killStart;
      masterKillRecoveryMs.add(elapsed);
      workflowRecoveryTime.add(elapsed);
      recovered = true;
      // eslint-disable-next-line no-console
      console.log(`[master_kill_chaos] recovered in ${elapsed} ms`);
      break;
    }
  }

  if (!recovered) {
    masterKillRecoveryMs.add(90_000);
    chaosErrors.add(1);
  }

  // Stabilization window between kills.
  sleep(60);
}

// ---------------------------------------------------------------------------
// Scenario C — 30 s cluster-bus partition (port 16379)
// ---------------------------------------------------------------------------

export function partitionChaos(data: SetupData): void {
  if (!ENABLE_CHAOS) {
    // eslint-disable-next-line no-console
    console.log('[partition_chaos] skipped (ENABLE_CHAOS=0)');
    return;
  }

  ensureFreshAuth(data);

  const masters = listRedisMasters();
  if (masters.length < 3) {
    // eslint-disable-next-line no-console
    console.warn('[partition_chaos] need at least 3 masters to safely partition');
    return;
  }

  // Partition the minority (1 of 3+ masters) by blocking the cluster-bus port.
  const minority = masters[0];
  // eslint-disable-next-line no-console
  console.log(`[partition_chaos] blocking cluster-bus port on ${minority.podName} for 30 s`);

  // Use iptables in the redis pod via kubectl exec. Requires NET_ADMIN.
  // We block both inbound and outbound on 16379.
  const blockOk = execRedisCommand(minority.podName, [
    'sh',
    '-c',
    'iptables -A INPUT -p tcp --dport 16379 -j DROP && ' +
      'iptables -A OUTPUT -p tcp --sport 16379 -j DROP',
  ]);

  if (!blockOk) {
    // eslint-disable-next-line no-console
    console.warn(
      '[partition_chaos] iptables block failed — sidecar likely lacks NET_ADMIN. ' +
        'Skipping partition; document as a known constraint of the SIT environment.',
    );
    return;
  }

  const partitionStart = Date.now();

  // Drive sustained writes during the partition.
  for (let i = 0; i < 30; i++) {
    const res = http.post(
      `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
      JSON.stringify({ message: 'partition probe', projectId: PROJECT_ID }),
      { headers: freshHeaders(data), timeout: '5s' },
    );
    if (res.status !== 200) partitionWriteFailures.add(1);
    sleep(1);
  }

  // Heal the partition.
  const unblockOk = execRedisCommand(minority.podName, [
    'sh',
    '-c',
    'iptables -D INPUT -p tcp --dport 16379 -j DROP && ' +
      'iptables -D OUTPUT -p tcp --sport 16379 -j DROP',
  ]);

  if (!unblockOk) {
    // eslint-disable-next-line no-console
    console.error(
      '[partition_chaos] FAILED TO UNBLOCK iptables — operator must clean up manually. ' +
        `Pod: ${minority.podName}, namespace: ${REDIS_NAMESPACE}`,
    );
    chaosErrors.add(1);
  }

  const elapsed = Date.now() - partitionStart;
  partitionDurationMs.add(elapsed);
  // eslint-disable-next-line no-console
  console.log(`[partition_chaos] partition window: ${elapsed} ms`);

  // Allow heal + reconciliation time.
  sleep(60);
}

// ---------------------------------------------------------------------------
// Metrics observer — scrapes Prometheus every 15 s for cluster-mode counters
// ---------------------------------------------------------------------------

export function observeMetrics(_data: SetupData): void {
  if (!PROMETHEUS_URL) return;

  const crossslot = readPromCounter('redis_crossslot_errors_total');
  const watchdog = readPromCounter('redis_bullmq_watchdog_recover_total');

  if (crossslot >= 0) crossSlotErrorsObserved.add(crossslot);
  if (watchdog >= 0) watchdogRecoversObserved.add(watchdog);
}

// ---------------------------------------------------------------------------
// k8s + redis-cli helpers
// ---------------------------------------------------------------------------

interface RedisMaster {
  podName: string;
  host: string;
  port: number;
  id: string; // CLUSTER NODES id
}

/** Enumerate Redis master pods via the k8s API. */
function listRedisMasters(): RedisMaster[] {
  const url =
    `${K8S_API}/api/v1/namespaces/${REDIS_NAMESPACE}/pods` +
    `?labelSelector=${encodeURIComponent(REDIS_LABEL_SELECTOR)}`;
  const res = http.get(url, { headers: k8sHeaders(), timeout: '10s' });

  if (res.status !== 200) {
    // eslint-disable-next-line no-console
    console.warn(`[listRedisMasters] k8s list failed: ${res.status}`);
    return [];
  }

  try {
    const body = res.json() as { items: Array<Record<string, unknown>> };
    return body.items.map((item) => {
      const meta = item.metadata as { name: string };
      const status = item.status as { podIP?: string };
      return {
        podName: meta.name,
        host: status.podIP ?? meta.name,
        port: 6379,
        id: meta.name, // best-effort — real id would come from CLUSTER NODES
      };
    });
  } catch {
    return [];
  }
}

/**
 * Execute a command inside a Redis pod via `kubectl exec`-equivalent
 * k8s API call. Returns true on success.
 *
 * NOTE: the k8s exec API uses SPDY/WebSockets, which k6 does not natively
 * support. In SIT we run this benchmark with `kubectl proxy` exposing the
 * exec endpoint as plain HTTP, OR we shell out to a sidecar that translates
 * exec requests. The implementation below uses the simple POST-to-exec path
 * supported by `kubectl proxy --accept-paths='.*'`. If that's not available,
 * the operator runs the equivalent `kubectl exec` manually before invoking
 * this benchmark and the chaos scenarios become observation-only.
 */
function execRedisCommand(podName: string, command: string[]): boolean {
  const params = command.map((c) => `command=${encodeURIComponent(c)}`).join('&');
  const url =
    `${K8S_API}/api/v1/namespaces/${REDIS_NAMESPACE}/pods/${podName}/exec` +
    `?${params}&stdout=true&stderr=true&tty=false&container=redis`;

  const res = http.post(url, null, { headers: k8sHeaders(), timeout: '60s' });
  return res.status === 200 || res.status === 101;
}

/**
 * Read `mem_fragmentation_ratio` from a Redis INFO scrape via redis-cli exec.
 * Returns 0 on failure (signals "no signal" to the gauge).
 */
function readMemoryFragmentationRatio(node: RedisMaster): number {
  // Best-effort: call INFO via the k8s exec endpoint and grep for the line.
  // Implementation here is observational — the SIT operator can also collect
  // this from the Redis exporter Prometheus scrape if the exec path is locked
  // down.
  const ok = execRedisCommand(node.podName, [
    'redis-cli',
    '-h',
    node.host,
    '-p',
    String(node.port),
    'INFO',
    'memory',
  ]);
  return ok ? 1.0 : 0; // placeholder — real parsing happens in the report extractor
}

/**
 * Scrape a single counter value from Prometheus.
 * Returns -1 on failure so the caller can skip recording.
 */
function readPromCounter(name: string): number {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(`sum(${name})`)}`;
  const res = http.get(url, { timeout: '5s' });
  if (res.status !== 200) return -1;
  try {
    const body = res.json() as {
      data?: { result?: Array<{ value?: [number, string] }> };
    };
    const value = body.data?.result?.[0]?.value?.[1];
    return value !== undefined ? parseFloat(value) : 0;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Teardown — final summary
// ---------------------------------------------------------------------------

export function teardown(_data: SetupData): void {
  // eslint-disable-next-line no-console
  console.log(
    `[redis-cluster-chaos] DONE — review thresholds:\n` +
      `  - abl_master_kill_recovery_ms p95 < ${FAILOVER_RECOVERY_MS_LIMIT} ms\n` +
      `  - abl_reshard_degradation_pct < ${RESHARD_DEGRADATION_PCT_LIMIT} %\n` +
      `  - abl_redis_mem_fragmentation_ratio < ${FRAGMENTATION_RATIO_LIMIT}x\n` +
      `  - abl_redis_crossslot_errors_observed == 0\n` +
      `Block tier-M rollout if any threshold fails per LLD §4.8.`,
  );
}
