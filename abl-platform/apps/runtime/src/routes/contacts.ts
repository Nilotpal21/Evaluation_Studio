/**
 * Contact CRUD API Routes
 *
 * POST   /api/contacts                Create contact (ADMIN+)
 * GET    /api/contacts                Query contacts (any member)
 * GET    /api/contacts/lookup         Find by identity (any member)
 * GET    /api/contacts/:id            Get by ID (any member)
 * PUT    /api/contacts/:id            Update contact (ADMIN+)
 * DELETE /api/contacts/:id            Soft delete (ADMIN+)
 * POST   /api/contacts/:id/link-session  Link to session (ADMIN+)
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermissionInline } from '../middleware/rbac.js';
import { getStores } from '../services/stores/store-factory.js';
import { unlinkContactFromSessions } from '../repos/session-repo.js';
import { validateCreateContact, validateUpdateContact } from '../validation/contact-validation.js';
import {
  auditContactCreated,
  auditContactUpdated,
  auditContactDeleted,
  auditContactLinked,
} from '../services/audit-helpers.js';
import type { IdentityType } from '@abl/compiler/platform/core/types';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('contacts-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/contacts',
  tags: ['Contacts'],
});
const router: RouterType = openapi.router;

// Middleware chain (authMiddleware already sets ALS via runWithTenantContext)
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// Store accessors — delegate to the store factory
function getContactStore() {
  return getStores().contact;
}
function getConversationStore() {
  return getStores().conversation;
}

// =============================================================================
// SCHEMAS
// =============================================================================

const ContactTypeSchema = z.enum(['employee', 'customer', 'anonymous']);
const IdentityTypeSchema = z.enum(['email', 'phone', 'external']);

const ContactSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  type: ContactTypeSchema,
  identity: z.string().optional(),
  identityType: IdentityTypeSchema.optional(),
  displayName: z.string().optional(),
  department: z.string().optional(),
  employeeId: z.string().optional(),
  company: z.string().optional(),
  accountRef: z.string().optional(),
  channel: z.string().optional(),
  metadata: z.record(z.unknown()),
  tags: z.array(z.string()),
  firstSeenAt: z.string().or(z.date()),
  lastSeenAt: z.string().or(z.date()),
  deletedAt: z.string().or(z.date()).optional(),
});

const CreateContactBodySchema = z.object({
  type: ContactTypeSchema.default('customer'),
  identity: z.string().optional(),
  identityType: IdentityTypeSchema.optional(),
  displayName: z.string().max(200).optional(),
  department: z.string().optional(),
  employeeId: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  accountRef: z.string().optional(),
  channel: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
});

const UpdateContactBodySchema = z.object({
  type: ContactTypeSchema.optional(),
  identity: z.string().optional(),
  identityType: IdentityTypeSchema.optional(),
  displayName: z.string().max(200).optional(),
  department: z.string().optional(),
  employeeId: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  accountRef: z.string().optional(),
  channel: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
});

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * POST / — Create contact
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create contact',
    description: 'Create a new contact (requires admin or write access)',
    body: CreateContactBodySchema,
    response: z.object({
      success: z.boolean(),
      data: ContactSchema,
    }),
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!requirePermissionInline(req, res, 'agent:execute')) return;

      // Parse body through Zod so defaults (e.g. type='customer') fire
      const parsed = CreateContactBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
        return;
      }

      const params = { ...parsed.data, tenantId: req.tenantContext!.tenantId };
      const errors = validateCreateContact(params);
      if (errors.length > 0) {
        res.status(400).json({ success: false, errors });
        return;
      }

      const store = getContactStore();
      const contact = await store.create(params);

      auditContactCreated(contact, req.tenantContext!.userId!).catch((err) =>
        log.warn('audit contact created failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.status(201).json({ success: true, data: contact });
    } catch (error) {
      log.error('Error creating contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to create contact' });
    }
  },
);

/**
 * GET / — Query contacts
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Query contacts',
    description:
      'Query contacts with optional filters (query params: type, channel, limit, offset)',
    response: z.object({
      success: z.boolean(),
      data: z.array(ContactSchema),
      total: z.number(),
    }),
  },
  async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Validate type parameter
      const VALID_CONTACT_TYPES = ['employee', 'customer', 'anonymous'] as const;
      if (req.query.type && !VALID_CONTACT_TYPES.includes(req.query.type as any)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'type must be one of: employee, customer, anonymous',
          },
        });
        return;
      }

      // Validate limit is a positive integer ≤ 1000
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 1000)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'limit must be an integer between 1 and 1000',
          },
        });
        return;
      }

      // Validate offset is a non-negative integer
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      if (offset !== undefined && (isNaN(offset) || offset < 0)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'offset must be a non-negative integer',
          },
        });
        return;
      }

      const store = getContactStore();
      const result = await store.query({
        tenantId: req.tenantContext.tenantId,
        type: req.query.type as any,
        channel: req.query.channel as string,
        limit,
        offset,
      });

      res.json({ success: true, data: result.contacts, total: result.total });
    } catch (error) {
      log.error('Error querying contacts', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to query contacts' });
    }
  },
);

/**
 * GET /lookup — Find by identity
 */
