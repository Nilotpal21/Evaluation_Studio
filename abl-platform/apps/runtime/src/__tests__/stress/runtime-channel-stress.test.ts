/**
 * Channel Stress Tests (Full Stack)
 *
 * Exercises the full production topology via HTTP:
 *   HTTP POST /api/v1/chat/agent → session creation → execution → persistence
 *
 * All backends wired simultaneously in every test:
 *   - MongoDB: DB sessions + messages (always)
 *   - Redis: session state (optional — skips gracefully)
 *   - Mock ClickHouse: trace events (always)
 *
 * Parameterized by LLM latency:
 *   - Fast (700ms) — simulates a snappy model
 *   - Slow (1500ms) — simulates a reasoning-heavy model
 *
 * 12 tests total: 6 scenarios × 2 LLM profiles
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createStressTestServer, type StressTestServer } from '../helpers/stress-test-server.js';
import {
  createMockClickHouseClient,
  type MockClickHouseClient,
} from '../helpers/mock-clickhouse.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import type { SessionStore } from '../../services/session/session-store.js';

// =============================================================================
// DSL LOADING
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../examples');
const HOTEL_BOOKING_AGENT_NAME = 'Hotel_Booking';
const STRESS_TENANT_ID = 'stress-test';

function loadDSL(relativePath: string): string {
  const fullPath = path.join(EXAMPLES_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`DSL file not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

const HOTEL_BOOKING_DSL = loadDSL('flow-test/agents/hotel_booking.agent.abl');

// Conversation inputs matching MockSessionLLMClient deterministic extraction
const BOOKING_CONVERSATION = ['Paris', '2025-06-15 to 2025-06-20', '2 guests'];

// =============================================================================
// LLM PROFILES
// =============================================================================

const LLM_PROFILES = [
  { name: 'fast', chatLatencyMs: 700, jitter: 0.1 },
  { name: 'slow', chatLatencyMs: 1500, jitter: 0.1 },
] as const;

/** Per-turn HTTP request timeout (individual turn, not whole test) */
const TURN_TIMEOUT_MS = 10_000;

/** Vitest timeout — generous; the real constraint is per-turn */
const TEST_TIMEOUT_MS = 180_000;

// =============================================================================
// TYPES
// =============================================================================

interface TurnResult {
  input: string;
  response: string;
  latencyMs: number;
  success: boolean;
  timedOut: boolean;
}

interface SessionResult {
  sessionId: string;
  dbSessionId?: string;
  turns: TurnResult[];
  success: boolean;
  totalMs: number;
}

interface ChannelStressResult {
  sessions: SessionResult[];
  concurrentPeak: number;
  totalDurationMs: number;
  memoryDeltaMB: number;
}

interface PercentileStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  count: number;
}

// =============================================================================
// PERCENTILE COMPUTATION
// =============================================================================

function computePercentiles(values: number[]): PercentileStats {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    p50: sorted[Math.floor(len * 0.5)],
    p95: sorted[Math.floor(len * 0.95)],
    p99: sorted[Math.floor(len * 0.99)],
    min: sorted[0],
    max: sorted[len - 1],
    mean: values.reduce((a, b) => a + b, 0) / len,
    count: len,
  };
}

function formatPercentiles(label: string, stats: PercentileStats): string {
  return (
    `  ${label}: P50=${stats.p50}ms P95=${stats.p95}ms P99=${stats.p99}ms ` +
    `min=${stats.min}ms max=${stats.max}ms mean=${stats.mean.toFixed(0)}ms (n=${stats.count})`
  );
}

// =============================================================================
// CONCURRENCY RUNNER
// =============================================================================

