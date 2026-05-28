import http from 'http';
import { createServer as createNetServer, type AddressInfo } from 'net';
import crypto from 'crypto';
import express, { type Express } from 'express';
import mongoose from 'mongoose';
import { signSDKSessionToken } from '@agent-platform/shared-auth';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { requestIdMiddleware } from '@agent-platform/shared-observability';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import { initMongoBackend, disconnectDatabase } from '../../db/index.js';
import { reloadConfig } from '../../config/index.js';
import {
  clearRuntimeContactLinking,
  initializeRuntimeContactLinking,
} from '../../contexts/contact/runtime-contact-context.js';
import { getRedisClient } from '../../services/redis/redis-client.js';
import type { RedisTicketClient } from '../../services/identity/sdk-ws-ticket-store.js';

const TEST_JWT_SECRET = '1'.repeat(64);
const TEST_MASTER_KEY = '2'.repeat(64);
export const TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET = '5'.repeat(64);
export const TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET = '6'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGOMS_LAUNCH_TIMEOUT_MS = 30_000;
const MONGOMS_START_RETRY_LIMIT = 3;
const MONGOMS_START_RETRY_BACKOFF_MS = 250;
const ASYNC_INFRA_INIT_TIMEOUT_MS = 30_000;
const TEST_MONGO_MAX_POOL_SIZE = Number(process.env.TEST_MONGO_MAX_POOL_SIZE ?? '5');
const TEST_MONGO_DATABASE_PREFIX = 'abl_platform_test';

/** Max time to wait for shutdownRuntimeServer before proceeding to env teardown. */
const HARNESS_SHUTDOWN_TIMEOUT_MS = 30_000;

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'DATABASE_URL',
  'MONGODB_URL',
  'MONGODB_DATABASE',
  'JWT_SECRET',
  'AUTH_SDK_SESSION_SIGNING_SECRET',
  'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
  'AUTH_SDK_JWE_ENABLED',
  'AUTH_SDK_JWE_MAX_ENCRYPTED_BOOTSTRAP_BYTES',
  'AUTH_SDK_JWE_MAX_ENCRYPTED_SESSION_BYTES',
  'ENCRYPTION_MASTER_KEY',
  'REDIS_ENABLED',
  'REDIS_URL',
  'SUPER_ADMIN_USER_IDS',
  'PLATFORM_ADMIN_ALLOWED_IPS',
  'EMAIL_INBOUND_DOMAIN',
  'RUNTIME_PUBLIC_BASE_URL',
  'CALLBACK_BASE_URL',
  'ALLOW_INMEMORY_ASYNC_INFRA',
  'SESSION_TERMINALIZATION_ENABLED',
  'SESSION_CLEANUP_TTL_HOURS',
  'MESSAGE_CLEANUP_TTL_HOURS',
  'CLEANUP_INTERVAL_MINUTES',
  'SESSION_TIMEOUT_SWEEP_ENABLED',
  'SESSION_TIMEOUT_SWEEP_INTERVAL_MINUTES',
  'MULTIMODAL_SERVICE_URL',
  'FEATURE_LIVEKIT_ENABLED',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LINE_API_BASE_URL',
  'LINE_DATA_API_BASE_URL',
  'TELEGRAM_API_BASE_URL',
  'SLACK_API_BASE_URL',
  'TWILIO_API_BASE_URL',
  'JAMBONZ_BASE_API_URL',
  'JAMBONZ_ACCOUNT_SID',
  'JAMBONZ_API_KEY',
  'JAMBONZ_VOIP_CARRIER_SID',
  'JAMBONZ_SERVICE_PROVIDER_ID',
  'JAMBONZ_SERVICE_PROVIDER_API_KEY',
  'JAMBONZ_SBC_ADDRESS',
  'JAMBONZ_SBC_WS_ADDRESS',
  'ALLOW_SSRF_PRIVATE_RANGES',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];
export type RuntimeHarnessEnvOverrides = Partial<Record<ManagedEnvKey, string | undefined>>;

