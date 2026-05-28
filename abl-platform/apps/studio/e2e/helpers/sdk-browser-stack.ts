import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { acquireNonBlockingTestLock } from '../../../../tools/testing/nonblocking-test-lock.mjs';
import {
  getSdkBrowserRuntimeBaseUrl,
  getSdkBrowserStudioBaseUrl,
  SDK_BROWSER_STUDIO_READY_PATH,
} from './sdk-browser-env';

const TEST_JWT_SECRET = '7'.repeat(64);
const TEST_MASTER_KEY = '1a2b3c4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90abc123def4567';
const TEST_SDK_SESSION_SIGNING_SECRET = '9'.repeat(64);
const TEST_SDK_BOOTSTRAP_SIGNING_SECRET = 'a'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION ?? '7.0.20';
const INFRA_LOCK_NAME = 'abl-shared-heavy-test-infra';
const MONGOMS_LAUNCH_TIMEOUT_MS = 15_000;
const ISOLATED_MONGODB_PORT = 27017;
const ISOLATED_MONGODB_DATABASE = 'abl-studio-test';
const STARTUP_TIMEOUT_MS = 90_000;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 15_000;
const HEALTH_REQUEST_TIMEOUT_MS = 2_500;
const MAX_LOG_LINES = 100;
const ACCEPTED_RUNTIME_HEALTH_STATUSES = new Set(['ok', 'healthy']);

interface ManagedProcess {
  name: string;
  child: ChildProcessWithoutNullStreams;
  recentLogs: string[];
}

interface StackContext {
  mongod: MongoMemoryServer;
  runtime: ManagedProcess;
  studio?: ManagedProcess;
}

const thisFilePath = fileURLToPath(import.meta.url);
const thisDir = dirname(thisFilePath);
const studioRoot = resolve(thisDir, '../..');
const repoRoot = resolve(thisDir, '../../../..');
const runtimeRoot = resolve(repoRoot, 'apps/runtime');
const runtimeEntry = resolve(runtimeRoot, 'dist/index.js');
const studioBuildId = resolve(studioRoot, '.next/BUILD_ID');
const sdkBundlePath = resolve(repoRoot, 'packages/web-sdk/dist/agent-sdk.umd.js');

let shuttingDown = false;

function log(message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stdout.write(`[sdk-browser-stack] ${message}${suffix}\n`);
}

function resolvePnpmBinary(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function ensureFileExists(path: string, hint: string): void {
  if (!existsSync(path)) {
    throw new Error(`${hint} (missing: ${path})`);
  }
}

function ensureBuildArtifacts(): void {
  ensureFileExists(
    runtimeEntry,
    'Runtime build output is missing. Run "pnpm build --filter=@agent-platform/runtime" first.',
  );
  ensureFileExists(
    studioBuildId,
    'Studio build output is missing. Run "pnpm build --filter=@agent-platform/studio" first.',
  );
  ensureFileExists(
    sdkBundlePath,
    'SDK UMD bundle is missing. Run "pnpm build --filter=@agent-platform/web-sdk" first.',
  );
}

function parseOutputIntoRecentLogs(target: string[], chunk: string | Buffer): void {
  const lines = chunk
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    target.push(line);
    if (target.length > MAX_LOG_LINES) {
      target.shift();
    }
  }
}

function attachManagedProcess(
  name: string,
  child: ChildProcessWithoutNullStreams,
  debugOutput: boolean,
): ManagedProcess {
  const recentLogs: string[] = [];

  child.stdout.on('data', (chunk) => {
    parseOutputIntoRecentLogs(recentLogs, chunk);
    if (debugOutput) {
      process.stdout.write(`[${name}:stdout] ${chunk.toString()}`);
    }
  });

  child.stderr.on('data', (chunk) => {
    parseOutputIntoRecentLogs(recentLogs, chunk);
    if (debugOutput) {
      process.stderr.write(`[${name}:stderr] ${chunk.toString()}`);
    }
  });

  child.on('exit', (code, signal) => {
    const details = { code, signal };
    if (shuttingDown) {
      log(`${name} exited during shutdown`, details);
      return;
    }
    log(`${name} exited unexpectedly`, details);
  });

  return { name, child, recentLogs };
}

