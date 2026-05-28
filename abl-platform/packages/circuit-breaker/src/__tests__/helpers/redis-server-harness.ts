import net from 'node:net';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Redis from 'ioredis';

export interface RedisServerHarness {
  url: string;
  clear(): Promise<void>;
  close(): Promise<void>;
}

let nextDb = 1;
let redisServerBinaryAvailable: boolean | null = null;

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
    process.once('exit', () => resolve());
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

export async function startRedisServerHarness(): Promise<RedisServerHarness> {
  const externalUrl = process.env['REDIS_URL'];
  if (externalUrl) {
    return startExternalRedisHarness(externalUrl);
  }

  if (!hasRedisServerBinary()) {
    throw new Error(
      'redis-server is not installed and REDIS_URL is not set. ' +
        'Either install redis-server locally or set REDIS_URL to a running Redis instance.',
    );
  }

  return startSpawnedRedisHarness();
}

export function isRedisServerHarnessAvailable(): boolean {
  return Boolean(process.env['REDIS_URL']) || hasRedisServerBinary();
}
