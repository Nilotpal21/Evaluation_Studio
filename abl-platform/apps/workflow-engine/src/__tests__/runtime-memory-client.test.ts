/**
 * UT-3 — `RuntimeMemoryClient` request shape & error mapping.
 *
 * Pure tests of how the client builds HTTP requests + maps response codes to
 * `WorkflowMemoryError`. Uses an injected `fetch` impl so there's no network
 * traffic. The integration test (`runtime-memory-client.integration.test.ts`)
 * boots the real route and exercises the full HTTP path.
 *
 * Per CLAUDE.md "Test Architecture" — the test mocks NO platform components.
 * `fetch` is an external (third-party) interface and is dependency-injected via
 * the constructor.
 */

import { describe, expect, it, vi } from 'vitest';
import { RuntimeMemoryClient, WorkflowMemoryError } from '../clients/runtime-memory-client.js';

const baseOpts = {
  baseUrl: 'http://runtime.test',
  serviceTokenSecret: 'test-secret-with-32-chars-min-min',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('UT-3 — RuntimeMemoryClient request translation', () => {
  it('loadProjection sends POST /api/internal/memory/projection with required fields', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        success: true,
        data: { workflow: { foo: 1 }, project: {}, user: undefined },
      }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    const result = await client.loadProjection({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
    });
    expect(result.workflow).toEqual({ foo: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://runtime.test/api/internal/memory/projection');
    expect(init.method).toBe('POST');
    const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({ tenantId: 't1', projectId: 'p1', workflowId: 'wf-1' });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Bearer ey/);
  });

  it('loadProjection forwards endUserId when provided', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { success: true, data: { workflow: {}, project: {}, user: { x: 1 } } }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await client.loadProjection({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      endUserId: 'user-9',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.endUserId).toBe('user-9');
  });

  it('get sends POST /api/internal/memory/get with scope+key+runId', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { success: true, data: { value: { hello: 'world' } } }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    const value = await client.get({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'run-9',
      actor: { kind: 'workflow-author' },
      scope: 'workflow',
      key: 'lastCursor',
    });
    expect(value).toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://runtime.test/api/internal/memory/get');
    const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'run-9',
      scope: 'workflow',
      key: 'lastCursor',
    });
  });

  it('set sends POST /api/internal/memory/set with value+ttl+actor', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, data: {} }));
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await client.set({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'run-9',
      actor: { kind: 'end-user', endUserId: 'u-3' },
      scope: 'user',
      key: 'preferences',
      value: { theme: 'dark' },
      ttl: '30d',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      runId: 'run-9',
      scope: 'user',
      key: 'preferences',
      value: { theme: 'dark' },
      ttl: '30d',
      actor: { kind: 'end-user', endUserId: 'u-3' },
    });
  });

  it('delete omits value/ttl from request body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, data: {} }));
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await client.delete({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'run-9',
      actor: { kind: 'workflow-author' },
      scope: 'project',
      key: 'banner',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.value).toBeUndefined();
    expect(body.ttl).toBeUndefined();
    expect(body.scope).toBe('project');
    expect(body.key).toBe('banner');
  });
});

describe('UT-5 — RuntimeMemoryClient error code mapping', () => {
  it('maps 400 RESERVED_PREFIX to WorkflowMemoryError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        success: false,
        error: { code: 'RESERVED_PREFIX', message: 'wf: prefix is reserved' },
      }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.set({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'wf:nope',
        value: 1,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowMemoryError',
      code: 'RESERVED_PREFIX',
    });
  });

  it('maps 400 QUOTA_VALUE_SIZE to WorkflowMemoryError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        success: false,
        error: { code: 'QUOTA_VALUE_SIZE', message: 'too big' },
      }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.set({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'big',
        value: 'x',
      }),
    ).rejects.toBeInstanceOf(WorkflowMemoryError);
  });

  it('maps 503 STORAGE_UNAVAILABLE to WorkflowMemoryError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(503, {
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'redis down' },
      }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.get({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'foo',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('maps unknown 500 to WorkflowMemoryError(INTERNAL)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { success: false, error: { code: 'WAT', message: 'no idea' } }),
    );
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.get({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'foo',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('treats network failure as STORAGE_UNAVAILABLE', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    });
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.get({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'foo',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('treats AbortSignal timeout as STORAGE_UNAVAILABLE', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi.fn(async () => {
      throw abortErr;
    });
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await expect(
      client.get({
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        runId: 'run-9',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'foo',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});

describe('UT-3 — Service token signing', () => {
  it('signs a fresh service token per request with the per-call tenantId', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, data: { value: 1 } }));
    const client = new RuntimeMemoryClient({ ...baseOpts, fetchImpl: fetchMock });
    await client.get({
      tenantId: 'tenantA',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'r1',
      actor: { kind: 'workflow-author' },
      scope: 'workflow',
      key: 'k',
    });
    await client.get({
      tenantId: 'tenantB',
      projectId: 'p1',
      workflowId: 'wf-1',
      runId: 'r1',
      actor: { kind: 'workflow-author' },
      scope: 'workflow',
      key: 'k',
    });
    const headersA = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const headersB = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    // Tokens differ because tenantId is in the payload (different signature).
    expect(headersA.Authorization).not.toBe(headersB.Authorization);
    // Both must be Bearer JWTs.
    expect(headersA.Authorization).toMatch(/^Bearer eyJ/);
    expect(headersB.Authorization).toMatch(/^Bearer eyJ/);
  });
});