async function stopManagedProcess(processHandle: ManagedProcess | undefined): Promise<void> {
  if (!processHandle || processHandle.child.exitCode !== null) {
    return;
  }

  processHandle.child.kill('SIGTERM');

  await Promise.race([
    new Promise<void>((resolve) => {
      processHandle.child.once('exit', () => resolve());
    }),
    delay(PROCESS_SHUTDOWN_TIMEOUT_MS).then(() => {
      if (processHandle.child.exitCode === null) {
        processHandle.child.kill('SIGKILL');
      }
    }),
  ]);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve port'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function assertPortAvailable(hostname: string, port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(
        new Error(`${label} port ${String(port)} on ${hostname} is unavailable: ${String(error)}`),
      );
    });
    server.listen(port, hostname, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

function buildRecentLogSuffix(processHandle: ManagedProcess): string {
  if (processHandle.recentLogs.length === 0) {
    return '';
  }

  return ` recent logs: ${processHandle.recentLogs.slice(-10).join(' | ')}`;
}

async function waitForHttpReady(
  url: string,
  processHandle: ManagedProcess,
  options: {
    timeoutMs?: number;
    validateBody?: (bodyText: string) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | null = null;
  let lastBody = '';

  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) {
      throw new Error(
        `${processHandle.name} exited before ${url} became ready.${buildRecentLogSuffix(processHandle)}`,
      );
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal });
        const bodyText = await response.text();

        if (response.ok) {
          options.validateBody?.(bodyText);
          return;
        }

        lastStatus = response.status;
        lastBody = bodyText;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Retry until startup completes.
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for ${url}.` +
      (lastStatus !== null ? ` last status=${String(lastStatus)} body=${lastBody}` : '') +
      buildRecentLogSuffix(processHandle),
  );
}

function validateRuntimeHealth(bodyText: string): void {
  const parsed = JSON.parse(bodyText) as { status?: string };
  if (!ACCEPTED_RUNTIME_HEALTH_STATUSES.has(parsed.status ?? '')) {
    throw new Error(`Runtime health endpoint returned unsupported status: ${bodyText}`);
  }
}

function validateStudioE2EReadiness(bodyText: string): void {
  const parsed = JSON.parse(bodyText) as { status?: string };
  if (parsed.status !== 'ready') {
    throw new Error(`Studio E2E readiness endpoint returned unsupported status: ${bodyText}`);
  }
}

function parseUrlWithPort(name: string, value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:') {
    throw new Error(`${name} must use http:// for local browser E2E: ${value}`);
  }

  if (parsed.port.length === 0) {
    throw new Error(`${name} must include an explicit port for isolated browser E2E: ${value}`);
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${name} must include a valid port: ${value}`);
  }

  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(`${name} must point to localhost or 127.0.0.1 for isolated browser E2E.`);
  }

  return parsed;
}

function startRuntimeProcess(
  mongoUri: string,
  mongoDatabase: string,
  runtimeBaseUrl: URL,
  studioBaseUrl: URL,
  debugOutput: boolean,
): ManagedProcess {
  const child = spawn(process.execPath, [runtimeEntry], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: runtimeBaseUrl.hostname,
      PORT: runtimeBaseUrl.port,
      FRONTEND_URL: studioBaseUrl.origin,
      CORS_ORIGINS: `${studioBaseUrl.origin},null`,
      DATABASE_URL: mongoUri,
      MONGODB_URL: mongoUri,
      MONGODB_DATABASE: mongoDatabase,
      MONGODB_DIRECT_CONNECTION: 'true',
      MONGODB_MIN_POOL_SIZE: '1',
      MONGODB_MAX_POOL_SIZE: '5',
      JWT_SECRET: TEST_JWT_SECRET,
      AUTH_SDK_SESSION_SIGNING_SECRET: TEST_SDK_SESSION_SIGNING_SECRET,
      AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: TEST_SDK_BOOTSTRAP_SIGNING_SECRET,
      ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY,
      ENCRYPTION_ENABLED: 'true',
      ALLOW_INMEMORY_AUTH_GATE_STATE_STORE: 'true',
      REDIS_ENABLED: 'false',
      REDIS_URL: '',
      FEATURE_LIVEKIT_ENABLED: 'false',
      CLICKHOUSE_URL: '',
      EVENT_KAFKA_ENABLED: 'false',
      SMTP_PORT: '',
      EMAIL_FROM_ADDRESS: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return attachManagedProcess('runtime', child, debugOutput);
}

function startStudioProcess(
  mongoUri: string,
  mongoDatabase: string,
  runtimeBaseUrl: URL,
  studioBaseUrl: URL,
  debugOutput: boolean,
): ManagedProcess {
  const child = spawn(
    resolvePnpmBinary(),
    ['exec', 'next', 'start', '-p', studioBaseUrl.port, '-H', studioBaseUrl.hostname],
    {
      cwd: studioRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ENABLE_DEV_LOGIN: 'true',
        FRONTEND_URL: studioBaseUrl.origin,
        RUNTIME_URL: runtimeBaseUrl.origin,
        RUNTIME_PUBLIC_BASE_URL: runtimeBaseUrl.origin,
        NEXT_PUBLIC_RUNTIME_URL: runtimeBaseUrl.origin,
        RUNTIME_WS_URL: `${runtimeBaseUrl.origin.replace(/^http/, 'ws')}/ws`,
        RUNTIME_SDK_WS_URL: `${runtimeBaseUrl.origin.replace(/^http/, 'ws')}/ws/sdk`,
        JWT_SECRET: TEST_JWT_SECRET,
        AUTH_SDK_SESSION_SIGNING_SECRET: TEST_SDK_SESSION_SIGNING_SECRET,
        AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: TEST_SDK_BOOTSTRAP_SIGNING_SECRET,
        ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY,
        ENCRYPTION_ENABLED: 'true',
        MONGODB_URL: mongoUri,
        MONGODB_URI: mongoUri,
        MONGODB_DATABASE: mongoDatabase,
        MONGODB_DB_NAME: mongoDatabase,
        MONGODB_MANAGED: 'true',
        REDIS_ENABLED: 'false',
        REDIS_URL: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  return attachManagedProcess('studio', child, debugOutput);
}

async function shutdownStack(context: StackContext | null): Promise<void> {
  if (!context || shuttingDown) {
    return;
  }

  shuttingDown = true;
  log('Shutting down isolated SDK browser E2E stack');

  await Promise.allSettled([
    stopManagedProcess(context.studio),
    stopManagedProcess(context.runtime),
  ]);
  await context.mongod.stop();
}

async function main(): Promise<void> {
  ensureBuildArtifacts();
  const infraLock = await acquireNonBlockingTestLock(INFRA_LOCK_NAME, {
    owner: 'studio:sdk-browser-isolated',
  });

  try {
    const debugOutput = process.env.SDK_BROWSER_E2E_DEBUG === 'true';
    const runtimeBaseUrl = parseUrlWithPort('RUNTIME_URL', getSdkBrowserRuntimeBaseUrl());
    const studioBaseUrl = parseUrlWithPort('STUDIO_URL', getSdkBrowserStudioBaseUrl());

    await Promise.all([
      assertPortAvailable(runtimeBaseUrl.hostname, Number(runtimeBaseUrl.port), 'Runtime'),
      assertPortAvailable(studioBaseUrl.hostname, Number(studioBaseUrl.port), 'Studio'),
      assertPortAvailable('127.0.0.1', ISOLATED_MONGODB_PORT, 'MongoMemoryServer'),
    ]);

    const mongoDatabase = process.env.SDK_BROWSER_E2E_MONGODB_DATABASE ?? ISOLATED_MONGODB_DATABASE;

    log('Starting isolated MongoDB for SDK browser E2E', { mongoDatabase });
    const mongod = await MongoMemoryServer.create({
      binary: { version: MONGOMS_VERSION },
      instance: {
        dbName: mongoDatabase,
        ip: '127.0.0.1',
        launchTimeout: MONGOMS_LAUNCH_TIMEOUT_MS,
        port: ISOLATED_MONGODB_PORT,
      },
    });
    const mongoUri = mongod.getUri(mongoDatabase);

    const runtime = startRuntimeProcess(
      mongoUri,
      mongoDatabase,
      runtimeBaseUrl,
      studioBaseUrl,
      debugOutput,
    );

    const stackContext: StackContext = { mongod, runtime };

    try {
      await waitForHttpReady(`${runtimeBaseUrl.origin}/health`, runtime, {
        validateBody: validateRuntimeHealth,
      });

      const studio = startStudioProcess(
        mongoUri,
        mongoDatabase,
        runtimeBaseUrl,
        studioBaseUrl,
        debugOutput,
      );
      stackContext.studio = studio;

      await waitForHttpReady(`${studioBaseUrl.origin}${SDK_BROWSER_STUDIO_READY_PATH}`, studio, {
        validateBody: validateStudioE2EReadiness,
      });
      log('Isolated SDK browser E2E stack ready', {
        studio: studioBaseUrl.origin,
        runtime: runtimeBaseUrl.origin,
        mongoDatabase,
      });

      await new Promise<void>((resolve, reject) => {
        const terminate = () => resolve();

        process.on('SIGINT', terminate);
        process.on('SIGTERM', terminate);

        runtime.child.once('exit', (code, signal) => {
          if (!shuttingDown) {
            reject(
              new Error(
                `runtime exited unexpectedly code=${String(code)} signal=${String(signal)}${buildRecentLogSuffix(runtime)}`,
              ),
            );
          }
        });

        studio.child.once('exit', (code, signal) => {
          if (!shuttingDown) {
            reject(
              new Error(
                `studio exited unexpectedly code=${String(code)} signal=${String(signal)}${buildRecentLogSuffix(studio)}`,
              ),
            );
          }
        });
      });
    } finally {
      await shutdownStack(stackContext);
    }
  } finally {
    await infraLock.release();
  }
}

void main().catch((error) => {
  log('SDK browser E2E stack failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
