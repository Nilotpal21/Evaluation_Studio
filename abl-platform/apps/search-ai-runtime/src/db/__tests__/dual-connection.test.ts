/**
 * Regression test for ABLP-873.
 *
 * Contract under test:
 *   SearchAIDualConnection.initialize() MUST connect the default
 *   `mongoose.connection` (the platform DB), so models bound at
 *   module-import time to `mongoose.connection` (notably DEKEntry, used by
 *   the encryption plugin's post-find decrypt hook) can actually be queried.
 *
 * Before the fix, SearchAIDualConnection used `mongoose.createConnection()`
 * for both DBs, leaving the default unconnected. DEKEntry queries then
 * buffered for `bufferTimeoutMS` (10s default) and timed out, taking
 * 20+ seconds for a single LLMCredential.findOne and silently nulling the
 * decrypted fields.
 *
 * The test guards three things:
 *   1. After init, mongoose.connection.readyState === 1 (connected).
 *   2. getPlatformConnection() returns mongoose.connection (not a separate
 *      named connection).
 *   3. A trivial query against a default-bound model completes promptly
 *      and does NOT raise the buffering timeout error.
 *
 * Anyone who reverts to `mongoose.createConnection()` for the platform DB
 * will fail (1) and (3); anyone who keeps the wiring but accidentally
 * returns a different connection instance from getPlatformConnection() will
 * fail (2).
 *
 * Requires MongoMemoryServer; skips automatically if the binary can't be
 * downloaded (mirrors the helpers/setup-mongo.ts pattern).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database';
import { SearchAIDualConnection } from '../dual-connection.js';

let mongod: MongoMemoryServer | null = null;
let mongoAvailable = false;

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const PLATFORM_DB = 'abl_platform_test';
const CONTENT_DB = 'search_ai_test';

function buildConfig(url: string, database: string, appName: string): MongoDBConfig {
  return {
    enabled: true,
    url,
    database,
    appName,
    minPoolSize: 1,
    maxPoolSize: 5,
    maxIdleTimeMs: 30_000,
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 45_000,
    serverSelectionTimeoutMs: 10_000,
    heartbeatFrequencyMs: 10_000,
    tls: false,
    tlsAllowInvalidCertificates: false,
    authSource: 'admin',
    writeConcern: 'majority',
    readPreference: 'primary',
    retryWrites: true,
    retryReads: true,
    directConnection: true,
    autoIndex: true,
    slowQueryThresholdMs: 200,
  };
}

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGO_VERSION },
      instance: { launchTimeout: 60_000 },
    });
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[TEST] MongoMemoryServer unavailable — dual-connection regression test will be skipped',
      err,
    );
  }
}, 120_000);

afterAll(async () => {
  try {
    await SearchAIDualConnection.getInstance().disconnect();
  } catch {
    // already disconnected, or never initialised — fine
  }
  await MongoConnectionManager.reset().catch(() => {});

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect().catch(() => {});
  }
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}, 60_000);

describe('SearchAIDualConnection (ABLP-873 regression)', () => {
  it('connects the default mongoose.connection so module-level model bindings work', async (ctx) => {
    if (!mongoAvailable || !mongod) return ctx.skip();

    expect(mongoose.connection.readyState).toBe(0);

    const url = mongod.getUri();
    await SearchAIDualConnection.initialize({
      platformDb: buildConfig(url, PLATFORM_DB, 'search-ai-runtime-test-platform'),
      contentDb: buildConfig(url, CONTENT_DB, 'search-ai-runtime-test-content'),
    });

    // (1) Default mongoose.connection MUST be connected.
    expect(mongoose.connection.readyState).toBe(1);
    expect(mongoose.connection.name).toBe(PLATFORM_DB);
  });

  it('getPlatformConnection() returns the default mongoose.connection (same identity)', async (ctx) => {
    if (!mongoAvailable) return ctx.skip();

    const platformConn = SearchAIDualConnection.getInstance().getPlatformConnection();

    // (2) Must be the SAME object as the default — not a separate named
    // connection. If it's not, models bound at module load (DEKEntry, etc.)
    // will still be on a different connection and buffer-timeout on first
    // query.
    expect(platformConn).toBe(mongoose.connection);
  });

  it('a model bound to default mongoose.connection responds without buffer timeout', async (ctx) => {
    if (!mongoAvailable) return ctx.skip();

    // Bind a tiny ad-hoc model to the DEFAULT mongoose connection — same
    // pattern as DEKEntry / setMasterKey models that are registered at
    // module-import time before any explicit connect() call.
    const ProbeSchema = new mongoose.Schema({ key: String, value: String });
    const Probe =
      (mongoose.models['__abl873_probe'] as mongoose.Model<{ key: string; value: string }>) ||
      mongoose.model<{ key: string; value: string }>('__abl873_probe', ProbeSchema);

    const t = Date.now();
    // The query against a non-existent key is the canonical reproducer:
    // before the fix, this took ~10 000 ms and threw
    // `Operation \`...\` buffering timed out after 10000ms` because the
    // default connection wasn't connected.
    const result = await Probe.findOne({ key: 'never-exists' }).lean();
    const ms = Date.now() - t;

    // (3) Threshold is intentionally loose — we just need to prove the
    // query DID NOT hit the 10 s buffering timeout. Anything under 5 s is
    // well outside the failure mode.
    expect(result).toBeNull();
    expect(ms).toBeLessThan(5_000);
  });

  it('the named content connection is separate from the default', async (ctx) => {
    if (!mongoAvailable) return ctx.skip();

    const contentConn = SearchAIDualConnection.getInstance().getContentConnection();

    expect(contentConn).not.toBe(mongoose.connection);
    expect(contentConn.readyState).toBe(1);
    expect(contentConn.name).toBe(CONTENT_DB);
  });
});
