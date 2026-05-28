import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireNonBlockingTestLock } from '../../../tools/testing/nonblocking-test-lock.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SCRIPT_DIR);
const RESOURCE_MANIFEST_PATH = join(PACKAGE_ROOT, 'test-resource-manifest.json');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const FAIL_FAST_ENABLED = process.env.RUNTIME_TEST_FAIL_FAST !== 'false';
const PLAN_ONLY_ARG = '--plan-only';
const PLAN_ONLY_ENABLED =
  process.env.RUNTIME_TEST_PLAN_ONLY === '1' || process.argv.includes(PLAN_ONLY_ARG);
const INFRA_LOCK_NAME = 'abl-shared-heavy-test-infra';
const LANE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_LANE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CORE_CPU_CONCURRENCY = 1;
const FAILURE_OUTPUT_TAIL_CHARS = 20_000;
const EXCLUSIVE_HEAVY_INFRA_RESOURCE = 'exclusive-heavy-infra';
const STREAM_LANE_OUTPUT = process.env.RUNTIME_TEST_STREAM_LANE_OUTPUT === '1';
const HEAVY_INFRA_PHASE_NAMES = new Set([
  'connectors',
  'e2e-shards',
  'e2e-workflows',
  'integration',
  'isolated',
]);
const CORE_ROOT_LANES = [
  'test:core:root:1',
  'test:core:root:2',
  'test:core:root:3',
  'test:core:root:4',
  'test:core:root:5',
  'test:core:root:6',
];
const CORE_AUTHZ_LANES = [
  'test:core:platform:auth:authz:1',
  'test:core:platform:auth:authz:2',
  'test:core:platform:auth:authz:3',
  'test:core:platform:auth:authz:4',
  'test:core:platform:auth:authz:5',
  'test:core:platform:auth:authz:6',
];
const E2E_SHARD_LANES = [
  'test:e2e:shard:1',
  'test:e2e:shard:2',
  'test:e2e:shard:3',
  'test:e2e:shard:4',
];
const ISOLATED_LANES = ['test:flaky:sessions', 'test:flaky:control-plane', 'test:flaky:async'];
const CORE_WEBSOCKET_LANES = [
  'test:core:channels:websocket:handler',
  'test:core:channels:websocket:transport',
  'test:core:channels:websocket:sdk',
];
const CORE_NON_PORT_BOUND_LANES = [
  'test:core:execution:engine:flows',
  'test:core:execution:engine:handoff',
  'test:core:execution:engine:reasoning',
  'test:core:execution:engine:runtime',
  'test:core:execution:routing',
  'test:core:execution:event-bus',
  ...CORE_AUTHZ_LANES,
  'test:core:platform:auth:middleware',
  'test:core:platform:auth:profiles',
  'test:core:platform:auth:security',
  'test:core:channels:voice',
  'test:core:channels:adapters',
  ...CORE_ROOT_LANES,
  'test:core:platform:routes',
  ...CORE_WEBSOCKET_LANES,
  'test:core:execution:contexts',
  'test:core:platform:services',
  'test:core:execution:guardrails',
  'test:core:channels:core',
  'test:core:channels:email',
  'test:core:platform:auth-profile',
  'test:core:execution:legacy',
  'test:core:channels:webhooks',
  'test:core:observability',
  'test:core:tools',
];
const CORE_CPU_LANES = CORE_NON_PORT_BOUND_LANES.filter(
  (lane) => !CORE_ROOT_LANES.includes(lane) && !CORE_WEBSOCKET_LANES.includes(lane),
);
const CORE_REGRESSION_CPU_LANES = [...CORE_CPU_LANES, 'test:regression:project-io'];

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const LANE_TIMEOUT_MS = parsePositiveInteger(
  process.env.RUNTIME_TEST_LANE_TIMEOUT_MS,
  DEFAULT_LANE_TIMEOUT_MS,
);
const CORE_CPU_CONCURRENCY = parsePositiveInteger(
  process.env.RUNTIME_TEST_CORE_CPU_CONCURRENCY,
  DEFAULT_CORE_CPU_CONCURRENCY,
);
const CORE_PROFILE_PHASES = [
  {
    name: 'port-bound-sessions',
    concurrency: 1,
    lanes: ['test:core:platform:sessions'],
  },
  {
    name: 'core-cpu',
    concurrency: CORE_CPU_CONCURRENCY,
    lanes: CORE_CPU_LANES,
  },
  {
    name: 'core-websocket',
    concurrency: 1,
    lanes: CORE_WEBSOCKET_LANES,
  },
  {
    name: 'core-root-mongo',
    concurrency: 1,
    lanes: CORE_ROOT_LANES,
  },
];
const CORE_REGRESSION_FAST_PHASES = [
  {
    name: 'port-bound-sessions',
    concurrency: 1,
    lanes: ['test:core:platform:sessions'],
  },
  {
    name: 'core-cpu',
    concurrency: CORE_CPU_CONCURRENCY,
    lanes: CORE_REGRESSION_CPU_LANES,
  },
  {
    name: 'core-websocket',
    concurrency: 1,
    lanes: CORE_WEBSOCKET_LANES,
  },
  {
    name: 'core-root-mongo',
    concurrency: 1,
    lanes: CORE_ROOT_LANES,
  },
];
const REGRESSION_SHARD_PROFILES = {
  'regression:shard:1': {
    phases: CORE_REGRESSION_FAST_PHASES,
  },
  'regression:shard:2': {
    phases: [
      {
        name: 'integration',
        concurrency: 1,
        lanes: ['test:integration:shard:1', 'test:integration:shard:2'],
      },
    ],
  },
  'regression:shard:3': {
    phases: [
      {
        name: 'e2e-shards',
        concurrency: 1,
        lanes: E2E_SHARD_LANES,
      },
      {
        name: 'e2e-workflows',
        concurrency: 1,
        lanes: ['test:e2e:workflows'],
      },
    ],
  },
  'regression:shard:4': {
    phases: [
      {
        name: 'isolated',
        concurrency: 1,
        lanes: ISOLATED_LANES,
      },
      {
        name: 'connectors',
        concurrency: 1,
        lanes: ['test:regression:connectors'],
      },
    ],
  },
};

