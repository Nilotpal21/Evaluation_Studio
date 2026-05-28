/**
 * Integration tests for agent-assist callback worker.
 *
 * Real HTTP server as callback sink. No vi.mock of platform components.
 * Worker logic exercised via the exported processCallbackJob function with DI.
 * The executeTurnAndBuildEnvelope dependency is a DI stub (vi.fn) because
 * the execution bridge requires a full runtime context — the HTTP delivery
 * path is the integration boundary under test.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import {
  processCallbackJob,
  type AgentAssistCallbackJob,
  type ProcessJobContext,
  deliverCallback,
} from '../../workers/agent-assist-callback-worker.js';
import { verifyCallbackSignature } from '../../services/agent-assist/callback-signer.js';
import type { V1ExecuteResponse } from '../../services/agent-assist/types.js';

// ─── Callback sink server ───────────────────────────────────────────────

interface SinkRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function createCallbackSink(): {
  server: http.Server;
  port: number;
  requests: SinkRequest[];
  setResponse: (statusCode: number) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const requests: SinkRequest[] = [];
  let responseStatus = 200;

  const server = http.createServer((req, res) => {
    let bodyData = '';
    req.on('data', (chunk) => {
      bodyData += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: bodyData,
      });

      res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  let port = 0;

  return {
    server,
    get port() {
      return port;
    },
    requests,
    setResponse(statusCode: number) {
      responseStatus = statusCode;
    },
    start() {
      return new Promise<void>((resolve) => {
        // Bind without forcing IPv4 so localhost callers can connect via ::1 or 127.0.0.1.
        server.listen(0, () => {
          const addr = server.address();
          if (addr && typeof addr !== 'string') {
            port = addr.port;
          }
          resolve();
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ─── Test fixtures ──────────────────────────────────────────────────────

const TEST_SECRET = 'integration-test-hmac-secret';

function makeJob(callbackUrl: string): AgentAssistCallbackJob {
  return {
    messageId: 'msg-int-1',
    runId: 'run-int-1',
    tenantId: 'tenant-int',
    projectId: 'project-int',
    appId: 'aa-int-test',
    envName: 'dev',
    bindingId: 'binding-int',
    callbackUrl,
    binding: {
      deploymentId: null,
      apiKeyId: 'api-key-int',
      runtimeBaseUrl: null,
    },
    input: {
      executionInput: {
        userMessage: 'Integration test message',
        sessionReference: 'ref-int',
      },
      source: 'agent-assist-v1',
      metadata: { locale: 'en-US' },
      userReference: 'user-int',
      callerUserId: 'caller-user-int',
      callerApiKeyId: 'api-key-int',
    },
  };
}

function makeEnvelope(): V1ExecuteResponse {
  return {
    messageId: 'msg_int_1',
    output: [{ type: 'text', content: 'Integration response' }],
    sessionInfo: {
      sessionId: 'session-int-1',
      runId: 'run-int-1',
      status: 'completed',
      appId: 'aa-int-test',
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('agent-assist-callback-worker integration', () => {
  const sink = createCallbackSink();
  let dlqEntries: unknown[];

  beforeAll(async () => {
    await sink.start();
    process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET = TEST_SECRET;
  });

  afterAll(async () => {
    delete process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET;
    await sink.stop();
  });

  beforeEach(() => {
    sink.requests.length = 0;
    sink.setResponse(200);
    dlqEntries = [];
  });

  function makeCtx(): ProcessJobContext {
    return {
      deps: {
        executeTurnAndBuildEnvelope: vi.fn().mockResolvedValue(makeEnvelope()),
        deliverPayload: deliverCallback,
      },
      dlqQueue: {
        add: vi.fn(async (_name: string, data: unknown) => {
          dlqEntries.push(data);
        }),
      },
      urlValidationOptions: { allowHttpLocalhost: true },
    };
  }

  it('delivers to real HTTP server with valid HMAC signature', async () => {
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await processCallbackJob(job, 0, 5, ctx);

    expect(sink.requests).toHaveLength(1);
    const req = sink.requests[0];
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['user-agent']).toBe('ABL-Agent-Assist-Compat/1');
    expect(req.headers['x-abl-run-id']).toBe('run-int-1');
    expect(req.headers['x-abl-event']).toBe('agentic.callback.complete');

    const sigHeader = req.headers['x-abl-signature'];
    expect(sigHeader).toBeDefined();
    expect(typeof sigHeader).toBe('string');

    const verification = verifyCallbackSignature(req.body, sigHeader as string, TEST_SECRET);
    expect(verification.valid).toBe(true);

    expect(dlqEntries).toHaveLength(0);
  });

  it('bit-flipped body fails HMAC verification', async () => {
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await processCallbackJob(job, 0, 5, ctx);

    const req = sink.requests[0];
    const sigHeader = req.headers['x-abl-signature'] as string;

    const flippedBody = req.body.slice(0, -2) + 'X}';
    const verification = verifyCallbackSignature(flippedBody, sigHeader, TEST_SECRET);
    expect(verification.valid).toBe(false);
  });

  it('500 from sink triggers retryable error', async () => {
    sink.setResponse(500);
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await expect(processCallbackJob(job, 0, 5, ctx)).rejects.toThrow('retryable');

    expect(sink.requests).toHaveLength(1);
    expect(dlqEntries).toHaveLength(0);
  });

  it('400 from sink is terminal and goes to DLQ', async () => {
    sink.setResponse(400);
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await processCallbackJob(job, 0, 5, ctx);

    expect(sink.requests).toHaveLength(1);
    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string; statusCode: number } };
    expect(entry.lastError.code).toBe('TERMINAL_HTTP_ERROR');
    expect(entry.lastError.statusCode).toBe(400);
  });

  it('exhausted retries with 500 goes to DLQ', async () => {
    sink.setResponse(500);
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await processCallbackJob(job, 4, 5, ctx);

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string }; attempts: number };
    expect(entry.lastError.code).toBe('RETRIES_EXHAUSTED');
    expect(entry.attempts).toBe(5);
  });

  it('response body is valid JSON matching the V1 envelope', async () => {
    const callbackUrl = `http://localhost:${sink.port}/callback`;
    const job = makeJob(callbackUrl);
    const ctx = makeCtx();

    await processCallbackJob(job, 0, 5, ctx);

    const req = sink.requests[0];
    const parsed = JSON.parse(req.body) as V1ExecuteResponse;
    expect(parsed.messageId).toBe('msg_int_1');
    expect(parsed.output[0].content).toBe('Integration response');
    expect(parsed.sessionInfo.status).toBe('completed');
  });
});
