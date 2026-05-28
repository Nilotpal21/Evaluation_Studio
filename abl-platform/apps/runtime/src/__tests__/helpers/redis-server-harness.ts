import net from 'node:net';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Redis from 'ioredis';

export interface RedisServerHarness {
  url: string;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Use an already-running Redis instance (e.g. the CI sidecar).
 *
 * Each harness gets its own Redis DB number (0-15) so parallel test suites
 * within the same worker don't collide.  `clear()` flushes only that DB.
 */
let nextDb = 1; // DB 0 is the default — avoid it to dodge accidental cross-talk
let redisServerBinaryAvailable: boolean | null = null;
const DEFAULT_REDIS_HOST = '127.0.0.1';
const DEFAULT_EXTERNAL_REDIS_PORT = '6379';
const FALLBACK_EXTERNAL_REDIS_URLS = [
  `redis://${DEFAULT_REDIS_HOST}:${DEFAULT_EXTERNAL_REDIS_PORT}`,
  `redis://localhost:${DEFAULT_EXTERNAL_REDIS_PORT}`,
];

function hasRedisServerBinary(): boolean {
  if (redisServerBinaryAvailable !== null) {
    return redisServerBinaryAvailable;
  }

  try {
    execFileSync('which', ['redis-server'], { stdio: 'ignore' });
    redisServerBinaryAvailable = true;
  } catch {
    redisServerBinaryAvailable = false;
  }

  return redisServerBinaryAvailable;
}

function buildRedisUrlFromHostConfig(): string | null {
  const host = process.env['REDIS_HOST'];
  const port = process.env['REDIS_PORT'];
  const password = process.env['REDIS_PASSWORD'];

  if (!host && !port && !password) {
    return null;
  }

  const url = new URL(
    `redis://${host || DEFAULT_REDIS_HOST}:${port || DEFAULT_EXTERNAL_REDIS_PORT}`,
  );
  if (password) {
    url.password = password;
  }
  return url.toString();
}

function getExternalRedisCandidates(): string[] {
  const candidates = [process.env['REDIS_URL'], buildRedisUrlFromHostConfig()].filter(
    (value): value is string => Boolean(value),
  );

  if (candidates.length > 0) {
    return [...new Set(candidates)];
  }

  return [...FALLBACK_EXTERNAL_REDIS_URLS];
}

async function startExternalRedisHarness(baseUrl: string): Promise<RedisServerHarness> {
  const db = nextDb++ % 16;
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${db}`;
  const url = parsed.toString();

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: null,
    connectTimeout: 1_000,
  });
  await client.connect();
  await client.flushdb();

  return {
    url,
    async clear() {
      await client.flushdb();
    },
    async close() {
      await client.flushdb();
      await client.quit().catch(async () => {
        await client.disconnect();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Spawned redis-server (local development without a running Redis)
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }

      const port = address.port;
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

async function waitForRedis(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: null,
    });
    client.on('error', () => {
      // Connection refusal is expected while the server is still starting.
    });

    try {
      await client.connect();
      await client.ping();
      await client.quit();
      return;
    } catch {
      await client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('Timed out waiting for redis-server to accept connections');
}

async function stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    process.once('exit', onExit);
    process.kill('SIGTERM');

    setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL');
      }
    }, 2_000);
  });
}

async function startSpawnedRedisHarness(): Promise<RedisServerHarness> {
  const port = await getFreePort();
  const url = `redis://127.0.0.1:${port}`;

  const child = spawn(
    'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--save',
      '',
      '--appendonly',
      'no',
      '--protected-mode',
      'no',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
        LC_CTYPE: 'C',
      },
    },
  );

  const stdout: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk.toString('utf8'));
  });
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'));
  });

  await waitForRedis(url, 10_000).catch(async (error) => {
    await stopProcess(child);
    throw new Error(
      `Failed to start redis-server: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout.join('')}${stderr.join('')}`,
    );
  });

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: null,
  });
  await client.connect();

  return {
    url,
    async clear() {
      await client.flushall();
    },
    async close() {
      await client.quit().catch(async () => {
        await client.disconnect();
      });
      await stopProcess(child);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a Redis harness for tests.
 *
 * When `REDIS_URL` is set (e.g. CI sidecar at redis://localhost:6379), reuses
 * that instance with a dedicated DB number per harness for isolation.
 * Otherwise falls back to spawning a local `redis-server` process.
 */
export async function startRedisServerHarness(): Promise<RedisServerHarness> {
  const explicitExternalRedisConfigured =
    Boolean(process.env['REDIS_URL']) ||
    Boolean(process.env['REDIS_HOST']) ||
    Boolean(process.env['REDIS_PORT']) ||
    Boolean(process.env['REDIS_PASSWORD']);

  const candidateErrors: string[] = [];
  for (const candidate of getExternalRedisCandidates()) {
    try {
      return await startExternalRedisHarness(candidate);
    } catch (error) {
      candidateErrors.push(
        `${candidate} (${error instanceof Error ? error.message : String(error)})`,
      );
      if (explicitExternalRedisConfigured) {
        break;
      }
    }
  }

  if (!hasRedisServerBinary()) {
    throw new Error(
      'redis-server is not installed and no external Redis instance was reachable. ' +
        `Attempted: ${candidateErrors.join('; ')}. ` +
        'Either install redis-server locally or configure REDIS_URL/REDIS_HOST/REDIS_PORT for a running Redis instance.',
    );
  }

  return startSpawnedRedisHarness();
}

/**
 * Whether the current environment can provide a Redis harness for integration/E2E tests.
 */
export function isRedisServerHarnessAvailable(): boolean {
  return (
    Boolean(process.env['REDIS_URL'] || buildRedisUrlFromHostConfig()) || hasRedisServerBinary()
  );
}
