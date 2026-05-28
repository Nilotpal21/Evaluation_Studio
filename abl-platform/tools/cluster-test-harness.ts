/**
 * Redis Cluster integration-test harness.
 *
 * Wraps `docker-compose.cluster.yml` so test suites can:
 *   - boot()           — wait for `cluster_state:ok` on port 7000
 *   - flushAllMasters() — `FLUSHDB` on every master between cases
 *   - forceFailover()   — graceful (`CLUSTER FAILOVER`) or ungraceful (`docker stop`)
 *   - tearDown()        — `docker compose down -v`
 *   - getNodes() / getUrl() — connection-string helpers
 *
 * The API intentionally diverges from the standalone `redis-server-harness.ts`:
 * cluster boot/failover semantics are different and merging the two would
 * obscure both. Tests choose which harness to import based on the suite type.
 *
 * Cluster ports (host network): 7000-7002 masters, 7003-7005 replicas.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Redis, Cluster } from 'ioredis';
import type { ClusterNode } from 'ioredis';

const execFileAsync = promisify(execFile);

const COMPOSE_FILE = path.resolve(process.cwd(), 'docker-compose.cluster.yml');

const MASTER_PORTS = [7000, 7001, 7002] as const;
const REPLICA_PORTS = [7003, 7004, 7005] as const;
const ALL_PORTS = [...MASTER_PORTS, ...REPLICA_PORTS] as const;

export type FailoverMode = 'graceful' | 'ungraceful';

async function dockerCompose(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, ...args]);
  return stdout;
}

async function waitForClusterOk(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = new Redis({ host: '127.0.0.1', port: MASTER_PORTS[0], lazyConnect: true });
      await probe.connect();
      const info = await probe.cluster('INFO');
      await probe.quit();
      if (typeof info === 'string' && info.includes('cluster_state:ok')) return;
    } catch {
      // Retry — node may not be up yet.
    }
    await sleep(500);
  }
  throw new Error(`Cluster did not reach cluster_state:ok within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ClusterTestHarness {
  /**
   * Bring the cluster up (idempotent) and wait for `cluster_state:ok`.
   * Safe to call from multiple test files; docker compose will reuse running
   * containers.
   *
   * Note: we deliberately don't pass `--wait` — the bootstrap container
   * (`abl-redis-cluster-init`) exits 0 after creating the cluster, and
   * `--wait` treats any non-running service as unhealthy. We poll
   * `CLUSTER INFO` for `cluster_state:ok` ourselves instead.
   */
  async boot(): Promise<void> {
    await dockerCompose('up', '-d');
    await waitForClusterOk();
  }

  /**
   * Issue `FLUSHDB` on every current master so test cases start with empty data.
   * Uses a transient Cluster client to discover actual masters dynamically —
   * after a graceful failover the static MASTER_PORTS list may include replicas,
   * causing READONLY errors if we flush by hardcoded port.
   */
  async flushAllMasters(): Promise<void> {
    const probe = new Cluster(
      MASTER_PORTS.map((port) => ({ host: '127.0.0.1', port })),
      { enableOfflineQueue: false, lazyConnect: true },
    );
    try {
      await probe.connect();
      await Promise.all(probe.nodes('master').map((node) => node.flushdb()));
    } finally {
      probe.quit().catch((_err) => {
        // quit on teardown probe is best-effort
      });
    }
  }

  /**
   * Force a master failover.
   *  - 'graceful'   → issue `CLUSTER FAILOVER` on a replica of a current master.
   *  - 'ungraceful' → `docker stop` the master container; cluster promotes a
   *    replica after `cluster-node-timeout` (5s).
   *
   * The `masterPort` hint is best-effort: after a previous failover the port
   * may now be a replica. We use a Cluster client to discover an actual current
   * master, so repeated test runs stay robust regardless of prior topology state.
   */
  async forceFailover(masterPort: number, mode: FailoverMode): Promise<void> {
    if (!MASTER_PORTS.includes(masterPort as (typeof MASTER_PORTS)[number])) {
      throw new Error(`forceFailover: ${masterPort} is not a known master port`);
    }
    if (mode === 'graceful') {
      // Discover topology via Cluster client; pick the first master that has a replica.
      const probe = new Cluster(
        MASTER_PORTS.map((port) => ({ host: '127.0.0.1', port })),
        { enableOfflineQueue: false, lazyConnect: true },
      );
      try {
        await probe.connect();
        const masters = probe.nodes('master');
        if (masters.length === 0) throw new Error('No master nodes found in cluster');

        // Prefer the shard that was originally at masterPort; fall back to any master.
        const preferredMaster =
          masters.find((n) => (n.options.port as number) === masterPort) ?? masters[0];

        // Get this master's node ID and then its replicas.
        const myId = (await preferredMaster.cluster('MYID')) as string;
        const replicas = (await preferredMaster.cluster('REPLICAS', myId.trim())) as
          | string[]
          | string;
        const flat = Array.isArray(replicas) ? replicas.join('\n') : replicas;
        const match = flat.match(/127\.0\.0\.1:(70\d{2})/);
        if (!match) throw new Error('No replica found for graceful failover');
        const replicaPort = parseInt(match[1], 10);

        const replica = new Redis({ host: '127.0.0.1', port: replicaPort, lazyConnect: true });
        try {
          await replica.connect();
          await replica.cluster('FAILOVER');
        } finally {
          replica.quit().catch((_err) => {
            // best-effort
          });
        }
      } finally {
        probe.quit().catch((_err) => {
          // best-effort
        });
      }
      return;
    }
    // Ungraceful: stop the container.
    const containerName = `abl-redis-cluster-${MASTER_PORTS.indexOf(
      masterPort as (typeof MASTER_PORTS)[number],
    )}`;
    await execFileAsync('docker', ['stop', containerName]);
  }

  /** `docker compose down -v` — destroys volumes. */
  async tearDown(): Promise<void> {
    await dockerCompose('down', '-v');
  }

  /** Master seed nodes (3 entries). Use these to construct a Cluster client. */
  getNodes(): ClusterNode[] {
    return MASTER_PORTS.map((port) => ({ host: '127.0.0.1', port }));
  }

  /** Comma-joined seed list suitable for `REDIS_URL` in cluster mode. */
  getUrl(): string {
    return MASTER_PORTS.map((p) => `127.0.0.1:${p}`).join(',');
  }

  /** All ports including replicas — diagnostic use only. */
  getAllPorts(): readonly number[] {
    return ALL_PORTS;
  }
}
