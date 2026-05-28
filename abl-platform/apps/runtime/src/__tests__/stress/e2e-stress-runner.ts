/**
 * E2E Stress Test Runner
 *
 * HTTP-based stress test runner that exercises the runtime through its HTTP API.
 * No platform components are mocked in test code — the server infrastructure
 * handles the external LLM service boundary via DI.
 *
 * All interaction is via HTTP POST to /api/v1/chat/agent on a real Express
 * server backed by real RuntimeExecutor + SessionService.
 */

import {
  createStressTestServer,
  type StressTestServer,
  type StressServerConfig,
} from '../helpers/stress-test-server.js';
import type {
  LoadScenarioConfig,
  LoadTestResult,
  SessionMetric,
  TurnMetric,
  PersistenceMetric,
} from './runtime-load-test.js';

// ---------------------------------------------------------------------------
// HTTP response shape from stress-test-server POST /api/v1/chat/agent
// ---------------------------------------------------------------------------

interface AgentChatResponse {
  sessionId: string;
  response: string;
  traceEventCount: number;
  dbSessionId?: string;
}

/** Shape returned by GET /api/v1/sessions/:id/state */
interface SessionStateResponse {
  sessionId: string;
  agentName: string;
  initialized: boolean;
  isComplete: boolean;
  currentFlowStep: string | null;
  conversationHistoryLength: number;
  dataValues: Record<string, unknown>;
  gatherProgress: Record<string, unknown>;
}