const PROFILES = {
  fast: {
    phases: [
      {
        name: 'units',
        concurrency: 2,
        lanes: ['test:fast:units:1', 'test:fast:units:2'],
      },
      {
        name: 'external-agents',
        concurrency: 1,
        lanes: ['test:fast:external-agents'],
      },
      {
        name: 'hotspots',
        concurrency: 4,
        lanes: [
          'test:fast:hotspots:1',
          'test:fast:hotspots:2',
          'test:fast:hotspots:3',
          'test:fast:hotspots:4',
          'test:fast:hotspots:5',
          'test:fast:hotspots:6',
          'test:fast:hotspots:7',
          'test:fast:hotspots:8',
        ],
      },
    ],
  },
  channels: {
    concurrency: 4,
    lanes: [
      'test:core:channels:voice',
      'test:core:channels:adapters',
      'test:core:channels:websocket:handler',
      'test:core:channels:websocket:transport',
      'test:core:channels:websocket:sdk',
      'test:core:channels:core',
      'test:core:channels:email',
      'test:core:channels:webhooks',
    ],
  },
  'channels:websocket': {
    concurrency: 1,
    lanes: CORE_WEBSOCKET_LANES,
  },
  execution: {
    concurrency: 4,
    lanes: [
      'test:core:execution:engine:flows',
      'test:core:execution:engine:handoff',
      'test:core:execution:engine:reasoning',
      'test:core:execution:engine:runtime',
      'test:core:execution:routing',
      'test:core:execution:event-bus',
      'test:core:execution:contexts',
      'test:core:execution:guardrails',
      'test:core:execution:legacy',
    ],
  },
  'execution:engine': {
    concurrency: 4,
    lanes: [
      'test:core:execution:engine:flows',
      'test:core:execution:engine:handoff',
      'test:core:execution:engine:reasoning',
      'test:core:execution:engine:runtime',
    ],
  },
  core: {
    phases: CORE_PROFILE_PHASES,
  },
  isolated: {
    concurrency: 2,
    lanes: ISOLATED_LANES,
  },
  platform: {
    concurrency: 4,
    lanes: [
      'test:core:platform:sessions',
      ...CORE_AUTHZ_LANES,
      'test:core:platform:auth:middleware',
      'test:core:platform:auth:profiles',
      'test:core:platform:auth:security',
      'test:core:platform:routes',
      'test:core:platform:services',
      'test:core:platform:auth-profile',
    ],
  },
  'platform:auth': {
    concurrency: 4,
    lanes: [
      ...CORE_AUTHZ_LANES,
      'test:core:platform:auth:middleware',
      'test:core:platform:auth:profiles',
      'test:core:platform:auth:security',
    ],
  },
  'platform:authz': {
    concurrency: 3,
    lanes: CORE_AUTHZ_LANES,
  },
  'ci-regression': {
    phases: [
      {
        name: 'project-io',
        concurrency: 1,
        lanes: ['test:regression:project-io'],
      },
      {
        name: 'isolated',
        concurrency: 1,
        lanes: ISOLATED_LANES,
      },
    ],
  },
  deterministic: {
    phases: CORE_REGRESSION_FAST_PHASES,
  },
  'regression:fast': {
    phases: CORE_REGRESSION_FAST_PHASES,
  },
  'regression:e2e': {
    phases: [
      {
        name: 'e2e-shards',
        concurrency: 1,
        lanes: E2E_SHARD_LANES,
      },
      {
        name: 'e2e-workflows',
        concurrency: 1,
        lanes: ['test:e2e:workflows'],
      },
    ],
  },
  'regression:heavy': {
    phases: [
      {
        name: 'integration',
        concurrency: 1,
        lanes: ['test:integration:shard:1', 'test:integration:shard:2'],
      },
      {
        name: 'e2e-shards',
        concurrency: 1,
        lanes: E2E_SHARD_LANES,
      },
      {
        name: 'e2e-workflows',
        concurrency: 1,
        lanes: ['test:e2e:workflows'],
      },
      {
        name: 'isolated',
        concurrency: 1,
        lanes: ISOLATED_LANES,
      },
      {
        name: 'connectors',
        concurrency: 1,
        lanes: ['test:regression:connectors'],
      },
    ],
  },
  regression: {
    phases: [
      {
        name: 'port-bound-sessions',
        concurrency: 1,
        lanes: ['test:core:platform:sessions'],
      },
      {
        name: 'core-cpu',
        concurrency: CORE_CPU_CONCURRENCY,
        lanes: CORE_REGRESSION_CPU_LANES,
      },
      {
        name: 'core-websocket',
        concurrency: 1,
        lanes: CORE_WEBSOCKET_LANES,
      },
      {
        name: 'core-root-mongo',
        concurrency: 1,
        lanes: CORE_ROOT_LANES,
      },
      {
        name: 'integration',
        // These shards are individually green, but concurrent Mongo-backed setup
        // can exhaust the local pool and trip hook timeouts in late-running suites.
        concurrency: 1,
        lanes: ['test:integration:shard:1', 'test:integration:shard:2'],
      },
      {
        name: 'e2e-shards',
        concurrency: 1,
        lanes: E2E_SHARD_LANES,
      },
      {
        name: 'e2e-workflows',
        concurrency: 1,
        lanes: ['test:e2e:workflows'],
      },
      {
        name: 'isolated',
        concurrency: 1,
        lanes: ISOLATED_LANES,
      },
      {
        name: 'connectors',
        concurrency: 1,
        lanes: ['test:regression:connectors'],
      },
    ],
  },
  ...REGRESSION_SHARD_PROFILES,
};

