// packages/a2a/src/infrastructure/express-handlers.ts

// NOTE: We use generic types for Express app/middleware parameters because
// the SDK types reference Express v4 while our package may resolve Express v5.
// At runtime the types are compatible — only the TS declarations differ.
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from '@a2a-js/sdk/server';
import { A2AExpressApp } from '@a2a-js/sdk/server/express';
import {
  AgentExecutorAdapter,
  a2aContextStorage,
  type A2AAttachmentIngestor,
} from './agent-executor-adapter.js';
import type {
  A2ATracingPort,
  AgentExecutionPort,
  A2ASessionResolverPort,
  A2ARequestContext,
} from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:express-handlers');

/** Minimal ChannelConnection fields needed to build A2ARequestContext */
export interface A2AChannelConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string | null;
  environment: string | null;
  status: string;
  /** Decrypted inbound API key for Bearer token auth. Null = auth not configured. */
  inboundApiKey: string | null;
}

export interface CreateA2AExpressHandlersConfig {
  /** The agent card describing this agent's capabilities */
  agentCard: AgentCard;
  /** Name of the local agent */
  agentName: string;
  /** Platform execution port (delegates to RuntimeExecutor) */
  executionPort: AgentExecutionPort;
  /** Tracing port for inbound call instrumentation */
  tracing: A2ATracingPort;
  /** Optional task store — defaults to InMemoryTaskStore */
  taskStore?: TaskStore;
  /** Base URL for A2A endpoints (e.g. "/a2a") */
  baseUrl?: string;
  /** Optional session resolver for contextId → RuntimeSession mapping */
  sessionResolver?: A2ASessionResolverPort;
  /** Optional host-provided ingestor for inbound A2A file parts. */
  attachmentIngestor?: A2AAttachmentIngestor;
  /** Optional Express middlewares to apply to the A2A routes */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middlewares?: any[];
  /** Lookup function to resolve a ChannelConnection by ID */
  getConnection?: (connectionId: string) => Promise<A2AChannelConnection | null>;
  /**
   * Dynamic agent card provider — called on every agent-card request when
   * a connection context is available (from a2aContextStorage). Receives
   * the resolved A2ARequestContext and returns a per-connection AgentCard.
   * Falls back to the static `agentCard` if not provided or if no context.
   */
  agentCardProvider?: (context: A2ARequestContext) => Promise<AgentCard>;
}

/**
 * Factory function that wires up the A2A SDK server integration with
 * the platform's AgentExecutorAdapter.
 *
 * Returns a setup function that attaches A2A routes to an Express app.
 *
 * Architecture:
 *  1. Creates an AgentExecutorAdapter (bridges SDK <-> platform executor)
 *  2. Creates the SDK's DefaultRequestHandler with our adapter
 *  3. Creates an A2AExpressApp that handles JSON-RPC transport + SSE
 *  4. Returns a function to attach connection-scoped routes to an Express app
 */
