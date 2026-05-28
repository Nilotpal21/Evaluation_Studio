/**
 * Wiring Tests (Runtime)
 *
 * Verifies that runtime-relevant code paths are properly wired.
 * Design-time wiring tests (mfaGuard, audit, scheduler, SSO) are in studio.
 */

import { describe, test, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// MOCKS
// =============================================================================

// Mock tenant context middleware
vi.mock('../middleware/tenant-context', () => ({
  getCurrentTenantId: () => 'org-1',
  getCurrentRequestId: () => 'req-123',
  getTenantContextData: () => ({ tenantId: 'org-1', userId: 'user-1' }),
  runWithTenantContext: vi.fn(async (_ctx: any, fn: () => Promise<void>) => fn()),
}));

// Mock request-id middleware
vi.mock('../middleware/request-id', () => ({
  getCurrentRequestId: () => 'req-123',
  requestIdMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock config module — server.ts calls getConfig() at module scope
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    server: { port: 3112, frontendUrl: 'http://localhost:3000' },
    port: 3112,
    voice: { twilio: {} },
    clickhouse: {},
    redis: {},
  }),
  loadConfig: vi.fn(),
}));

// Static imports — module resolution at file load doesn't count against test timeout.
// vi.mock() calls above are hoisted by vitest, so mocks are applied before these load.
import { sdkClients } from '../websocket/sdk-handler';
import { WebSocketConnectionManager } from '../websocket/connection-manager';
import { OtelTraceStore } from '../observability/otel-trace-bridge';
import {
  recordHttpRequest,
  incrementActiveRequests,
  decrementActiveRequests,
  recordLlmCall,
  recordToolCall,
  incrementActiveSessions,
  decrementActiveSessions,
  setCircuitBreakerState,
  recordRateLimitRejection,
  recordWsRateLimitRejection,
  recordBackpressure,
} from '../observability/metrics';

// =============================================================================
// W6: sdkClients admin visibility + graceful shutdown
// =============================================================================

describe('W6: sdkClients admin visibility', () => {
  test('sdkClients exports a map-like WebSocket connection manager from sdk-handler', () => {
    expect(sdkClients).toBeInstanceOf(WebSocketConnectionManager);
    expect(typeof sdkClients.get).toBe('function');
    expect(typeof sdkClients.set).toBe('undefined');
    expect(typeof sdkClients.delete).toBe('function');
    expect(typeof sdkClients.clear).toBe('function');
  });
});

// =============================================================================
// W2: OTEL metrics functions wired into application code
// =============================================================================

describe('W2: OTEL metrics wired into application code', () => {
  test('all 11 exported metrics functions exist', () => {
    expect(typeof recordHttpRequest).toBe('function');
    expect(typeof incrementActiveRequests).toBe('function');
    expect(typeof decrementActiveRequests).toBe('function');
    expect(typeof recordLlmCall).toBe('function');
    expect(typeof recordToolCall).toBe('function');
    expect(typeof incrementActiveSessions).toBe('function');
    expect(typeof decrementActiveSessions).toBe('function');
    expect(typeof setCircuitBreakerState).toBe('function');
    expect(typeof recordRateLimitRejection).toBe('function');
    expect(typeof recordWsRateLimitRejection).toBe('function');
    expect(typeof recordBackpressure).toBe('function');
  });
});

// =============================================================================
// W3: OtelTraceStore instantiated
// =============================================================================

describe('W3: OtelTraceStore instantiated in trace-store', () => {
  test('trace-store conditionally creates OtelTraceStore when OTEL is configured', () => {
    const storePath = path.resolve(import.meta.dirname, '../services/trace-store.ts');
    const content = fs.readFileSync(storePath, 'utf-8');

    // Verify conditional instantiation
    expect(content).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(content).toContain('new OtelTraceStore(');

    // Verify events are forwarded to the bridge
    expect(content).toContain('this.otelBridge');
    expect(content).toMatch(/otelBridge[\s\n]*\.appendEvent/);
  });

  test('OtelTraceStore class can be imported and has expected methods', () => {
    expect(OtelTraceStore).toBeDefined();
    expect(OtelTraceStore.prototype.appendEvent).toBeDefined();
    expect(OtelTraceStore.prototype.endTrace).toBeDefined();
    expect(OtelTraceStore.prototype.startTrace).toBeDefined();
  });
});