function formatYesNo(value) {
  return value ? 'yes' : 'no';
}

function describePhases(profile) {
  const phases =
    'phases' in profile
      ? profile.phases
      : [{ name: 'single', concurrency: profile.concurrency, lanes: profile.lanes }];

  return phases
    .map((phase) => `${phase.name}:${phase.lanes.length}@${phase.concurrency}`)
    .join(', ');
}

async function loadResourceManifest() {
  const rawManifest = JSON.parse(await readFile(RESOURCE_MANIFEST_PATH, 'utf8'));
  const defaultLaneResources = Array.isArray(rawManifest.defaultLaneResources)
    ? rawManifest.defaultLaneResources
    : ['cpu'];
  const resourceLimits =
    rawManifest.resourceLimits && typeof rawManifest.resourceLimits === 'object'
      ? rawManifest.resourceLimits
      : {};
  const lanes = rawManifest.lanes && typeof rawManifest.lanes === 'object' ? rawManifest.lanes : {};

  return {
    defaultLaneResources,
    lanes,
    resourceLimits,
  };
}

function getLaneResources(resourceManifest, laneName) {
  const resources = resourceManifest.lanes[laneName];
  return Array.isArray(resources) && resources.length > 0
    ? resources
    : resourceManifest.defaultLaneResources;
}

