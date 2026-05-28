/**
 * Runtime simulation route.
 *
 * Mounted at /api/projects/:projectId/runtime/simulate.
 * Runs dirty/persisted project DSL through RuntimeExecutor with ephemeral
 * persistence and fail-closed tool mocks.
 */

import crypto from 'crypto';
import { Router, type RequestHandler, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import type { ToolExecutor } from '@abl/compiler';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import {
  RUNTIME_SIMULATION_MAX_DSL_OVERRIDE_BYTES,
  RUNTIME_SIMULATION_MAX_SCRIPTED_TURNS,
} from '@agent-platform/config/constants';
import { findProjectAgentsForProject } from '../repos/project-repo.js';
import { compileToResolvedAgent, getRuntimeExecutor } from '../services/runtime-executor.js';
import { getTraceStore } from '../services/trace-store.js';

const log = createLogger('simulate-route');

type RuntimeExecutor = ReturnType<typeof getRuntimeExecutor>;
type TraceStore = ReturnType<typeof getTraceStore>;

interface SimulateRouterDeps {
  authMiddleware?: RequestHandler;
  projectScopeMiddleware?: RequestHandler;
  rateLimitMiddleware?: RequestHandler;
  requireProjectPermission?: typeof requireProjectPermission;
  findProjectAgentsForProject?: typeof findProjectAgentsForProject;
  compileToResolvedAgent?: typeof compileToResolvedAgent;
  getRuntimeExecutor?: () => RuntimeExecutor;
  getTraceStore?: () => TraceStore;
  createFactStore?: () => InMemoryFactStore;
}

const mockResultSchema = z.object({
  success: z.boolean().optional(),
  response: z.unknown().optional(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
  delayMs: z.number().int().min(0).max(30_000).optional(),
});

const simulateRequestSchema = z
  .object({
    agentId: z.string().min(1),
    dslOverride: z.string().max(RUNTIME_SIMULATION_MAX_DSL_OVERRIDE_BYTES).optional(),
    scriptedUserTurns: z.array(z.string().min(1)).min(1).max(RUNTIME_SIMULATION_MAX_SCRIPTED_TURNS),
    mockedToolResponses: z.record(mockResultSchema).optional().default({}),
    options: z
      .object({
        maxTurns: z.number().int().min(1).max(RUNTIME_SIMULATION_MAX_SCRIPTED_TURNS).optional(),
        scenarioId: z.string().min(1).max(128).optional(),
        intentTags: z
          .array(z.string().min(1).max(128))
          .max(RUNTIME_SIMULATION_MAX_SCRIPTED_TURNS)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type MockResult = z.infer<typeof mockResultSchema>;

class FailClosedSimulationToolExecutor implements ToolExecutor {
  constructor(private readonly mocks: Record<string, MockResult>) {}

  async execute(toolName: string, _params: Record<string, unknown>, _timeoutMs: number) {
    const mock = this.mocks[toolName];
    if (!mock) {
      return {
        success: false,
        error: {
          code: 'MOCKED_TOOL_NOT_PROVIDED',
          message: `Simulation mock not provided for tool "${toolName}"`,
        },
      };
    }

    if (mock.delayMs && mock.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    }

    if (mock.success === false) {
      return {
        success: false,
        error: mock.error ?? {
          code: 'MOCK_ERROR',
          message: `Mocked failure for tool "${toolName}"`,
        },
      };
    }

    if ('response' in mock) return mock.response;
    if ('data' in mock) return { success: true, data: mock.data };
    return { success: true, data: null };
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ) {
    return Promise.all(
      calls.map(async (call) => ({
        name: call.name,
        result: await this.execute(call.name, call.params, timeoutMs),
      })),
    );
  }
}

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeAgentKey(value: string): string {
  return value.trim().toLowerCase();
}

export function createSimulateRouter(deps: SimulateRouterDeps = {}): RouterType {
  const router: RouterType = Router({ mergeParams: true });
  const auth = deps.authMiddleware ?? authMiddleware;
  const projectScope =
    deps.projectScopeMiddleware ?? requireProjectScope('projectId', { concealOutOfScope: true });
  const rateLimit = deps.rateLimitMiddleware ?? tenantRateLimit('request');
  const permissionCheck = deps.requireProjectPermission ?? requireProjectPermission;
  const findAgents = deps.findProjectAgentsForProject ?? findProjectAgentsForProject;
  const compileResolved = deps.compileToResolvedAgent ?? compileToResolvedAgent;
  const runtimeExecutorFactory = deps.getRuntimeExecutor ?? getRuntimeExecutor;
  const traceStoreFactory = deps.getTraceStore ?? getTraceStore;
  const createFactStore =
    deps.createFactStore ?? (() => new InMemoryFactStore({ type: 'memory', environment: 'dev' }));

  router.use(auth);
  router.use(projectScope);
  router.use(rateLimit);

  router.post('/', async (req, res) => {
    const projectId = String((req.params as { projectId?: string }).projectId ?? '');
    let sessionId: string | null = null;
    let executor: RuntimeExecutor | null = null;
    try {
      if (!(await permissionCheck(req, res, 'session:execute'))) return;

      const parsed = simulateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SIMULATION_REQUEST',
            message: 'Invalid simulation request body',
            details: parsed.error.flatten(),
          },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: { code: 'USER_CONTEXT_REQUIRED', message: 'User context required' },
        });
        return;
      }

      const agentRecords = await findAgents(projectId, {
        tenantId,
        includeDSLContent: true,
      });
      const requestedAgentKey = normalizeAgentKey(parsed.data.agentId);
      const targetAgent = agentRecords.find((agent: { name?: string; agentPath?: string }) => {
        const names = [agent.name, agent.agentPath, agent.agentPath?.split('/').pop()].filter(
          (value): value is string => typeof value === 'string',
        );
        return names.some((name) => normalizeAgentKey(name) === requestedAgentKey);
      });

      if (!targetAgent?.name) {
        res.status(404).json({
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' },
        });
        return;
      }

      const dsls = agentRecords
        .map((agent: { name?: string; dslContent?: string | null }) =>
          agent.name === targetAgent.name && parsed.data.dslOverride
            ? parsed.data.dslOverride
            : (agent.dslContent ?? ''),
        )
        .filter((dsl: string) => dsl.trim().length > 0);

      if (dsls.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_DSL_AVAILABLE', message: 'No DSL content available to simulate' },
        });
        return;
      }

      const scenarioId = parsed.data.options?.scenarioId;
      executor = runtimeExecutorFactory();
      const resolved = compileResolved(dsls, targetAgent.name);
      sessionId = `sim_${crypto.randomUUID()}`;
      const session = executor.createSessionFromResolved(resolved, {
        tenantId,
        projectId,
        userId,
        sessionId,
        channelType: 'simulation',
        ephemeralExecution: { kind: 'simulation', scenarioId },
      });

      session.toolExecutor = new FailClosedSimulationToolExecutor(parsed.data.mockedToolResponses);
      session._externalToolExecutor = session.toolExecutor;
      session.factStore = createFactStore();
      session.projectFactStore = createFactStore();

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
        const payload = {
          ...event,
          data: {
            ...event.data,
            simulation: true,
            scenarioId,
          },
        };
        traceEvents.push(payload);
        sendSse(res, 'trace', payload);
      };

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      sendSse(res, 'started', {
        success: true,
        sessionId,
        agentName: targetAgent.name,
        scenarioId,
      });

      const maxTurns = parsed.data.options?.maxTurns ?? parsed.data.scriptedUserTurns.length;
      const turns = parsed.data.scriptedUserTurns.slice(0, maxTurns);
      for (let index = 0; index < turns.length; index += 1) {
        const result = await executor.executeMessage(
          sessionId,
          turns[index],
          undefined,
          onTraceEvent,
        );
        const activeSession = executor.getSession(sessionId);
        const isComplete = activeSession?.isComplete ?? result.action?.type === 'complete';
        sendSse(res, 'turn', {
          index,
          user: turns[index],
          response: result.response ?? '',
          action: result.action ?? null,
          isComplete,
          intentTag: parsed.data.options?.intentTags?.[index],
        });

        if (isComplete) {
          break;
        }
      }

      sendSse(res, 'complete', {
        success: true,
        sessionId,
        traceEventCount: traceEvents.length,
      });

      res.end();
    } catch (err) {
      log.error('Simulation failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: { code: 'SIMULATION_FAILED', message: 'Simulation failed' },
        });
        return;
      }
      sendSse(res, 'error', {
        success: false,
        error: { code: 'SIMULATION_FAILED', message: 'Simulation failed' },
      });
      res.end();
    } finally {
      if (sessionId) {
        traceStoreFactory().clearSession?.(sessionId);
        executor?.endSession(sessionId);
      }
    }
  });

  return router;
}

export default createSimulateRouter();
