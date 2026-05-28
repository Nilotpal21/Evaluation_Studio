/**
 * RestateWorkflowClient — unit tests for the Restate ingress/admin HTTP wrapper.
 *
 * Strategy:
 *   - Stub `globalThis.fetch` only (a runtime global, not a codebase module).
 *   - No mocking of internal packages or relative imports.
 *   - Every test asserts the URL, method, and body the client actually sends,
 *     so a typo in the URL template or handler name is caught.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestateWorkflowClient } from '../services/restate-client.js';

const INGRESS = 'http://restate-ingress:9999';
const ADMIN = 'http://restate-admin:9998';

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    clone() {
      return okResponse();
    },
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  const make = (): Response =>
    ({
      ok: false,
      status,
      clone: () => make(),
      text: vi.fn().mockResolvedValue(body),
    }) as unknown as Response;
  return make();
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('RestateWorkflowClient.startLegacyWorkflow', () => {
  it('posts input to ingress /workflow-runner/{executionId}/run/send', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.startLegacyWorkflow('exec-1', { workflowId: 'wf-1' });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${INGRESS}/workflow-runner/${encodeURIComponent('exec-1')}/run/send`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ workflowId: 'wf-1' });
  });

  it('throws on non-2xx response with status and body in the error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errorResponse(500, 'internal boom'),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(client.startLegacyWorkflow('exec-2', {})).rejects.toThrow(/500.*internal boom/);
  });

  it('re-registers and retries once on 404 "service not found"', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        errorResponse(404, JSON.stringify({ message: "service 'workflow-runner' not found" })),
      )
      .mockResolvedValueOnce(okResponse());

    const registerFn = vi.fn().mockResolvedValue(true);
    const client = new RestateWorkflowClient({
      ingressUrl: INGRESS,
      adminUrl: ADMIN,
      registerFn,
    });

    await client.startLegacyWorkflow('exec-3', { workflowId: 'wf-3' });

    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when registerFn is absent, surfaces the 404 instead', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      errorResponse(404, JSON.stringify({ message: "service 'workflow-runner' not found" })),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(client.startLegacyWorkflow('exec-4', {})).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404 when the body is not "service not found"', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(errorResponse(404, 'not found'));

    const registerFn = vi.fn().mockResolvedValue(true);
    const client = new RestateWorkflowClient({
      ingressUrl: INGRESS,
      adminUrl: ADMIN,
      registerFn,
    });

    await expect(client.startLegacyWorkflow('exec-5', {})).rejects.toThrow(/404/);
    expect(registerFn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the original 404 when registerFn returns false', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      errorResponse(404, JSON.stringify({ message: "service 'workflow-runner' not found" })),
    );
    const registerFn = vi.fn().mockResolvedValue(false);
    const client = new RestateWorkflowClient({
      ingressUrl: INGRESS,
      adminUrl: ADMIN,
      registerFn,
    });

    await expect(client.startLegacyWorkflow('exec-6', {})).rejects.toThrow(/404/);
    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('RestateWorkflowClient.startWorkflow (relay-race)', () => {
  it('posts WorkflowRunInput to workflow-executor/{executionId}/runWorkflow/send', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });
    const input = { tenantId: 't1', projectId: 'p1', startFromStepIds: ['step-a'] };

    await client.startWorkflow('exec-rr-1', input);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      `${INGRESS}/workflow-executor/${encodeURIComponent('exec-rr-1')}/runWorkflow/send`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('supports delayed dispatch via delayMs query param', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.startWorkflow(
      'exec-rr-delay',
      { tenantId: 't1', projectId: 'p1', startFromStepIds: [] },
      { delayMs: 5000 },
    );

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('delay=5000ms');
  });

  it('throws on non-2xx with status and body', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errorResponse(500, 'executor down'),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(
      client.startWorkflow('exec-rr-2', {
        tenantId: 't1',
        projectId: 'p1',
        startFromStepIds: [],
      }),
    ).rejects.toThrow(/500.*executor down/);
  });
});

describe('RestateWorkflowClient.cancelLegacyWorkflow', () => {
  it('POSTs to ingress cancel/send handler for cooperative cancellation', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.cancelLegacyWorkflow('exec-7');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${INGRESS}/workflow-runner/exec-7/cancel/send`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('treats a 404 as success (workflow already finished or unknown)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errorResponse(404, 'invocation not found'),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(client.cancelLegacyWorkflow('exec-8')).resolves.toBeUndefined();
  });

  it('throws on non-404 error responses', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errorResponse(500, 'restate unhappy'),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(client.cancelLegacyWorkflow('exec-9')).rejects.toThrow(/500.*restate unhappy/);
  });
});

describe('RestateWorkflowClient.cancelWorkflow (relay-race)', () => {
  it('POSTs to workflow-executor/{executionId}/cancelWorkflow/send', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.cancelWorkflow('exec-rr-cancel', 't1', 'p1');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${INGRESS}/workflow-executor/exec-rr-cancel/cancelWorkflow/send`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tenantId: 't1', projectId: 'p1' });
  });

  it('throws on non-2xx error responses', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      errorResponse(500, 'executor unhappy'),
    );
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await expect(client.cancelWorkflow('exec-rr-fail', 't1', 'p1')).rejects.toThrow(
      /500.*executor unhappy/,
    );
  });
});

describe('RestateWorkflowClient.resolveCallback', () => {
  it('posts to /workflow-runner/{executionId}/resolveCallback with stepId and payload', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.resolveCallback('exec-10', 'step-a', { orderId: 'ORD-77' });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${INGRESS}/workflow-runner/${encodeURIComponent('exec-10')}/resolveCallback`);
    expect(JSON.parse(init.body)).toEqual({
      executionId: 'exec-10',
      stepId: 'step-a',
      payload: { orderId: 'ORD-77' },
    });
  });
});

describe('RestateWorkflowClient.resolveApproval', () => {
  it('posts decision to /workflow-runner/{executionId}/resolveApproval', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.resolveApproval('exec-11', 'approve-step', {
      approved: true,
      decidedBy: 'alice',
      reason: 'LGTM',
    });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${INGRESS}/workflow-runner/${encodeURIComponent('exec-11')}/resolveApproval`);
    expect(JSON.parse(init.body)).toEqual({
      executionId: 'exec-11',
      stepId: 'approve-step',
      decision: { approved: true, decidedBy: 'alice', reason: 'LGTM' },
    });
  });
});

describe('RestateWorkflowClient.resolveHumanTask', () => {
  it('posts to /workflow-runner/{executionId}/resolveHumanTask with nested response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.resolveHumanTask('exec-12', 'ht-step', {
      respondedBy: 'bob',
      respondedAt: '2026-04-19T12:00:00.000Z',
      fields: { note: 'ok' },
      decision: 'approved',
    });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      `${INGRESS}/workflow-runner/${encodeURIComponent('exec-12')}/resolveHumanTask`,
    );
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      executionId: 'exec-12',
      stepId: 'ht-step',
      response: {
        respondedBy: 'bob',
        respondedAt: '2026-04-19T12:00:00.000Z',
        fields: { note: 'ok' },
        decision: 'approved',
      },
    });
  });

  it('defaults respondedAt to the current ISO timestamp when caller omits it', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    const before = Date.now();
    await client.resolveHumanTask('exec-13', 'ht-step', {
      respondedBy: 'carol',
      fields: {},
    });
    const after = Date.now();

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    const respondedAtMs = Date.parse(body.response.respondedAt);
    expect(respondedAtMs).toBeGreaterThanOrEqual(before);
    expect(respondedAtMs).toBeLessThanOrEqual(after);
  });
});

// Covers finding ABLP-2 #4 (high / security): any pod able to reach the
// Restate ingress could previously start / cancel / resolve workflows for
// any tenant because outbound calls carried no Authorization header. The
// client now adds `Authorization: Bearer <token>` on every call when
// `authToken` (or `RESTATE_INGRESS_AUTH_TOKEN`) is configured, so the
// Restate deployment can reject callers that are not workflow-engine.
describe('RestateWorkflowClient — outbound bearer auth (finding #4)', () => {
  it('attaches Authorization: Bearer on ingress POSTs when authToken is set', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({
      ingressUrl: INGRESS,
      adminUrl: ADMIN,
      authToken: 'restate-dev-token',
    });

    await client.startLegacyWorkflow('exec-auth', { workflowId: 'wf-auth' });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer restate-dev-token');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('attaches Authorization: Bearer on admin DELETE /invocations when authToken is set', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({
      ingressUrl: INGRESS,
      adminUrl: ADMIN,
      authToken: 'restate-dev-token',
    });

    await client.cancelLegacyWorkflow('exec-auth-cancel');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer restate-dev-token');
  });

  it('omits Authorization header when authToken is not configured (legacy dev behavior)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse());
    const client = new RestateWorkflowClient({ ingressUrl: INGRESS, adminUrl: ADMIN });

    await client.startLegacyWorkflow('exec-no-auth', {});

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
