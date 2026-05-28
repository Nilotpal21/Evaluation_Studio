/**
 * Workflow Memory — Right-to-Erasure Cascade E2E (E2E-4)
 *
 * Covers test-spec scenario E2E-4 — "Right-to-erasure cascade purges
 * `memory.user.*` for an erased contact" — from
 * `docs/testing/sub-features/workflow-first-class-memory-and-context.md`.
 *
 * Per CLAUDE.md "E2E Test Standards": real Studio + Runtime, real Mongo
 * via the running services. No `vi.mock`, no Mongoose imports, no direct
 * DB access — every step goes through the live HTTP API.
 *
 * What's exercised end-to-end:
 *
 *   1. POST /api/contacts                              — create contact c1
 *   2. POST /api/internal/memory/set    (user-scope)   — write a fact owned
 *                                                        by c1's endUserId
 *   3. POST /api/internal/memory/set    (project-scope) — write a sibling
 *                                                        project-scope fact
 *                                                        (must SURVIVE the
 *                                                        cascade)
 *   4. POST /api/internal/memory/projection            — confirm both facts
 *                                                        are reachable
 *   5. DELETE /api/contacts/manage/:id/gdpr            — triggers
 *                                                        CascadeDeleteContact
 *                                                        which calls the
 *                                                        Phase 5 factErasure
 *                                                        port
 *   6. POST /api/internal/memory/projection            — assert user is
 *                                                        empty AND project
 *                                                        fact is intact
 *
 * The internal memory route is service-token authenticated (the same JWT
 * secret that workflow-engine uses in production). We mint a service token
 * inside the test harness using the dev JWT_SECRET — this is the same
 * mechanism `runtime-memory-client.ts` uses at runtime, so the auth path is
 * the real one. There is NO test-only bypass.
 */

import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { loginAndSetup } from './helpers';

const STUDIO_URL = 'http://localhost:5173';
const RUNTIME_URL = 'http://localhost:3112';
// Same secret declared in apps/studio/e2e/workflows/agents.md "Prerequisites".
const RUNTIME_JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-that-is-at-least-32chars';
const PLATFORM_JWT_ISSUER = 'agent-platform';

/** Decode a JWT (no verification) and extract the tenantId claim. */
function tenantIdFromToken(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('access token is not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as {
    tenantId?: string;
  };
  if (!payload.tenantId) throw new Error('access token missing tenantId claim');
  return payload.tenantId;
}

/**
 * Mint a service-to-service JWT mirroring `createServiceToken` from
 * `packages/shared-auth`. Kept inline so the spec has zero compile-time
 * dependency on the platform package — Playwright tsconfig must stay self-
 * contained.
 */
function mintServiceToken(tenantId: string): string {
  return jwt.sign(
    {
      sub: 'service:e2e-test',
      email: 'e2e-test@internal.service',
      type: 'service',
      tenantId,
      serviceName: 'e2e-test',
    },
    RUNTIME_JWT_SECRET,
    {
      expiresIn: '5m',
      audience: 'agent-platform-internal',
      issuer: PLATFORM_JWT_ISSUER,
    },
  );
}

interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function jsonFetch(
  url: string,
  init: RequestInit & { body?: string | undefined } = {},
): Promise<JsonResponse> {
  const resp = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { ok: resp.ok, status: resp.status, body };
}

