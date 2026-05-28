/**
 * Runtime Load Test Infrastructure
 *
 * Exercises the real RuntimeExecutor + SessionService pipeline with mock LLM/tools.
 * Unlike the compiler-level stress tests (packages/compiler/src/__tests__/stress/),
 * these tests go through the full runtime stack: session creation, multi-turn
 * message execution, SessionService persistence with MemorySessionStore,
 * trace recording, and thread management.
 *
 * Components:
 * - MockSessionLLMClient: Simulates LLM calls with configurable latency
 * - RuntimeLoadTestRunner: Orchestrates concurrent session execution
 * - MetricsAggregator: P50/P95/P99 percentile computation
 * - ReportGenerator: Formatted performance report output
 */

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { SessionService } from '../../services/session/session-service.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import type { SessionStore } from '../../services/session/session-store.js';
import type { RuntimeSession } from '../../services/runtime-executor.js';
import type {
  ChatResult,
  SessionStreamEvent,
  ToolDefinition,
  Message,
} from '../../services/llm/session-llm-client.js';

// =============================================================================
// TYPES
// =============================================================================

export interface LatencyConfig {
  chatLatencyMs: number;
  jitter: number; // 0-1, e.g. 0.1 = +/-10%
}

export interface LoadScenarioConfig {
  name: string;
  agentDSL: string;
  agentName: string;
  conversationInputs: string[];
  concurrency: number;
  totalSessions: number;
  mode: 'burst' | 'pool';
  llmLatency?: Partial<LatencyConfig>;
  initializeFlow?: boolean;
  /** For deep persistence: save+verify every N turns (e.g., 2 = save after turns 2, 4, 6...) */
  persistEveryNTurns?: number;
}

export interface TurnMetric {
  sessionIndex: number;
  turnIndex: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface SessionMetric {
  sessionIndex: number;
  sessionId: string;
  creationTimeMs: number;
  turns: TurnMetric[];
  totalMs: number;
  success: boolean;
}

export interface PersistenceMetric {
  sessionId: string;
  saveTimeMs: number;
  loadTimeMs: number;
  stateMatch: boolean;
  historyMatch: boolean;
  threadMatch: boolean;
}

/** Deep persistence verification with field-by-field comparison */
export interface DeepPersistenceMetric extends PersistenceMetric {
  cycle: number; // Which save/load cycle (0-based)
  turnsBefore: number; // Turns executed before this save
  dataValuesMatch: boolean; // session.data.values ↔ loaded.dataValues
  flowStepMatch: boolean; // currentFlowStep survived
  irResolved: boolean; // agentIR resolved from cache via hash
  compilationResolved: boolean; // compilationOutput resolved from cache
  isCompleteMatch: boolean; // isComplete flag match
  handoffStackMatch: boolean; // handoffStack survived
  gatherProgressMatch: boolean; // gatherProgress in state
  mismatches: string[]; // List of mismatched fields for debugging
}

export interface LoadTestResult {
  config: LoadScenarioConfig;
  sessions: SessionMetric[];
  persistence: PersistenceMetric[];
  deepPersistence?: DeepPersistenceMetric[];
  totalDurationMs: number;
  concurrentPeak: number;
  memoryDeltaMB: number;
  storeType: 'memory' | 'redis';
}

export interface PercentileStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
  mean: number;
}

export interface LoadTestMetrics {
  sessionCreation: PercentileStats;
  turnExecution: PercentileStats;
  throughputTurnsPerSec: number;
  successRate: number;
  concurrentPeak: number;
  totalSessions: number;
  totalTurns: number;
  totalDurationMs: number;
  memoryDeltaMB: number;
  persistence?: {
    save: PercentileStats;
    load: PercentileStats;
  };
}

// =============================================================================
// MOCK SESSION LLM CLIENT
// =============================================================================

const DEFAULT_LATENCY: LatencyConfig = {
  chatLatencyMs: 5,
  jitter: 0.1,
};

