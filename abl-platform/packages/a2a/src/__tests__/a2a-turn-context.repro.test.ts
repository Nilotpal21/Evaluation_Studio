/**
 * ABLP-974 Reproduction Tests — A2A Turn Context (Issues 2, 3, 6)
 *
 * FAILS: reproduces ABLP-974 issues 2, 3, 6
 *
 * Issue 2: taskId from remote response is not carried to the next turn.
 *   routing-executor.ts:1964 always generates a fresh taskId; never reads
 *   the remote-assigned Task.id from the response.
 *
 * Issue 3: Discovery trace taskId leaks endpoint URL.
 *   discover-agent.ts:53 sets DISCOVERY_TASK_ID = `discovery:${endpoint}`
 *
 * Issue 6: contextId missing from A2A trace events.
 *   ports.ts A2ATracingPort.traceOutbound has no contextId parameter;
 *   routing-executor never passes session.id into trace emissions.
 *
 * Test strategy:
 * - Uses an in-process Express server on port 0 (real HTTP, no mocks of
 *   platform packages).
 * - Implements a minimal A2A JSON-RPC responder that returns tasks with
 *   known IDs and states.
 */

// FAILS: reproduces ABLP-974

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { sendTask } from '../application/send-task.js';
import { discoverAgent } from '../application/discover-agent.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import type { A2AClient } from '@a2a-js/sdk/client';
import { createA2AClient } from '../infrastructure/client-factory.js';

// =============================================================================
// FAKE A2A REMOTE SERVER
// =============================================================================

const REMOTE_TASK_ID = 'remote-generated-task-abc123';
const REMOTE_CONTEXT_ID = 'remote-ctx-xyz';

function createFakeA2AServer(): express.Express {
  const app = express();
  app.use(express.json());

  // Agent card endpoint. The SDK default is /.well-known/agent-card.json.
  app.get('/.well-known/agent-card.json', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      name: 'Fake Remote Agent',
      description: 'Test agent for turn context tests',
      url: origin,
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    });
  });

  // JSON-RPC message/send endpoint — returns input-required on first call
  let callCount = 0;
  app.post('/', (req, res) => {
    callCount++;
    const body = req.body;

    if (body.method === 'message/send') {
      const incomingTaskId = body.params?.message?.taskId;
      const isFollowUp = incomingTaskId === REMOTE_TASK_ID;

      if (isFollowUp) {
        // Second turn — complete the task
        res.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            id: REMOTE_TASK_ID,
            contextId: REMOTE_CONTEXT_ID,
            kind: 'task',
            status: { state: 'completed' },
            artifacts: [
              {
                artifactId: 'art-1',
                parts: [{ kind: 'text', text: 'Task completed on follow-up' }],
              },
            ],
          },
        });
      } else {
        // First turn — respond with input-required + server-generated taskId
        res.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            id: REMOTE_TASK_ID,
            contextId: REMOTE_CONTEXT_ID,
            kind: 'task',
            status: { state: 'input-required' },
            artifacts: [
              {
                artifactId: 'art-1',
                parts: [{ kind: 'text', text: 'Please provide more details' }],
              },
            ],
          },
        });
      }
    } else {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  });

  return app;
}

// =============================================================================
// TEST SETUP
// =============================================================================

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createFakeA2AServer();
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

// Simple tracing spy
function createTracingSpy(): A2ATracingPort & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    traceOutbound(params) {
      calls.push({ type: 'outbound', ...params });
    },
    traceInbound(params) {
      calls.push({ type: 'inbound', ...params });
    },
  };
}

// Permissive endpoint validator (allows localhost for tests)
const validator: EndpointValidator = {
  validate() {
    /* no-op for test */
  },
};

// =============================================================================
// ISSUE 2: taskId not carried forward across turns
// =============================================================================

