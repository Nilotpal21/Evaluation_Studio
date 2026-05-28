/**
 * WfBridge Tests
 *
 * Tests the runtime WebSocket bridge that relays workflow execution events
 * from Redis pub/sub to browser clients. All deps are injected via WfBridgeDeps
 * — no module-level mocks needed.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { WfBridge } from '../websocket/wf-bridge.js';
import type { WfBridgeDeps, WfAuthContext } from '../websocket/wf-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_OPEN = 1;

function makeWs(readyState = WS_OPEN): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState,
    OPEN: WS_OPEN, // wf-bridge checks ws.readyState !== ws.OPEN (instance property)
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    close: vi.fn(),
  } as unknown as WebSocket;
  return { ws, sent };
}

function makeDeps(overrides?: Partial<WfBridgeDeps>): WfBridgeDeps {
  return {
    getRedisClient: vi.fn(() => null),
    executionModel: {
      findOne: vi.fn(async () => null),
    },
    checkProjectAccess: vi.fn(async () => true),
    ...overrides,
  };
}

function makeExecDoc(partial?: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: 'exec-1',
    status: 'running',
    context: { steps: {} },
    startedAt: new Date().toISOString(),
    workflowId: 'wf-1',
    workflowVersionId: 'wfv-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    triggerType: 'manual',
    ...partial,
  };
}

const AUTH: WfAuthContext = { tenantId: 'tenant-1', userId: 'user-1' };

const SUBSCRIBE_MSG = JSON.stringify({
  type: 'subscribe_execution',
  executionId: 'exec-1',
  projectId: 'proj-1',
  workflowId: 'wf-1',
});

function parseSent(sent: string[], index = 0): Record<string, unknown> {
  return JSON.parse(sent[index]) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// handleMessage — schema gating
// ---------------------------------------------------------------------------

describe('WfBridge.handleMessage', () => {
  let bridge: WfBridge;
  let deps: WfBridgeDeps;

  beforeEach(() => {
    deps = makeDeps();
    bridge = new WfBridge(deps);
  });

  test('sends error on invalid JSON', () => {
    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, 'not-json{');
    expect(parseSent(sent).code).toBe('invalid_json');
  });

  test('sends error on unknown message type', () => {
    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, JSON.stringify({ type: 'bogus', executionId: 'x' }));
    expect(parseSent(sent).code).toBe('unknown_message_type');
  });

  test('sends error when subscribe_execution is missing required fields', () => {
    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, JSON.stringify({ type: 'subscribe_execution' }));
    expect(parseSent(sent).code).toBe('unknown_message_type');
  });

  test('sends error when subscribe_execution has empty executionId', () => {
    const { ws, sent } = makeWs();
    bridge.handleMessage(
      ws,
      AUTH,
      JSON.stringify({
        type: 'subscribe_execution',
        executionId: '',
        projectId: 'p',
        workflowId: 'w',
      }),
    );
    expect(parseSent(sent).code).toBe('unknown_message_type');
  });

  test('routes unsubscribe_execution without error', () => {
    const { ws, sent } = makeWs();
    bridge.handleMessage(
      ws,
      AUTH,
      JSON.stringify({ type: 'unsubscribe_execution', executionId: 'exec-1' }),
    );
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleSubscribeExecution
// ---------------------------------------------------------------------------

describe('WfBridge.handleSubscribeExecution', () => {
  let bridge: WfBridge;
  let deps: WfBridgeDeps;

  beforeEach(() => {
    deps = makeDeps();
    bridge = new WfBridge(deps);
  });

  test('sends snapshot when execution is found', async () => {
    const execDoc = makeExecDoc();
    vi.mocked(deps.executionModel.findOne).mockResolvedValue(execDoc);

    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = parseSent(sent);
    expect(msg.type).toBe('workflow_execution_snapshot');
    expect((msg.execution as Record<string, unknown>).id).toBe('exec-1');
  });

  test('sends execution_not_found when execution does not exist', async () => {
    vi.mocked(deps.executionModel.findOne).mockResolvedValue(null);

    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    // Bridge retries findOne up to 5 times with 400ms delay each → allow up to 3s
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 3500 });

    expect(parseSent(sent).type).toBe('execution_not_found');
  });

  test('sends forbidden error when access is denied', async () => {
    vi.mocked(deps.checkProjectAccess).mockResolvedValue(false);

    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = parseSent(sent);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('forbidden');
  });

  test('sends access_check_failed when checkProjectAccess throws', async () => {
    vi.mocked(deps.checkProjectAccess).mockRejectedValue(new Error('db timeout'));

    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = parseSent(sent);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('access_check_failed');
  });

  test('bypasses project access check for tenant-level role with project:* permission', async () => {
    const execDoc = makeExecDoc();
    vi.mocked(deps.executionModel.findOne).mockResolvedValue(execDoc);

    const { ws, sent } = makeWs();
    const adminAuth: WfAuthContext = { tenantId: 'tenant-1', userId: 'admin', role: 'ADMIN' };
    bridge.handleMessage(ws, adminAuth, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    expect(deps.checkProjectAccess).not.toHaveBeenCalled();
    expect(parseSent(sent).type).toBe('workflow_execution_snapshot');
  });

  test('does not send on closed WebSocket', async () => {
    const execDoc = makeExecDoc();
    vi.mocked(deps.executionModel.findOne).mockResolvedValue(execDoc);

    const { ws, sent } = makeWs(/* readyState= */ 3 /* CLOSED */);
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(0);
  });

  test('sanitizes encryptedAccessToken from triggerMetadata in snapshot', async () => {
    const execDoc = makeExecDoc({
      triggerMetadata: { encryptedAccessToken: 'secret', source: 'webhook' },
    });
    vi.mocked(deps.executionModel.findOne).mockResolvedValue(execDoc);

    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const exec = parseSent(sent).execution as Record<string, unknown>;
    const meta = exec.triggerMetadata as Record<string, unknown>;
    expect(meta.encryptedAccessToken).toBeUndefined();
    expect(meta.source).toBe('webhook');
  });
});

