/**
 * Stress Test Server Factory
 *
 * Self-contained Express server that wires:
 *   HTTP POST /api/v1/chat/agent → RuntimeExecutor → all backends
 *
 * Backends wired per request:
 *   - Session state: SessionService (Memory or Redis store)
 *   - DB sessions + messages: MongoDB via MongoConversationStore + batchCreateMessages
 *   - Trace events: mock ClickHouse (_addRows)
 *
 * Used by runtime-channel-stress.test.ts to exercise the full production
 * topology from HTTP request down to persistence.
 */

import http from 'http';
import express from 'express';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { SessionService } from '../../services/session/session-service.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import type { SessionStore } from '../../services/session/session-store.js';
import type { MockClickHouseClient } from './mock-clickhouse.js';
import { MockSessionLLMClient, type LatencyConfig } from '../stress/runtime-load-test.js';

// =============================================================================
// TYPES
// =============================================================================

export interface StressServerConfig {
  /** ABL DSL source for the agent */
  dsl: string;
  /** Entry agent name */
  agentName: string;
  /** Environment label used for persisted MongoDB sessions */
  environment?: 'dev' | 'staging' | 'production';
  /** Mock LLM latency config */
  llmLatency?: { chatLatencyMs: number; jitter: number };
  /** Session store (Redis or Memory) */
  sessionStore?: SessionStore;
  /** Enable MongoDB message persistence via batchCreateMessages */
  enableMessagePersistence?: boolean;
  /** Mock ClickHouse client for trace writes */
  mockClickHouseClient?: MockClickHouseClient;
}

const STRESS_TENANT_ID = 'stress-test';
const STRESS_PROJECT_ID = 'stress-test-project';

export interface StressTestServer {
  /** Base URL including port (e.g., http://127.0.0.1:12345) */
  baseUrl: string;
  /** The RuntimeExecutor instance */
  executor: RuntimeExecutor;
  /** The SessionService instance */
  sessionService: SessionService;
  /** Shut down the server and flush queues */
  close(): Promise<void>;
  /** All runtime session IDs created so far */
  getSessionIds(): string[];
  /** All MongoDB session IDs created so far */
  getDbSessionIds(): string[];
  /** Clear tracked session IDs (call between tests when collections are cleared) */
  resetTracking(): void;
  /** Await any fire-and-forget persistence started by prior requests */
  flushPersistence(): Promise<void>;
}

// =============================================================================
// FACTORY
// =============================================================================

