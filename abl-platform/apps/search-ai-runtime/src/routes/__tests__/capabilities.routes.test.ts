import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Mock Dependencies ───────────────────────────────────────────────────

const mockListCapabilities = vi.fn();
const mockGetCapabilityById = vi.fn();
const mockCreateCapability = vi.fn();
const mockUpdateCapability = vi.fn();
const mockToggleCapability = vi.fn();
const mockDeleteCapability = vi.fn();

vi.mock('../../services/capability/capability.service.js', () => ({
  CapabilityService: vi.fn().mockImplementation(function () {
    return {
      listCapabilities: mockListCapabilities,
      getCapabilityById: mockGetCapabilityById,
      createCapability: mockCreateCapability,
      updateCapability: mockUpdateCapability,
      toggleCapability: mockToggleCapability,
      deleteCapability: mockDeleteCapability,
    };
  }),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = {
      tenantId: 'tenant_123',
      id: 'user_456',
      role: req.headers['x-test-role'] || 'user',
    };
    req.tenantContext = { tenantId: 'tenant_123', userId: 'user_456' };
    next();
  },
}));

// ─── Test Setup ──────────────────────────────────────────────────────────

const mockCapability = {
  _id: 'cap_123',
  tenantId: 'tenant_123',
  name: 'count',
  type: 'aggregation',
  description: 'Count number of items',
  supportedFieldTypes: ['any'],
  triggerKeywords: ['count', 'total', 'number of'],
  examples: ['Count all bugs', 'Total number of issues'],
  enabled: true,
  metadata: {
    version: 1,
    createdBy: 'system',
  },
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Capability Management Routes', () => {
  let app: Express;

  beforeEach(async () => {
    mockListCapabilities.mockReset();
    mockGetCapabilityById.mockReset();
    mockCreateCapability.mockReset();
    mockUpdateCapability.mockReset();
    mockToggleCapability.mockReset();
    mockDeleteCapability.mockReset();
    vi.resetModules();

    const { default: capabilitiesRoutes } = await import('../capabilities.routes.js');
    app = express();
    app.use(express.json());
    app.use(capabilitiesRoutes);
  });

  describe('API-11: GET /capabilities', () => {
    it('lists all capabilities', async () => {
      mockListCapabilities.mockResolvedValue([mockCapability]);

      const response = await request(app).get('/capabilities').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capabilities).toHaveLength(1);
      expect(response.body.data.capabilities[0].name).toBe('count');
      expect(response.body.data.total).toBe(1);
      expect(mockListCapabilities).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        type: undefined,
        enabled: undefined,
      });
    });

    it('filters by type', async () => {
      mockListCapabilities.mockResolvedValue([mockCapability]);

      const response = await request(app).get('/capabilities?type=aggregation').expect(200);

      expect(response.body.success).toBe(true);
      expect(mockListCapabilities).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        type: 'aggregation',
        enabled: undefined,
      });
    });

    it('filters by enabled status', async () => {
      mockListCapabilities.mockResolvedValue([mockCapability]);

      const response = await request(app).get('/capabilities?enabled=true').expect(200);

      expect(response.body.success).toBe(true);
      expect(mockListCapabilities).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        type: undefined,
        enabled: true,
      });
    });

    it('returns empty array when no capabilities', async () => {
      mockListCapabilities.mockResolvedValue([]);

      const response = await request(app).get('/capabilities').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capabilities).toHaveLength(0);
      expect(response.body.data.total).toBe(0);
    });
  });

  describe('API-12: GET /capabilities/:capabilityId', () => {
    it('returns capability by ID', async () => {
      mockGetCapabilityById.mockResolvedValue(mockCapability);

      const response = await request(app).get('/capabilities/cap_123').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capability.name).toBe('count');
      expect(mockGetCapabilityById).toHaveBeenCalledWith('tenant_123', 'cap_123');
    });

    it('returns 404 when capability not found', async () => {
      mockGetCapabilityById.mockResolvedValue(null);

      const response = await request(app).get('/capabilities/nonexistent').expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('CAPABILITY_NOT_FOUND');
    });
  });

  describe('API-13: POST /capabilities', () => {
    it('creates capability as admin', async () => {
      mockCreateCapability.mockResolvedValue(mockCapability);

      const newCapability = {
        name: 'sum',
        type: 'aggregation',
        description: 'Sum numeric values',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['sum', 'total'],
        examples: ['Sum all amounts'],
      };

      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'admin')
        .send(newCapability)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capability.name).toBe('count');
      expect(response.body.data.message).toContain('created successfully');
      expect(mockCreateCapability).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        ...newCapability,
        createdBy: 'admin',
      });
    });

    it('rejects non-admin users', async () => {
      const response = await request(app)
        .post('/capabilities')
        .send({
          name: 'sum',
          type: 'aggregation',
          description: 'Sum numeric values',
          supportedFieldTypes: ['number'],
          triggerKeywords: ['sum'],
          examples: ['Sum all amounts'],
        })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message).toBe('Admin role required');
    });

    it('validates required fields', async () => {
      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'admin')
        .send({
          name: 'sum',
          // Missing required fields
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toBeDefined();
    });

    it('validates name length', async () => {
      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'admin')
        .send({
          name: '', // Empty name
          type: 'aggregation',
          description: 'Test',
          supportedFieldTypes: ['any'],
          triggerKeywords: ['test'],
          examples: ['Test example'],
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('validates triggerKeywords count', async () => {
      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'admin')
        .send({
          name: 'test',
          type: 'aggregation',
          description: 'Test',
          supportedFieldTypes: ['any'],
          triggerKeywords: Array(21).fill('keyword'), // Too many keywords
          examples: ['Test example'],
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('handles duplicate name error', async () => {
      mockCreateCapability.mockRejectedValue(
        new Error('Capability with name "count" already exists for tenant'),
      );

      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'admin')
        .send({
          name: 'count',
          type: 'aggregation',
          description: 'Test',
          supportedFieldTypes: ['any'],
          triggerKeywords: ['test'],
          examples: ['Test example'],
        })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('DUPLICATE_NAME');
    });
  });

  describe('API-14: PUT /capabilities/:capabilityId', () => {
    it('updates capability as admin', async () => {
      const updated = { ...mockCapability, description: 'Updated description' };
      mockUpdateCapability.mockResolvedValue(updated);

      const response = await request(app)
        .put('/capabilities/cap_123')
        .set('x-test-role', 'admin')
        .send({ description: 'Updated description' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capability.description).toBe('Updated description');
      expect(response.body.data.message).toContain('updated successfully');
      expect(mockUpdateCapability).toHaveBeenCalledWith('tenant_123', 'cap_123', {
        description: 'Updated description',
      });
    });

    it('rejects non-admin users', async () => {
      const response = await request(app)
        .put('/capabilities/cap_123')
        .send({ description: 'Updated' })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 when capability not found', async () => {
      mockUpdateCapability.mockResolvedValue(null);

      const response = await request(app)
        .put('/capabilities/nonexistent')
        .set('x-test-role', 'admin')
        .send({ description: 'Updated' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('CAPABILITY_NOT_FOUND');
    });

    it('validates update fields', async () => {
      const response = await request(app)
        .put('/capabilities/cap_123')
        .set('x-test-role', 'admin')
        .send({ description: '' }) // Empty description
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('API-15: POST /capabilities/:capabilityId/toggle', () => {
    it('toggles capability as admin', async () => {
      const toggled = { ...mockCapability, enabled: false };
      mockToggleCapability.mockResolvedValue(toggled);

      const response = await request(app)
        .post('/capabilities/cap_123/toggle')
        .set('x-test-role', 'admin')
        .send({ enabled: false })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.capability.enabled).toBe(false);
      expect(response.body.data.message).toContain('disabled successfully');
      expect(mockToggleCapability).toHaveBeenCalledWith('tenant_123', 'cap_123', false);
    });

    it('rejects non-admin users', async () => {
      const response = await request(app)
        .post('/capabilities/cap_123/toggle')
        .send({ enabled: false })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('validates enabled field is boolean', async () => {
      const response = await request(app)
        .post('/capabilities/cap_123/toggle')
        .set('x-test-role', 'admin')
        .send({ enabled: 'true' }) // String instead of boolean
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('must be a boolean');
    });

    it('returns 404 when capability not found', async () => {
      mockToggleCapability.mockResolvedValue(null);

      const response = await request(app)
        .post('/capabilities/nonexistent/toggle')
        .set('x-test-role', 'admin')
        .send({ enabled: false })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('CAPABILITY_NOT_FOUND');
    });
  });

  describe('API-16: DELETE /capabilities/:capabilityId', () => {
    it('deletes capability as admin', async () => {
      mockDeleteCapability.mockResolvedValue(true);

      const response = await request(app)
        .delete('/capabilities/cap_123')
        .set('x-test-role', 'admin')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.deleted).toBe(true);
      expect(response.body.data.message).toContain('deleted successfully');
      expect(mockDeleteCapability).toHaveBeenCalledWith('tenant_123', 'cap_123');
    });

    it('rejects non-admin users', async () => {
      const response = await request(app).delete('/capabilities/cap_123').expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 when capability not found', async () => {
      mockDeleteCapability.mockResolvedValue(false);

      const response = await request(app)
        .delete('/capabilities/nonexistent')
        .set('x-test-role', 'admin')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('CAPABILITY_NOT_FOUND');
    });
  });

  describe('Admin Role Authorization', () => {
    it('allows owner role for admin operations', async () => {
      mockCreateCapability.mockResolvedValue(mockCapability);

      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'owner')
        .send({
          name: 'test',
          type: 'aggregation',
          description: 'Test',
          supportedFieldTypes: ['any'],
          triggerKeywords: ['test'],
          examples: ['Test example'],
        })
        .expect(201);

      expect(response.body.success).toBe(true);
    });

    it('rejects user role for admin operations', async () => {
      const response = await request(app)
        .post('/capabilities')
        .set('x-test-role', 'user')
        .send({
          name: 'test',
          type: 'aggregation',
          description: 'Test',
          supportedFieldTypes: ['any'],
          triggerKeywords: ['test'],
          examples: ['Test example'],
        })
        .expect(403);

      expect(response.body.success).toBe(false);
    });
  });
});
