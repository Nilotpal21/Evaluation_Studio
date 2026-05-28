/**
 * E2E-7 — Workflow Tool Auth: Unauthenticated/forbidden requests rejected
 *
 * Verifies that the auth middleware protects workflow-related endpoints:
 * - No auth header → 401
 * - Expired JWT → 401
 * - Internal JWT signed with wrong key → rejected
 * - Valid auth succeeds (not 401/403)
 *
 * Uses real Express server on a random port with full middleware chain.
 * Real MongoDB (MongoMemoryServer). No mocks of platform components.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  authHeaders,
  requestJson,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const TIMEOUT = 90_000;
const TEST_JWT_SECRET = '1'.repeat(64);

describe('E2E-7: Workflow Tool Auth', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'wf-auth-e2e@example.com',
      uniqueSlug('wf-auth-tenant'),
      uniqueSlug('wf-auth-proj'),
    );
  }, TIMEOUT);

  afterAll(async () => {
    await harness.close();
  }, TIMEOUT);

  test('no auth header returns 401', async () => {
    const res = await requestJson(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'POST',
      body: { agentName: 'test-agent' },
    });
    expect(res.status).toBe(401);
  });

  test('expired JWT returns 401', async () => {
    const expiredToken = jwt.sign(
      {
        sub: admin.userId,
        email: 'wf-auth-e2e@example.com',
        type: 'access',
        tokenClass: 'user',
        tenantId: admin.tenantId,
        role: 'OWNER',
      },
      TEST_JWT_SECRET,
      { expiresIn: -10 },
    );
    const res = await requestJson(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'POST',
      headers: authHeaders(expiredToken),
      body: { agentName: 'test-agent' },
    });
    expect(res.status).toBe(401);
  });

  test('JWT signed with wrong key is rejected', async () => {
    const forgedToken = jwt.sign(
      {
        sub: 'runtime-service',
        email: 'runtime-internal@service.local',
        type: 'access',
        tokenClass: 'user',
        tenantId: admin.tenantId,
        role: 'OWNER',
        internal: true,
      },
      'wrong-secret-key-that-does-not-match',
      { expiresIn: 3600 },
    );
    const res = await requestJson(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'POST',
      headers: authHeaders(forgedToken),
      body: { agentName: 'test-agent' },
    });
    expect(res.status).toBe(401);
  });

  test('valid auth with proper JWT succeeds (not 401/403)', async () => {
    const res = await requestJson(harness, `/api/projects/${admin.projectId}/agents`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