// ---------------------------------------------------------------------------
// onRedisMessage — event routing
// ---------------------------------------------------------------------------

describe('WfBridge.onRedisMessage', () => {
  let bridge: WfBridge;
  let deps: WfBridgeDeps;

  beforeEach(() => {
    deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
    });
    bridge = new WfBridge(deps);
  });

  async function subscribeAndGetWs() {
    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    sent.length = 0; // clear snapshot
    return { ws, sent };
  }

  test('forwards step.started as workflow_step_status with status running', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.started',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );

    const msg = parseSent(sent);
    expect(msg.type).toBe('workflow_step_status');
    expect(msg.status).toBe('running');
    expect(msg.stepId).toBe('step-a');
  });

  test('forwards step.completed as workflow_step_status with status completed', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.completed',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );

    expect(parseSent(sent).status).toBe('completed');
  });

  test('forwards step.waiting_approval with correct status', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.waiting_approval',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );

    expect(parseSent(sent).status).toBe('waiting_approval');
  });

  test('forwards step delta with contextPatch field', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.completed',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
        contextPatch: { foo: 'bar' },
      }),
    );

    expect((parseSent(sent).contextPatch as Record<string, unknown>).foo).toBe('bar');
  });

  test('forwards step delta with path state fields', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.completed',
        stepId: 'loop-1',
        timestamp: new Date().toISOString(),
        pathState: { 'edge-start-loop': 'completed' },
        iterationPathState: {
          'loop-1': {
            '0': { 'edge-loop-body': 'completed' },
          },
        },
      }),
    );

    const msg = parseSent(sent);
    expect(msg.pathState).toEqual({ 'edge-start-loop': 'completed' });
    expect(msg.iterationPathState).toEqual({
      'loop-1': {
        '0': { 'edge-loop-body': 'completed' },
      },
    });
  });

  test('forwards workflow.completed as workflow_execution_status', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'workflow.completed',
        timestamp: new Date().toISOString(),
        pathState: { 'edge-loop-next': 'completed' },
        iterationPathState: {
          'loop-1': {
            '0': { 'edge-loop-body': 'completed' },
          },
        },
      }),
    );

    const msg = parseSent(sent);
    expect(msg.type).toBe('workflow_execution_status');
    expect(msg.status).toBe('completed');
    expect(msg.pathState).toEqual({ 'edge-loop-next': 'completed' });
    expect(msg.iterationPathState).toEqual({
      'loop-1': {
        '0': { 'edge-loop-body': 'completed' },
      },
    });
  });

  test('workflow.failed marks entry terminal for sweep', async () => {
    await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'workflow.failed',
        timestamp: new Date().toISOString(),
      }),
    );

    // After grace period the entry should be swept
    const { evicted } = (
      bridge as unknown as { registry: { sweep(n: number): { evicted: string[] } } }
    ).registry.sweep(Date.now() + 60_000);
    expect(evicted).toContain('exec-1');
  });

  test('drops message for unknown executionId', async () => {
    const { ws, sent } = makeWs();
    // Never subscribe — registry has no entry for exec-1
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.started',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );

    expect(ws.send).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  test('drops message with malformed channel format', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'bad-channel-format',
      JSON.stringify({
        type: 'step.started',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );

    expect(sent).toHaveLength(0);
  });

  test('drops message with unrecognised event type', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'unknown.event',
        timestamp: new Date().toISOString(),
      }),
    );

    expect(sent).toHaveLength(0);
  });

  test('drops message with invalid JSON', async () => {
    const { sent } = await subscribeAndGetWs();
    bridge.onRedisMessage('workflow:tenant-1:execution:exec-1:status', 'not-json');

    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleClose / handleUnsubscribeExecution
// ---------------------------------------------------------------------------

describe('WfBridge.handleClose', () => {
  test('removes the WebSocket from the registry on close', async () => {
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    bridge.handleClose(ws, AUTH.tenantId);

    // No entry left — subsequent Redis message produces no send
    sent.length = 0;
    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.started',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );
    expect(sent).toHaveLength(0);
  });
});

describe('WfBridge.handleUnsubscribeExecution', () => {
  test('unregisters the execution so subsequent events are not forwarded', async () => {
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    sent.length = 0;

    bridge.handleMessage(
      ws,
      AUTH,
      JSON.stringify({ type: 'unsubscribe_execution', executionId: 'exec-1' }),
    );

    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.started',
        stepId: 'step-a',
        timestamp: new Date().toISOString(),
      }),
    );
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// close — lifecycle
// ---------------------------------------------------------------------------

describe('WfBridge.close', () => {
  test('is idempotent — calling twice does not throw', () => {
    const bridge = new WfBridge(makeDeps());
    bridge.start();
    expect(() => {
      bridge.close();
      bridge.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Boundary tests — data-flow audit F-3 & F-4
// (docs/sdlc-logs/ws-relocation/data-flow-audit.md)
// ---------------------------------------------------------------------------

describe('Boundary: connector output policy (F-3)', () => {
  // Connector action outputs are intentionally forwarded to Studio WS clients
  // in full — Studio is project-scoped and authenticated, so full connector API
  // responses (Slack, GitHub, Jira, HubSpot, etc.) are visible to the workflow
  // designer for debugging. This test pins that accepted policy so any future
  // accidental stripping becomes a failing test.
  test('connector step output flows through step.completed event to WS unchanged', async () => {
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    sent.length = 0; // clear snapshot

    const connectorOutput = {
      id: 'msg-abc',
      channel: 'C012AB3CD',
      text: 'Hello World',
      ts: '1234567890.123456',
    };

    bridge.onRedisMessage(
      'workflow:tenant-1:execution:exec-1:status',
      JSON.stringify({
        type: 'step.completed',
        stepId: 'connector-step-1',
        stepType: 'connector_action',
        status: 'completed',
        timestamp: new Date().toISOString(),
        stepData: {
          nodeType: 'connector_action',
          status: 'completed',
          output: connectorOutput,
        },
      }),
    );

    const msg = parseSent(sent);
    expect(msg.type).toBe('workflow_step_status');
    const stepData = msg.stepData as Record<string, unknown>;
    expect(stepData).toBeDefined();
    const output = stepData.output as Record<string, unknown>;
    expect(output).toEqual(connectorOutput);
  });

  test('callbackSecret is stripped from connector step data in snapshot (credential boundary)', async () => {
    const execDoc = makeExecDoc({
      context: {
        steps: {
          'async-step': {
            nodeType: 'async_webhook',
            status: 'waiting_callback',
            callbackSecret: 'enc-secret-abc',
            output: { status: 'pending' },
          },
        },
      },
    });
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => execDoc) },
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const snapshot = parseSent(sent);
    expect(snapshot.type).toBe('workflow_execution_snapshot');
    const exec = snapshot.execution as Record<string, unknown>;
    const ctx = exec.context as Record<string, unknown>;
    const steps = ctx.steps as Record<string, Record<string, unknown>>;
    // callbackSecret must be stripped
    expect(steps['async-step'].callbackSecret).toBeUndefined();
    // non-credential output is preserved
    expect(steps['async-step'].output).toEqual({ status: 'pending' });
  });
});

describe('Boundary: access control (F-4)', () => {
  // JWT auth happens in server.ts before WfBridge is called — the WfBridge
  // receives an already-verified authCtx. The subscription-level guard
  // (checkProjectAccess) is tested here as the effective WfBridge security boundary.
  // Server-level JWT expiry / invalid-token → ws.close(4001) is covered by the
  // connection handler in server.ts (integration test gap noted in the audit).

  test('rejects subscription when project access check fails with access_check_failed', async () => {
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
      checkProjectAccess: vi.fn(async () => {
        throw new Error('simulated timeout');
      }),
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = parseSent(sent);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('access_check_failed');
  });

  test('rejects subscription when user does not have project access with forbidden', async () => {
    const deps = makeDeps({
      executionModel: { findOne: vi.fn(async () => makeExecDoc()) },
      checkProjectAccess: vi.fn(async () => false),
    });
    const bridge = new WfBridge(deps);
    const { ws, sent } = makeWs();

    bridge.handleMessage(ws, AUTH, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = parseSent(sent);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('forbidden');
  });

  test('execution lookup scopes by tenantId and projectId — cross-tenant exec is not found', async () => {
    const deps = makeDeps({
      executionModel: {
        findOne: vi.fn(async (filter: Record<string, unknown>) => {
          // Simulate the DB returning null when tenantId doesn't match
          if (filter.tenantId !== 'tenant-1') return null;
          return makeExecDoc();
        }),
      },
    });
    const bridge = new WfBridge(deps);

    const crossTenantAuth: WfAuthContext = { tenantId: 'tenant-other', userId: 'user-1' };
    const { ws, sent } = makeWs();
    bridge.handleMessage(ws, crossTenantAuth, SUBSCRIBE_MSG);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 3500 });

    expect(parseSent(sent).type).toBe('execution_not_found');
  });
});