export function createA2AExpressHandlers(config: CreateA2AExpressHandlersConfig) {
  // 1. Create the adapter that bridges SDK's AgentExecutor to our platform
  const agentExecutor = new AgentExecutorAdapter({
    agentName: config.agentName,
    executionPort: config.executionPort,
    tracing: config.tracing,
    sessionResolver: config.sessionResolver,
    attachmentIngestor: config.attachmentIngestor,
  });

  // 2. Create SDK request handler with our adapter
  const taskStore = config.taskStore ?? new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(config.agentCard, taskStore, agentExecutor);

  // 3. Override getAgentCard to be connection-aware when agentCardProvider is set.
  //    The SDK's DefaultRequestHandler.getAgentCard() returns a static card.
  //    We monkey-patch it to read the current A2ARequestContext from AsyncLocalStorage
  //    and delegate to the dynamic agentCardProvider, falling back to the static card.
  if (config.agentCardProvider) {
    const staticGetAgentCard = requestHandler.getAgentCard.bind(requestHandler);
    const dynamicProvider = config.agentCardProvider;
    requestHandler.getAgentCard = async () => {
      const ctx = a2aContextStorage.getStore();
      if (ctx) {
        try {
          return await dynamicProvider(ctx);
        } catch (err) {
          log.warn('Dynamic agent card provider failed, falling back to static card', {
            connectionId: ctx.connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return staticGetAgentCard();
    };
  }

  // 4. Create the SDK Express app wrapper
  const a2aApp = new A2AExpressApp(requestHandler);

  // 4. Return a setup function for attaching to an Express app
  return {
    /**
     * Attaches A2A protocol routes to the given Express app.
     *
     * When `getConnection` is configured, routes are connection-scoped:
     *   POST /a2a/:connectionId          → JSON-RPC
     *   GET  /a2a/:connectionId/sse      → SSE streaming
     *   GET  /a2a/:connectionId/.well-known/agent-card.json → dynamic agent card
     *
     * Each request resolves the ChannelConnection, validates it,
     * builds an A2ARequestContext, and sets it on the adapter before
     * delegating to the SDK.
     *
     * @param app The Express application to attach routes to
     * @returns The Express app with A2A routes attached
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupRoutes(app: any): any {
      if (config.getConnection) {
        // Connection-scoped middleware: resolve connection → set context
        // NOTE: The SDK's A2AExpressApp creates its own Router without mergeParams,
        // so req.params.connectionId is NOT available inside the SDK router.
        // We extract connectionId from req.baseUrl instead.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resolveConnection = async (req: any, res: any, next: any) => {
          // req.baseUrl is e.g. "/a2a/019cff49-d759-7ef5-80e0-c63f574bc55d"
          const baseUrl = config.baseUrl ?? '/a2a';
          const prefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
          const urlAfterBase = req.baseUrl.startsWith(prefix)
            ? req.baseUrl.slice(prefix.length)
            : (req.baseUrl.split('/').pop() ?? '');
          const connectionId = urlAfterBase.split('/')[0] || req.params.connectionId;
          if (!connectionId || connectionId.length > 128 || !/^[\w-]+$/.test(connectionId)) {
            res.status(400).json({ error: 'Invalid connection ID' });
            return;
          }

          try {
            const connection = await config.getConnection!(connectionId);
            if (!connection) {
              res.status(404).json({ error: 'Connection not found' });
              return;
            }

            if (connection.status !== 'active') {
              res.status(410).json({ error: 'Connection is inactive' });
              return;
            }

            // Validate inbound auth — Bearer token must match the connection's API key.
            // When inboundApiKey is set on the connection, all requests (JSON-RPC, SSE,
            // and agent card discovery) require a valid Authorization header.
            if (connection.inboundApiKey) {
              const authHeader = req.headers?.authorization as string | undefined;
              if (!authHeader) {
                res.status(401).json({ error: 'Authorization header required' });
                return;
              }
              const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
              if (!token || token !== connection.inboundApiKey) {
                res.status(401).json({ error: 'Invalid API key' });
                return;
              }
            }

            const context: A2ARequestContext = {
              tenantId: connection.tenantId,
              projectId: connection.projectId,
              connectionId: connection._id,
              deploymentId: connection.deploymentId ?? undefined,
              environment: connection.environment ?? undefined,
            };

            // Store context in AsyncLocalStorage (concurrency-safe for parallel requests)
            a2aContextStorage.run(context, () => next());
          } catch (err) {
            log.error('Failed to resolve connection', {
              connectionId,
              error: err instanceof Error ? err.message : String(err),
            });
            res.status(500).json({ error: 'Internal server error' });
          }
        };

        const baseUrl = config.baseUrl ?? '/a2a';
        const allMiddlewares = [...(config.middlewares ?? []), resolveConnection];

        // Register connection-scoped routes with the SDK's A2AExpressApp
        return a2aApp.setupRoutes(app, `${baseUrl}/:connectionId`, allMiddlewares);
      }

      // Fallback: non-connection-scoped routes (backward compat / testing)
      return a2aApp.setupRoutes(app, config.baseUrl, config.middlewares);
    },

    /** Exposed for testing: the underlying SDK request handler */
    requestHandler,

    /** Exposed for testing: the platform agent executor adapter */
    agentExecutor,
  };
}
