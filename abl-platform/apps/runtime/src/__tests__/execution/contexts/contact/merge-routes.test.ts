/**
 * Contact Merge, Self-Merge, GDPR Cascade & Merge Suggestions Route Tests
 *
 * Tests the factory-created routers for:
 * - POST   /merge             (admin merge two contacts)
 * - POST   /:id/self-merge    (SDK session self-merge)
 * - DELETE /:id/gdpr          (GDPR cascade hard-delete)
 * - GET    /merge-suggestions  (list suggestions)
 * - PUT    /merge-suggestions/:id (accept/reject suggestion)
 *
 * Uses Express + mock req/res pattern (same as webhook-router.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import {
  createContactMergeRouter,
  type ContactMergeRouterDeps,
} from '../../../../routes/contact-merge.js';
import {
  createMergeSuggestionsRouter,
  type MergeSuggestionsRouterDeps,
  type MergeSuggestionStore,
} from '../../../../routes/merge-suggestions.js';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { MergeSuggestion } from '../../../../contexts/contact/domain/merge-suggestion.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(
  overrides: Partial<Request> & { tenantContext?: Record<string, unknown> } = {},
): Request {
  return {
    params: {},
    body: {},
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  const now = new Date();
  return {
    id: overrides.id ?? 'contact-001',
    tenantId: overrides.tenantId ?? 'tenant-001',
    identities: overrides.identities ?? [],
    displayName: overrides.displayName ?? null,
    type: overrides.type ?? 'customer',
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    channelHistory: overrides.channelHistory ?? [],
    sessionCount: overrides.sessionCount ?? 0,
    firstSeenAt: overrides.firstSeenAt ?? now,
    lastSeenAt: overrides.lastSeenAt ?? now,
    mergedInto: overrides.mergedInto ?? null,
    deletedAt: overrides.deletedAt ?? null,
    encryptionSalt: overrides.encryptionSalt ?? null,
  };
}

function makeSuggestion(overrides: Partial<MergeSuggestion> = {}): MergeSuggestion {
  return {
    id: overrides.id ?? 'suggestion-001',
    tenantId: overrides.tenantId ?? 'tenant-001',
    primaryContactId: overrides.primaryContactId ?? 'contact-a',
    secondaryContactId: overrides.secondaryContactId ?? 'contact-b',
    overlapIdentities: overrides.overlapIdentities ?? [{ type: 'email', blindIndex: 'blind-1' }],
    confidence: overrides.confidence ?? 'high',
    status: overrides.status ?? 'pending',
    suggestedAt: overrides.suggestedAt ?? new Date(),
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
  };
}

/**
 * Extract a named route handler from an Express Router for direct invocation.
 * The handler is found by matching path + method.
 */