function applyJitter(baseMs: number, jitter: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(1, Math.round(baseMs * factor));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock LLM client that matches the SessionLLMClient interface used by RuntimeExecutor.
 * Returns deterministic extraction results for flow progression and simulates latency.
 */
export class MockSessionLLMClient {
  private config: LatencyConfig;
  public callCount = 0;
  public totalLatencyMs = 0;

  constructor(config?: Partial<LatencyConfig>) {
    this.config = { ...DEFAULT_LATENCY, ...config };
  }

  /**
   * Main LLM call — entity extraction and response generation.
   * Returns ChatResult matching session-llm-client.ts:129 interface.
   */
  async chatWithToolUse(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    operationType: string = 'response_gen',
  ): Promise<ChatResult> {
    const latencyMs = applyJitter(this.config.chatLatencyMs, this.config.jitter);
    await delay(latencyMs);
    this.callCount++;
    this.totalLatencyMs += latencyMs;

    // Check if this is an extraction call (entity extraction for GATHER)
    if (operationType === 'extraction' || systemPrompt.includes('entity extraction')) {
      return this.handleExtraction(messages);
    }

    // Default: reasoning/response generation
    return {
      text: 'I can help you with that. Let me process your request.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        { type: 'text', text: 'I can help you with that. Let me process your request.' },
      ],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    operationType: string = 'response_gen',
    _onChunk?: (chunk: string) => void,
  ): Promise<ChatResult> {
    return this.chatWithToolUse(systemPrompt, messages, tools, operationType);
  }

  /**
   * Streaming LLM call — not used in load tests but required by interface.
   */
  async *streamChatWithToolUse(
    _systemPrompt: string,
    _messages: Message[],
    _tools: ToolDefinition[],
    _operationType?: string,
  ): AsyncGenerator<SessionStreamEvent> {
    yield { type: 'text_delta', delta: 'Mock streaming response' };
    yield { type: 'done' };
  }

  isConfigured(): boolean {
    return true;
  }

  /**
   * Handle entity extraction calls. Parses user input to return
   * deterministic extraction results that drive flow progression.
   */
  private handleExtraction(messages: Message[]): ChatResult {
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');

    const extracted = this.deterministicExtract(userContent);
    const text = JSON.stringify(extracted);

    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text }],
      usage: { inputTokens: 80, outputTokens: 30 },
    };
  }

  /**
   * Deterministic entity extraction based on message content.
   * Supports common field types for hotel booking and auth flows.
   */
  private deterministicExtract(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lower = text.toLowerCase();

    // Destination extraction
    if (lower.includes('paris')) result.destination = 'Paris';
    else if (lower.includes('barcelona')) result.destination = 'Barcelona';
    else if (lower.includes('new york')) result.destination = 'New York';
    else if (lower.includes('london')) result.destination = 'London';
    else if (lower.includes('tokyo')) result.destination = 'Tokyo';

    // Date extraction (YYYY-MM-DD)
    const dates = text.match(/\d{4}-\d{2}-\d{2}/g);
    if (dates) {
      if (dates[0]) result.checkin_date = dates[0];
      if (dates[1]) result.checkout_date = dates[1];
    }

    // Guest count
    const guestMatch = text.match(/(\d+)\s*(?:guest|person|people|room)/i);
    if (guestMatch) result.num_guests = parseInt(guestMatch[1], 10);
    // Standalone number for guest count context
    else if (/^\d+$/.test(text.trim())) result.num_guests = parseInt(text.trim(), 10);

    // Email
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (emailMatch) result.email = emailMatch[0];

    // Name (capitalized words)
    const nameMatch = text.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
    if (nameMatch) result.name = nameMatch[0];

    // Booking reference
    const bookingMatch = text.match(/\b[A-Z]{2,3}-?\d{4,}\b/);
    if (bookingMatch) result.booking_reference = bookingMatch[0];

    // Verification code
    const codeMatch = text.match(/\b\d{6}\b/);
    if (codeMatch) result.verification_code = codeMatch[0];

    // Phone
    const phoneMatch = text.match(/\+?\d[\d\s-]{8,}/);
    if (phoneMatch) result.phone = phoneMatch[0].trim();

    // Simple text fields — use entire input if nothing else matched
    if (Object.keys(result).length === 0 && text.trim().length > 0) {
      result.input = text.trim();
    }

    return result;
  }
}

// =============================================================================
// MOCK LLM INJECTION HELPER
// =============================================================================

/**
 * Inject a mock LLM client into a session using Object.defineProperty.
 * This prevents the async `wireLLMClient` fire-and-forget in createSession()
 * from overwriting our mock with a real SessionLLMClient.
 */
function injectMockLLMClient(
  session: RuntimeSession,
  latencyConfig?: Partial<LatencyConfig>,
): void {
  const mockClient = new MockSessionLLMClient(latencyConfig);
  Object.defineProperty(session, 'llmClient', {
    get: () => mockClient,
    set: () => {
      /* no-op: prevent runtime from overwriting mock */
    },
    configurable: true,
  });
}