function getResourceLimit(resourceManifest, resourceName, phaseConcurrency) {
  const configuredLimit = Number(resourceManifest.resourceLimits[resourceName]);
  if (Number.isInteger(configuredLimit) && configuredLimit > 0) {
    return configuredLimit;
  }
  return phaseConcurrency;
}

function formatResourceList(resources) {
  return resources.length > 0 ? resources.join('+') : 'none';
}

function describePhaseResourcePlan(phase, resourceManifest) {
  const resourceCounts = new Map();
  for (const lane of phase.lanes) {
    for (const resource of getLaneResources(resourceManifest, lane)) {
      resourceCounts.set(resource, (resourceCounts.get(resource) ?? 0) + 1);
    }
  }

  return [...resourceCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([resource, count]) =>
        `${resource}:${count}/${getResourceLimit(resourceManifest, resource, phase.concurrency)}`,
    )
    .join(', ');
}

function parseEndpointFromUrl(value, defaultPort) {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (!parsed.hostname) {
      return undefined;
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPort,
    };
  } catch {
    return undefined;
  }
}

function getMongoEndpoint() {
  return (
    parseEndpointFromUrl(process.env.MONGODB_URI, 27017) ??
    parseEndpointFromUrl(process.env.MONGODB_URL, 27017) ??
    parseEndpointFromUrl(process.env.MONGO_URI, 27017) ??
    parseEndpointFromUrl(process.env.DATABASE_URL, 27017)
  );
}

function getRedisEndpoint() {
  const urlEndpoint = parseEndpointFromUrl(process.env.REDIS_URL, 6379);
  if (urlEndpoint) {
    return urlEndpoint;
  }

  if (!process.env.REDIS_HOST) {
    return undefined;
  }

  return {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? '6379'),
  };
}

function probeTcp(endpoint) {
  if (!endpoint) {
    return Promise.resolve('not-configured');
  }

  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0) {
    return Promise.resolve('invalid');
  }

  return new Promise((resolve) => {
    const socket = connectTcp({ host: endpoint.host, port: endpoint.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve('no');
    }, 500);

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve('yes');
    });

    socket.once('error', () => {
      clearTimeout(timeout);
      resolve('no');
    });
  });
}

