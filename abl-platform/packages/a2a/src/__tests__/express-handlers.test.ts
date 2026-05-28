import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createA2AExpressHandlers } from '../infrastructure/express-handlers.js';
import type { CreateA2AExpressHandlersConfig } from '../infrastructure/express-handlers.js';
import type { A2ATracingPort, AgentExecutionPort } from '../domain/ports.js';
import type { AgentCard } from '@a2a-js/sdk';
import { AgentExecutorAdapter } from '../infrastructure/agent-executor-adapter.js';

describe('createA2AExpressHandlers', () => {
  let tracing: A2ATracingPort;
  let executionPort: AgentExecutionPort;
  let config: CreateA2AExpressHandlersConfig;

  const sampleAgentCard: AgentCard = {
    name: 'Test Agent',
    description: 'A test agent served via A2A',
    url: 'http://localhost:3000/a2a',
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: 'General chat capability',
      },
    ],
  } as AgentCard;

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    executionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello',
        action: { type: 'complete' },
      }),
      getSessionDetail: vi.fn().mockReturnValue(null),
    };
    config = {
      agentCard: sampleAgentCard,
      agentName: 'test-agent',
      tenantId: 'tenant-1',
      executionPort,
      tracing,
    };
  });

  it('returns an object with setupRoutes function', () => {
    const handlers = createA2AExpressHandlers(config);

    expect(handlers).toBeDefined();
    expect(typeof handlers.setupRoutes).toBe('function');
  });

  it('exposes the underlying request handler', () => {
    const handlers = createA2AExpressHandlers(config);

    expect(handlers.requestHandler).toBeDefined();
    expect(typeof handlers.requestHandler.getAgentCard).toBe('function');
    expect(typeof handlers.requestHandler.sendMessage).toBe('function');
  });

  it('exposes the agent executor adapter', () => {
    const handlers = createA2AExpressHandlers(config);

    expect(handlers.agentExecutor).toBeDefined();
    expect(handlers.agentExecutor).toBeInstanceOf(AgentExecutorAdapter);
  });

  it('request handler returns the configured agent card', async () => {
    const handlers = createA2AExpressHandlers(config);
    const card = await handlers.requestHandler.getAgentCard();

    expect(card).toEqual(sampleAgentCard);
  });

  it('setupRoutes attaches routes to a mock Express app', () => {
    const handlers = createA2AExpressHandlers(config);

    // Create a minimal mock Express app to verify setupRoutes runs
    const mockApp = {
      post: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnThis(),
      use: vi.fn().mockReturnThis(),
    };

    // setupRoutes should not throw — it wires SDK routes
    const result = handlers.setupRoutes(mockApp as any);
    expect(result).toBeDefined();
  });

  it('accepts optional baseUrl and middlewares config', () => {
    const middleware = vi.fn();
    const configWithOptions: CreateA2AExpressHandlersConfig = {
      ...config,
      baseUrl: '/custom/a2a',
      middlewares: [middleware as any],
    };

    const handlers = createA2AExpressHandlers(configWithOptions);
    expect(typeof handlers.setupRoutes).toBe('function');
  });

  it('accepts a custom task store', () => {
    const customStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
    };

    const configWithStore: CreateA2AExpressHandlersConfig = {
      ...config,
      taskStore: customStore,
    };

    const handlers = createA2AExpressHandlers(configWithStore);
    expect(handlers.requestHandler).toBeDefined();
  });
});
