import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock DomainVocabulary Model ─────────────────────────────────────────

const { mockDomainVocabulary } = vi.hoisted(() => ({
  mockDomainVocabulary: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'DomainVocabulary') return mockDomainVocabulary;
    return {};
  },
}));

import { VocabularyService } from '../vocabulary-management/vocabulary.service.js';

const DomainVocabulary = mockDomainVocabulary;

// ─── Test Data ───────────────────────────────────────────────────────────

const mockVocabulary = {
  _id: 'vocab_123',
  tenantId: 'tenant_456',
  projectKnowledgeBaseId: 'kb_789',
  version: 1,
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
      confidence: 0.95,
      generatedBy: 'auto' as const,
      usageCount: 10,
      lastUsed: new Date('2026-03-01'),
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-03-01'),
    },
    {
      id: 'entry_2',
      term: 'status',
      aliases: ['state'],
      description: 'Issue status',
      fieldRef: 'issue_status',
      capabilities: {
        canFilter: true,
        canDisplay: true,
        canAggregate: false,
        canSort: false,
      },
      relatedFields: {
        displayWith: ['title'],
        aggregateWith: [],
      },
      enabled: false,
      confidence: 0.9,
      generatedBy: 'manual' as const,
      usageCount: 0,
      createdAt: new Date('2026-01-15'),
      updatedAt: new Date('2026-01-15'),
    },
  ],
  updatedAt: new Date('2026-03-01'),
  createdAt: new Date('2026-01-01'),
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('VocabularyService', () => {
  let service: VocabularyService;

  beforeEach(() => {
    service = new VocabularyService();
    vi.clearAllMocks();
  });

  describe('listEntries', () => {
    it('lists all active entries by default', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const result = await service.listEntries({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
      });

      expect(result.entries).toHaveLength(1); // Only enabled entry
      expect(result.entries[0].term).toBe('priority');
      expect(result.total).toBe(1);
      expect(result.vocabulary._id).toBe('vocab_123');
    });

    it('lists all entries when status=all', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const result = await service.listEntries({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        status: 'all',
      });

      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('filters by generatedBy', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const result = await service.listEntries({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        status: 'all',
        generatedBy: 'manual',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].term).toBe('status');
    });

    it('searches in term and aliases', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const result = await service.listEntries({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        status: 'all',
        search: 'urgency',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].term).toBe('priority');
    });

    it('paginates results', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockVocabulary),
      } as any);

      const result = await service.listEntries({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        status: 'all',
        limit: 1,
        offset: 1,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].term).toBe('status');
      expect(result.total).toBe(2);
      expect(result.offset).toBe(1);
    });

    it('throws error when vocabulary not found', async () => {
      vi.mocked(DomainVocabulary.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      await expect(
        service.listEntries({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
        }),
      ).rejects.toThrow('VOCABULARY_NOT_FOUND');
    });
  });

  describe('createEntry', () => {
    it('creates new entry successfully', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue(null as any); // No duplicate
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const newEntry = {
        term: 'assignee',
        aliases: ['owner'],
        description: 'Issue assignee',
        fieldRef: 'issue_assignee',
        capabilities: {
          canFilter: true,
          canDisplay: true,
          canAggregate: true,
          canSort: true,
        },
        relatedFields: {
          displayWith: ['title', 'status'],
          aggregateWith: ['priority'],
        },
        enabled: true,
        generatedBy: 'manual' as const,
      };

      const result = await service.createEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entry: newEntry,
      });

      expect(result.entryId).toMatch(/^entry_/);
      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectKnowledgeBaseId: 'kb_789',
          tenantId: 'tenant_456',
        }),
        expect.objectContaining({
          $push: expect.objectContaining({
            entries: expect.objectContaining({
              term: 'assignee',
            }),
          }),
        }),
        { new: true },
      );
    });

    it('validates term length', async () => {
      const invalidEntry = {
        term: 'a', // Too short
        aliases: [],
        fieldRef: 'field',
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
        enabled: true,
        generatedBy: 'manual' as const,
      };

      await expect(
        service.createEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entry: invalidEntry,
        }),
      ).rejects.toThrow('VALIDATION_ERROR: Term must be between 2 and 50 characters');
    });

    it('validates alias count', async () => {
      const tooManyAliases = Array(11).fill('alias');
      const invalidEntry = {
        term: 'test',
        aliases: tooManyAliases,
        fieldRef: 'field',
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
        enabled: true,
        generatedBy: 'manual' as const,
      };

      await expect(
        service.createEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entry: invalidEntry,
        }),
      ).rejects.toThrow('VALIDATION_ERROR: Maximum 10 aliases allowed');
    });

    it('validates at least one capability is enabled', async () => {
      const noCapabilities = {
        term: 'test',
        aliases: [],
        fieldRef: 'field',
        capabilities: {
          canFilter: false,
          canDisplay: false,
          canAggregate: false,
          canSort: false,
        },
        relatedFields: {
          displayWith: [],
          aggregateWith: [],
        },
        enabled: true,
        generatedBy: 'manual' as const,
      };

      await expect(
        service.createEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entry: noCapabilities,
        }),
      ).rejects.toThrow('VALIDATION_ERROR: At least one capability must be enabled');
    });

    it('detects duplicate terms', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const duplicateEntry = {
        term: 'priority', // Already exists
        aliases: [],
        fieldRef: 'field',
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
        enabled: true,
        generatedBy: 'manual' as const,
      };

      await expect(
        service.createEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entry: duplicateEntry,
        }),
      ).rejects.toThrow(/DUPLICATE_TERM/);
    });
  });

  describe('updateEntry', () => {
    it('updates entry successfully', async () => {
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      await service.updateEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entryId: 'entry_1',
        updates: {
          aliases: ['pri', 'urgency', 'importance'],
          description: 'Updated description',
        },
      });

      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectKnowledgeBaseId: 'kb_789',
          tenantId: 'tenant_456',
          'entries.id': 'entry_1',
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'entries.$.aliases': ['pri', 'urgency', 'importance'],
            'entries.$.description': 'Updated description',
          }),
        }),
        { new: true },
      );
    });

    it('throws error when entry not found', async () => {
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue(null as any);

      await expect(
        service.updateEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entryId: 'nonexistent',
          updates: { description: 'test' },
        }),
      ).rejects.toThrow('ENTRY_NOT_FOUND');
    });
  });

  describe('deleteEntry', () => {
    it('deletes entry successfully', async () => {
      const oldEntry = {
        ...mockVocabulary.entries[0],
        usageCount: 0,
        lastUsed: undefined,
      };
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
        entries: [oldEntry],
      } as any);
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({} as any);

      await service.deleteEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entryId: 'entry_1',
      });

      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectKnowledgeBaseId: 'kb_789',
          tenantId: 'tenant_456',
        }),
        expect.objectContaining({
          $pull: { entries: { id: 'entry_1' } },
        }),
      );
    });

    it('prevents deletion of recently used entry', async () => {
      const recentlyUsed = {
        ...mockVocabulary.entries[0],
        usageCount: 100,
        lastUsed: new Date(), // Just now
      };
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
        entries: [recentlyUsed],
      } as any);

      await expect(
        service.deleteEntry({
          projectKbId: 'kb_789',
          tenantId: 'tenant_456',
          entryId: 'entry_1',
        }),
      ).rejects.toThrow(/ENTRY_IN_USE/);
    });

    it('allows deletion of entry not used in 30+ days', async () => {
      const oldUsage = {
        ...mockVocabulary.entries[0],
        usageCount: 100,
        lastUsed: new Date('2026-01-01'), // More than 30 days ago
      };
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
        entries: [oldUsage],
      } as any);
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({} as any);

      await service.deleteEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entryId: 'entry_1',
      });

      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('toggleEntry', () => {
    it('enables entry', async () => {
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({} as any);

      await service.toggleEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entryId: 'entry_2',
        enabled: true,
      });

      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          'entries.id': 'entry_2',
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'entries.$.enabled': true,
          }),
        }),
        { new: true },
      );
    });

    it('disables entry', async () => {
      vi.mocked(DomainVocabulary.findOneAndUpdate).mockResolvedValue({} as any);

      await service.toggleEntry({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        entryId: 'entry_1',
        enabled: false,
      });

      expect(DomainVocabulary.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          'entries.id': 'entry_1',
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'entries.$.enabled': false,
          }),
        }),
        { new: true },
      );
    });
  });

  describe('testResolution', () => {
    it('finds matching entries by term', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const result = await service.testResolution({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        query: 'Show me priority issues',
      });

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('priority');
      expect(result.resolutions[0].matchedEntry.id).toBe('entry_1');
    });

    it('finds matching entries by alias', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const result = await service.testResolution({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        query: 'Show me urgency level',
      });

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('priority');
    });

    it('filters by entryIds when provided', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const result = await service.testResolution({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        query: 'Show me priority and status',
        entryIds: ['entry_2'], // Only status
      });

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('status');
    });

    it('returns empty resolutions when no matches', async () => {
      vi.mocked(DomainVocabulary.findOne).mockResolvedValue({
        ...mockVocabulary,
      } as any);

      const result = await service.testResolution({
        projectKbId: 'kb_789',
        tenantId: 'tenant_456',
        query: 'Show me nonexistent field',
      });

      expect(result.resolutions).toHaveLength(0);
      expect(result.suggestions).toContain('No matching vocabulary entries found');
    });
  });

  describe('cache management', () => {
    it('returns cache statistics', () => {
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.maxSize).toBe(500);
    });

    it('clears cache', () => {
      service.clearCache();

      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });
});
