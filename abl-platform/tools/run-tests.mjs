#!/usr/bin/env node
/**
 * Cluster-aware test orchestrator.
 *
 * Detects whether a Redis Cluster is reachable on the harness ports
 * (127.0.0.1:7000) and runs the appropriate test pass:
 *
 *   - cluster reachable     → standalone tests + *.cluster.test.ts
 *   - cluster not reachable → standalone tests only (cluster suite skipped)
 *
 * Modes (REDIS_TEST_MODE env or first CLI arg):
 *
 *   auto       — default. Probe; if cluster up, run both passes. If down,
 *                run standalone only and emit a clear note about how to
 *                enable cluster coverage.
 *   standalone — never probe; run standalone tests only.
 *   cluster    — boot docker harness if needed; run cluster suite only.
 *   both       — boot docker harness if needed; run BOTH passes.
 *   detect     — print whether the cluster is reachable and exit 0/1; no
 *                tests are run. For CI scripts that want to gate on it.
 *
 * Exit codes:
 *   0 — every requested pass succeeded.
 *   1 — one or more passes failed.
 *   2 — invalid arguments or environment setup error.
 *
 * Usage:
 *   node tools/run-tests.mjs               # auto-detect
 *   pnpm test:smart                        # same, via package.json
 *   REDIS_TEST_MODE=both pnpm test:smart   # force both passes
 *   REDIS_TEST_MODE=cluster node tools/run-tests.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const HARNESS_HOST = '127.0.0.1';
const HARNESS_PROBE_PORT = 7000;
const COMPOSE_FILE = 'docker-compose.cluster.yml';

const VALID_MODES = new Set(['auto', 'standalone', 'cluster', 'both', 'detect']);

const mode = (process.env.REDIS_TEST_MODE ?? process.argv[2] ?? 'auto').toLowerCase();
if (!VALID_MODES.has(mode)) {
  console.error(`Unknown REDIS_TEST_MODE: ${mode}. Valid: ${[...VALID_MODES].join(', ')}`);
  process.exit(2);
}

/**
 * Check whether 127.0.0.1:7000 accepts a TCP connection within the timeout.
 * A successful TCP open is the cheapest reliable proof that the cluster
 * harness is up; we don't issue CLUSTER INFO here because the orchestrator
 * runs before any test framework loads.
 */
function isClusterReachable(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(HARNESS_PROBE_PORT, HARNESS_HOST);
  });
}

function dockerComposeUp() {
  console.log('[run-tests] booting cluster via docker compose...');
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[run-tests] docker compose up failed');
    process.exit(2);
  }
}

function dockerComposeDown() {
  console.log('[run-tests] tearing down cluster...');
  spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'], {
    stdio: 'inherit',
  });
}

function runVitest(args, label) {
  console.log(`\n[run-tests] === ${label} ===`);
  return new Promise((resolve) => {
    const proc = spawn('pnpm', ['vitest', 'run', ...args], { stdio: 'inherit' });
    proc.on('exit', (code) => resolve(code ?? 1));
  });
}

async function ensureClusterUp() {
  if (await isClusterReachable()) {
    console.log('[run-tests] cluster already reachable on 127.0.0.1:7000');
    return false; // we did NOT boot it; don't tear down
  }
  dockerComposeUp();
  // Wait up to 30s for cluster_state:ok via the probe port (boot + bootstrap).
  for (let i = 0; i < 60; i++) {
    if (await isClusterReachable()) {
      // Give the init container a few extra seconds to finish CLUSTER CREATE.
      await new Promise((r) => setTimeout(r, 3000));
      return true; // we booted it; tear down at the end
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('[run-tests] cluster did not come up after 30s');
  return false;
}

async function runStandalonePass() {
  return runVitest([], 'STANDALONE pass (no docker required)');
}

async function runClusterPass() {
  return runVitest(['--config', 'vitest.cluster.config.ts'], 'CLUSTER pass (vs. live cluster)');
}

// ─── Main ─────────────────────────────────────────────────────────────────

if (mode === 'detect') {
  const up = await isClusterReachable();
  console.log(
    `cluster ${up ? 'REACHABLE' : 'NOT REACHABLE'} at ${HARNESS_HOST}:${HARNESS_PROBE_PORT}`,
  );
  process.exit(up ? 0 : 1);
}

let bootedCluster = false;
const exitCodes = [];

try {
  if (mode === 'standalone') {
    exitCodes.push(await runStandalonePass());
  } else if (mode === 'cluster') {
    bootedCluster = await ensureClusterUp();
    exitCodes.push(await runClusterPass());
  } else if (mode === 'both') {
    exitCodes.push(await runStandalonePass());
    bootedCluster = await ensureClusterUp();
    exitCodes.push(await runClusterPass());
  } else {
    // auto
    exitCodes.push(await runStandalonePass());
    const reachable = await isClusterReachable();
    if (reachable) {
      console.log('[run-tests] cluster reachable — running cluster pass too');
      exitCodes.push(await runClusterPass());
    } else {
      console.log('[run-tests] cluster NOT reachable; cluster suite skipped.');
      console.log('[run-tests] To enable: `docker compose -f docker-compose.cluster.yml up -d`');
      console.log('[run-tests] Or run: `REDIS_TEST_MODE=both pnpm test:smart`');
    }
  }
} finally {
  if (bootedCluster) {
    dockerComposeDown();
  }
}

const failed = exitCodes.some((c) => c !== 0);
console.log(
  `\n[run-tests] passes: ${exitCodes.length}, failed: ${exitCodes.filter((c) => c !== 0).length}`,
);
process.exit(failed ? 1 : 0);