test.describe('Workflow Memory — Right-to-Erasure Cascade (E2E-4)', () => {
  test('GDPR cascade purges memory.user.* for the deleted contact; memory.project.* survives', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ════════════════════════════════════════════════════════════════════
    // PHASE 1 — Studio login and resolve tenantId.
    // ════════════════════════════════════════════════════════════════════
    const { projectId, token } = await loginAndSetup(page);
    const tenantId = tenantIdFromToken(token);

    const contactEmail = `e2e-erasure-${Date.now()}@example.com`;
    const workflowId = `wf-erasure-${Date.now()}`;
    const runId = `run-erasure-${Date.now()}`;
    let contactId: string | null = null;

    try {
      // ════════════════════════════════════════════════════════════════════
      // PHASE 2 — Create a real contact via the public CRUD route.
      // ════════════════════════════════════════════════════════════════════
      const createContact = await jsonFetch(`${STUDIO_URL}/api/contacts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identity: { type: 'email', value: contactEmail },
          displayName: 'E2E Erasure Test',
        }),
      });
      expect(
        createContact.ok,
        `Contact create failed: ${createContact.status} ${JSON.stringify(createContact.body)}`,
      ).toBe(true);
      const contactBody = createContact.body as { contact?: { id?: string }; id?: string };
      contactId = contactBody.contact?.id ?? contactBody.id ?? null;
      expect(contactId, 'contact id missing on create response').toBeTruthy();

      // ════════════════════════════════════════════════════════════════════
      // PHASE 3 — Mint a service token and write two facts:
      //           (a) user-scope, owned by contactId
      //           (b) project-scope, sentinel `__project__` user
      // The internal memory route hits the real Mongo / Fact model.
      // ════════════════════════════════════════════════════════════════════
      const serviceToken = mintServiceToken(tenantId);
      const internalHeaders = {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      };

      const userSet = await jsonFetch(`${RUNTIME_URL}/api/internal/memory/set`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          tenantId,
          projectId,
          workflowId,
          runId,
          actor: { kind: 'end-user', endUserId: contactId },
          scope: 'user',
          key: 'preferredLang',
          value: 'fr',
          ttl: '90d',
        }),
      });
      expect(
        userSet.ok,
        `user-scope set failed: ${userSet.status} ${JSON.stringify(userSet.body)}`,
      ).toBe(true);

      const projectSet = await jsonFetch(`${RUNTIME_URL}/api/internal/memory/set`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          tenantId,
          projectId,
          workflowId,
          runId,
          actor: { kind: 'workflow-author' },
          scope: 'project',
          key: 'erasureSentinel',
          value: { keep: 'me' },
          ttl: '7d',
        }),
      });
      expect(
        projectSet.ok,
        `project-scope set failed: ${projectSet.status} ${JSON.stringify(projectSet.body)}`,
      ).toBe(true);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 4 — Sanity: both facts are reachable via projection.
      // ════════════════════════════════════════════════════════════════════
      const before = await jsonFetch(`${RUNTIME_URL}/api/internal/memory/projection`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ tenantId, projectId, workflowId, endUserId: contactId }),
      });
      expect(before.ok).toBe(true);
      const beforeData = (
        before.body as {
          data: { user?: Record<string, unknown>; project: Record<string, unknown> };
        }
      ).data;
      expect(beforeData.user?.preferredLang).toBe('fr');
      expect(beforeData.project.erasureSentinel).toEqual({ keep: 'me' });

      // ════════════════════════════════════════════════════════════════════
      // PHASE 5 — GDPR delete via the contact-manage cascade route. This
      // calls CascadeDeleteContact which invokes the Phase 5 factErasure
      // port to purge user-scope facts owned by the contact.
      // ════════════════════════════════════════════════════════════════════
      const gdprDelete = await jsonFetch(
        `${STUDIO_URL}/api/contacts/manage/${encodeURIComponent(contactId!)}/gdpr`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(
        gdprDelete.ok,
        `GDPR delete failed: ${gdprDelete.status} ${JSON.stringify(gdprDelete.body)}`,
      ).toBe(true);
      // After this point the contact document is gone — clean-up phase below
      // should not try to delete it again.
      contactId = null;

      // ════════════════════════════════════════════════════════════════════
      // PHASE 6 — Re-fetch the projection. Assert:
      //   • user-scope is empty (the only key was the now-erased contact's)
      //   • project-scope sentinel is INTACT — the cascade must not over-reach.
      // ════════════════════════════════════════════════════════════════════
      const after = await jsonFetch(`${RUNTIME_URL}/api/internal/memory/projection`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          tenantId,
          projectId,
          workflowId,
          endUserId: contactBody.contact?.id ?? contactBody.id,
        }),
      });
      expect(after.ok).toBe(true);
      const afterData = (
        after.body as { data: { user?: Record<string, unknown>; project: Record<string, unknown> } }
      ).data;
      expect(afterData.user ?? {}).toEqual({});
      expect(afterData.project.erasureSentinel).toEqual({ keep: 'me' });
    } finally {
      // Clean up the project-scope sentinel so re-runs stay deterministic.
      try {
        const cleanupToken = mintServiceToken(tenantId);
        await jsonFetch(`${RUNTIME_URL}/api/internal/memory/delete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cleanupToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tenantId,
            projectId,
            workflowId,
            runId,
            actor: { kind: 'workflow-author' },
            scope: 'project',
            key: 'erasureSentinel',
          }),
        });
      } catch {
        /* best-effort */
      }

      // Cascade-delete the contact ONLY if we did not already do it in Phase 5.
      if (contactId) {
        await fetch(`${STUDIO_URL}/api/contacts/manage/${encodeURIComponent(contactId)}/gdpr`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
  });
});
