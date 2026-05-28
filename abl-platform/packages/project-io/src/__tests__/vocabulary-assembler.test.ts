import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VocabularyAssembler } from '../export/layer-assemblers/vocabulary-assembler.js';

vi.mock('@agent-platform/database/models', () => ({
  KnowledgeBase: { find: vi.fn(), countDocuments: vi.fn() },
  DomainVocabulary: { find: vi.fn(), countDocuments: vi.fn() },
  LookupEntry: { find: vi.fn(), countDocuments: vi.fn() },
  CanonicalSchema: { find: vi.fn(), countDocuments: vi.fn() },
  Fact: { find: vi.fn(), countDocuments: vi.fn() },
}));

import {
  KnowledgeBase,
  DomainVocabulary,
  LookupEntry,
  CanonicalSchema,
  Fact,
} from '@agent-platform/database/models';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  return { lean: () => ({ select: () => Promise.resolve(data) }) };
}

describe('VocabularyAssembler', () => {
  let assembler: VocabularyAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new VocabularyAssembler();
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([{ _id: 'pkb-1' }]));
  });

  it('should have layer name "vocabulary"', () => {
    expect(assembler.layer).toBe('vocabulary');
  });

  it('should assemble domain vocabulary', async () => {
    (DomainVocabulary.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'vocab-1',
          tenantId: 'tenant-1',
          projectKnowledgeBaseId: 'pkb-1',
          version: 1,
          status: 'active',
          entries: [
            {
              term: 'churn',
              aliases: ['attrition'],
              description: 'Customer leaving',
              resolution: { field: 'status', value: 'churned' },
              enabled: true,
            },
          ],
        },
      ]),
    );
    (LookupEntry.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CanonicalSchema.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (Fact.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('vocabulary/domain-vocabulary.json')).toBe(true);
    const vocabJson = JSON.parse(result.files.get('vocabulary/domain-vocabulary.json')!);
    expect(vocabJson).toHaveLength(1);
    expect(vocabJson[0].entries[0].term).toBe('churn');
    expect(vocabJson[0]).not.toHaveProperty('_id');
    expect(vocabJson[0]).not.toHaveProperty('tenantId');
    expect(DomainVocabulary.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectKnowledgeBaseId: { $in: ['pkb-1'] },
    });
  });

  it('should group lookup entries by table name', async () => {
    (DomainVocabulary.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (LookupEntry.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'le-1',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          tableName: 'countries',
          value: 'United States',
          field: 'name',
          metadata: { code: 'US' },
        },
        {
          _id: 'le-2',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          tableName: 'countries',
          value: 'Canada',
          field: 'name',
          metadata: { code: 'CA' },
        },
        {
          _id: 'le-3',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          tableName: 'departments',
          value: 'Engineering',
          field: 'name',
        },
      ]),
    );
    (CanonicalSchema.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (Fact.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('vocabulary/lookup-tables/countries.lookup.json')).toBe(true);
    expect(result.files.has('vocabulary/lookup-tables/departments.lookup.json')).toBe(true);

    const countries = JSON.parse(
      result.files.get('vocabulary/lookup-tables/countries.lookup.json')!,
    );
    expect(countries).toHaveLength(2);
    expect(countries[0]).not.toHaveProperty('_id');
    expect(countries[0]).not.toHaveProperty('projectId');

    const departments = JSON.parse(
      result.files.get('vocabulary/lookup-tables/departments.lookup.json')!,
    );
    expect(departments).toHaveLength(1);
  });

  it('should export canonical schemas', async () => {
    (DomainVocabulary.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (LookupEntry.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CanonicalSchema.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'schema-1',
          tenantId: 'tenant-1',
          knowledgeBaseId: 'kb-1',
          version: 1,
          fields: [
            {
              name: 'title',
              label: 'Title',
              type: 'string',
              indexed: true,
              filterable: true,
              aggregatable: false,
            },
          ],
          status: 'active',
        },
      ]),
    );
    (Fact.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('vocabulary/schemas/kb-1.schema.json')).toBe(true);
    const schemaJson = JSON.parse(result.files.get('vocabulary/schemas/kb-1.schema.json')!);
    expect(schemaJson.fields).toHaveLength(1);
    expect(schemaJson.fields[0].name).toBe('title');
    expect(schemaJson).not.toHaveProperty('_id');
    expect(CanonicalSchema.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      knowledgeBaseId: { $in: ['pkb-1'] },
    });
  });

  it('should export project-scoped facts and strip user fields', async () => {
    (DomainVocabulary.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (LookupEntry.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CanonicalSchema.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (Fact.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'fact-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          projectId: 'proj-1',
          key: 'business_hours',
          value: '9am-5pm',
          sourceType: 'manual',
          sourceAgentName: 'Supervisor',
          sourceSessionId: 'sess-1',
          sourceTraceId: 'trace-1',
          expiresAt: null,
          metadata: null,
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('vocabulary/facts.json')).toBe(true);
    const factsJson = JSON.parse(result.files.get('vocabulary/facts.json')!);
    expect(factsJson).toHaveLength(1);
    expect(factsJson[0].key).toBe('business_hours');
    expect(factsJson[0]).not.toHaveProperty('userId');
    expect(factsJson[0]).not.toHaveProperty('sourceSessionId');
    expect(factsJson[0]).not.toHaveProperty('sourceTraceId');
    expect(factsJson[0]).not.toHaveProperty('_id');
  });

  it('should handle empty project', async () => {
    (DomainVocabulary.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (LookupEntry.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CanonicalSchema.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (Fact.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
  });

  it('should count entities correctly', async () => {
    (DomainVocabulary.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (LookupEntry.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    (CanonicalSchema.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (Fact.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(10);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(63);
    expect(DomainVocabulary.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectKnowledgeBaseId: { $in: ['pkb-1'] },
    });
    expect(CanonicalSchema.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      knowledgeBaseId: { $in: ['pkb-1'] },
    });
  });
});
