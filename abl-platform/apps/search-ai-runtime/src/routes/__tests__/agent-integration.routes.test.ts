import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ─── Mock Dependencies ───────────────────────────────────────────────────

const { mockDomainVocabulary, mockCanonicalSchema, mockSearchIndex } = vi.hoisted(() => ({
  mockDomainVocabulary: { findOne: vi.fn() },
  mockCanonicalSchema: { findOne: vi.fn() },
  mockSearchIndex: { findOne: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'DomainVocabulary') return mockDomainVocabulary;
    if (name === 'CanonicalSchema') return mockCanonicalSchema;
    if (name === 'SearchIndex') return mockSearchIndex;
    return {};
  },
}));

import agentIntegrationRoutes from '../agent-integration.routes.js';

const DomainVocabulary = mockDomainVocabulary;
const CanonicalSchema = mockCanonicalSchema;

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { tenantId: 'tenant_123', id: 'user_456' };
    req.tenantContext = { tenantId: 'tenant_123', userId: 'user_456' };
    next();
  },
}));

// ─── Test Setup ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(agentIntegrationRoutes);

const mockVocabulary = {
  _id: 'vocab_123',
  tenantId: 'tenant_123',
  projectKnowledgeBaseId: 'kb_789',
  version: 2,
  status: 'active',
  entries: [
    {
      id: 'entry_1',
      term: 'priority',
      aliases: ['pri', 'urgency'],
      description: 'Priority level',
      fieldRef: 'issue_priority',
      capabilities: {
        canFilter: true,
        canDisplay: true,
        canAggregate: true,
        canSort: true,
      },
      relatedFields: {
        displayWith: ['summary', 'assignee'],
        aggregateWith: ['status'],
      },
      enabled: true,
    },
    {
      id: 'entry_2',
      term: 'status',
      aliases: [],
      description: 'Issue status',
      fieldRef: 'issue_status',
      capabilities: {
        canFilter: true,
        canDisplay: true,
        canAggregate: false,
        canSort: false,
      },
      relatedFields: {
        displayWith: [],
        aggregateWith: [],
      },
      enabled: false, // Disabled
    },
  ],
  updatedAt: new Date('2026-03-01'),
};