export interface RuntimeApiHarness {
  app: Express;
  server: http.Server;
  baseUrl: string;
  mongoUri: string;
  resetRuntimeState(): Promise<void>;
  close(): Promise<void>;
}

interface PreparedRuntimeHarnessEnvironment {
  previousEnv: Record<ManagedEnvKey, string | undefined>;
  previousAutoCreate: boolean | undefined;
  mongod?: MongoMemoryServer;
  mongoUri: string;
  mongoLifecycle: 'external' | 'isolated' | 'shared';
}

export interface RuntimeHarnessOptions {
  mongoUri?: string;
  mongoDatabase?: string;
  autoIndex?: boolean;
  requireAsyncInfra?: boolean;
  bootstrapServer?: boolean;
  allowPrivateEndpoints?: boolean;
}

interface AsyncInfraBootstrapHandle {
  shutdownRuntimeServer?: (options?: { exitProcess?: boolean }) => Promise<void>;
  harnessSigtermListeners: Function[];
  harnessSigintListeners: Function[];
}

interface ConfigureHarnessBaseUrlOptions {
  bootstrapMode?: 'import' | 'wait';
}

interface SharedHarnessMongoState {
  mongod: MongoMemoryServer;
  uri: string;
  autoIndexPrimedDatabases: Set<string>;
}

let sharedHarnessMongoState: SharedHarnessMongoState | null = null;
let sharedHarnessMongoStatePromise: Promise<SharedHarnessMongoState> | null = null;
let sharedHarnessMongoCleanupRegistered = false;

class InMemorySdkWsTicketRedisClient implements RedisTicketClient {
  private readonly entries = new Map<string, { value: string; expiresAtMs: number }>();

  async set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null> {
    if (mode !== 'EX' || condition !== 'NX') {
      return null;
    }

    const existing = this.entries.get(key);
    if (existing && existing.expiresAtMs > Date.now()) {
      return null;
    }

    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    });
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAtMs <= Date.now()) {
      return null;
    }
    return entry.value;
  }

  clear(): void {
    this.entries.clear();
  }
}

const runtimeHarnessWsTicketRedis = new InMemorySdkWsTicketRedisClient();

async function installRuntimeHarnessWsTicketStore(): Promise<void> {
  runtimeHarnessWsTicketRedis.clear();
  const { setSdkWsTicketRedisClientForTesting } =
    await import('../../services/identity/sdk-ws-ticket-store.js');
  setSdkWsTicketRedisClientForTesting(runtimeHarnessWsTicketRedis);
}

async function uninstallRuntimeHarnessWsTicketStore(): Promise<void> {
  runtimeHarnessWsTicketRedis.clear();
  const { setSdkWsTicketRedisClientForTesting } =
    await import('../../services/identity/sdk-ws-ticket-store.js');
  setSdkWsTicketRedisClientForTesting(null);
}

function snapshotEnv(): Record<ManagedEnvKey, string | undefined> {
  const snapshot = {} as Record<ManagedEnvKey, string | undefined>;
  for (const key of MANAGED_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<ManagedEnvKey, string | undefined>): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of MANAGED_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete env[key];
    } else {
      env[key] = snapshot[key];
    }
  }
}

function registerSharedHarnessMongoCleanup(): void {
  if (sharedHarnessMongoCleanupRegistered) {
    return;
  }

  sharedHarnessMongoCleanupRegistered = true;
  process.once('beforeExit', () => {
    if (!sharedHarnessMongoState) {
      return;
    }

    void sharedHarnessMongoState.mongod.stop().catch(() => {
      /* best-effort process cleanup */
    });
    sharedHarnessMongoState = null;
    sharedHarnessMongoStatePromise = null;
  });
}

async function createSharedHarnessMongoState(): Promise<SharedHarnessMongoState> {
  const mongod = await createMongoMemoryServerWithRetry();

  return {
    mongod,
    uri: mongod.getUri(),
    autoIndexPrimedDatabases: new Set<string>(),
  };
}

function sanitizeMongoDatabaseNamePart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'worker'
  );
}