// =============================================================================
// RUNTIME LOAD TEST RUNNER
// =============================================================================

export class RuntimeLoadTestRunner {
  private executor: RuntimeExecutor;
  private sessionService: SessionService;
  private store: SessionStore;
  readonly storeType: 'memory' | 'redis';

  constructor(store?: SessionStore, storeType?: 'memory' | 'redis') {
    this.executor = new RuntimeExecutor({});
    this.store = store || new MemorySessionStore();
    this.storeType = storeType || 'memory';
    this.sessionService = new SessionService(this.store);
    this.executor.setSessionService(this.sessionService);
  }

  /** Factory: create a runner with RedisSessionStore if Redis is available, else MemorySessionStore */
  static async createWithRedis(
    redisUrl = 'redis://127.0.0.1:6379',
  ): Promise<RuntimeLoadTestRunner> {
    try {
      const { default: Redis } = await import('ioredis');
      const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await client.connect();
      await client.ping();

      const { RedisSessionStore } = await import('../../services/session/redis-session-store.js');
      const store = new RedisSessionStore(client, { sessionTtlMinutes: 5, irTtlMinutes: 10 });
      console.log('[LoadTest] Using RedisSessionStore');
      const runner = new RuntimeLoadTestRunner(store, 'redis');
      // Stash client for cleanup
      (runner as any)._redisClient = client;
      return runner;
    } catch {
      console.log('[LoadTest] Redis not available, using MemorySessionStore');
      return new RuntimeLoadTestRunner();
    }
  }