async function runChannelStress(
  baseUrl: string,
  totalSessions: number,
  concurrency: number,
  mode: 'burst' | 'pool',
  conversationInputs: string[],
  turnTimeoutMs: number,
): Promise<ChannelStressResult> {
  const startMem = process.memoryUsage().heapUsed;
  const startTime = Date.now();
  let activeSessions = 0;
  let concurrentPeak = 0;

  async function runSessionWorker(index: number): Promise<SessionResult> {
    activeSessions++;
    if (activeSessions > concurrentPeak) concurrentPeak = activeSessions;
    const sessionStart = Date.now();
    const turns: TurnResult[] = [];
    let sessionId: string | undefined;
    let dbSessionId: string | undefined;

    try {
      for (let i = 0; i < conversationInputs.length; i++) {
        const turnStart = Date.now();
        try {
          const body: Record<string, string> = { message: conversationInputs[i] };
          if (sessionId) body.sessionId = sessionId;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), turnTimeoutMs);

          const res = await fetch(`${baseUrl}/api/v1/chat/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!res.ok) {
            turns.push({
              input: conversationInputs[i],
              response: '',
              latencyMs: Date.now() - turnStart,
              success: false,
              timedOut: false,
            });
            continue;
          }

          const data = (await res.json()) as {
            sessionId: string;
            dbSessionId?: string;
            response: string;
            traceEventCount: number;
          };

          if (!sessionId) {
            sessionId = data.sessionId;
            dbSessionId = data.dbSessionId;
          }

          turns.push({
            input: conversationInputs[i],
            response: data.response,
            latencyMs: Date.now() - turnStart,
            success: true,
            timedOut: false,
          });
        } catch (err: unknown) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          turns.push({
            input: conversationInputs[i],
            response: '',
            latencyMs: Date.now() - turnStart,
            success: false,
            timedOut: isAbort,
          });
        }
      }
    } finally {
      activeSessions--;
    }

    const allSuccess = turns.length > 0 && turns.every((t) => t.success);
    return {
      sessionId: sessionId ?? `failed-${index}`,
      dbSessionId,
      turns,
      success: allSuccess,
      totalMs: Date.now() - sessionStart,
    };
  }

  let sessions: SessionResult[];

  if (mode === 'burst') {
    // All sessions start simultaneously
    const promises = Array.from({ length: totalSessions }, (_, i) => runSessionWorker(i));
    sessions = await Promise.all(promises);
  } else {
    // Pool: maintain N concurrent, replace completed ones
    sessions = [];
    let nextIndex = 0;
    const activePromises = new Map<number, Promise<SessionResult>>();

    // Seed the pool
    while (nextIndex < concurrency && nextIndex < totalSessions) {
      activePromises.set(nextIndex, runSessionWorker(nextIndex));
      nextIndex++;
    }

    while (activePromises.size > 0) {
      const completed = await Promise.race(
        Array.from(activePromises.entries()).map(([idx, p]) => p.then((r) => ({ idx, result: r }))),
      );

      sessions.push(completed.result);
      activePromises.delete(completed.idx);

      if (nextIndex < totalSessions) {
        activePromises.set(nextIndex, runSessionWorker(nextIndex));
        nextIndex++;
      }
    }
  }

  const endMem = process.memoryUsage().heapUsed;

  return {
    sessions,
    concurrentPeak,
    totalDurationMs: Date.now() - startTime,
    memoryDeltaMB: (endMem - startMem) / 1024 / 1024,
  };
}

// =============================================================================
// ASSERTION HELPER
// =============================================================================

function assertStressInvariants(
  result: ChannelStressResult,
  totalSessions: number,
  concurrency: number,
  mode: 'burst' | 'pool',
  conversationInputs: string[],
  turnTimeoutMs: number,
): void {
  const allTurns = result.sessions.flatMap((s) => s.turns);
  const successTurns = allTurns.filter((t) => t.success);
  const timedOutTurns = allTurns.filter((t) => t.timedOut);
  const expectedTurns = totalSessions * conversationInputs.length;

  // 1. Session count
  expect(result.sessions).toHaveLength(totalSessions);

  // 2. Per-turn success rate >= 90%
  expect(successTurns.length).toBeGreaterThanOrEqual(expectedTurns * 0.9);

  // 3. Per-turn timeout rate < 5%
  expect(timedOutTurns.length).toBeLessThan(expectedTurns * 0.05);

  // 4. No successful turn exceeds the turn timeout
  for (const t of successTurns) {
    expect(t.latencyMs).toBeLessThan(turnTimeoutMs);
  }

  // 5. Concurrency peak
  if (mode === 'pool') {
    expect(result.concurrentPeak).toBeLessThanOrEqual(concurrency + 5);
  } else {
    expect(result.concurrentPeak).toBeGreaterThan(concurrency * 0.5);
  }

  // 6. All session IDs unique
  const ids = result.sessions.map((s) => s.sessionId).filter((id) => !id.startsWith('failed-'));
  expect(new Set(ids).size).toBe(ids.length);

  // 7. Memory bounded
  expect(result.memoryDeltaMB).toBeLessThan(500);
}

// =============================================================================
// BACKEND ASSERTION HELPERS
// =============================================================================

/** Pick up to N random items from an array */
function sampleOf<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function assertMongoDbSessions(
  dbSessionIds: string[],
  agentName: string,
  tenantId: string,
  findSessionById: (id: string, tenantId: string) => Promise<any>,
): Promise<void> {
  const sample = sampleOf(dbSessionIds, 10);
  for (const id of sample) {
    const session = await findSessionById(id, tenantId);
    expect(session).not.toBeNull();
    expect(session!.currentAgent).toBe(agentName);
  }
}

async function assertMongoDbMessages(
  dbSessionIds: string[],
  minMessagesPerSession: number,
  tenantId: string,
  findMessagesForSession: (id: string, limit?: number, tenantId?: string) => Promise<any[]>,
): Promise<void> {
  const sample = sampleOf(dbSessionIds, 10);
  for (const id of sample) {
    const msgs = await findMessagesForSession(id, undefined, tenantId);
    // At least 80% of expected messages persisted
    expect(msgs.length).toBeGreaterThanOrEqual(minMessagesPerSession * 0.8);
    for (const m of msgs) {
      expect(['user', 'assistant']).toContain(m.role);
      expect(m.content.length).toBeGreaterThan(0);
    }
  }
}

function assertClickHouseTraces(
  mockCh: MockClickHouseClient,
  validSessionIds: Set<string>,
  minSessionCoverage: number,
): void {
  const traceRows = mockCh._rows.get('abl_platform.platform_events') || [];
  expect(traceRows.length).toBeGreaterThan(0);

  // Per-session trace counts
  const sessionTraces = new Map<string, number>();
  for (const row of traceRows) {
    const sid = row.session_id as string;
    sessionTraces.set(sid, (sessionTraces.get(sid) || 0) + 1);
  }

  // At least minSessionCoverage% of sessions have traces
  expect(sessionTraces.size).toBeGreaterThanOrEqual(minSessionCoverage);

  // No unknown session IDs
  for (const [sid] of sessionTraces) {
    expect(validSessionIds.has(sid)).toBe(true);
  }
}

// =============================================================================
// FULL RESULTS PRINTER
// =============================================================================

function printFullResults(
  name: string,
  result: ChannelStressResult,
  totalSessions: number,
  turnTimeoutMs: number,
): void {
  const allTurns = result.sessions.flatMap((s) => s.turns);
  const successTurns = allTurns.filter((t) => t.success);
  const failedTurns = allTurns.filter((t) => !t.success);
  const timedOutTurns = failedTurns.filter((t) => t.timedOut);
  const errorTurns = failedTurns.filter((t) => !t.timedOut);

  const turnStats = computePercentiles(successTurns.map((t) => t.latencyMs));

  // Per-turn breakdown by conversation position (turn 1, turn 2, turn 3)
  const turnsByIndex = new Map<number, number[]>();
  for (const s of result.sessions) {
    for (let i = 0; i < s.turns.length; i++) {
      if (s.turns[i].success) {
        const arr = turnsByIndex.get(i) ?? [];
        arr.push(s.turns[i].latencyMs);
        turnsByIndex.set(i, arr);
      }
    }
  }

  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[${name}] FULL RESULTS (per-turn, timeout=${turnTimeoutMs}ms)`);
  console.log(`[${'='.repeat(60)}]`);
  console.log(
    `  Total turns: ${allTurns.length} (${totalSessions} sessions x ${allTurns.length / totalSessions} turns)`,
  );
  console.log(
    `  Succeeded: ${successTurns.length} (${((successTurns.length / allTurns.length) * 100).toFixed(1)}%)`,
  );
  console.log(`  Timed out: ${timedOutTurns.length}`);
  console.log(`  Errors: ${errorTurns.length}`);
  const wallSec = result.totalDurationMs / 1000;
  const turnsPerSec = successTurns.length / wallSec;
  const sessionsPerSec = totalSessions / wallSec;

  console.log(`  Peak concurrent sessions: ${result.concurrentPeak}`);
  console.log(
    `  Wall clock: ${result.totalDurationMs}ms | Memory delta: ${result.memoryDeltaMB.toFixed(1)}MB`,
  );
  console.log(
    `  Throughput: ${turnsPerSec.toFixed(1)} turns/s | ${sessionsPerSec.toFixed(1)} sessions/s`,
  );
  console.log(formatPercentiles('All turns', turnStats));

  // Per-turn-index breakdown
  for (const [idx, latencies] of [...turnsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const stats = computePercentiles(latencies);
    console.log(formatPercentiles(`  Turn ${idx + 1}`, stats));
  }

  if (failedTurns.length > 0) {
    const failedStats = computePercentiles(failedTurns.map((t) => t.latencyMs));
    console.log(formatPercentiles('Failed turns', failedStats));
  }

  console.log(`[${'='.repeat(60)}]\n`);
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Channel Stress Tests (Full Stack)', () => {
  let sessionStore: SessionStore;
  let redisAvailable = false;
  let redis: any = null;

  // MongoDB repo functions (dynamically imported after mongo connect)
  let findSessionById: (id: string, tenantId: string) => Promise<any>;
  let findMessagesForSession: (id: string, limit?: number, tenantId?: string) => Promise<any[]>;

  // Mongo lifecycle
  let teardownTestMongo: () => Promise<void>;
  let clearCollections: () => Promise<void>;

  // ── Shared backend setup (once for all profiles) ─────────────────────
  beforeAll(async () => {
    // 1. MongoDB
    const mongoHelpers = await import('../helpers/setup-mongo.js');
    teardownTestMongo = mongoHelpers.teardownTestMongo;
    clearCollections = mongoHelpers.clearCollections;
    await mongoHelpers.setupTestMongo();

    // Dynamic-import repo functions AFTER mongo is connected
    const repo = await import('../../repos/session-repo.js');
    findSessionById = repo.findSessionById;
    findMessagesForSession = repo.findMessagesForSession;

    // Fix insertMany hook (same as runtime-e2e-persistence.test.ts)
    const models = await import('@agent-platform/database/models');
    const insertManyHooks = (models.Message.schema as any).s?.hooks?._pres?.get?.('insertMany');
    if (insertManyHooks) {
      insertManyHooks.length = 0;
    }

    // 2. Redis (optional)
    try {
      const IORedis = await import('ioredis');
      const RedisClass = IORedis.default ?? IORedis;
      redis = new RedisClass({
        host: '127.0.0.1',
        port: 6379,
        lazyConnect: true,
        connectTimeout: 2000,
      });
      await redis.connect();
      await redis.ping();

      const { RedisSessionStore } = await import('../../services/session/redis-session-store.js');
      sessionStore = new RedisSessionStore(redis, { sessionTtlMinutes: 5 });
      redisAvailable = true;
    } catch {
      sessionStore = new MemorySessionStore();
      redisAvailable = false;
    }
  }, 120_000);

  afterAll(async () => {
    await teardownTestMongo();
    if (redis) {
      try {
        await redis.disconnect();
      } catch {
        /* ignore */
      }
    }
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════
  // PER-LLM-PROFILE TEST BLOCK
  // ═════════════════════════════════════════════════════════════════════

  describe.each(LLM_PROFILES)(
    '$name LLM ($chatLatencyMs ms)',
    ({ name: profileName, chatLatencyMs, jitter }) => {
      let server: StressTestServer;
      let mockCh: MockClickHouseClient;

      beforeAll(async () => {
        mockCh = createMockClickHouseClient();
        server = await createStressTestServer({
          dsl: HOTEL_BOOKING_DSL,
          agentName: HOTEL_BOOKING_AGENT_NAME,
          llmLatency: { chatLatencyMs, jitter },
          sessionStore,
          enableMessagePersistence: true,
          mockClickHouseClient: mockCh,
        });

        console.log(
          `[ChannelStress:${profileName}] Server at ${server.baseUrl} | ` +
            `LLM: ${chatLatencyMs}ms | ` +
            `Redis: ${redisAvailable ? 'YES' : 'NO (MemoryStore)'} | ` +
            `MongoDB: YES | ClickHouse: MOCK`,
        );
      }, 60_000);

      afterAll(async () => {
        await server?.close();
      }, 30_000);

      afterEach(async () => {
        await clearCollections();
        mockCh._clear();
        server?.resetTracking();
      });

      // ── Shared scenario runner for this profile ────────────────────────
      async function runScenario(
        scenarioName: string,
        totalSessions: number,
        concurrency: number,
        mode: 'burst' | 'pool',
      ): Promise<ChannelStressResult> {
        const label = `${profileName}:${scenarioName}`;

        const result = await runChannelStress(
          server.baseUrl,
          totalSessions,
          concurrency,
          mode,
          BOOKING_CONVERSATION,
          TURN_TIMEOUT_MS,
        );

        // ── Full results ─────────────────────────────────────────────────
        printFullResults(label, result, totalSessions, TURN_TIMEOUT_MS);

        // ── Core invariants (per-turn) ──────────────────────────────────
        assertStressInvariants(
          result,
          totalSessions,
          concurrency,
          mode,
          BOOKING_CONVERSATION,
          TURN_TIMEOUT_MS,
        );

        // ── Drain fire-and-forget persistence before backend assertions ─
        await server.flushPersistence();

        // ── A. MongoDB — DB sessions exist ─────────────────────────────
        const dbIds = server.getDbSessionIds();
        if (dbIds.length > 0) {
          await assertMongoDbSessions(
            dbIds,
            HOTEL_BOOKING_AGENT_NAME,
            STRESS_TENANT_ID,
            findSessionById,
          );
        }

        // ── B. MongoDB — Messages persisted (2 per turn: user + assistant)
        if (dbIds.length > 0) {
          const expectedMsgsPerSession = BOOKING_CONVERSATION.length * 2;
          await assertMongoDbMessages(
            dbIds,
            expectedMsgsPerSession,
            STRESS_TENANT_ID,
            findMessagesForSession,
          );
        }

        // ── C. Redis — session state (if available) ────────────────────
        if (redisAvailable) {
          const runtimeIds = server.getSessionIds();
          const sample = sampleOf(runtimeIds, 5);
          let loadable = 0;
          for (const sid of sample) {
            const loaded = await sessionStore.load(sid);
            if (loaded) loadable++;
          }
          console.log(`[${label}] Redis: ${loadable}/${sample.length} sessions loadable`);
        }

        // ── D. ClickHouse — trace events written ──────────────────────
        const validIds = new Set(server.getSessionIds());
        const successSessions = result.sessions.filter((s) => s.success).length;
        assertClickHouseTraces(mockCh, validIds, Math.floor(successSessions * 0.8));

        return result;
      }

      // ── Pool Mode ────────────────────────────────────────────────────
      describe('Pool Mode', () => {
        test(
          'pool: 100 sessions, 50 concurrent',
          async () => {
            await runScenario('pool-50', 100, 50, 'pool');
          },
          TEST_TIMEOUT_MS,
        );

        test(
          'pool: 200 sessions, 100 concurrent',
          async () => {
            await runScenario('pool-100', 200, 100, 'pool');
          },
          TEST_TIMEOUT_MS,
        );

        test(
          'pool: 400 sessions, 200 concurrent',
          async () => {
            await runScenario('pool-200', 400, 200, 'pool');
          },
          TEST_TIMEOUT_MS,
        );
      });

      // ── Burst Mode ───────────────────────────────────────────────────
      describe('Burst Mode', () => {
        test(
          'burst: 50 simultaneous sessions',
          async () => {
            await runScenario('burst-50', 50, 50, 'burst');
          },
          TEST_TIMEOUT_MS,
        );

        test(
          'burst: 100 simultaneous sessions',
          async () => {
            await runScenario('burst-100', 100, 100, 'burst');
          },
          TEST_TIMEOUT_MS,
        );

        test(
          'burst: 200 simultaneous sessions',
          async () => {
            await runScenario('burst-200', 200, 200, 'burst');
          },
          TEST_TIMEOUT_MS,
        );
      });
    },
  );
});