function getRuntimeHarnessMongoDatabaseName(appName: string, explicitDatabase?: string): string {
  if (explicitDatabase) {
    return explicitDatabase;
  }

  if (process.env.TEST_MONGODB_DATABASE) {
    return process.env.TEST_MONGODB_DATABASE;
  }

  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.env.JEST_WORKER_ID;
  const workerPart = sanitizeMongoDatabaseNamePart(workerId ?? String(process.pid));
  const appPart = sanitizeMongoDatabaseNamePart(appName);

  return `${TEST_MONGO_DATABASE_PREFIX}_${appPart}_${workerPart}`;
}

function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('already in use') || message.includes('eaddrinuse');
}

async function createMongoMemoryServerWithRetry(): Promise<MongoMemoryServer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MONGOMS_START_RETRY_LIMIT; attempt++) {
    try {
      return await MongoMemoryServer.create({
        binary: { version: MONGOMS_VERSION },
        instance: { launchTimeout: MONGOMS_LAUNCH_TIMEOUT_MS },
      });
    } catch (error) {
      lastError = error;

      if (!isPortInUseError(error) || attempt === MONGOMS_START_RETRY_LIMIT) {
        throw error;
      }

      console.warn(
        `[TEST] MongoMemoryServer port conflict; retrying runtime harness startup (${attempt + 1}/${MONGOMS_START_RETRY_LIMIT})`,
      );
      await new Promise((resolve) => setTimeout(resolve, MONGOMS_START_RETRY_BACKOFF_MS * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('MongoMemoryServer failed to start after retry attempts');
}

async function getSharedHarnessMongoState(): Promise<SharedHarnessMongoState> {
  if (sharedHarnessMongoState) {
    return sharedHarnessMongoState;
  }

  if (!sharedHarnessMongoStatePromise) {
    sharedHarnessMongoStatePromise = createSharedHarnessMongoState()
      .then((state) => {
        sharedHarnessMongoState = state;
        registerSharedHarnessMongoCleanup();
        return state;
      })
      .catch((error) => {
        sharedHarnessMongoStatePromise = null;
        throw error;
      });
  }

  return sharedHarnessMongoStatePromise;
}

async function loadFreshRuntimeServerModule() {
  const moduleUrl = new URL('../../server.js', import.meta.url);
  // Force a fresh server module instance per harness so test suites do not
  // share singleton Express/WebSocket state across imports in the same worker.
  moduleUrl.searchParams.set('runtimeHarness', crypto.randomUUID());
  return import(moduleUrl.href);
}

function diffProcessListeners(signal: NodeJS.Signals, baseline: Function[]): Function[] {
  const baselineSet = new Set(baseline);
  return process.listeners(signal).filter((listener) => !baselineSet.has(listener));
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function clearRuntimeMongoCollections(): Promise<void> {
  try {
    const manager = MongoConnectionManager.getInstance();
    const db = manager.connection.db;
    if (!db) {
      return;
    }

    const collections = await db.listCollections().toArray();
    await Promise.all(
      collections
        .filter((collection) => !collection.name.startsWith('system.'))
        .map((collection) => db.collection(collection.name).deleteMany({})),
    );
  } catch {
    /* ignore */
  }
}

async function cleanupRuntimeState(options: { clearDatabase?: boolean } = {}): Promise<void> {
  const { clearDatabase = true } = options;

  runtimeHarnessWsTicketRedis.clear();

  try {
    const { resetHybridRateLimiter } =
      await import('../../services/resilience/hybrid-rate-limiter.js');
    resetHybridRateLimiter();
  } catch {
    /* ignore */
  }

  try {
    const { clearProviderCache } = await import('../../services/llm/index.js');
    clearProviderCache();
  } catch {
    /* ignore */
  }

  try {
    const { getTraceStore } = await import('../../services/trace-store.js');
    const traceStore = getTraceStore();
    const { getRuntimeExecutor } = await import('../../services/runtime-executor.js');
    const executor = getRuntimeExecutor();
    for (const session of executor.listSessions()) {
      try {
        executor.endSession(session.id);
      } catch {
        /* ignore */
      }
      try {
        traceStore.removeSession(session.id);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const { flushBufferedPersistenceOnShutdown } =
      await import('../../services/runtime-shutdown-flush.js');
    await flushBufferedPersistenceOnShutdown();
  } catch {
    /* ignore */
  }

  try {
    const { shutdownMessageQueue } = await import('../../services/message-persistence-queue.js');
    await shutdownMessageQueue();
  } catch {
    /* ignore */
  }

  try {
    const { shutdownLLMQueue } = await import('../../services/llm/llm-queue.js');
    await shutdownLLMQueue();
  } catch {
    /* ignore */
  }

  try {
    const { getToolOAuthService, resetToolOAuthService } =
      await import('../../services/tool-oauth-service-singleton.js');
    getToolOAuthService()?.destroy();
    resetToolOAuthService();
  } catch {
    /* ignore */
  }

  try {
    const { resetPausedExecutionStore } =
      await import('../../services/auth-profile/paused-execution-store.js');
    resetPausedExecutionStore();
  } catch {
    /* ignore */
  }

  try {
    const { resetBudgetEnforcer } = await import('../../services/llm/budget-enforcement.js');
    resetBudgetEnforcer();
  } catch {
    /* ignore */
  }

  try {
    const { resetPIIAuditLogger } = await import('../../services/execution/pii-audit-singleton.js');
    resetPIIAuditLogger();
  } catch {
    /* ignore */
  }

  try {
    const { shutdownAuditStore, _resetAuditStore } =
      await import('../../services/audit-store-singleton.js');
    await shutdownAuditStore();
    _resetAuditStore();
  } catch {
    /* ignore */
  }

  try {
    const { _resetEventStore } = await import('../../services/eventstore-singleton.js');
    _resetEventStore();
  } catch {
    /* ignore */
  }

  try {
    const { resetTraceStore } = await import('../../services/trace-store.js');
    resetTraceStore();
  } catch {
    /* ignore */
  }

  try {
    const { closeClickHouseClient } = await import('@agent-platform/database/clickhouse');
    await closeClickHouseClient();
  } catch {
    /* ignore */
  }

  if (clearDatabase) {
    await clearRuntimeMongoCollections();
  }
}

async function initializeRuntimeHarnessAuditStore(): Promise<void> {
  const { getAuditStore, initializeAuditStore, _resetAuditStore } =
    await import('../../services/audit-store-singleton.js');

  if (getAuditStore()) {
    return;
  }

  _resetAuditStore();
  await initializeAuditStore({ clickhouseReady: false });
}

async function initializeRuntimeTestEncryption(): Promise<void> {
  const { setMasterKey, _resetEncryptionStateForTesting } =
    await import('@agent-platform/database/models');
  const { initDEKFacade, setGlobalKMSResolver } = await import('@agent-platform/database/kms');

  _resetEncryptionStateForTesting();
  setMasterKey(TEST_MASTER_KEY);

  const dek = await initDEKFacade({ masterKeyHex: TEST_MASTER_KEY });
  setGlobalKMSResolver(dek.resolver);
}

async function resetRuntimeTestEncryption(): Promise<void> {
  try {
    const { getGlobalKMSResolver, clearGlobalKMSResolver } =
      await import('@agent-platform/database/kms');
    const resolver = getGlobalKMSResolver();
    if (resolver) {
      await resolver.shutdown();
      clearGlobalKMSResolver();
    }
  } catch {
    /* ignore */
  }

  try {
    const { shutdownKMSRegistry, _resetKMSRegistryForTesting } =
      await import('@agent-platform/database/kms');
    await shutdownKMSRegistry();
    _resetKMSRegistryForTesting();
  } catch {
    /* ignore */
  }

  try {
    const { _resetEncryptionStateForTesting } = await import('@agent-platform/database/models');
    _resetEncryptionStateForTesting();
  } catch {
    /* ignore */
  }

  try {
    const { _resetEncryptionServiceForTesting } = await import('@agent-platform/shared-encryption');
    _resetEncryptionServiceForTesting();
  } catch {
    /* ignore */
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const portServer = createNetServer();
    portServer.unref();
    portServer.on('error', reject);
    portServer.listen(0, '127.0.0.1', () => {
      const address = portServer.address();
      if (!address || typeof address === 'string') {
        portServer.close(() => reject(new Error('Failed to reserve loopback port')));
        return;
      }

      const port = address.port;
      portServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function prepareRuntimeHarnessEnvironment(
  envOverrides: RuntimeHarnessEnvOverrides,
  appName: string,
  options: RuntimeHarnessOptions = {},
): Promise<PreparedRuntimeHarnessEnvironment> {
  const previousEnv = snapshotEnv();
  const previousAutoCreate = mongoose.get('autoCreate') as boolean | undefined;
  let mongod: MongoMemoryServer | undefined;
  let mongoUri: string;
  let mongoLifecycle: 'external' | 'isolated' | 'shared';
  let autoIndex = options.autoIndex ?? true;
  const mongoDatabase = getRuntimeHarnessMongoDatabaseName(appName, options.mongoDatabase);

  if (options.mongoUri) {
    mongoUri = options.mongoUri;
    mongoLifecycle = 'external';
  } else {
    const sharedMongo = await getSharedHarnessMongoState();
    mongoUri = sharedMongo.uri;
    mongoLifecycle = 'shared';
    autoIndex = options.autoIndex ?? !sharedMongo.autoIndexPrimedDatabases.has(mongoDatabase);
    sharedMongo.autoIndexPrimedDatabases.add(mongoDatabase);
  }
  const reservedPort = options.bootstrapServer ? await reserveLoopbackPort() : undefined;

  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'test';
  if (reservedPort !== undefined) {
    env.PORT = String(reservedPort);
    env.HOST = '127.0.0.1';
  } else {
    delete env.PORT;
    delete env.HOST;
  }
  env.DATABASE_URL = mongoUri;
  env.MONGODB_URL = mongoUri;
  env.MONGODB_DATABASE = mongoDatabase;
  env.JWT_SECRET = TEST_JWT_SECRET;
  env.AUTH_SDK_SESSION_SIGNING_SECRET = TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET;
  env.AUTH_SDK_BOOTSTRAP_SIGNING_SECRET = TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET;
  env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  env.REDIS_ENABLED = 'false';
  env.SUPER_ADMIN_USER_IDS = '';
  env.PLATFORM_ADMIN_ALLOWED_IPS = '';
  env.EMAIL_INBOUND_DOMAIN = 'inbound.test.local';

  if (options.allowPrivateEndpoints) {
    env.ALLOW_SSRF_PRIVATE_RANGES = 'true';
  }

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  await MongoConnectionManager.reset();
  mongoose.set('autoCreate', false);
  await reloadConfig({ logSummary: false });

  await initMongoBackend({
    enabled: true,
    url: mongoUri,
    database: mongoDatabase,
    minPoolSize: 1,
    maxPoolSize: TEST_MONGO_MAX_POOL_SIZE,
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
    autoIndex,
    slowQueryThresholdMs: 250,
    appName,
  });

  await initializeRuntimeTestEncryption();
  await clearRuntimeMongoCollections();
  await initializeRuntimeHarnessAuditStore();
  await installRuntimeHarnessWsTicketStore();

  return {
    previousEnv,
    previousAutoCreate,
    mongod,
    mongoUri,
    mongoLifecycle,
  };
}

async function teardownRuntimeHarnessEnvironment(
  previousEnv: Record<ManagedEnvKey, string | undefined>,
  previousAutoCreate: boolean | undefined,
  mongod: MongoMemoryServer | undefined,
  mongoLifecycle: 'external' | 'isolated' | 'shared',
): Promise<void> {
  await uninstallRuntimeHarnessWsTicketStore();
  await resetRuntimeTestEncryption();
  await disconnectDatabase();
  await MongoConnectionManager.reset();
  mongoose.set('autoCreate', previousAutoCreate ?? true);
  if (mongoLifecycle === 'isolated' && mongod) {
    await mongod.stop();
  }
  restoreEnv(previousEnv);
}

async function finalizeRuntimeHarnessEnvironment(
  previousEnv: Record<ManagedEnvKey, string | undefined>,
  previousAutoCreate: boolean | undefined,
  mongod: MongoMemoryServer | undefined,
  mongoLifecycle: 'external' | 'isolated' | 'shared',
): Promise<void> {
  await uninstallRuntimeHarnessWsTicketStore();
  await resetRuntimeTestEncryption();
  await MongoConnectionManager.reset();
  mongoose.set('autoCreate', previousAutoCreate ?? true);
  if (mongoLifecycle === 'isolated' && mongod) {
    await mongod.stop();
  }
  restoreEnv(previousEnv);
}

async function shutdownAsyncInfraBootstrap(
  handle: AsyncInfraBootstrapHandle | undefined,
): Promise<void> {
  if (!handle) {
    return;
  }

  try {
    if (typeof handle.shutdownRuntimeServer === 'function') {
      await shutdownRuntimeServerWithTimeout(
        handle.shutdownRuntimeServer,
        'async-infra bootstrap shutdown',
      );
    }
  } finally {
    for (const listener of handle.harnessSigtermListeners) {
      process.off('SIGTERM', listener as (...args: unknown[]) => void);
    }
    for (const listener of handle.harnessSigintListeners) {
      process.off('SIGINT', listener as (...args: unknown[]) => void);
    }
  }
}

async function shutdownRuntimeServerWithTimeout(
  shutdownRuntimeServer: ((options?: { exitProcess?: boolean }) => Promise<void>) | undefined,
  warningContext: string,
): Promise<void> {
  if (typeof shutdownRuntimeServer !== 'function') {
    return;
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      shutdownRuntimeServer({ exitProcess: false }),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.warn(
            '[RuntimeApiHarness] %s exceeded %dms — proceeding to teardown',
            warningContext,
            HARNESS_SHUTDOWN_TIMEOUT_MS,
          );
          try {
            const redis = getRedisClient();
            if (redis) redis.disconnect();
          } catch {
            // Redis may already be gone — ignore
          }
          resolve();
        }, HARNESS_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function configureHarnessBaseUrls(
  baseUrl: string,
  requireAsyncInfra: boolean,
  options: ConfigureHarnessBaseUrlOptions = {},
): Promise<AsyncInfraBootstrapHandle | undefined> {
  process.env.RUNTIME_PUBLIC_BASE_URL = baseUrl;
  process.env.CALLBACK_BASE_URL = `${baseUrl}/a2a/callbacks`;
  await reloadConfig({ logSummary: false });

  if (!requireAsyncInfra) {
    return undefined;
  }

  const { getRuntimeExecutor } = await import('../../services/runtime-executor.js');
  const updateExistingAsyncInfraBaseUrl = (): boolean => {
    const existingAsyncInfra = getRuntimeExecutor().asyncInfra;
    if (!existingAsyncInfra) {
      return false;
    }

    getRuntimeExecutor().setAsyncInfra({
      ...existingAsyncInfra,
      callbackBaseUrl: process.env.CALLBACK_BASE_URL!,
    });
    return true;
  };

  if (updateExistingAsyncInfraBaseUrl()) {
    return undefined;
  }

  const deadline = Date.now() + ASYNC_INFRA_INIT_TIMEOUT_MS;
  if (options.bootstrapMode === 'wait') {
    while (Date.now() < deadline) {
      if (updateExistingAsyncInfraBaseUrl()) {
        return undefined;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error('Runtime async infrastructure did not initialize in time for test harness');
  }

  const sigtermListenersBeforeImport = process.listeners('SIGTERM');
  const sigintListenersBeforeImport = process.listeners('SIGINT');
  const runtimeServerModule = await loadFreshRuntimeServerModule();
  const bootstrapHandle: AsyncInfraBootstrapHandle = {
    shutdownRuntimeServer: runtimeServerModule.shutdownRuntimeServer as
      | ((options?: { exitProcess?: boolean }) => Promise<void>)
      | undefined,
    harnessSigtermListeners: diffProcessListeners('SIGTERM', sigtermListenersBeforeImport),
    harnessSigintListeners: diffProcessListeners('SIGINT', sigintListenersBeforeImport),
  };

  while (Date.now() < deadline) {
    if (updateExistingAsyncInfraBaseUrl()) {
      return bootstrapHandle;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await shutdownAsyncInfraBootstrap(bootstrapHandle);
  throw new Error('Runtime async infrastructure did not initialize in time for test harness');
}

function shouldRequireAsyncInfra(
  envOverrides: Partial<Record<ManagedEnvKey, string>>,
  options: RuntimeHarnessOptions,
): boolean {
  const envRequiresAsyncInfra =
    envOverrides.ALLOW_INMEMORY_ASYNC_INFRA === 'true' || envOverrides.REDIS_ENABLED === 'true';
  return options.requireAsyncInfra ?? envRequiresAsyncInfra;
}

export async function startRuntimeApiHarness(
  mountRoutes: (app: Express) => void,
  envOverrides: Partial<Record<ManagedEnvKey, string>> = {},
  options: RuntimeHarnessOptions = {},
): Promise<RuntimeApiHarness> {
  const { previousEnv, previousAutoCreate, mongod, mongoUri, mongoLifecycle } =
    await prepareRuntimeHarnessEnvironment(envOverrides, 'runtime-api-harness', options);

  const app = express();
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
      verify: (req: any, _res, buf) => {
        if (!req.rawBody) {
          req.rawBody = buf;
        }
      },
    }),
  );
  app.use(
    express.text({
      type: ['text/*', 'application/xml', 'application/csv'],
      limit: '2mb',
    }),
  );
  app.use(requestIdMiddleware());

  mountRoutes(app);

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let asyncInfraBootstrap: AsyncInfraBootstrapHandle | undefined;

  try {
    asyncInfraBootstrap = await configureHarnessBaseUrls(
      baseUrl,
      shouldRequireAsyncInfra(envOverrides, options),
    );
    await initializeRuntimeContactLinking({
      onAudit: async () => undefined,
    });
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await shutdownAsyncInfraBootstrap(asyncInfraBootstrap).catch(() => undefined);
    await teardownRuntimeHarnessEnvironment(
      previousEnv,
      previousAutoCreate,
      mongod,
      mongoLifecycle,
    );
    throw error;
  }

  return {
    app,
    server,
    baseUrl,
    mongoUri,
    async resetRuntimeState() {
      await cleanupRuntimeState();
      await initializeRuntimeHarnessAuditStore();
    },
    async close() {
      await cleanupRuntimeState();
      clearRuntimeContactLinking();
      await closeServer(server);
      await shutdownAsyncInfraBootstrap(asyncInfraBootstrap);
      await teardownRuntimeHarnessEnvironment(
        previousEnv,
        previousAutoCreate,
        mongod,
        mongoLifecycle,
      );
    },
  };
}

export async function startRuntimeServerHarness(
  envOverrides: RuntimeHarnessEnvOverrides = {},
  options: RuntimeHarnessOptions = {},
): Promise<RuntimeApiHarness> {
  const { previousEnv, previousAutoCreate, mongod, mongoUri, mongoLifecycle } =
    await prepareRuntimeHarnessEnvironment(envOverrides, 'runtime-server-harness', options);

  const sigtermListenersBeforeImport = process.listeners('SIGTERM');
  const sigintListenersBeforeImport = process.listeners('SIGINT');
  const runtimeServerModule = await loadFreshRuntimeServerModule();
  const app = runtimeServerModule.app as Express;
  const server = runtimeServerModule.server as http.Server;
  const startServer = runtimeServerModule.startServer as (() => Promise<void>) | undefined;
  const wss = runtimeServerModule.wss;
  const wssSDK = runtimeServerModule.wssSDK;
  const shutdownRuntimeServer = runtimeServerModule.shutdownRuntimeServer as (options?: {
    exitProcess?: boolean;
  }) => Promise<void>;
  const harnessSigtermListeners = diffProcessListeners('SIGTERM', sigtermListenersBeforeImport);
  const harnessSigintListeners = diffProcessListeners('SIGINT', sigintListenersBeforeImport);
  let asyncInfraBootstrap: AsyncInfraBootstrapHandle | undefined;

  try {
    if (options.bootstrapServer) {
      if (typeof startServer !== 'function') {
        throw new Error('Runtime server bootstrap requested, but startServer is unavailable');
      }
      await startServer();
    }

    if (server.listening) {
      await closeServer(server);
    }

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    asyncInfraBootstrap = await configureHarnessBaseUrls(
      baseUrl,
      shouldRequireAsyncInfra(envOverrides, options),
      { bootstrapMode: 'wait' },
    );
    await initializeRuntimeContactLinking({
      onAudit: async () => undefined,
    });

    return {
      app,
      server,
      baseUrl,
      mongoUri,
      async resetRuntimeState() {
        await cleanupRuntimeState();
        await initializeRuntimeHarnessAuditStore();
      },
      async close() {
        await cleanupRuntimeState();
        for (const client of wss.clients) {
          client.terminate();
        }
        for (const client of wssSDK.clients) {
          client.terminate();
        }

        try {
          // shutdownRuntimeServer has no internal timeout when exitProcess=false.
          // Race against a deadline so teardown can't hang forever (e.g. when
          // Redis is on a dummy port and disconnect/flush operations stall).
          await shutdownRuntimeServerWithTimeout(shutdownRuntimeServer, 'shutdownRuntimeServer');
          await shutdownAsyncInfraBootstrap(asyncInfraBootstrap);
        } finally {
          clearRuntimeContactLinking();
          for (const listener of harnessSigtermListeners) {
            process.off('SIGTERM', listener as (...args: unknown[]) => void);
          }
          for (const listener of harnessSigintListeners) {
            process.off('SIGINT', listener as (...args: unknown[]) => void);
          }
          await finalizeRuntimeHarnessEnvironment(
            previousEnv,
            previousAutoCreate,
            mongod,
            mongoLifecycle,
          );
        }
      },
    };
  } catch (error) {
    try {
      await shutdownRuntimeServerWithTimeout(
        shutdownRuntimeServer,
        'startup cleanup shutdownRuntimeServer',
      ).catch(() => undefined);
      await shutdownAsyncInfraBootstrap(asyncInfraBootstrap).catch(() => undefined);
      await closeServer(server).catch(() => undefined);
      clearRuntimeContactLinking();
    } finally {
      for (const listener of harnessSigtermListeners) {
        process.off('SIGTERM', listener as (...args: unknown[]) => void);
      }
      for (const listener of harnessSigintListeners) {
        process.off('SIGINT', listener as (...args: unknown[]) => void);
      }
      await finalizeRuntimeHarnessEnvironment(
        previousEnv,
        previousAutoCreate,
        mongod,
        mongoLifecycle,
      ).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Mint an SDK session JWT for E2E test use using the same signer Runtime uses
 * for issued SDK session tokens.
 */
export function mintSdkSessionToken(opts: {
  tenantId: string;
  projectId: string;
  channelId: string;
  sessionId: string;
  contactId?: string;
  identityTier?: number;
  permissions?: string[];
}): string {
  const payload = {
    type: 'sdk_session',
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    channelId: opts.channelId,
    sessionId: opts.sessionId,
    contactId: opts.contactId,
    identityTier: opts.identityTier ?? 2,
    source: 'sdk',
    permissions: opts.permissions ?? ['session:read', 'session:send_message'],
    userContext: { userId: `test-user-${crypto.randomUUID().slice(0, 8)}` },
  };
  return signSDKSessionToken(payload, TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET, {
    expiresIn: '1h',
  });
}
