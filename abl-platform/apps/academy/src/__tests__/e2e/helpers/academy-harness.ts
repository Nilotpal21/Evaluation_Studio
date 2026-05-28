/**
 * Academy E2E Test Harness
 *
 * Starts the full Express app with a MongoMemoryServer backend.
 * Tests exercise the real HTTP API with real middleware (auth, validation, error handling).
 * No mocks — only real servers and real MongoDB.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PLATFORM_ACCESS_TOKEN_AUDIENCE, PLATFORM_JWT_ISSUER } from '@agent-platform/shared-auth';

const TEST_JWT_SECRET = 'academy-e2e-test-secret-0123456789abcdef';

// Set env vars before any lazy config reads
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: TEST_JWT_SECRET,
});

export interface AcademyHarness {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Start the full academy Express app against an in-memory MongoDB instance.
 */
export async function startAcademyHarness(): Promise<AcademyHarness> {
  // 1. Start MongoDB Memory Server
  const mongod = await MongoMemoryServer.create({
    instance: { launchTimeout: 30_000 },
  });
  const mongoUri = mongod.getUri();
  process.env.MONGODB_URL = mongoUri;

  // 2. Reset any prior MongoConnectionManager state (singleton)
  const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
  await MongoConnectionManager.reset();

  // 3. Initialize MongoDB backend (connects + wires academy services)
  const { initMongoBackend, disconnectDatabase } = await import('../../../lib/db.js');
  await initMongoBackend(
    {
      enabled: true,
      url: mongoUri,
      database: 'academy_e2e',
      minPoolSize: 1,
      maxPoolSize: 5,
      maxIdleTimeMs: 10_000,
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 10_000,
      serverSelectionTimeoutMs: 10_000,
      heartbeatFrequencyMs: 10_000,
      tls: false,
      tlsAllowInvalidCertificates: false,
      authSource: 'admin',
      writeConcern: '1',
      readPreference: 'primary',
      retryWrites: true,
      retryReads: true,
      directConnection: true,
      autoIndex: true,
      slowQueryThresholdMs: 250,
      appName: 'academy-e2e',
    },
    // contentRoot — omit to let resolveContentRoot() find packages/academy/content/
    undefined,
  );

  // 4. Import the Express app (middleware closures read config lazily)
  const { app } = await import('../../../server.js');

  // 5. Start HTTP server on random port
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await disconnectDatabase();
      await MongoConnectionManager.reset();
      await mongod.stop();
    },
  };
}

/**
 * Mint a JWT access token for a test user.
 * The dev-mode auth fallback returns a synthetic AuthUser for any userId.
 */
export function mintToken(userId: string, extra?: Record<string, unknown>): string {
  return jwt.sign(
    { type: 'access', sub: userId, email: `${userId}@test.local`, ...extra },
    TEST_JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: PLATFORM_JWT_ISSUER,
      audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
    },
  );
}

/** Standard auth headers for fetch requests. */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