openapi.route(
  'get',
  '/lookup',
  {
    summary: 'Find contact by identity',
    description: 'Find a contact by identity type and value (query params: identityType, identity)',
    response: z.object({
      success: z.boolean(),
      data: ContactSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { identityType, identity } = req.query;
      if (!identityType || !identity) {
        res
          .status(400)
          .json({ success: false, error: 'identityType and identity query params required' });
        return;
      }

      const store = getContactStore();
      const contact = await store.findByIdentity(
        req.tenantContext.tenantId,
        identityType as IdentityType,
        identity as string,
      );

      if (!contact) {
        res.status(404).json({ success: false, error: 'Contact not found' });
        return;
      }

      res.json({ success: true, data: contact });
    } catch (error) {
      log.error('Error looking up contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to look up contact' });
    }
  },
);

/**
 * GET /:id — Get by ID
 */
openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get contact by ID',
    description: 'Get a contact by its ID',
    response: z.object({
      success: z.boolean(),
      data: ContactSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const store = getContactStore();
      const contact = await store.getById(req.params.id, req.tenantContext!.tenantId);

      if (!contact) {
        res.status(404).json({ success: false, error: 'Contact not found' });
        return;
      }

      res.json({ success: true, data: contact });
    } catch (error) {
      log.error('Error getting contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to get contact' });
    }
  },
);

/**
 * PUT /:id — Update contact
 */