async function printPreflight(profileName, profile, resourceManifest) {
  const [mongoReachable, redisReachable] = await Promise.all([
    probeTcp(getMongoEndpoint()),
    probeTcp(getRedisEndpoint()),
  ]);
  const liveLlmEnabled = process.env.RUN_LIVE_LLM_E2E === '1';
  const liveKeyPresent = Boolean(
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.LLM_API_KEY,
  );
  const externalNetwork =
    process.env.NO_NETWORK === '1' || process.env.DISABLE_NETWORK === '1' ? 'no' : 'unknown';

  console.log(
    [
      `[runtime-tests] preflight profile=${profileName}`,
      `mongoReachable=${mongoReachable} redisReachable=${redisReachable}`,
      `liveLlm=${formatYesNo(liveLlmEnabled)} liveKey=${formatYesNo(liveKeyPresent)}`,
      `externalNetwork=${externalNetwork}`,
      `planOnly=${formatYesNo(PLAN_ONLY_ENABLED)}`,
      `laneTimeoutMs=${String(LANE_TIMEOUT_MS)}`,
      `phases=${describePhases(profile)}`,
      `resourceLimits=${Object.entries(resourceManifest.resourceLimits)
        .map(([name, limit]) => `${name}:${String(limit)}`)
        .join(',')}`,
    ].join(' | '),
  );
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function formatProgressState(progress, phase, queue, activeLanes, phaseCompletedCount) {
  const elapsedMs = Date.now() - progress.startedAt;
  return [
    `profile=${progress.profileName}`,
    `phase=${phase.name}`,
    `completed=${progress.completed}/${progress.total}`,
    `phaseCompleted=${phaseCompletedCount}/${phase.lanes.length}`,
    `running=${activeLanes.size}`,
    `queued=${queue.length}`,
    `elapsed=${formatSeconds(elapsedMs)}s`,
  ].join(' ');
}

function sanitizeScriptLabel(scriptName) {
  return scriptName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

function appendBoundedOutput(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  const maxLength = 120_000;
  if (next.length <= maxLength) {
    return next;
  }
  return next.slice(next.length - maxLength);
}

function formatFailureOutputTail(output) {
  if (output.length <= FAILURE_OUTPUT_TAIL_CHARS) {
    return output;
  }

  return output.slice(output.length - FAILURE_OUTPUT_TAIL_CHARS);
}

function hasBailArg(forwardedArgs) {
  return forwardedArgs.some((arg) => arg === '--bail' || arg.startsWith('--bail='));
}

function applyFailFastArgs(forwardedArgs) {
  if (!FAIL_FAST_ENABLED || hasBailArg(forwardedArgs)) {
    return forwardedArgs;
  }

  return [...forwardedArgs, '--bail=1'];
}

function classifyFailure(output) {
  const rules = [
    {
      kind: 'credential-failure',
      pattern:
        /(401|unauthorized|invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|credential)/i,
    },
    {
      kind: 'db-pool-timeout',
      pattern:
        /(POOL_CHECKOUT_FAILED|MongoServerSelectionError|MongoNetworkError|buffering timed out|ECONNREFUSED.*27017|createIndexes.*timed out)/i,
    },
    {
      kind: 'redis-unavailable',
      pattern: /(ECONNREFUSED.*63(79|80)|Redis connection|ioredis|redis.*unavailable)/i,
    },
    {
      kind: 'port-bind-failure',
      pattern: /(EADDRINUSE|address already in use)/i,
    },
    {
      kind: 'timeout',
      pattern: /(Test timed out|hook timed out|timed out in|ETIMEDOUT|TimeoutError)/i,
    },
    {
      kind: 'assertion-failure',
      pattern: /(AssertionError|expected .* to |toEqual|toBe|toContain|Received:|Expected:)/i,
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(output)) {
      return rule.kind;
    }
  }

  return 'unknown';
}

function applyLaneOutputFileSuffix(scriptName, forwardedArgs) {
  const junitOutputPrefix = '--outputFile.junit=';
  const laneLabel = sanitizeScriptLabel(scriptName);

  return forwardedArgs.map((arg) => {
    if (!arg.startsWith(junitOutputPrefix)) {
      return arg;
    }

    const outputFile = arg.slice(junitOutputPrefix.length);
    const extensionIndex = outputFile.lastIndexOf('.');
    if (extensionIndex <= 0) {
      return `${junitOutputPrefix}${outputFile}-${laneLabel}`;
    }

    return `${junitOutputPrefix}${outputFile.slice(0, extensionIndex)}-${laneLabel}${outputFile.slice(extensionIndex)}`;
  });
}

function terminateLaneChild(scriptName, child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  console.log(`[runtime-tests] stopping ${scriptName} after peer failure`);
  killLaneChildProcessTree(child, 'SIGTERM');

  setTimeout(() => {
    if (child.exitCode === null) {
      killLaneChildProcessTree(child, 'SIGKILL');
    }
  }, LANE_KILL_TIMEOUT_MS).unref();
}

function killLaneChildProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the immediate child below if the process group is gone.
    }
  }

  child.kill(signal);
}