describe('ABLP-974 Issue 2 — taskId carryover across turns', () => {
  it('taskId from response Turn 1 should be echoed in Turn 2 request', async () => {
    const tracing = createTracingSpy();

    // Turn 1: send without taskId — remote responds with REMOTE_TASK_ID
    const turn1Result = await sendTask(
      {
        endpoint: baseUrl,
        tenantId: 'tenant-1',
        taskId: 'local-task-1', // Our local tracking ID
        message: {
          message: {
            kind: 'message' as const,
            messageId: 'msg-1',
            role: 'user' as const,
            contextId: 'ctx-1',
            parts: [{ kind: 'text' as const, text: 'Hello' }],
          },
        },
      },
      { tracing, validator, createClient: createA2AClient },
    );

    // Verify Turn 1 returned a task with the remote-generated ID
    expect(turn1Result).toHaveProperty('kind', 'task');
    expect((turn1Result as any).id).toBe(REMOTE_TASK_ID);
    expect((turn1Result as any).status.state).toBe('input-required');

    // BUG ASSERTION: The platform should store REMOTE_TASK_ID and include it
    // in the next turn's message. Currently sendTask has no mechanism for this —
    // the caller (routing-executor) generates a fresh taskId every time (line 1964).
    //
    // This test documents the expected behavior: Turn 2 message should carry
    // the remote taskId so the remote agent can correlate turns.
    //
    // Since sendTask itself is stateless, the FIX belongs in routing-executor
    // (store task.id on AgentThread, pass as sdkMessage.message.taskId on next turn).
    // We test here that the infrastructure supports passing taskId through:
    const turn2Result = await sendTask(
      {
        endpoint: baseUrl,
        tenantId: 'tenant-1',
        taskId: 'local-task-2',
        message: {
          message: {
            kind: 'message' as const,
            messageId: 'msg-2',
            role: 'user' as const,
            contextId: 'ctx-1',
            // BUG: There is no `taskId` field on the message type in
            // the current MessageSendParams interface. The A2A spec requires
            // message.taskId to carry the remote-assigned task identifier.
            // This assertion will fail until the message type supports it.
            taskId: REMOTE_TASK_ID, // <-- This field needs to be wired
            parts: [{ kind: 'text' as const, text: 'More details here' }],
          } as any, // 'as any' because taskId is not on the current type
        },
      },
      { tracing, validator, createClient: createA2AClient },
    );

    // If taskId was properly echoed, remote responds with 'completed'
    expect(turn2Result).toHaveProperty('kind', 'task');
    expect((turn2Result as any).status.state).toBe('completed');
  });
});

// =============================================================================
// ISSUE 6: contextId missing from trace events
// =============================================================================

describe('ABLP-974 Issue 6 — contextId in A2A traces', () => {
  it('traceOutbound should include contextId from the message', async () => {
    const tracing = createTracingSpy();
    const EXPECTED_CONTEXT_ID = 'session-ctx-for-trace';

    await sendTask(
      {
        endpoint: baseUrl,
        tenantId: 'tenant-1',
        taskId: 'trace-task-1',
        message: {
          message: {
            kind: 'message' as const,
            messageId: 'msg-trace-1',
            role: 'user' as const,
            contextId: EXPECTED_CONTEXT_ID,
            parts: [{ kind: 'text' as const, text: 'Test trace' }],
          },
        },
      },
      { tracing, validator, createClient: createA2AClient },
    );

    // FAILS: A2ATracingPort.traceOutbound does not have a contextId parameter
    // (see packages/a2a/src/domain/ports.ts:11-20).
    // The traced-client.ts TracedCallInterceptor never passes contextId through.
    //
    // Once fixed, traceOutbound should receive contextId from the message
    // so that all turns of a multi-turn conversation can be correlated in traces.
    const outboundCall = tracing.calls.find((c) => c.type === 'outbound');
    expect(outboundCall).toBeDefined();
    expect(outboundCall).toHaveProperty('contextId', EXPECTED_CONTEXT_ID);
  });
});

// =============================================================================
// ISSUE 3: Discovery taskId leaks endpoint URL
// =============================================================================

describe('ABLP-974 Issue 3 — discovery taskId should not contain endpoint URL', () => {
  it('discovery trace should use an opaque taskId, not the endpoint URL', async () => {
    const tracing = createTracingSpy();

    try {
      await discoverAgent(
        { endpoint: baseUrl, tenantId: 'tenant-1', allowPrivate: true },
        { tracing, validator, createClient: createA2AClient as (url: string) => A2AClient },
      );
    } catch {
      // Discovery may fail if agent card format doesn't match SDK expectations;
      // the trace is still emitted on error path (discover-agent.ts:61-62)
    }

    // Find the discovery trace call
    const discoveryCall = tracing.calls.find((c) => c.type === 'outbound');
    expect(discoveryCall).toBeDefined();

    // BUG: taskId is `discovery:http://127.0.0.1:PORT` — leaks the full URL.
    // discover-agent.ts:53: const DISCOVERY_TASK_ID = `discovery:${params.endpoint}`
    //
    // The taskId should NOT contain the endpoint URL.
    const taskId = discoveryCall!.taskId as string;
    expect(taskId).not.toContain('http');
    expect(taskId).not.toContain('127.0.0.1');
    expect(taskId).not.toContain(baseUrl);
  });
});