export async function createStressTestServer(
  config: StressServerConfig,
): Promise<StressTestServer> {
  // 1. Compile DSL once
  const resolved = compileToResolvedAgent([config.dsl], config.agentName);

  // 2. Create executor + session service
  const store = config.sessionStore ?? new MemorySessionStore();
  const sessionService = new SessionService(store);
  const executor = new RuntimeExecutor({});
  executor.setSessionService(sessionService);
  const persistenceEnvironment = config.environment ?? 'dev';

  // 3. Track created session IDs
  const sessionIds: string[] = [];
  const dbSessionIds: string[] = [];
  const pendingPersistence = new Set<Promise<void>>();

  function trackPersistence(promise: Promise<void>): void {
    pendingPersistence.add(promise);
    promise.finally(() => pendingPersistence.delete(promise));
  }

  // 4. Dynamic import of MongoDB models (only if persistence enabled)
  let Session: any = null;
  let Message: any = null;
  let batchCreateMessages: ((msgs: any[]) => Promise<void>) | null = null;

  if (config.enableMessagePersistence) {
    const models = await import('@agent-platform/database/models');
    Session = models.Session;
    Message = models.Message;

    // The tenant-isolation insertMany hook can hang in this harness; keep the
    // encryption hook so persisted messages still round-trip through DEK crypto.
    const insertManyHooks = (Message.schema as any).s?.hooks?._pres?.get?.('insertMany');
    if (Array.isArray(insertManyHooks) && insertManyHooks.length > 0) {
      insertManyHooks.splice(0, 1);
    }

    const repo = await import('../../repos/session-repo.js');
    batchCreateMessages = repo.batchCreateMessages;
  }

  // 5. Build Express app
  const app = express();
  app.use(express.json());

  app.post('/api/v1/chat/agent', async (req, res) => {
    const { message, sessionId: existingSessionId } = req.body as {
      message: string;
      sessionId?: string;
    };

    if (!message) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_MESSAGE', message: 'message is required' },
      });
      return;
    }

    try {
      let sessionId = existingSessionId;
      let dbSessionId: string | undefined;

      // ── Create session if new ──────────────────────────────────────────
      if (!sessionId) {
        const session = executor.createSessionFromResolved(resolved);
        sessionId = session.id;
        sessionIds.push(sessionId);

        // Inject mock LLM client
        const mockClient = new MockSessionLLMClient(config.llmLatency);
        Object.defineProperty(session, 'llmClient', {
          get: () => mockClient,
          set: () => {
            /* prevent runtime overwrite */
          },
          configurable: true,
        });

        // Initialize flow-mode agent
        if (session.currentFlowStep !== undefined) {
          try {
            await executor.initializeSession(sessionId);
          } catch {
            // Initialization failures are non-fatal for stress testing
          }
        }

        // Create DB session in MongoDB if persistence enabled
        if (Session) {
          try {
            const now = new Date();
            const doc = await Session.create({
              tenantId: STRESS_TENANT_ID,
              projectId: STRESS_PROJECT_ID,
              currentAgent: config.agentName,
              environment: persistenceEnvironment,
              channel: 'api',
              status: 'active',
              isTest: true,
              runtimeSessionId: sessionId,
              startedAt: now,
              lastActivityAt: now,
            });
            dbSessionId = (doc as any)._id.toString();
            dbSessionIds.push(dbSessionId);
          } catch (err) {
            console.warn('[StressServer] DB session creation failed:', err);
          }
        }
      } else {
        // Look up dbSessionId for existing session
        const idx = sessionIds.indexOf(sessionId);
        if (idx >= 0 && idx < dbSessionIds.length) {
          dbSessionId = dbSessionIds[idx];
        }
      }

      // ── Execute message ────────────────────────────────────────────────
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

      const result = await executor.executeMessage(
        sessionId,
        message,
        undefined, // onChunk — not needed for stress tests
        (event) => {
          traceEvents.push(event);
        },
      );

      const responseText = result?.response ?? result?.text ?? '';

      // ── Persist messages to MongoDB ────────────────────────────────────
      // Mirror the production /api/v1/chat/agent route: persistence is
      // fire-and-forget and must not inflate request latency.
      if (config.enableMessagePersistence && batchCreateMessages && dbSessionId) {
        const now = Date.now();
        trackPersistence(
          batchCreateMessages([
            {
              sessionId: dbSessionId,
              tenantId: STRESS_TENANT_ID,
              projectId: STRESS_PROJECT_ID,
              role: 'user',
              content: message,
              channel: 'api',
              timestamp: new Date(now),
              idempotencyKey: `${dbSessionId}:user:${now}`,
            },
            {
              sessionId: dbSessionId,
              tenantId: STRESS_TENANT_ID,
              projectId: STRESS_PROJECT_ID,
              role: 'assistant',
              content: responseText,
              channel: 'api',
              timestamp: new Date(now + 1),
              idempotencyKey: `${dbSessionId}:assistant:${now}`,
            },
          ]).catch((err) => {
            console.warn('[StressServer] Message persistence failed:', err);
          }),
        );
      }

      // ── Write trace events to mock ClickHouse ──────────────────────────
      if (config.mockClickHouseClient && traceEvents.length > 0) {
        const rows = traceEvents.map((evt) => ({
          session_id: sessionId,
          event_type: evt.type,
          data: JSON.stringify(evt.data),
          timestamp: new Date().toISOString(),
        }));
        config.mockClickHouseClient._addRows('abl_platform.platform_events', rows);
      }

      res.json({
        sessionId,
        dbSessionId,
        response: responseText,
        traceEventCount: traceEvents.length,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('[StressServer] Request failed:', errMsg);
      res.status(500).json({
        success: false,
        error: { code: 'EXECUTION_ERROR', message: errMsg },
      });
    }
  });

  // 6. Session state inspection endpoint — returns entity values, history,
  //    flow step, and flags so stress tests can verify real persistence.
  app.get('/api/v1/sessions/:id/state', (req, res) => {
    const session = executor.getSession(req.params.id);
    if (!session) {
      res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${req.params.id} not found` },
      });
      return;
    }

    res.json({
      sessionId: session.id,
      agentName: session.agentName,
      initialized: session.initialized,
      isComplete: session.isComplete,
      currentFlowStep: session.currentFlowStep ?? null,
      conversationHistoryLength: (session.conversationHistory || []).length,
      dataValues: session.data?.values ?? {},
      gatherProgress: session.state?.gatherProgress ?? {},
    });
  });

  // 7. Start server on ephemeral port
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    executor,
    sessionService,
    getSessionIds: () => [...sessionIds],
    getDbSessionIds: () => [...dbSessionIds],
    resetTracking() {
      sessionIds.length = 0;
      dbSessionIds.length = 0;
    },
    async flushPersistence() {
      if (pendingPersistence.size === 0) {
        return;
      }
      await Promise.allSettled([...pendingPersistence]);
    },
    async close() {
      if (pendingPersistence.size > 0) {
        await Promise.allSettled([...pendingPersistence]);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