function runLane(scriptName, forwardedArgs, options = {}) {
  const startedAt = Date.now();

  console.log(`[runtime-tests] starting ${scriptName}`);

  const laneForwardedArgs = applyLaneOutputFileSuffix(scriptName, applyFailFastArgs(forwardedArgs));
  const laneArgs = ['run', scriptName];
  if (laneForwardedArgs.length > 0) {
    if (laneForwardedArgs[0] === '--') {
      laneArgs.push(...laneForwardedArgs);
    } else {
      laneArgs.push('--', ...laneForwardedArgs);
    }
  }

  return new Promise((resolve, reject) => {
    let capturedOutput = '';
    let timedOut = false;
    let settled = false;
    let laneTimeout;
    let forceResolveTimeout;

    function finish(result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(laneTimeout);
      clearTimeout(forceResolveTimeout);
      options.onExit?.(child);
      resolve(result);
    }

    const child = spawn(PNPM_BIN, laneArgs, {
      cwd: PACKAGE_ROOT,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.onSpawn?.(child);

    laneTimeout = setTimeout(() => {
      if (child.exitCode !== null) {
        return;
      }

      timedOut = true;
      capturedOutput = appendBoundedOutput(
        capturedOutput,
        `\n[runtime-tests] lane ${scriptName} exceeded timeout ${LANE_TIMEOUT_MS}ms\n`,
      );
      console.error(
        `[runtime-tests] lane ${scriptName} exceeded timeout ${LANE_TIMEOUT_MS}ms; stopping`,
      );
      terminateLaneChild(scriptName, child);
      forceResolveTimeout = setTimeout(() => {
        if (child.exitCode === null) {
          killLaneChildProcessTree(child, 'SIGKILL');
        }

        const elapsedMs = Date.now() - startedAt;
        console.error(
          `[runtime-tests] failed ${scriptName} after ${formatSeconds(
            elapsedMs,
          )}s (timeout; process did not exit cleanly)`,
        );
        console.error(`[runtime-tests] failure-classification script=${scriptName} class=timeout`);
        if (!STREAM_LANE_OUTPUT && capturedOutput.trim().length > 0) {
          console.error(`[runtime-tests] ${scriptName} output tail:`);
          console.error(formatFailureOutputTail(capturedOutput));
        }
        finish({ elapsedMs, scriptName, success: false });
      }, LANE_KILL_TIMEOUT_MS).unref();
    }, LANE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      capturedOutput = appendBoundedOutput(capturedOutput, text);
      if (STREAM_LANE_OUTPUT) {
        process.stdout.write(text);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      capturedOutput = appendBoundedOutput(capturedOutput, text);
      if (STREAM_LANE_OUTPUT) {
        process.stderr.write(text);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      clearTimeout(laneTimeout);
      clearTimeout(forceResolveTimeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[runtime-tests] passed ${scriptName} (${formatSeconds(elapsedMs)}s)`);
        finish({ elapsedMs, scriptName, success: true });
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
      console.error(
        `[runtime-tests] failed ${scriptName} after ${formatSeconds(elapsedMs)}s (${reason})`,
      );
      console.error(
        `[runtime-tests] failure-classification script=${scriptName} class=${
          timedOut ? 'timeout' : classifyFailure(capturedOutput)
        }`,
      );
      if (!STREAM_LANE_OUTPUT && capturedOutput.trim().length > 0) {
        console.error(`[runtime-tests] ${scriptName} output tail:`);
        console.error(formatFailureOutputTail(capturedOutput));
      }
      finish({ elapsedMs, scriptName, success: false });
    });
  });
}

function profileNeedsHeavyInfra(profile, resourceManifest) {
  const phases =
    'phases' in profile
      ? profile.phases
      : [{ name: 'single', concurrency: profile.concurrency, lanes: profile.lanes }];

  return phases.some(
    (phase) =>
      HEAVY_INFRA_PHASE_NAMES.has(phase.name) ||
      phase.lanes.some((lane) =>
        getLaneResources(resourceManifest, lane).includes(EXCLUSIVE_HEAVY_INFRA_RESOURCE),
      ),
  );
}

async function acquireHeavyInfraLockIfNeeded(profileName, profile, resourceManifest) {
  if (
    PLAN_ONLY_ENABLED ||
    !FAIL_FAST_ENABLED ||
    !profileNeedsHeavyInfra(profile, resourceManifest)
  ) {
    return null;
  }

  console.log(`[runtime-tests] acquiring shared infra lock for profile ${profileName}`);
  return acquireNonBlockingTestLock(INFRA_LOCK_NAME, {
    owner: `runtime:${profileName}`,
  });
}

function canReserveLaneResources(
  resourceManifest,
  activeResourceCounts,
  laneName,
  phaseConcurrency,
) {
  for (const resource of getLaneResources(resourceManifest, laneName)) {
    const activeCount = activeResourceCounts.get(resource) ?? 0;
    const limit = getResourceLimit(resourceManifest, resource, phaseConcurrency);
    if (activeCount >= limit) {
      return false;
    }
  }
  return true;
}

function reserveLaneResources(resourceManifest, activeResourceCounts, laneName) {
  for (const resource of getLaneResources(resourceManifest, laneName)) {
    activeResourceCounts.set(resource, (activeResourceCounts.get(resource) ?? 0) + 1);
  }
}

function releaseLaneResources(resourceManifest, activeResourceCounts, laneName) {
  for (const resource of getLaneResources(resourceManifest, laneName)) {
    const nextCount = (activeResourceCounts.get(resource) ?? 1) - 1;
    if (nextCount <= 0) {
      activeResourceCounts.delete(resource);
    } else {
      activeResourceCounts.set(resource, nextCount);
    }
  }
}

function findStartableLaneIndex(resourceManifest, activeResourceCounts, phase, queue) {
  return queue.findIndex((laneName) =>
    canReserveLaneResources(resourceManifest, activeResourceCounts, laneName, phase.concurrency),
  );
}

async function runPhase(phase, forwardedArgs, resourceManifest, progress) {
  console.log(
    `[runtime-tests] phase ${phase.name} starting (${phase.lanes.length} lanes, concurrency ${phase.concurrency}, resources ${describePhaseResourcePlan(
      phase,
      resourceManifest,
    )})`,
  );

  const queue = [...phase.lanes];
  const activeChildren = new Map();
  const activeLanes = new Set();
  const activeResourceCounts = new Map();
  const phaseResults = [];
  let phaseCompletedCount = 0;
  let stopStartingNewLanes = false;

  await new Promise((resolve, reject) => {
    function fail(error) {
      stopStartingNewLanes = true;
      for (const [laneName, child] of activeChildren.entries()) {
        terminateLaneChild(laneName, child);
      }
      reject(error);
    }

    function maybeResolve() {
      if ((queue.length === 0 || stopStartingNewLanes) && activeLanes.size === 0) {
        resolve();
      }
    }

    function startNextAvailableLanes() {
      try {
        while (!stopStartingNewLanes && activeLanes.size < phase.concurrency && queue.length > 0) {
          const nextLaneIndex = findStartableLaneIndex(
            resourceManifest,
            activeResourceCounts,
            phase,
            queue,
          );

          if (nextLaneIndex === -1) {
            if (activeLanes.size === 0) {
              fail(
                new Error(
                  `No resource capacity available for phase "${phase.name}". ` +
                    `First queued lane ${queue[0]} requires ${formatResourceList(
                      getLaneResources(resourceManifest, queue[0]),
                    )}.`,
                ),
              );
            }
            break;
          }

          const nextLane = queue.splice(nextLaneIndex, 1)[0];
          reserveLaneResources(resourceManifest, activeResourceCounts, nextLane);
          activeLanes.add(nextLane);

          console.log(
            `[runtime-tests] lane ${nextLane} resources=${formatResourceList(
              getLaneResources(resourceManifest, nextLane),
            )}`,
          );

          if (PLAN_ONLY_ENABLED) {
            phaseResults.push({ elapsedMs: 0, scriptName: nextLane, success: true });
            progress.completed += 1;
            phaseCompletedCount += 1;
            releaseLaneResources(resourceManifest, activeResourceCounts, nextLane);
            activeLanes.delete(nextLane);
            console.log(
              `[runtime-tests] progress ${formatProgressState(
                progress,
                phase,
                queue,
                activeLanes,
                phaseCompletedCount,
              )} last=${nextLane} status=planned`,
            );
            continue;
          }

          runLane(nextLane, forwardedArgs, {
            onExit() {
              activeChildren.delete(nextLane);
            },
            onSpawn(child) {
              activeChildren.set(nextLane, child);
              if (stopStartingNewLanes) {
                terminateLaneChild(nextLane, child);
              }
            },
          })
            .then((result) => {
              phaseResults.push(result);
              progress.completed += 1;
              phaseCompletedCount += 1;
              releaseLaneResources(resourceManifest, activeResourceCounts, nextLane);
              activeLanes.delete(nextLane);

              const status = result.success ? 'pass' : 'fail';
              console.log(
                `[runtime-tests] progress ${formatProgressState(
                  progress,
                  phase,
                  queue,
                  activeLanes,
                  phaseCompletedCount,
                )} last=${nextLane} status=${status}`,
              );

              if (!result.success) {
                stopStartingNewLanes = true;
                for (const [laneName, child] of activeChildren.entries()) {
                  if (laneName === nextLane) {
                    continue;
                  }
                  terminateLaneChild(laneName, child);
                }
              }

              startNextAvailableLanes();
              maybeResolve();
            })
            .catch((error) => {
              releaseLaneResources(resourceManifest, activeResourceCounts, nextLane);
              activeLanes.delete(nextLane);
              fail(error);
            });
        }

        maybeResolve();
      } catch (error) {
        fail(error);
      }
    }

    startNextAvailableLanes();
  });

  console.log(`[runtime-tests] phase ${phase.name} completed`);
  return phaseResults;
}

function getProfilePhases(profileName, profile) {
  return 'phases' in profile
    ? profile.phases
    : [{ name: profileName, concurrency: profile.concurrency, lanes: profile.lanes }];
}

function isVitestPathSelectionArg(arg) {
  if (arg === '--' || arg.startsWith('-')) {
    return false;
  }

  return (
    /(^|\/)(src|test|tests|__tests__)\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(arg) ||
    /(^|\/)__tests__\//.test(arg)
  );
}

function normalizeDirectVitestArgs(forwardedArgs) {
  return forwardedArgs.filter((arg) => arg !== '--');
}

function shouldRunDirectVitest(forwardedArgs) {
  return forwardedArgs.some(isVitestPathSelectionArg);
}

function runDirectVitest(forwardedArgs) {
  const startedAt = Date.now();
  const vitestArgs = [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.core.config.ts',
    ...normalizeDirectVitestArgs(forwardedArgs),
  ];

  console.log(`[runtime-tests] running direct vitest selection`);

  return new Promise((resolve, reject) => {
    const child = spawn(PNPM_BIN, vitestArgs, {
      cwd: PACKAGE_ROOT,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(
          `[runtime-tests] passed direct vitest selection (${formatSeconds(elapsedMs)}s)`,
        );
        resolve();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
      reject(
        new Error(`Direct vitest selection failed after ${formatSeconds(elapsedMs)}s (${reason})`),
      );
    });
  });
}

async function runProfile(profileName, forwardedArgs) {
  const profile = PROFILES[profileName];
  if (!profile) {
    const supported = Object.keys(PROFILES).join(', ');
    throw new Error(`Unknown runtime test profile "${profileName}". Supported: ${supported}`);
  }

  const resourceManifest = await loadResourceManifest();
  await printPreflight(profileName, profile, resourceManifest);
  const infraLock = await acquireHeavyInfraLockIfNeeded(profileName, profile, resourceManifest);

  try {
    const results = [];
    const phases = getProfilePhases(profileName, profile);
    const startedAt = Date.now();
    const progress = {
      completed: 0,
      profileName,
      startedAt,
      total: phases.reduce((count, phase) => count + phase.lanes.length, 0),
    };

    for (const phase of phases) {
      const phaseResults = await runPhase(phase, forwardedArgs, resourceManifest, progress);
      results.push(...phaseResults);

      const phaseFailed = results.filter(
        (result) => !result.success && phase.lanes.includes(result.scriptName),
      );
      if (phaseFailed.length > 0) {
        const failedScripts = phaseFailed.map((result) => result.scriptName).join(', ');
        throw new Error(`Runtime test phase "${phase.name}" failed: ${failedScripts}`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const failed = results.filter((result) => !result.success);

    if (failed.length > 0) {
      const failedScripts = failed.map((result) => result.scriptName).join(', ');
      throw new Error(
        `Runtime test profile "${profileName}" failed in ${formatSeconds(elapsedMs)}s: ${failedScripts}`,
      );
    }

    console.log(`[runtime-tests] profile ${profileName} completed in ${formatSeconds(elapsedMs)}s`);
  } finally {
    await infraLock?.release();
  }
}

const profileName = process.argv[2] ?? 'core';
const forwardedArgs = process.argv.slice(3).filter((arg) => arg !== PLAN_ONLY_ARG);

(shouldRunDirectVitest(forwardedArgs)
  ? runDirectVitest(forwardedArgs)
  : runProfile(profileName, forwardedArgs)
).catch((error) => {
  console.error(
    error instanceof Error
      ? `[runtime-tests] ${error.message}`
      : `[runtime-tests] ${String(error)}`,
  );
  process.exitCode = 1;
});