const mockSchema = {
  _id: 'schema_456',
  tenantId: 'tenant_123',
  projectKnowledgeBaseId: 'kb_789',
  fields: [
    {
      name: 'issue_priority',
      label: 'Priority',
      type: 'string',
      filterable: true,
      aggregatable: true,
      sortable: true,
      displayable: true,
      allowedValues: ['P0', 'P1', 'P2', 'P3'],
      description: 'Priority level',
    },
    {
      name: 'issue_status',
      label: 'Status',
      type: 'string',
      filterable: true,
      aggregatable: false,
      sortable: false,
      displayable: true,
      allowedValues: ['Open', 'In Progress', 'Closed'],
      description: 'Issue status',
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Agent Integration Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockSearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'kb_789',
        tenantId: 'tenant_123',
        projectId: 'proj_1',
      }),
    } as any);
  });

  describe('API-7: GET /projects/:projectId/kb/:kbId/query-types', () => {
    it('returns query type examples for default connector', async () => {
      const response = await request(app).get('/projects/proj_1/kb/kb_789/query-types').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.queryTypes).toBeDefined();
      expect(response.body.data.queryTypes.structured).toBeDefined();
      expect(response.body.data.queryTypes.semantic).toBeDefined();
      expect(response.body.data.queryTypes.hybrid).toBeDefined();
      expect(response.body.data.queryTypes.aggregation).toBeDefined();
      expect(response.body.data.metadata.connectorType).toBe('generic');
    });

    it('returns query type examples for specific connector', async () => {
      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/query-types?connectorType=jira')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.metadata.connectorType).toBe('jira');
      expect(response.body.data.queryTypes.structured.examples.length).toBeGreaterThan(0);
    });

    it('includes generic examples when requested', async () => {
      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/query-types?connectorType=jira&includeGeneric=true')
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should have more examples when generic is included
      expect(response.body.data.queryTypes.structured.examples.length).toBeGreaterThan(3);
    });

    it('includes correct structure for structured examples', async () => {
      const response = await request(app).get('/projects/proj_1/kb/kb_789/query-types').expect(200);

      const structuredExample = response.body.data.queryTypes.structured.examples[0];
      expect(structuredExample).toHaveProperty('query');
      expect(structuredExample).toHaveProperty('reasoning');
      expect(structuredExample).toHaveProperty('confidence');
      expect(structuredExample.confidence).toBeGreaterThan(0);
      expect(structuredExample.confidence).toBeLessThanOrEqual(1);
    });

    it('sets cache headers for 1 hour', async () => {
      const response = await request(app).get('/projects/proj_1/kb/kb_789/query-types').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('rejects query examples when kb does not belong to the route project', async () => {
      vi.mocked(mockSearchIndex.findOne).mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      const response = await request(app)
        .get('/projects/proj_other/kb/kb_789/query-types')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(mockSearchIndex.findOne).toHaveBeenCalledWith({
        _id: 'kb_789',
        tenantId: 'tenant_123',
        projectId: 'proj_other',
      });
    });
  });

  describe('API-8: GET /projects/:projectId/kb/:kbId/vocabulary-context', () => {
    it('returns vocabulary context with defaults', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);
      vi.mocked(CanonicalSchema.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSchema),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.vocabulary).toHaveLength(1); // Only enabled entry
      expect(response.body.data.vocabulary[0].term).toBe('priority');
      expect(response.body.data.schema).toBeDefined();
      expect(response.body.data.capabilities).toBeDefined();
    });

    it('rejects vocabulary context when kb does not belong to the route project', async () => {
      vi.mocked(mockSearchIndex.findOne).mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      const response = await request(app)
        .get('/projects/proj_other/kb/kb_789/vocabulary-context')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(DomainVocabulary.findOne).not.toHaveBeenCalled();
    });

    it('filters out disabled vocabulary entries', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.body.data.vocabulary).toHaveLength(1);
      expect(response.body.data.vocabulary.every((v: any) => v.capabilities)).toBe(true);
    });

    it('excludes schema when includeSchema=false', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context?includeSchema=false')
        .expect(200);

      expect(response.body.data.vocabulary).toBeDefined();
      expect(response.body.data.schema).toBeUndefined();
    });

    it('excludes capabilities when includeCapabilities=false', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context?includeCapabilities=false')
        .expect(200);

      expect(response.body.data.vocabulary).toBeDefined();
      expect(response.body.data.capabilities).toBeUndefined();
    });

    it('includes metadata with version and timestamps', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.body.data.metadata).toBeDefined();
      expect(response.body.data.metadata.vocabularyVersion).toBe(2);
      expect(response.body.data.metadata.totalEntries).toBe(2);
      expect(response.body.data.metadata.activeEntries).toBe(1);
    });

    it('returns 404 when vocabulary not found', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VOCABULARY_NOT_FOUND');
    });

    it('sets cache headers for 5 minutes', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=300');
    });

    it('includes capabilities with all operators', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.body.data.capabilities.filterOperators).toContainEqual(
        expect.objectContaining({ name: 'equals' }),
      );
      expect(response.body.data.capabilities.filterOperators).toContainEqual(
        expect.objectContaining({ name: 'in' }),
      );
      expect(response.body.data.capabilities.filterOperators).toContainEqual(
        expect.objectContaining({ name: 'contains' }),
      );
      expect(response.body.data.capabilities.filterOperators).toContainEqual(
        expect.objectContaining({ name: 'greater_than' }),
      );
      expect(response.body.data.capabilities.filterOperators).toContainEqual(
        expect.objectContaining({ name: 'less_than' }),
      );
    });

    it('includes aggregation functions', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const response = await request(app)
        .get('/projects/proj_1/kb/kb_789/vocabulary-context')
        .expect(200);

      expect(response.body.data.capabilities.aggregationFunctions).toContainEqual(
        expect.objectContaining({ name: 'count' }),
      );
      expect(response.body.data.capabilities.aggregationFunctions).toContainEqual(
        expect.objectContaining({ name: 'sum' }),
      );
      expect(response.body.data.capabilities.aggregationFunctions).toContainEqual(
        expect.objectContaining({ name: 'avg' }),
      );
      expect(response.body.data.capabilities.aggregationFunctions).toContainEqual(
        expect.objectContaining({ name: 'min' }),
      );
      expect(response.body.data.capabilities.aggregationFunctions).toContainEqual(
        expect.objectContaining({ name: 'max' }),
      );
    });
  });
});