  /** Cleanup: disconnect Redis if we hold a connection */
  async dispose(): Promise<void> {
    const client = (this as any)._redisClient;
    if (client) {
      try {
        await client.quit();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Run a load test scenario. Returns detailed metrics.
   */
  async run(config: LoadScenarioConfig): Promise<LoadTestResult> {
    const memBefore = process.memoryUsage();
    const startTime = Date.now();
    let concurrentPeak = 0;
    let activeSessions = 0;

    const runSession = async (sessionIndex: number): Promise<SessionMetric> => {
      activeSessions++;
      if (activeSessions > concurrentPeak) concurrentPeak = activeSessions;

      const turns: TurnMetric[] = [];
      let sessionSuccess = true;
      const sessionStart = Date.now();

      // Create session
      const creationStart = Date.now();
      let session: RuntimeSession;
      try {
        session = this.executor.createSessionFromResolved(
          compileToResolvedAgent([config.agentDSL], config.agentName),
        );
      } catch (error) {
        activeSessions--;
        return {
          sessionIndex,
          sessionId: '',
          creationTimeMs: Date.now() - creationStart,
          turns: [],
          totalMs: Date.now() - sessionStart,
          success: false,
        };
      }
      const creationTimeMs = Date.now() - creationStart;

      // Inject mock LLM client via defineProperty to prevent async wireLLMClient override
      injectMockLLMClient(session, config.llmLatency);

      // Initialize flow session if needed
      if (config.initializeFlow && session.currentFlowStep !== undefined) {
        try {
          await this.executor.initializeSession(session.id);
        } catch {
          // Flow init can fail for non-flow agents, ignore
        }
      }

      // Execute conversation turns
      for (let turnIndex = 0; turnIndex < config.conversationInputs.length; turnIndex++) {
        const userMessage = config.conversationInputs[turnIndex];
        const turnStart = Date.now();

        try {
          await this.executor.executeMessage(session.id, userMessage);

          turns.push({
            sessionIndex,
            turnIndex,
            latencyMs: Date.now() - turnStart,
            success: true,
          });
        } catch (error) {
          sessionSuccess = false;
          turns.push({
            sessionIndex,
            turnIndex,
            latencyMs: Date.now() - turnStart,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      activeSessions--;

      return {
        sessionIndex,
        sessionId: session.id,
        creationTimeMs,
        turns,
        totalMs: Date.now() - sessionStart,
        success: sessionSuccess,
      };
    };

    let sessions: SessionMetric[];

    if (config.mode === 'burst') {
      // Burst: all sessions start simultaneously
      const promises = Array.from({ length: config.totalSessions }, (_, i) => runSession(i));
      sessions = await Promise.all(promises);
    } else {
      // Pool: maintain N concurrent sessions, replace completed ones
      sessions = [];
      let nextIndex = 0;
      const activePromises = new Map<number, Promise<SessionMetric>>();

      // Seed the pool
      while (nextIndex < config.concurrency && nextIndex < config.totalSessions) {
        activePromises.set(nextIndex, runSession(nextIndex));
        nextIndex++;
      }

      while (activePromises.size > 0) {
        const result = await Promise.race(
          Array.from(activePromises.entries()).map(([idx, p]) =>
            p.then((r) => ({ idx, result: r })),
          ),
        );

        sessions.push(result.result);
        activePromises.delete(result.idx);

        // Launch next session if available
        if (nextIndex < config.totalSessions) {
          activePromises.set(nextIndex, runSession(nextIndex));
          nextIndex++;
        }
      }
    }

    const memAfter = process.memoryUsage();
    const memoryDeltaMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

    return {
      config,
      sessions,
      persistence: [],
      totalDurationMs: Date.now() - startTime,
      concurrentPeak,
      memoryDeltaMB,
      storeType: this.storeType,
    };
  }

  /**
   * Run a load test with session persistence verification.
   * After executing turns, persists to SessionService and verifies round-trip integrity.
   */
  async runWithPersistence(config: LoadScenarioConfig): Promise<LoadTestResult> {
    const baseResult = await this.run(config);
    const persistenceMetrics: PersistenceMetric[] = [];

    for (const sessionMetric of baseResult.sessions) {
      if (!sessionMetric.success || !sessionMetric.sessionId) continue;

      const session = (this.executor as any).sessions.get(sessionMetric.sessionId) as
        | RuntimeSession
        | undefined;
      if (!session) continue;

      // Sync conversation history to store's conversations map
      // (MemorySessionStore keeps conversations in a separate map from session data)
      if (session.conversationHistory.length > 0) {
        await this.sessionService.appendToConversation(session.id, session.conversationHistory);
      }

      // Save snapshot
      const saveStart = Date.now();
      await this.executor.saveSessionSnapshot(session);
      const saveTimeMs = Date.now() - saveStart;

      // Load from SessionService
      const loadStart = Date.now();
      const loaded = await this.sessionService.loadSession(sessionMetric.sessionId);
      const loadTimeMs = Date.now() - loadStart;

      if (!loaded) {
        persistenceMetrics.push({
          sessionId: sessionMetric.sessionId,
          saveTimeMs,
          loadTimeMs,
          stateMatch: false,
          historyMatch: false,
          threadMatch: false,
        });
        continue;
      }

      // Verify state survived round-trip
      const stateMatch = loaded.state.conversationPhase === session.state.conversationPhase;

      // Verify conversation history length (loaded may have been trimmed by window)
      const historyMatch =
        loaded.conversationHistory.length > 0 || session.conversationHistory.length === 0;

      // Verify thread data
      const threadMatch = loaded.threads.length > 0 || session.threads.length === 0;

      persistenceMetrics.push({
        sessionId: sessionMetric.sessionId,
        saveTimeMs,
        loadTimeMs,
        stateMatch,
        historyMatch,
        threadMatch,
      });
    }

    return {
      ...baseResult,
      persistence: persistenceMetrics,
      storeType: this.storeType,
    };
  }

  /**
   * Run a deep persistence stress test.
   *
   * For each session:
   * 1. Create session + execute N turns
   * 2. Every `persistEveryNTurns`: save snapshot → load from store → deep verify
   * 3. Track field-by-field comparison results
   * 4. Multiple save/load cycles per session (simulating pod migration mid-conversation)
   *
   * This exercises the full persistence pipeline: RuntimeExecutor → SessionService
   * → SessionStore (Memory or Redis) → loadSession → hydrate IR from cache.
   */
  async runWithDeepPersistence(config: LoadScenarioConfig): Promise<LoadTestResult> {
    const memBefore = process.memoryUsage();
    const startTime = Date.now();
    let concurrentPeak = 0;
    let activeSessions = 0;
    const persistEvery = config.persistEveryNTurns || 2;
    const deepMetrics: DeepPersistenceMetric[] = [];

    const runSession = async (sessionIndex: number): Promise<SessionMetric> => {
      activeSessions++;
      if (activeSessions > concurrentPeak) concurrentPeak = activeSessions;

      const turns: TurnMetric[] = [];
      let sessionSuccess = true;
      const sessionStart = Date.now();

      // Create session
      const creationStart = Date.now();
      let session: RuntimeSession;
      try {
        session = this.executor.createSessionFromResolved(
          compileToResolvedAgent([config.agentDSL], config.agentName),
        );
      } catch {
        activeSessions--;
        return {
          sessionIndex,
          sessionId: '',
          creationTimeMs: Date.now() - creationStart,
          turns: [],
          totalMs: Date.now() - sessionStart,
          success: false,
        };
      }
      const creationTimeMs = Date.now() - creationStart;
      injectMockLLMClient(session, config.llmLatency);

      // Initialize flow
      if (config.initializeFlow && session.currentFlowStep !== undefined) {
        try {
          await this.executor.initializeSession(session.id);
        } catch {
          /* ignore */
        }
      }

      let cycle = 0;

      // Execute turns with periodic persistence checkpoints
      for (let turnIndex = 0; turnIndex < config.conversationInputs.length; turnIndex++) {
        const userMessage = config.conversationInputs[turnIndex];
        const turnStart = Date.now();

        try {
          await this.executor.executeMessage(session.id, userMessage);
          turns.push({ sessionIndex, turnIndex, latencyMs: Date.now() - turnStart, success: true });
        } catch (error) {
          sessionSuccess = false;
          turns.push({
            sessionIndex,
            turnIndex,
            latencyMs: Date.now() - turnStart,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Persistence checkpoint every N turns
        if (
          (turnIndex + 1) % persistEvery === 0 ||
          turnIndex === config.conversationInputs.length - 1
        ) {
          const metric = await this.deepPersistenceCheck(session, cycle, turnIndex + 1);
          deepMetrics.push(metric);
          cycle++;
        }
      }

      activeSessions--;
      return {
        sessionIndex,
        sessionId: session.id,
        creationTimeMs,
        turns,
        totalMs: Date.now() - sessionStart,
        success: sessionSuccess,
      };
    };

    // Execute with concurrency control
    let sessions: SessionMetric[];
    if (config.mode === 'burst') {
      sessions = await Promise.all(
        Array.from({ length: config.totalSessions }, (_, i) => runSession(i)),
      );
    } else {
      sessions = [];
      let nextIndex = 0;
      const activePromises = new Map<number, Promise<SessionMetric>>();
      while (nextIndex < config.concurrency && nextIndex < config.totalSessions) {
        activePromises.set(nextIndex, runSession(nextIndex));
        nextIndex++;
      }
      while (activePromises.size > 0) {
        const res = await Promise.race(
          Array.from(activePromises.entries()).map(([idx, p]) =>
            p.then((r) => ({ idx, result: r })),
          ),
        );
        sessions.push(res.result);
        activePromises.delete(res.idx);
        if (nextIndex < config.totalSessions) {
          activePromises.set(nextIndex, runSession(nextIndex));
          nextIndex++;
        }
      }
    }

    const memAfter = process.memoryUsage();

    return {
      config,
      sessions,
      persistence: [],
      deepPersistence: deepMetrics,
      totalDurationMs: Date.now() - startTime,
      concurrentPeak,
      memoryDeltaMB: (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024,
      storeType: this.storeType,
    };
  }

  /**
   * Deep persistence check: save → load → field-by-field comparison.
   */
  private async deepPersistenceCheck(
    session: RuntimeSession,
    cycle: number,
    turnsBefore: number,
  ): Promise<DeepPersistenceMetric> {
    const mismatches: string[] = [];

    // Sync conversation history to store
    if (session.conversationHistory.length > 0) {
      await this.sessionService.appendToConversation(session.id, session.conversationHistory);
    }

    // Save snapshot
    const saveStart = Date.now();
    await this.executor.saveSessionSnapshot(session);
    const saveTimeMs = Date.now() - saveStart;

    // Load from store
    const loadStart = Date.now();
    const loaded = await this.sessionService.loadSession(session.id);
    const loadTimeMs = Date.now() - loadStart;

    if (!loaded) {
      return {
        sessionId: session.id,
        cycle,
        turnsBefore,
        saveTimeMs,
        loadTimeMs,
        stateMatch: false,
        historyMatch: false,
        threadMatch: false,
        dataValuesMatch: false,
        flowStepMatch: false,
        irResolved: false,
        compilationResolved: false,
        isCompleteMatch: false,
        handoffStackMatch: false,
        gatherProgressMatch: false,
        mismatches: ['session not found after save'],
      };
    }

    // --- Field-by-field comparison ---

    // State
    const stateMatch = loaded.state.conversationPhase === session.state.conversationPhase;
    if (!stateMatch)
      mismatches.push(
        `conversationPhase: "${session.state.conversationPhase}" vs "${loaded.state.conversationPhase}"`,
      );

    // Conversation history
    const historyMatch =
      loaded.conversationHistory.length > 0 || session.conversationHistory.length === 0;
    if (!historyMatch)
      mismatches.push(`conversationHistory: ${session.conversationHistory.length} messages lost`);

    // Thread count
    const threadMatch = loaded.threads.length > 0 || session.threads.length === 0;
    if (!threadMatch) mismatches.push(`threads: ${session.threads.length} threads lost`);

    // Data values (the gathered/computed data)
    const loadedDataKeys = Object.keys(loaded.dataValues).sort();
    const sessionDataKeys = Object.keys(session.data.values).sort();
    const dataValuesMatch = JSON.stringify(loadedDataKeys) === JSON.stringify(sessionDataKeys);
    if (!dataValuesMatch) {
      const onlyInSession = sessionDataKeys.filter((k) => !loadedDataKeys.includes(k));
      const onlyInLoaded = loadedDataKeys.filter((k) => !sessionDataKeys.includes(k));
      if (onlyInSession.length)
        mismatches.push(`dataValues missing in loaded: [${onlyInSession.join(',')}]`);
      if (onlyInLoaded.length)
        mismatches.push(`dataValues extra in loaded: [${onlyInLoaded.join(',')}]`);
    }

    // Flow step
    const flowStepMatch = loaded.currentFlowStep === session.currentFlowStep;
    if (!flowStepMatch)
      mismatches.push(
        `currentFlowStep: "${session.currentFlowStep}" vs "${loaded.currentFlowStep}"`,
      );

    // IR resolution (agentIR resolved from cache via hash)
    const irResolved = loaded.agentIR !== null || session.agentIR === null;
    if (!irResolved) mismatches.push('agentIR not resolved from cache');

    // CompilationOutput resolution
    const compilationResolved =
      loaded.compilationOutput !== null || session.compilationOutput === null;
    if (!compilationResolved) mismatches.push('compilationOutput not resolved from cache');

    // isComplete
    const isCompleteMatch = loaded.isComplete === session.isComplete;
    if (!isCompleteMatch)
      mismatches.push(`isComplete: ${session.isComplete} vs ${loaded.isComplete}`);

    // Handoff stack
    const handoffStackMatch =
      JSON.stringify(loaded.handoffStack) === JSON.stringify(session.handoffStack);
    if (!handoffStackMatch)
      mismatches.push(`handoffStack: [${session.handoffStack}] vs [${loaded.handoffStack}]`);

    // Gather progress (in state)
    const sessionGP = JSON.stringify(session.state.gatherProgress);
    const loadedGP = JSON.stringify(loaded.state.gatherProgress);
    const gatherProgressMatch = sessionGP === loadedGP;
    if (!gatherProgressMatch) mismatches.push(`gatherProgress: ${sessionGP} vs ${loadedGP}`);

    return {
      sessionId: session.id,
      cycle,
      turnsBefore,
      saveTimeMs,
      loadTimeMs,
      stateMatch,
      historyMatch,
      threadMatch,
      dataValuesMatch,
      flowStepMatch,
      irResolved,
      compilationResolved,
      isCompleteMatch,
      handoffStackMatch,
      gatherProgressMatch,
      mismatches,
    };
  }

  /**
   * Run a mixed-agent load test with multiple DSLs.
   */
  async runMixed(configs: LoadScenarioConfig[]): Promise<LoadTestResult> {
    const memBefore = process.memoryUsage();
    const startTime = Date.now();
    let concurrentPeak = 0;
    let activeSessions = 0;

    const allSessionMetrics: SessionMetric[] = [];

    // Interleave sessions across configs
    const tasks: Array<{ config: LoadScenarioConfig; sessionIndex: number }> = [];
    let globalIndex = 0;
    for (const config of configs) {
      for (let i = 0; i < config.totalSessions; i++) {
        tasks.push({ config, sessionIndex: globalIndex++ });
      }
    }

    const maxConcurrency = Math.max(...configs.map((c) => c.concurrency));

    const runTask = async (task: (typeof tasks)[0]): Promise<SessionMetric> => {
      activeSessions++;
      if (activeSessions > concurrentPeak) concurrentPeak = activeSessions;

      const { config, sessionIndex } = task;
      const turns: TurnMetric[] = [];
      let sessionSuccess = true;
      const sessionStart = Date.now();

      const creationStart = Date.now();
      let session: RuntimeSession;
      try {
        session = this.executor.createSessionFromResolved(
          compileToResolvedAgent([config.agentDSL], config.agentName),
        );
      } catch (error) {
        activeSessions--;
        return {
          sessionIndex,
          sessionId: '',
          creationTimeMs: Date.now() - creationStart,
          turns: [],
          totalMs: Date.now() - sessionStart,
          success: false,
        };
      }
      const creationTimeMs = Date.now() - creationStart;

      injectMockLLMClient(session, config.llmLatency);

      if (config.initializeFlow && session.currentFlowStep !== undefined) {
        try {
          await this.executor.initializeSession(session.id);
        } catch {
          /* ignore */
        }
      }

      for (let turnIndex = 0; turnIndex < config.conversationInputs.length; turnIndex++) {
        const userMessage = config.conversationInputs[turnIndex];
        const turnStart = Date.now();

        try {
          await this.executor.executeMessage(session.id, userMessage);

          turns.push({ sessionIndex, turnIndex, latencyMs: Date.now() - turnStart, success: true });
        } catch (error) {
          sessionSuccess = false;
          turns.push({
            sessionIndex,
            turnIndex,
            latencyMs: Date.now() - turnStart,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      activeSessions--;
      return {
        sessionIndex,
        sessionId: session.id,
        creationTimeMs,
        turns,
        totalMs: Date.now() - sessionStart,
        success: sessionSuccess,
      };
    };

    // Pool execution
    let nextIndex = 0;
    const activePromises = new Map<number, Promise<SessionMetric>>();

    while (nextIndex < maxConcurrency && nextIndex < tasks.length) {
      activePromises.set(nextIndex, runTask(tasks[nextIndex]));
      nextIndex++;
    }

    while (activePromises.size > 0) {
      const result = await Promise.race(
        Array.from(activePromises.entries()).map(([idx, p]) => p.then((r) => ({ idx, result: r }))),
      );

      allSessionMetrics.push(result.result);
      activePromises.delete(result.idx);

      if (nextIndex < tasks.length) {
        activePromises.set(nextIndex, runTask(tasks[nextIndex]));
        nextIndex++;
      }
    }

    const memAfter = process.memoryUsage();

    return {
      config: configs[0], // Primary config for naming
      sessions: allSessionMetrics,
      persistence: [],
      totalDurationMs: Date.now() - startTime,
      concurrentPeak,
      memoryDeltaMB: (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024,
      storeType: this.storeType,
    };
  }
}

// =============================================================================
// METRICS AGGREGATOR
// =============================================================================

export class MetricsAggregator {
  static compute(result: LoadTestResult): LoadTestMetrics {
    const allTurns = result.sessions.flatMap((s) => s.turns);
    const successfulTurns = allTurns.filter((t) => t.success);

    // Session creation times
    const creationTimes = result.sessions.map((s) => s.creationTimeMs);

    // Turn latencies
    const turnLatencies = successfulTurns.map((t) => t.latencyMs);

    // Success rate
    const successCount = result.sessions.filter((s) => s.success).length;

    const metrics: LoadTestMetrics = {
      sessionCreation: this.computePercentiles(creationTimes),
      turnExecution: this.computePercentiles(turnLatencies),
      throughputTurnsPerSec:
        result.totalDurationMs > 0 ? allTurns.length / (result.totalDurationMs / 1000) : 0,
      successRate: result.sessions.length > 0 ? successCount / result.sessions.length : 0,
      concurrentPeak: result.concurrentPeak,
      totalSessions: result.sessions.length,
      totalTurns: allTurns.length,
      totalDurationMs: result.totalDurationMs,
      memoryDeltaMB: result.memoryDeltaMB,
    };

    // Add persistence metrics if available
    if (result.persistence.length > 0) {
      metrics.persistence = {
        save: this.computePercentiles(result.persistence.map((p) => p.saveTimeMs)),
        load: this.computePercentiles(result.persistence.map((p) => p.loadTimeMs)),
      };
    }

    return metrics;
  }

  static computePercentiles(values: number[]): PercentileStats {
    if (values.length === 0) {
      return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0, mean: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: sorted.length,
      mean: Math.round(sum / sorted.length),
    };
  }
}

// =============================================================================
// REPORT GENERATOR
// =============================================================================

export class ReportGenerator {
  static print(metrics: LoadTestMetrics, title?: string): void {
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    const fmtMs = (v: number) => `${v}ms`;
    const line = (label: string, stats: PercentileStats) => {
      console.log(
        `${label.padEnd(22)}${pad(fmtMs(stats.p50), 8)}${pad(fmtMs(stats.p95), 8)}${pad(fmtMs(stats.p99), 8)}${pad(fmtMs(stats.min), 8)}${pad(fmtMs(stats.max), 8)}${pad(stats.count, 8)}`,
      );
    };

    console.log('');
    if (title) console.log(`=== ${title} ===`);
    console.log(
      `${'Component'.padEnd(22)}${'P50'.padStart(8)}${'P95'.padStart(8)}${'P99'.padStart(8)}${'Min'.padStart(8)}${'Max'.padStart(8)}${'Count'.padStart(8)}`,
    );
    console.log('\u2500'.repeat(70));

    line('Session Creation', metrics.sessionCreation);
    line('Turn Execution', metrics.turnExecution);

    if (metrics.persistence) {
      line('Persistence Save', metrics.persistence.save);
      line('Persistence Load', metrics.persistence.load);
    }

    console.log('');
    console.log(
      `Throughput: ${metrics.throughputTurnsPerSec.toFixed(1)} turns/s | ` +
        `Success: ${(metrics.successRate * 100).toFixed(1)}% | ` +
        `Peak Concurrent: ${metrics.concurrentPeak}`,
    );
    console.log(
      `Sessions: ${metrics.totalSessions} | ` +
        `Turns: ${metrics.totalTurns} | ` +
        `Duration: ${metrics.totalDurationMs}ms | ` +
        `Memory \u0394: ${metrics.memoryDeltaMB.toFixed(2)} MB`,
    );
    console.log('');
  }

  /** Print deep persistence verification results */
  static printDeepPersistence(metrics: DeepPersistenceMetric[], storeType: string): void {
    if (metrics.length === 0) return;

    const total = metrics.length;
    const fields = [
      'stateMatch',
      'historyMatch',
      'threadMatch',
      'dataValuesMatch',
      'flowStepMatch',
      'irResolved',
      'compilationResolved',
      'isCompleteMatch',
      'handoffStackMatch',
      'gatherProgressMatch',
    ] as const;

    console.log(`\n--- Deep Persistence Report (${storeType}) ---`);
    console.log(
      `${'Field'.padEnd(24)} ${'Pass'.padStart(6)} / ${'Total'.padStart(6)}  ${'Rate'.padStart(7)}`,
    );
    console.log('\u2500'.repeat(50));

    let allPass = true;
    for (const field of fields) {
      const passed = metrics.filter((m) => m[field]).length;
      const rate = ((passed / total) * 100).toFixed(1);
      const marker = passed === total ? '\u2713' : '\u2717';
      console.log(
        `${marker} ${field.padEnd(22)} ${String(passed).padStart(6)} / ${String(total).padStart(6)}  ${rate.padStart(6)}%`,
      );
      if (passed < total) allPass = false;
    }

    // Print cycles summary
    const cycles = [...new Set(metrics.map((m) => m.cycle))];
    console.log(`\nCycles: ${cycles.length} per session | Total checkpoints: ${total}`);

    // Print save/load latencies
    const saves = MetricsAggregator.computePercentiles(metrics.map((m) => m.saveTimeMs));
    const loads = MetricsAggregator.computePercentiles(metrics.map((m) => m.loadTimeMs));
    console.log(`Save latency: P50=${saves.p50}ms P95=${saves.p95}ms P99=${saves.p99}ms`);
    console.log(`Load latency: P50=${loads.p50}ms P95=${loads.p95}ms P99=${loads.p99}ms`);

    // Print mismatches if any
    const withMismatches = metrics.filter((m) => m.mismatches.length > 0);
    if (withMismatches.length > 0) {
      console.log(`\nMismatches (${withMismatches.length} checkpoints):`);
      for (const m of withMismatches.slice(0, 10)) {
        console.log(
          `  session=${m.sessionId.slice(0, 8)}... cycle=${m.cycle}: ${m.mismatches.join('; ')}`,
        );
      }
      if (withMismatches.length > 10) {
        console.log(`  ... and ${withMismatches.length - 10} more`);
      }
    }

    console.log(allPass ? '\nAll persistence checks PASSED' : '\nSome persistence checks FAILED');
    console.log('');
  }
}
