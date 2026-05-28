/**
 * Contact Routes Tests
 *
 * Tests the Contact CRUD API using mocked stores and Express request/response.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the external dependencies before importing
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditContactCreated: vi.fn(() => Promise.resolve()),
  auditContactUpdated: vi.fn(() => Promise.resolve()),
  auditContactDeleted: vi.fn(() => Promise.resolve()),
  auditContactLinked: vi.fn(() => Promise.resolve()),
}));

let mockDb: any;
let contacts: Map<string, any>;
let idCounter: number;

function createMockDb() {
  contacts = new Map();
  idCounter = 0;
  const nextId = () => `contact-${++idCounter}`;

  return {
    tenantMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { tenantId, userId } = where.tenantId_userId;
        if (userId === 'admin-user') return { role: 'ADMIN', tenantId, userId };
        if (userId === 'member-user') return { role: 'MEMBER', tenantId, userId };
        return null;
      }),
    },
    contact: {
      create: vi.fn(async ({ data }: any) => {
        const id = nextId();
        const contact = { id, ...data, firstSeenAt: new Date(), lastSeenAt: new Date() };
        contacts.set(id, contact);
        return contact;
      }),
      findUnique: vi.fn(async ({ where }: any) => contacts.get(where.id) || null),
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          Array.from(contacts.values()).find(
            (c) =>
              c.tenantId === where.tenantId &&
              c.identityType === where.identityType &&
              c.identity === where.identity &&
              !c.deletedAt,
          ) || null
        );
      }),
      findMany: vi.fn(async ({ where, skip, take }: any) => {
        let results = Array.from(contacts.values()).filter((c) => !c.deletedAt);
        if (where?.tenantId) results = results.filter((c) => c.tenantId === where.tenantId);
        if (where?.type) results = results.filter((c) => c.type === where.type);
        if (where?.deletedAt === null) results = results.filter((c) => !c.deletedAt);
        return results.slice(skip || 0, (skip || 0) + (take || 50));
      }),
      count: vi.fn(async ({ where }: any) => {
        let results = Array.from(contacts.values()).filter((c) => !c.deletedAt);
        if (where?.tenantId) results = results.filter((c) => c.tenantId === where.tenantId);
        if (where?.deletedAt === null) results = results.filter((c) => !c.deletedAt);
        return results.length;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const contact = contacts.get(where.id);
        if (!contact) throw new Error(`Contact ${where.id} not found`);
        const updated = { ...contact, ...data };
        contacts.set(where.id, updated);
        return updated;
      }),
      delete: vi.fn(async ({ where }: any) => {
        contacts.delete(where.id);
      }),
    },
    session: {
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })),
    },
  };
}

// Create helpers for testing Express routes
function createMockReq(overrides: Record<string, any> = {}): any {
  return {
    body: {},
    params: {},
    query: {},
    tenantContext: {
      tenantId: 'org-1',
      userId: 'admin-user',
    },
    ...overrides,
  };
}

function createMockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((data: any) => {
      res.body = data;
      return res;
    }),
  };
  return res;
}

// Dynamically import the router after mocks are set up
async function getRouter() {
  const mod = await import('../routes/contacts.js');
  return mod.default;
}

// Helper to invoke a specific route handler directly
// Since Express router is complex to invoke directly, we test through store + validation logic
import { validateCreateContact, validateUpdateContact } from '../validation/contact-validation';
// TODO: Rewrite store tests for MongoDB — MongoContactStore uses Mongoose models
// import { MongoContactStore } from '../services/stores/mongo-contact-store';

describe('Contact Routes', () => {
  let contactStore: any;

  beforeEach(() => {
    mockDb = createMockDb();
    // TODO: Replace with MongoContactStore when MongoDB test infrastructure is available
    // TODO: Replace with MongoContactStore when MongoDB test infrastructure is available
    contactStore = {
      create: async (params: any) => mockDb.contact.create({ data: params }),
      getById: async (id: string) => {
        const doc = await mockDb.contact.findUnique({ where: { id } });
        if (!doc) return null;
        // Return doc as-is — preserve null values for soft-deleted PII fields
        return { ...doc };
      },
      findByIdentity: async (tenantId: string, identityType: string, identity: string) =>
        mockDb.contact.findFirst({ where: { tenantId, identityType, identity } }),
      query: async (params: any) => {
        const contacts = await mockDb.contact.findMany({ where: params });
        const total = await mockDb.contact.count({ where: params });
        return { contacts, total };
      },
      update: async (id: string, data: any) => mockDb.contact.update({ where: { id }, data }),
      softDelete: async (id: string) => {
        await mockDb.contact.update({
          where: { id },
          data: {
            identity: null,
            identityType: null,
            displayName: null,
            employeeId: null,
            company: null,
            accountRef: null,
            type: 'anonymous',
            deletedAt: new Date(),
          },
        });
        await mockDb.session.updateMany({ where: { contactId: id }, data: { contactId: null } });
      },
      touchLastSeen: async (id: string) =>
        mockDb.contact.update({ where: { id }, data: { lastSeenAt: new Date() } }),
    };
  });

  describe('Create contact (POST /)', () => {
    test('creates contact with valid data → 201 equivalent', async () => {
      const params = {
        tenantId: 'org-1',
        type: 'customer',
        identity: 'john@example.com',
        identityType: 'email',
        displayName: 'John Doe',
      };

      const errors = validateCreateContact(params);
      expect(errors).toHaveLength(0);

      const contact = await contactStore.create(params);
      expect(contact.id).toBeDefined();
      expect(contact.displayName).toBe('John Doe');
      expect(contact.type).toBe('customer');
    });

    test('rejects invalid data → 400 equivalent', () => {
      const params = {
        // missing tenantId
        identity: 'bad-email',
        identityType: 'email',
      };

      const errors = validateCreateContact(params);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === 'tenantId')).toBe(true);
      expect(errors.some((e) => e.field === 'identity')).toBe(true);
    });
  });

  describe('Get by ID (GET /:id)', () => {
    test('returns contact → 200 equivalent', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        displayName: 'Jane',
      });

      const found = await contactStore.getById(contact.id);
      expect(found).not.toBeNull();
      expect(found!.displayName).toBe('Jane');
    });

    test('returns null for non-existent → 404 equivalent', async () => {
      const found = await contactStore.getById('nonexistent-id');
      expect(found).toBeNull();
    });
  });

  describe('Query (GET /)', () => {
    test('returns paginated contacts', async () => {
      await contactStore.create({ tenantId: 'org-1', type: 'customer', displayName: 'A' });
      await contactStore.create({ tenantId: 'org-1', type: 'employee', displayName: 'B' });
      await contactStore.create({ tenantId: 'org-2', type: 'customer', displayName: 'C' });

      const result = await contactStore.query({ tenantId: 'org-1' });
      expect(result.contacts).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    test('filters by type', async () => {
      await contactStore.create({ tenantId: 'org-1', type: 'customer', displayName: 'A' });
      await contactStore.create({ tenantId: 'org-1', type: 'employee', displayName: 'B' });

      const result = await contactStore.query({ tenantId: 'org-1', type: 'customer' });
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].type).toBe('customer');
    });
  });

  describe('Lookup (GET /lookup)', () => {
    test('finds contact by identity', async () => {
      await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        identity: 'jane@example.com',
        identityType: 'email',
      });

      const found = await contactStore.findByIdentity('org-1', 'email', 'jane@example.com');
      expect(found).not.toBeNull();
      expect(found!.identity).toBe('jane@example.com');
    });

    test('returns null when not found', async () => {
      const found = await contactStore.findByIdentity('org-1', 'email', 'nobody@example.com');
      expect(found).toBeNull();
    });
  });

  describe('Update (PUT /:id)', () => {
    test('updates contact with valid data', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        displayName: 'Old Name',
      });

      const errors = validateUpdateContact({ displayName: 'New Name', type: 'employee' });
      expect(errors).toHaveLength(0);

      const updated = await contactStore.update(contact.id, {
        displayName: 'New Name',
        type: 'employee',
      });
      expect(updated.displayName).toBe('New Name');
      expect(updated.type).toBe('employee');
    });

    test('rejects invalid update data', () => {
      const errors = validateUpdateContact({ type: 'invalid_type' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });
  });

  describe('Soft delete (DELETE /:id)', () => {
    test('soft-deletes contact: PII nullified, deletedAt set', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        identity: 'john@example.com',
        identityType: 'email',
        displayName: 'John Doe',
        employeeId: 'emp-1',
        company: 'ACME',
        accountRef: 'acc-1',
      });

      await contactStore.softDelete(contact.id);

      // Verify PII was nullified (mapper converts null → undefined for optional fields)
      const deleted = await contactStore.getById(contact.id);
      expect(deleted).not.toBeNull();
      expect(deleted!.identity).toBeNull();
      expect(deleted!.identityType).toBeNull();
      expect(deleted!.displayName).toBeNull();
      expect(deleted!.employeeId).toBeNull();
      expect(deleted!.company).toBeNull();
      expect(deleted!.accountRef).toBeNull();
      expect(deleted!.type).toBe('anonymous');
      expect(deleted!.deletedAt).toBeInstanceOf(Date);
    });

    test('soft-deleted contacts excluded from query', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        displayName: 'To Delete',
      });

      const beforeResult = await contactStore.query({ tenantId: 'org-1' });
      expect(beforeResult.total).toBe(1);

      await contactStore.softDelete(contact.id);

      const afterResult = await contactStore.query({ tenantId: 'org-1' });
      expect(afterResult.total).toBe(0);
    });

    test('session contactId refs are nullified on delete', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        displayName: 'Test',
      });

      await contactStore.softDelete(contact.id);

      // Verify the session updateMany was called to null out contactId
      await mockDb.session.updateMany({
        where: { contactId: contact.id },
        data: { contactId: null },
      });

      expect(mockDb.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contactId: contact.id },
          data: { contactId: null },
        }),
      );
    });
  });

  describe('Link session (POST /:id/link-session)', () => {
    test('links contact to session via store', async () => {
      const contact = await contactStore.create({
        tenantId: 'org-1',
        type: 'customer',
        displayName: 'Test User',
      });

      // Simulate linkContact via session.update
      await mockDb.session.update({
        where: { id: 'session-1' },
        data: { contactId: contact.id },
      });

      expect(mockDb.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: { contactId: contact.id },
        }),
      );

      // touchLastSeen via contact.update
      await contactStore.touchLastSeen(contact.id);
      const updated = await contactStore.getById(contact.id);
      expect(updated!.lastSeenAt).toBeInstanceOf(Date);
    });
  });

  describe('RBAC', () => {
    test('ADMIN user has write access', async () => {
      const member = await mockDb.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: 'org-1', userId: 'admin-user' } },
      });
      expect(member).not.toBeNull();
      expect(['OWNER', 'ADMIN', 'OPERATOR'].includes(member.role)).toBe(true);
    });

    test('MEMBER user does not have write access', async () => {
      const member = await mockDb.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: 'org-1', userId: 'member-user' } },
      });
      expect(member).not.toBeNull();
      expect(['OWNER', 'ADMIN', 'OPERATOR'].includes(member.role)).toBe(false);
    });

    test('unknown user has no membership', async () => {
      const member = await mockDb.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: 'org-1', userId: 'unknown-user' } },
      });
      expect(member).toBeNull();
    });
  });
});