openapi.route(
  'put',
  '/:id',
  {
    summary: 'Update contact',
    description: 'Update a contact (requires admin or write access)',
    body: UpdateContactBodySchema,
    response: z.object({
      success: z.boolean(),
      data: ContactSchema,
    }),
  },
  async (req, res) => {
    try {
      if (!requirePermissionInline(req, res, 'agent:execute')) return;

      const errors = validateUpdateContact(req.body);
      if (errors.length > 0) {
        res.status(400).json({ success: false, errors });
        return;
      }

      const store = getContactStore();
      const tenantId = req.tenantContext!.tenantId;
      const existing = await store.getById(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Contact not found' });
        return;
      }

      const updated = await store.update(req.params.id, req.body, tenantId);

      auditContactUpdated(
        req.params.id,
        { type: existing.type, displayName: existing.displayName, identity: existing.identity },
        { type: updated.type, displayName: updated.displayName, identity: updated.identity },
        req.tenantContext!.userId!,
        req.tenantContext!.tenantId,
      ).catch((err) =>
        log.warn('audit contact updated failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, data: updated });
    } catch (error) {
      log.error('Error updating contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to update contact' });
    }
  },
);

/**
 * DELETE /:id — Soft delete
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete contact',
    description: 'Soft delete a contact (requires admin or write access)',
    response: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (req, res) => {
    try {
      if (!requirePermissionInline(req, res, 'agent:execute')) return;

      const store = getContactStore();
      const tenantId = req.tenantContext!.tenantId;
      const existing = await store.getById(req.params.id, tenantId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Contact not found' });
        return;
      }

      await store.softDelete(req.params.id, tenantId);

      // Null out contactId on linked sessions
      await unlinkContactFromSessions(req.params.id, req.tenantContext!.tenantId);

      auditContactDeleted(
        req.params.id,
        req.tenantContext!.userId!,
        req.tenantContext!.tenantId,
      ).catch((err) =>
        log.warn('audit contact deleted failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, message: 'Contact soft-deleted' });
    } catch (error) {
      log.error('Error deleting contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to delete contact' });
    }
  },
);

/**
 * POST /:id/link-session — Link contact to session
 */
openapi.route(
  'post',
  '/:id/link-session',
  {
    summary: 'Link contact to session',
    description: 'Link a contact to a session (requires admin or write access)',
    body: z.object({
      sessionId: z.string().describe('Session ID to link the contact to'),
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (req, res) => {
    try {
      if (!requirePermissionInline(req, res, 'agent:execute')) return;

      const { sessionId } = req.body;
      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ success: false, error: 'sessionId is required' });
        return;
      }

      const contactStore = getContactStore();
      const contact = await contactStore.getById(req.params.id, req.tenantContext!.tenantId);
      if (!contact) {
        res.status(404).json({ success: false, error: 'Contact not found' });
        return;
      }

      const convStore = getConversationStore();
      await convStore.linkContact(sessionId, req.params.id);
      await contactStore.touchLastSeen(req.params.id);

      auditContactLinked(
        sessionId,
        req.params.id,
        req.tenantContext!.userId!,
        req.tenantContext!.tenantId,
      ).catch((err) =>
        log.warn('audit contact linked failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, message: 'Contact linked to session' });
    } catch (error) {
      log.error('Error linking contact', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to link contact to session' });
    }
  },
);

/**
 * GET /:id/history — Cross-session message history for a contact
 * Cursor-paginated using message _id. Tier 2+ contacts only (404 for anonymous).
 * Uses existing index: { tenantId: 1, contactId: 1, timestamp: -1 }
 */
const MAX_HISTORY_PAGE_SIZE = 200;
const DEFAULT_HISTORY_PAGE_SIZE = 50;

router.get('/:id/history', async (req, res) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    if (!requirePermissionInline(req, res, 'agent:execute')) return;

    const tenantId = req.tenantContext.tenantId;
    const contactId = req.params.id;

    // Verify contact exists and belongs to tenant
    const { Contact: ContactModel } = await import('@agent-platform/database/models');
    const contact = (await ContactModel.findOne(
      { _id: contactId, tenantId },
      { _id: 1, type: 1 },
    ).lean()) as { _id: string; type: string } | null;

    if (!contact) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Contact not found' } });
      return;
    }

    // Cross-session history is only available for identified contacts (not anonymous)
    if (contact.type === 'anonymous') {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Contact not found' } });
      return;
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = Math.min(
      req.query.limit ? parseInt(String(req.query.limit), 10) : DEFAULT_HISTORY_PAGE_SIZE,
      MAX_HISTORY_PAGE_SIZE,
    );

    if (isNaN(limit) || limit < 1) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_LIMIT', message: 'limit must be a positive integer' },
      });
      return;
    }

    const { Message: MessageModel } = await import('@agent-platform/database/models');

    // Cursor is an ISO timestamp string; uses the { tenantId, contactId, timestamp } compound index.
    const filter: Record<string, unknown> = { tenantId, contactId };

    // Project isolation: SDK sessions are always scoped to their project.
    // Platform members may optionally filter by projectId query param.
    if (req.tenantContext.authType === 'sdk_session') {
      if (req.tenantContext.projectId) {
        filter.projectId = req.tenantContext.projectId;
      }
    } else {
      const projectIdParam =
        typeof req.query.projectId === 'string' ? req.query.projectId.trim() : undefined;
      if (projectIdParam) {
        filter.projectId = projectIdParam;
      }
    }

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (isNaN(cursorDate.getTime())) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CURSOR',
            message: 'cursor must be a valid ISO 8601 timestamp',
          },
        });
        return;
      }
      filter.timestamp = { $lt: cursorDate };
    }

    // Sort by timestamp to use the compound index { tenantId: 1, contactId: 1, timestamp: -1 }.
    const docs = (await MessageModel.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit + 1)
      .select({ _id: 1, sessionId: 1, role: 1, content: 1, timestamp: 1 })
      .lean()) as Array<{
      _id: string;
      sessionId: string;
      role: string;
      content: string;
      timestamp: Date;
    }>;

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const messages = page.map((d) => ({
      id: d._id,
      sessionId: d.sessionId,
      role: d.role,
      content: d.content,
      timestamp: d.timestamp,
    }));

    const nextCursor =
      hasMore && messages.length > 0
        ? messages[messages.length - 1].timestamp?.toISOString()
        : null;

    res.json({
      success: true,
      messages,
      nextCursor,
      hasMore,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to fetch contact history', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Failed to fetch contact history' },
    });
  }
});

export default openapi.router;