function getHandler(
  router: express.Router,
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  const stack = (router as any).stack;
  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routePath === path && routeMethod === method) {
        // Return the last handler (after middleware)
        const handlers = layer.route.stack;
        return handlers[handlers.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${path}`);
}

// =============================================================================
// CONTACT MERGE ROUTER TESTS
// =============================================================================

describe('createContactMergeRouter', () => {
  let deps: ContactMergeRouterDeps;

  beforeEach(() => {
    deps = {
      executeMerge: {
        execute: vi.fn().mockResolvedValue({
          success: true,
          data: {
            id: 'merge-exec-001',
            tenantId: 'tenant-001',
            primaryContactId: 'contact-a',
            secondaryContactId: 'contact-b',
            identitiesMoved: [],
            sessionsMoved: [],
            mergedAt: new Date(),
            mergedBy: 'admin-user',
            suggestionId: null,
          },
        }),
      },
      selfMerge: {
        execute: vi.fn().mockResolvedValue({
          success: true,
          contact: makeContact({ id: 'contact-merged' }),
          merged: true,
        }),
      },
      cascadeDelete: {
        execute: vi.fn().mockResolvedValue({ success: true }),
      },
    };
  });

  // ---------------------------------------------------------------------------
  // Auth: require tenantContext
  // ---------------------------------------------------------------------------

  describe('auth middleware', () => {
    it('rejects requests without tenantContext with 401', async () => {
      const router = createContactMergeRouter(deps);

      // The auth middleware is applied via router.use, so we need to find
      // the middleware layer (first in stack, before routes).
      const middlewareLayer = (router as any).stack[0];
      expect(middlewareLayer).toBeDefined();

      const req = createMockReq({ tenantContext: undefined } as any);
      const res = createMockRes();
      const next = vi.fn();

      middlewareLayer.handle(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /merge
  // ---------------------------------------------------------------------------

  describe('POST /merge', () => {
    it('returns 200 with merge execution data on success', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/merge');

      const req = createMockReq({
        body: {
          primaryContactId: 'contact-a',
          secondaryContactId: 'contact-b',
        },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: { primaryContactId: string } };
      expect(body.success).toBe(true);
      expect(body.data.primaryContactId).toBe('contact-a');
      expect(deps.executeMerge.execute).toHaveBeenCalledWith(
        'tenant-001',
        'contact-a',
        'contact-b',
        'admin-user',
      );
    });

    it('returns 400 when primaryContactId is missing', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/merge');

      const req = createMockReq({
        body: { secondaryContactId: 'contact-b' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(deps.executeMerge.execute).not.toHaveBeenCalled();
    });

    it('returns 400 when secondaryContactId is missing', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/merge');

      const req = createMockReq({
        body: { primaryContactId: 'contact-a' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(deps.executeMerge.execute).not.toHaveBeenCalled();
    });

    it('returns use case error when merge fails', async () => {
      (deps.executeMerge.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { code: 'CONTACT_NOT_FOUND', message: 'Primary contact not found' },
      });

      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/merge');

      const req = createMockReq({
        body: { primaryContactId: 'missing', secondaryContactId: 'contact-b' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(422);
      const body = res._json as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONTACT_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:id/self-merge
  // ---------------------------------------------------------------------------

  describe('POST /:id/self-merge', () => {
    it('returns 200 with merged contact on success', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/:id/self-merge');

      const req = createMockReq({
        params: { id: 'contact-current' },
        body: { identityType: 'email', identityValue: 'user@example.com' },
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; merged: boolean };
      expect(body.success).toBe(true);
      expect(body.merged).toBe(true);
      expect(deps.selfMerge.execute).toHaveBeenCalledWith(
        'tenant-001',
        'contact-current',
        'email',
        'user@example.com',
      );
    });

    it('returns 400 when identityType or identityValue is missing', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'post', '/:id/self-merge');

      const req = createMockReq({
        params: { id: 'contact-current' },
        body: { identityType: 'email' },
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(deps.selfMerge.execute).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id/gdpr
  // ---------------------------------------------------------------------------

  describe('DELETE /:id/gdpr', () => {
    it('returns 200 on successful cascade delete', async () => {
      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'delete', '/:id/gdpr');

      const req = createMockReq({
        params: { id: 'contact-to-delete' },
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean };
      expect(body.success).toBe(true);
      expect(deps.cascadeDelete.execute).toHaveBeenCalledWith('tenant-001', 'contact-to-delete');
    });

    it('returns use case error when contact not found', async () => {
      (deps.cascadeDelete.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' },
      });

      const router = createContactMergeRouter(deps);
      const handler = getHandler(router, 'delete', '/:id/gdpr');

      const req = createMockReq({
        params: { id: 'nonexistent' },
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(422);
      const body = res._json as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONTACT_NOT_FOUND');
    });
  });
});

// =============================================================================
// MERGE SUGGESTIONS ROUTER TESTS
// =============================================================================

describe('createMergeSuggestionsRouter', () => {
  let store: MergeSuggestionStore;
  let deps: MergeSuggestionsRouterDeps;

  beforeEach(() => {
    store = {
      findByTenant: vi
        .fn()
        .mockResolvedValue([makeSuggestion(), makeSuggestion({ id: 'suggestion-002' })]),
      findById: vi.fn().mockResolvedValue(makeSuggestion()),
      updateStatus: vi
        .fn()
        .mockResolvedValue(
          makeSuggestion({ status: 'accepted', resolvedAt: new Date(), resolvedBy: 'admin-user' }),
        ),
    };
    deps = { store };
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  describe('auth middleware', () => {
    it('rejects requests without tenantContext with 401', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const middlewareLayer = (router as any).stack[0];

      const req = createMockReq({ tenantContext: undefined } as any);
      const res = createMockRes();
      const next = vi.fn();

      middlewareLayer.handle(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------

  describe('GET /', () => {
    it('returns list of suggestions for the tenant', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'get', '/');

      const req = createMockReq({
        query: {},
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MergeSuggestion[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(store.findByTenant).toHaveBeenCalledWith('tenant-001', undefined);
    });

    it('passes status filter to store', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'get', '/');

      const req = createMockReq({
        query: { status: 'pending' },
        tenantContext: { tenantId: 'tenant-001' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(store.findByTenant).toHaveBeenCalledWith('tenant-001', 'pending');
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /:id
  // ---------------------------------------------------------------------------

  describe('PUT /:id', () => {
    it('accepts a suggestion and returns updated record', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'put', '/:id');

      const req = createMockReq({
        params: { id: 'suggestion-001' },
        body: { status: 'accepted' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MergeSuggestion };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('accepted');
      expect(store.updateStatus).toHaveBeenCalledWith(
        'tenant-001',
        'suggestion-001',
        'accepted',
        'admin-user',
      );
    });

    it('rejects a suggestion', async () => {
      (store.updateStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSuggestion({ status: 'rejected', resolvedBy: 'admin-user', resolvedAt: new Date() }),
      );

      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'put', '/:id');

      const req = createMockReq({
        params: { id: 'suggestion-001' },
        body: { status: 'rejected' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MergeSuggestion };
      expect(body.data.status).toBe('rejected');
    });

    it('returns 400 when status is missing from body', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'put', '/:id');

      const req = createMockReq({
        params: { id: 'suggestion-001' },
        body: {},
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(store.updateStatus).not.toHaveBeenCalled();
    });

    it('returns 400 when status is not accepted or rejected', async () => {
      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'put', '/:id');

      const req = createMockReq({
        params: { id: 'suggestion-001' },
        body: { status: 'pending' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(store.updateStatus).not.toHaveBeenCalled();
    });

    it('returns 404 when suggestion not found', async () => {
      (store.updateStatus as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const router = createMergeSuggestionsRouter(deps);
      const handler = getHandler(router, 'put', '/:id');

      const req = createMockReq({
        params: { id: 'nonexistent' },
        body: { status: 'accepted' },
        tenantContext: { tenantId: 'tenant-001', userId: 'admin-user' },
      } as any);
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(404);
    });
  });
});