/** Result of verifying a single session's state after conversation */
export interface StateVerification {
  sessionId: string;
  success: boolean;
  checks: {
    initialized: boolean;
    historyLengthCorrect: boolean;
    expectedHistoryLength: number;
    actualHistoryLength: number;
    entityValuesPresent: boolean;
    missingEntities: string[];
    entityValues: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// E2E STRESS RUNNER
// ---------------------------------------------------------------------------

export class E2EStressRunner {
  private server: StressTestServer;
  readonly storeType: 'memory' | 'redis';
  private _redisClient: { quit: () => Promise<unknown> } | null = null;

  private constructor(server: StressTestServer, storeType: 'memory' | 'redis') {
    this.server = server;
    this.storeType = storeType;
  }

  /** Create a runner backed by MemorySessionStore. */
  static async create(serverConfig: StressServerConfig): Promise<E2EStressRunner> {
    const server = await createStressTestServer(serverConfig);
    return new E2EStressRunner(server, 'memory');
  }

  /** Create a runner with Redis auto-detection; falls back to memory. */
  static async createWithRedis(serverConfig: StressServerConfig): Promise<E2EStressRunner> {
    try {
      const { default: Redis } = await import('ioredis');
      const redis = new Redis({ lazyConnect: true, connectTimeout: 2000 });
      await redis.connect();
      await redis.ping();

      const { RedisSessionStore } = await import('../../services/session/redis-session-store.js');
      const store = new RedisSessionStore(redis, {
        sessionTTLSeconds: 300,
        irTTLSeconds: 600,
      });

      const server = await createStressTestServer({ ...serverConfig, sessionStore: store });
      const runner = new E2EStressRunner(server, 'redis');
      runner._redisClient = redis;
      return runner;
    } catch {
      return E2EStressRunner.create(serverConfig);
    }
  }

  /** Shut down the HTTP server and Redis connection. */
  async dispose(): Promise<void> {
    await this.server.close();
    if (this._redisClient) {
      await this._redisClient.quit();
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /** Send a single message via HTTP POST. */
  private async sendMessage(message: string, sessionId?: string): Promise<AgentChatResponse> {
    const body: Record<string, string> = { message };
    if (sessionId) body.sessionId = sessionId;

    const res = await fetch(`${this.server.baseUrl}/api/v1/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return (await res.json()) as AgentChatResponse;
  }

  /** Get session state via HTTP GET. */
  private async getSessionState(sessionId: string): Promise<SessionStateResponse> {
    const res = await fetch(`${this.server.baseUrl}/api/v1/sessions/${sessionId}/state`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as SessionStateResponse;
  }

  /**
   * Verify session states after a load test run.
   * Checks that each successful session has:
   * - initialized=true
   * - conversation history with expected length (2 entries per turn: user + assistant)
   * - expected entity values present in data.values
   */
  async verifySessionStates(
    sessions: SessionMetric[],
    turnsPerSession: number,
    expectedEntities: string[],
  ): Promise<StateVerification[]> {
    const verifications: StateVerification[] = [];
    const successfulSessions = sessions.filter((s) => s.success && s.sessionId);

    for (const session of successfulSessions) {
      try {
        const state = await this.getSessionState(session.sessionId);

        // Each turn produces a user message + assistant response = 2 history entries.
        // Flow-mode init may add an initial assistant message, so allow ±2.
        const expectedMinHistory = turnsPerSession * 2;
        const historyLengthCorrect =
          state.conversationHistoryLength >= expectedMinHistory &&
          state.conversationHistoryLength <= expectedMinHistory + 4;

        const missingEntities = expectedEntities.filter(
          (key) => state.dataValues[key] === undefined || state.dataValues[key] === null,
        );

        const entityValuesPresent = missingEntities.length === 0;

        verifications.push({
          sessionId: session.sessionId,
          success: state.initialized && historyLengthCorrect && entityValuesPresent,
          checks: {
            initialized: state.initialized,
            historyLengthCorrect,
            expectedHistoryLength: expectedMinHistory,
            actualHistoryLength: state.conversationHistoryLength,
            entityValuesPresent,
            missingEntities,
            entityValues: Object.fromEntries(expectedEntities.map((k) => [k, state.dataValues[k]])),
          },
        });
      } catch (err) {
        verifications.push({
          sessionId: session.sessionId,
          success: false,
          checks: {
            initialized: false,
            historyLengthCorrect: false,
            expectedHistoryLength: turnsPerSession * 2,
            actualHistoryLength: 0,
            entityValuesPresent: false,
            missingEntities: expectedEntities,
            entityValues: {},
          },
        });
      }
    }

    return verifications;
  }

  // ---------------------------------------------------------------------------
  // Session execution (multi-turn via HTTP)
  // ---------------------------------------------------------------------------

  /**
   * Execute a complete multi-turn session over HTTP.
   * First message creates the session; subsequent messages reuse the sessionId.
   */
  private async executeSession(
    sessionIndex: number,
    conversationInputs: string[],
    onConcurrencyChange?: (delta: number) => void,
  ): Promise<SessionMetric> {
    onConcurrencyChange?.(1);

    const turns: TurnMetric[] = [];
    let sessionId: string | undefined;
    let creationTimeMs = 0;
    let sessionSuccess = true;
    const sessionStart = performance.now();

    for (let turnIndex = 0; turnIndex < conversationInputs.length; turnIndex++) {
      const turnStart = performance.now();
      try {
        const result = await this.sendMessage(conversationInputs[turnIndex], sessionId);

        const turnMs = performance.now() - turnStart;

        if (turnIndex === 0) {
          creationTimeMs = turnMs;
          sessionId = result.sessionId;
        }

        turns.push({ sessionIndex, turnIndex, latencyMs: turnMs, success: true });
      } catch (err) {
        turns.push({
          sessionIndex,
          turnIndex,
          latencyMs: performance.now() - turnStart,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        sessionSuccess = false;
      }
    }

    onConcurrencyChange?.(-1);

    return {
      sessionIndex,
      sessionId: sessionId ?? `failed-${sessionIndex}`,
      creationTimeMs,
      turns,
      totalMs: performance.now() - sessionStart,
      success: sessionSuccess,
    };
  }

  // ---------------------------------------------------------------------------
  // Concurrency helpers
  // ---------------------------------------------------------------------------

  /** Run tasks with bounded concurrency (pool). */
  private async runPool(
    totalTasks: number,
    concurrency: number,
    taskFn: (index: number) => Promise<SessionMetric>,
  ): Promise<SessionMetric[]> {
    const sessions: SessionMetric[] = [];
    let nextIndex = 0;
    const inflight = new Set<Promise<void>>();

    while (nextIndex < totalTasks || inflight.size > 0) {
      while (inflight.size < concurrency && nextIndex < totalTasks) {
        const idx = nextIndex++;
        const p = taskFn(idx).then((result) => {
          sessions.push(result);
          inflight.delete(p);
        });
        inflight.add(p);
      }
      if (inflight.size > 0) {
        await Promise.race(inflight);
      }
    }

    return sessions;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  /** Run a load scenario via HTTP with burst or pool concurrency. */
  async run(config: LoadScenarioConfig): Promise<LoadTestResult> {
    const memBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    let concurrentPeak = 0;
    let active = 0;

    const trackConcurrency = (delta: number) => {
      active += delta;
      if (active > concurrentPeak) concurrentPeak = active;
    };

    const runOne = (index: number) =>
      this.executeSession(index, config.conversationInputs, trackConcurrency);

    let sessions: SessionMetric[];

    if (config.mode === 'burst') {
      sessions = await Promise.all(
        Array.from({ length: config.totalSessions }, (_, i) => runOne(i)),
      );
    } else {
      sessions = await this.runPool(config.totalSessions, config.concurrency, runOne);
    }

    return {
      config,
      sessions,
      persistence: [],
      totalDurationMs: performance.now() - start,
      concurrentPeak,
      memoryDeltaMB: (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024),
      storeType: this.storeType,
    };
  }

  /**
   * Run then verify persistence: for each successful session, inspect the
   * session state via the state endpoint AND send a follow-up message to
   * verify the session can be resumed.
   *
   * State verification checks:
   * - Session is initialized
   * - Conversation history has expected length
   * - Entity values (from expectedEntities) are present in data.values
   * - Follow-up message gets a non-empty response
   */
  async runWithPersistence(
    config: LoadScenarioConfig,
    expectedEntities: string[] = [],
  ): Promise<LoadTestResult> {
    const result = await this.run(config);
    const persistence: PersistenceMetric[] = [];
    const turnsPerSession = config.conversationInputs.length;

    for (const session of result.sessions.filter((s) => s.success)) {
      const start = performance.now();
      try {
        // 1. Inspect session state for entity values and history
        const state = await this.getSessionState(session.sessionId);

        const expectedMinHistory = turnsPerSession * 2;
        const historyOk =
          state.conversationHistoryLength >= expectedMinHistory &&
          state.conversationHistoryLength <= expectedMinHistory + 4;

        const missingEntities = expectedEntities.filter(
          (key) => state.dataValues[key] === undefined || state.dataValues[key] === null,
        );
        const entitiesOk = missingEntities.length === 0;

        // 2. Send follow-up to verify session can be resumed
        const verifyResult = await this.sendMessage(
          'Please confirm what we discussed.',
          session.sessionId,
        );
        const elapsed = performance.now() - start;

        persistence.push({
          sessionId: session.sessionId,
          saveTimeMs: elapsed,
          loadTimeMs: elapsed,
          stateMatch: state.initialized && entitiesOk,
          historyMatch: historyOk && verifyResult.response.length > 0,
          threadMatch: true,
        });
      } catch {
        persistence.push({
          sessionId: session.sessionId,
          saveTimeMs: 0,
          loadTimeMs: 0,
          stateMatch: false,
          historyMatch: false,
          threadMatch: false,
        });
      }
    }

    return { ...result, persistence };
  }

  /**
   * Run mixed session groups with interleaved concurrency.
   * Each config contributes its own batch of sessions with its own
   * conversation inputs; all are executed in a shared pool.
   */
  async runMixed(configs: LoadScenarioConfig[]): Promise<LoadTestResult> {
    const memBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    let concurrentPeak = 0;
    let active = 0;

    const trackConcurrency = (delta: number) => {
      active += delta;
      if (active > concurrentPeak) concurrentPeak = active;
    };

    // Build interleaved task list
    const taskInputs: string[][] = [];
    for (const cfg of configs) {
      for (let i = 0; i < cfg.totalSessions; i++) {
        taskInputs.push(cfg.conversationInputs);
      }
    }

    const maxConcurrency = Math.max(...configs.map((c) => c.concurrency));

    const sessions = await this.runPool(taskInputs.length, maxConcurrency, (index) =>
      this.executeSession(index, taskInputs[index], trackConcurrency),
    );

    return {
      config: configs[0],
      sessions,
      persistence: [],
      totalDurationMs: performance.now() - start,
      concurrentPeak,
      memoryDeltaMB: (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024),
      storeType: this.storeType,
    };
  }
}