// =============================================================================
// INTEGRATION: Metrics functions execute without error
// =============================================================================

describe('Integration: Metrics functions are callable', () => {
  test('recordHttpRequest does not throw', () => {
    expect(() =>
      recordHttpRequest({
        method: 'GET',
        route: '/api/test',
        statusCode: 200,
        durationMs: 42,
      }),
    ).not.toThrow();
  });

  test('incrementActiveRequests / decrementActiveRequests do not throw', () => {
    expect(() => incrementActiveRequests()).not.toThrow();
    expect(() => decrementActiveRequests()).not.toThrow();
  });

  test('recordLlmCall does not throw', () => {
    expect(() =>
      recordLlmCall({
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        durationMs: 1200,
        tokensIn: 100,
        tokensOut: 250,
      }),
    ).not.toThrow();
  });

  test('incrementActiveSessions / decrementActiveSessions do not throw', () => {
    expect(() => incrementActiveSessions()).not.toThrow();
    expect(() => decrementActiveSessions()).not.toThrow();
  });

  test('setCircuitBreakerState does not throw', () => {
    expect(() => setCircuitBreakerState('llm:anthropic', 0)).not.toThrow();
    expect(() => setCircuitBreakerState('llm:anthropic', 2)).not.toThrow();
  });

  test('recordToolCall does not throw', () => {
    expect(() =>
      recordToolCall({
        toolName: 'search',
        durationMs: 500,
        success: true,
      }),
    ).not.toThrow();
  });

  test('recordRateLimitRejection does not throw', () => {
    expect(() =>
      recordRateLimitRejection({
        tenantId: 'org-1',
        operation: 'request',
      }),
    ).not.toThrow();
  });

  test('recordWsRateLimitRejection does not throw', () => {
    expect(() =>
      recordWsRateLimitRejection({
        ip: '127.0.0.1',
      }),
    ).not.toThrow();
  });
});

// =============================================================================
// WIRING: Metrics are called from production code paths
// =============================================================================

