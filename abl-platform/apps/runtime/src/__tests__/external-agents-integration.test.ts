/**
 * External Agent Registry — Integration Tests (INT-1 through INT-5, INT-7)
 *
 * Tests the external agent CRUD API through the full Runtime server stack
 * (auth, RBAC, SSRF validation, encryption, MongoDB).
 *
 * INT-1: Create → 201, masked response (no encryptedAuthConfig, authConfigured=true)
 * INT-2: List → returns only project-scoped agents (tenant isolation)
 * INT-3: Update → PATCH changes endpoint/authType, re-encrypts authConfig
 * INT-4: Delete → 204, subsequent GET → 404
 * INT-5: Duplicate name → 409 DUPLICATE_NAME
 * INT-7: Validation — invalid name format, missing endpoint → 400
 *
 * Real: MongoDB (MongoMemoryServer), encryption, auth middleware, SSRF validation
 * External mock: MockA2ARemoteAgent (for SSRF-safe endpoint URLs)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  requestJson,
  authHeaders,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';
import {
  startMockA2ARemoteAgent,
  type MockA2ARemoteAgent,
} from './helpers/mock-a2a-remote-agent.js';
import type { ExternalAgentConfigView } from '@agent-platform/shared/repos';

// ─── Harness & Fixtures ──────────────────────────────────────────────────

let harness: RuntimeApiHarness;
let bootstrap: BootstrapProjectResult;
let mockRemote: MockA2ARemoteAgent;

beforeAll(async () => {
  mockRemote = await startMockA2ARemoteAgent({ responseText: 'integration-test-ok' });

  harness = await startRuntimeServerHarness(
    {},
    { allowPrivateEndpoints: true, bootstrapServer: true },
  );
  const { ExternalAgentConfig } = await import('@agent-platform/database/models');
  await ExternalAgentConfig.syncIndexes();
  bootstrap = await bootstrapProject(
    harness,
    'ext-agent-int@example.com',
    'ext-int-tenant',
    'ext-int-project',
  );
}, 120_000);

afterAll(async () => {
  await mockRemote?.close();
  await harness?.close();
}, 30_000);

beforeEach(() => {
  mockRemote.reset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function apiPath(suffix = '') {
  return `/api/projects/${bootstrap.projectId}/external-agents${suffix}`;
}

interface SuccessResponse<T> {
  success: true;
  data: T;
}

interface ErrorResponse {
  success: false;
  error: { code: string; message: string };
}

// ─── INT-1: Create External Agent Config ──────────────────────────────────

describe('INT-1: Create external agent config', () => {
  it('creates an agent config and returns masked response (201)', async () => {
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'analytics_agent',
          displayName: 'Analytics Agent',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'bearer',
          authConfig: { value: 'secret-token-123' },
        },
      },
    );

    expect(status).toBe(201);
    expect(body.success).toBe(true);

    const agent = body.data;
    expect(agent.name).toBe('analytics_agent');
    expect(agent.displayName).toBe('Analytics Agent');
    expect(agent.endpoint).toBe(mockRemote.endpointUrl);
    expect(agent.protocol).toBe('a2a');
    expect(agent.authType).toBe('bearer');
    expect(agent.authConfigured).toBe(true);
    expect(agent.createdBy).toBe(bootstrap.userId);

    // Verify encryptedAuthConfig is NOT exposed in the response
    expect((agent as any).encryptedAuthConfig).toBeUndefined();
  });

  it('creates an agent config without auth (authType=none, authConfigured=false)', async () => {
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'unauthenticated_agent',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );

    expect(status).toBe(201);
    expect(body.data.authConfigured).toBe(false);
    expect(body.data.authType).toBe('none');
  });
});

// ─── INT-2: List External Agent Configs (project-scoped) ──────────────────

describe('INT-2: List external agent configs (tenant isolation)', () => {
  it('returns only agents belonging to the current project', async () => {
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView[]>>(
      harness,
      apiPath(),
      {
        headers: authHeaders(bootstrap.token),
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // Should contain agents created in INT-1
    expect(body.data.length).toBeGreaterThanOrEqual(2);

    // All agents should belong to the same project (no cross-project leakage)
    for (const agent of body.data) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      // Verify no encryptedAuthConfig is leaked
      expect((agent as any).encryptedAuthConfig).toBeUndefined();
    }
  });

  it('does not return agents from a different project', async () => {
    // Create a second project under the same tenant
    const secondProject = await bootstrapProject(
      harness,
      'ext-agent-int2@example.com',
      'ext-int-tenant2',
      'ext-int-project2',
    );

    // Create an agent in the second project
    await requestJson(harness, `/api/projects/${secondProject.projectId}/external-agents`, {
      method: 'POST',
      headers: authHeaders(secondProject.token),
      body: {
        name: 'isolated_agent',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
      },
    });

    // List agents from the first project — should NOT include isolated_agent
    const { body } = await requestJson<SuccessResponse<ExternalAgentConfigView[]>>(
      harness,
      apiPath(),
      {
        headers: authHeaders(bootstrap.token),
      },
    );

    const agentNames = body.data.map((a) => a.name);
    expect(agentNames).not.toContain('isolated_agent');
  });
});

// ─── INT-3: Update External Agent Config ──────────────────────────────────

describe('INT-3: Update external agent config', () => {
  let agentId: string;

  beforeAll(async () => {
    // Create an agent to update
    const { body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'updatable_agent',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );
    agentId = body.data.id;
  });

  it('updates endpoint and authType via PATCH', async () => {
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(`/${agentId}`),
      {
        method: 'PATCH',
        headers: authHeaders(bootstrap.token),
        body: {
          endpoint: mockRemote.baseUrl + '/updated-endpoint',
          authType: 'api_key',
          authConfig: { value: 'api-key-value', header: 'X-Api-Key' },
        },
      },
    );

    expect(status).toBe(200);
    expect(body.data.endpoint).toBe(mockRemote.baseUrl + '/updated-endpoint');
    expect(body.data.authType).toBe('api_key');
    expect(body.data.authConfigured).toBe(true);
    expect(body.data.modifiedBy).toBe(bootstrap.userId);
  });

  it('returns 404 for non-existent agent ID', async () => {
    const { status, body } = await requestJson<ErrorResponse>(harness, apiPath('/nonexistent-id'), {
      method: 'PATCH',
      headers: authHeaders(bootstrap.token),
      body: { displayName: 'Updated' },
    });

    expect(status).toBe(404);
  });
});

// ─── INT-4: Delete External Agent Config ──────────────────────────────────

describe('INT-4: Delete external agent config', () => {
  let agentId: string;

  beforeAll(async () => {
    const { body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'deletable_agent',
          endpoint: mockRemote.endpointUrl,
          protocol: 'rest',
          authType: 'none',
        },
      },
    );
    agentId = body.data.id;
  });

  it('deletes the agent config (204) and subsequent GET returns 404', async () => {
    // DELETE
    const deleteResult = await requestJson(harness, apiPath(`/${agentId}`), {
      method: 'DELETE',
      headers: authHeaders(bootstrap.token),
    });
    expect(deleteResult.status).toBe(204);

    // Subsequent GET should return 404
    const getResult = await requestJson<ErrorResponse>(harness, apiPath(`/${agentId}`), {
      headers: authHeaders(bootstrap.token),
    });
    expect(getResult.status).toBe(404);
  });
});

// ─── INT-5: Duplicate Name → 409 ──────────────────────────────────────────

describe('INT-5: Duplicate name returns 409', () => {
  it('returns 409 DUPLICATE_NAME when creating an agent with an existing name', async () => {
    // First create
    await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: 'duplicate_test_agent',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
      },
    });

    // Second create with same name
    const { status, body } = await requestJson<ErrorResponse>(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: 'duplicate_test_agent',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
      },
    });

    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('DUPLICATE_NAME');
  });
});

// ─── INT-7: Validation Errors ──────────────────────────────────────────────

describe('INT-7: Input validation', () => {
  it('rejects invalid name format (must start with letter, alphanumeric/underscore)', async () => {
    const { status } = await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: '123-invalid!',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
      },
    });

    expect(status).toBe(400);
  });

  it('rejects missing endpoint URL', async () => {
    const { status } = await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: 'no_endpoint_agent',
        protocol: 'a2a',
        authType: 'none',
      },
    });

    expect(status).toBe(400);
  });

  it('rejects invalid protocol value', async () => {
    const { status } = await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: 'bad_protocol_agent',
        endpoint: mockRemote.endpointUrl,
        protocol: 'grpc',
        authType: 'none',
      },
    });

    expect(status).toBe(400);
  });

  it('rejects empty name', async () => {
    const { status } = await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: '',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
      },
    });

    expect(status).toBe(400);
  });

  it('rejects unknown fields in strict body validation', async () => {
    const { status } = await requestJson(harness, apiPath(), {
      method: 'POST',
      headers: authHeaders(bootstrap.token),
      body: {
        name: 'strict_body_agent',
        endpoint: mockRemote.endpointUrl,
        protocol: 'a2a',
        authType: 'none',
        unknownField: 'should-be-rejected',
      },
    });

    expect(status).toBe(400);
  });
});

// ─── EXT-1..EXT-5: A2A Spec 1 — Executor-scoped contracts ─────────────────
//
// These scenarios pin the response shapes the Studio `executeExternalAgentOps`
// executor (apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts) consumes.
// They are end-to-end against the runtime stack — same MongoMemoryServer +
// Express auth/RBAC/SSRF + MockA2ARemoteAgent harness as INT-1..INT-7.
//
// Per LLD §3.12 R4 HIGH-2: numbered EXT-* (not INT-*) to signal executor-level
// concern (the executor's contract, not the bare HTTP route's). Per CLAUDE.md
// "Test Architecture": no `vi.mock` of internal packages; verifies the real
// route response is the shape the executor + ExternalAgentCard rely on.

describe('EXT-1: list returns array of ExternalAgentConfigView with required executor fields', () => {
  it('list includes id, name, endpoint, protocol, authType, authConfigured', async () => {
    // Seed via API
    const created = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'ext1_list_shape',
          displayName: 'List Shape Agent',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );
    expect(created.status).toBe(201);

    // List
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView[]>>(
      harness,
      apiPath(),
      { headers: authHeaders(bootstrap.token) },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const found = body.data.find((a) => a.name === 'ext1_list_shape');
    expect(found).toBeDefined();
    if (!found) return;
    // Executor + ExternalAgentCard rely on these exact field names:
    expect(typeof found.id).toBe('string');
    expect(typeof found.name).toBe('string');
    expect(typeof found.endpoint).toBe('string');
    expect(typeof found.protocol).toBe('string');
    expect(typeof found.authType).toBe('string');
    expect(typeof found.authConfigured).toBe('boolean');
    // Encrypted secret field MUST NOT leak (executor only sees masked view).
    expect((found as unknown as Record<string, unknown>).encryptedAuthConfig).toBeUndefined();
  });
});

describe('EXT-2: read returns ExternalAgentConfigView with discovery + connection metadata', () => {
  it('read response carries lastDiscoveredCard / lastConnectionStatus when populated', async () => {
    const created = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'ext2_read_shape',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(`/${id}`),
      { headers: authHeaders(bootstrap.token) },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(id);
    // Card-event-relevant fields exist on the wire shape (may be null if the
    // background test_connection has not completed yet — the executor handles
    // that branch via `lastConnectionStatus ?? null`).
    expect('lastDiscoveredCard' in body.data).toBe(true);
    expect('lastConnectionStatus' in body.data).toBe(true);
    expect('lastConnectionLatencyMs' in body.data).toBe(true);
  });
});

describe('EXT-3: create returns id the executor can emit a card for', () => {
  it('POST returns 201 with data.id and the masked view shape', async () => {
    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'ext3_create_shape',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    // Executor's emitCard branch reads `data.id` — must always be a non-empty string.
    expect(typeof body.data.id).toBe('string');
    expect(body.data.id.length).toBeGreaterThan(0);
    expect(body.data.name).toBe('ext3_create_shape');
    // Mirrors EXT-1 expectation: no encryptedAuthConfig leak.
    expect((body.data as unknown as Record<string, unknown>).encryptedAuthConfig).toBeUndefined();
  });
});

describe('EXT-4: update preserves the masked-view contract', () => {
  it('PATCH never exposes encryptedAuthConfig in response', async () => {
    const created = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'ext4_update_shape',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'bearer',
          authConfig: { value: 'test-token-xyz' },
        },
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.authConfigured).toBe(true);

    const { status, body } = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(`/${id}`),
      {
        method: 'PATCH',
        headers: authHeaders(bootstrap.token),
        body: { displayName: 'EXT-4 renamed' },
      },
    );
    expect(status).toBe(200);
    expect(body.data.displayName).toBe('EXT-4 renamed');
    // Critical: secret never leaves the runtime even after update round-trip.
    const raw = body.data as unknown as Record<string, unknown>;
    expect(raw.encryptedAuthConfig).toBeUndefined();
    expect(JSON.stringify(body.data)).not.toContain('test-token-xyz');
  });
});

describe('EXT-5: delete returns 204; executor sees it as success-with-no-body', () => {
  it('DELETE returns 204 (no body) and subsequent GET returns 404', async () => {
    const created = await requestJson<SuccessResponse<ExternalAgentConfigView>>(
      harness,
      apiPath(),
      {
        method: 'POST',
        headers: authHeaders(bootstrap.token),
        body: {
          name: 'ext5_delete_shape',
          endpoint: mockRemote.endpointUrl,
          protocol: 'a2a',
          authType: 'none',
        },
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const del = await requestJson(harness, apiPath(`/${id}`), {
      method: 'DELETE',
      headers: authHeaders(bootstrap.token),
    });
    // Executor maps 204 → { success: true, data: { deleted: true } }.
    expect(del.status).toBe(204);

    const get = await requestJson<ErrorResponse>(harness, apiPath(`/${id}`), {
      headers: authHeaders(bootstrap.token),
    });
    expect(get.status).toBe(404);
    expect(get.body.success).toBe(false);
  });
});