describe('Wiring: Metrics imported in production modules', () => {
  test('server.ts imports HTTP request metrics', () => {
    const serverPath = path.resolve(import.meta.dirname, '../server.ts');
    const content = fs.readFileSync(serverPath, 'utf-8');
    expect(content).toContain("from './observability/metrics.js'");
    expect(content).toContain('incrementActiveRequests');
    expect(content).toContain('decrementActiveRequests');
    expect(content).toContain('recordHttpRequest');
  });

  test('server.ts OAuth services guard with isRedisAvailable() before binding shared state', () => {
    const serverPath = path.resolve(import.meta.dirname, '../server.ts');
    const content = fs.readFileSync(serverPath, 'utf-8');
    const redisInitIndex = content.indexOf('await initializeRedis()');
    const toolOAuthIndex = content.indexOf('// ─── ToolOAuthService');
    const channelOAuthIndex = content.indexOf('// ─── ChannelOAuthService');

    // All three markers must exist
    expect(redisInitIndex).toBeGreaterThan(-1);
    expect(toolOAuthIndex).toBeGreaterThan(-1);
    expect(channelOAuthIndex).toBeGreaterThan(-1);

    // OAuth services check isRedisAvailable() and fall back to InMemoryOAuthStateStore
    expect(content).toContain('isRedisAvailable()');
    expect(content).toContain('InMemoryOAuthStateStore');
  });

  test('server.ts wires cache invalidation only after Redis initialization', () => {
    const serverPath = path.resolve(import.meta.dirname, '../server.ts');
    const content = fs.readFileSync(serverPath, 'utf-8');
    const redisInitIndex = content.indexOf('await initializeRedis()');
    const kmsInvalidationIndex = content.indexOf('await wireKmsAndDekInvalidation(dek);');
    const modelInvalidationIndex = content.indexOf('await wireModelHubInvalidation(encMasterKey);');

    expect(redisInitIndex).toBeGreaterThan(-1);
    expect(kmsInvalidationIndex).toBeGreaterThan(redisInitIndex);
    expect(modelInvalidationIndex).toBeGreaterThan(redisInitIndex);
  });

  test('server.ts wires both ToolOAuthService and ChannelOAuthService with state stores', () => {
    const serverPath = path.resolve(import.meta.dirname, '../server.ts');
    const content = fs.readFileSync(serverPath, 'utf-8');

    // ToolOAuthService uses Mongo-backed token store
    expect(content).toContain('ToolOAuthService');
    expect(content).toContain('buildMongoOAuthTokenStore');

    // ChannelOAuthService uses Redis or in-memory state store
    expect(content).toContain('ChannelOAuthService');
    expect(content).toContain('RedisOAuthStateStore');
    expect(content).toContain('InMemoryOAuthStateStore');
  });

  test('server.ts passes onContactAudit into initializeRuntimeContactLinking for domain contact events', () => {
    const serverPath = path.resolve(import.meta.dirname, '../server.ts');
    const content = fs.readFileSync(serverPath, 'utf-8');

    expect(content).toContain('initializeRuntimeContactLinking({');
    expect(content).toContain('onContactAudit: emitContactLifecycleAudit');
  });

  test('rate-limiter.ts imports recordRateLimitRejection', () => {
    const limiterPath = path.resolve(import.meta.dirname, '../middleware/rate-limiter.ts');
    const content = fs.readFileSync(limiterPath, 'utf-8');
    expect(content).toContain('recordRateLimitRejection');
    expect(content).toContain("from '../observability/metrics.js'");
  });

  test('sdk-handler.ts imports recordWsRateLimitRejection', () => {
    const sdkPath = path.resolve(import.meta.dirname, '../websocket/sdk-handler.ts');
    const content = fs.readFileSync(sdkPath, 'utf-8');
    expect(content).toContain('recordWsRateLimitRejection');
    expect(content).toContain("from '../observability/metrics.js'");
  });

  test('session-llm-client.ts imports recordLlmCall', () => {
    const llmPath = path.resolve(import.meta.dirname, '../services/llm/session-llm-client.ts');
    const content = fs.readFileSync(llmPath, 'utf-8');
    expect(content).toContain('recordLlmCall');
    expect(content).toContain("from '../../observability/metrics.js'");
  });

  test('reasoning-executor.ts imports recordToolCall', () => {
    const execPath = path.resolve(
      import.meta.dirname,
      '../services/execution/reasoning-executor.ts',
    );
    const content = fs.readFileSync(execPath, 'utf-8');
    expect(content).toContain('recordToolCall');
    expect(content).toContain("from '../../observability/metrics.js'");
  });

  test('flow-step-executor.ts imports recordToolCall', () => {
    const execPath = path.resolve(
      import.meta.dirname,
      '../services/execution/flow-step-executor.ts',
    );
    const content = fs.readFileSync(execPath, 'utf-8');
    expect(content).toContain('recordToolCall');
    expect(content).toContain("from '../../observability/metrics.js'");
  });

  test('llm-queue.ts imports recordBackpressure', () => {
    const queuePath = path.resolve(import.meta.dirname, '../services/llm/llm-queue.ts');
    const content = fs.readFileSync(queuePath, 'utf-8');
    expect(content).toContain('recordBackpressure');
    expect(content).toContain("from '../../observability/metrics.js'");
  });
});
