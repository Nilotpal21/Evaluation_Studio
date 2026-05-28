import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { KnowledgeBase } from '../models/knowledge-base.model.js';
import { SearchIndex } from '../models/search-index.model.js';
import { SearchSource } from '../models/search-source.model.js';
import { SearchDocument } from '../models/search-document.model.js';
import { SearchChunk } from '../models/search-chunk.model.js';
import { CanonicalSchema } from '../models/canonical-schema.model.js';
import { ConnectorSchema } from '../models/connector-schema.model.js';
import { FieldMapping } from '../models/field-mapping.model.js';
import { SchemaChangeLog } from '../models/schema-change-log.model.js';
import { DomainVocabulary } from '../models/domain-vocabulary.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── KnowledgeBase Model ────────────────────────────────────────────────────

describe('KnowledgeBase', () => {
  const validKB = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Product FAQ',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const doc = new KnowledgeBase({ projectId: 'p', name: 'n' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const doc = new KnowledgeBase({ tenantId: 't', name: 'n' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const doc = new KnowledgeBase({ tenantId: 't', projectId: 'p' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid knowledge base', () => {
    const doc = new KnowledgeBase(validKB());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.name).toBe('Product FAQ');
    expect(doc.description).toBeNull();
    expect(doc.searchIndexId).toBeNull();
    expect(doc.canonicalSchemaId).toBeNull();
    expect(doc.connectorCount).toBe(0);
    expect(doc.status).toBe('creating');
    expect(doc.documentCount).toBe(0);
    expect(doc.lastIndexedAt).toBeNull();
    expect(doc.indexError).toBeNull();
    expect(doc.isPublic).toBe(false);
    expect(doc.metadata).toBeNull();
    expect(doc._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId+projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await KnowledgeBase.create(validKB());
    await expect(KnowledgeBase.create(validKB())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── SearchIndex Model ──────────────────────────────────────────────────────

describe('SearchIndex', () => {
  const validIndex = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    slug: 'product-faq',
    name: 'Product FAQ Index',
    vectorStore: {
      provider: 'qdrant',
      collectionName: 'product_faq',
    },
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validIndex();
    delete (data as any).tenantId;
    const doc = new SearchIndex(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validIndex();
    delete (data as any).projectId;
    const doc = new SearchIndex(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires slug', () => {
    const data = validIndex();
    delete (data as any).slug;
    const doc = new SearchIndex(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slug).toBeDefined();
  });

  it('requires name', () => {
    const data = validIndex();
    delete (data as any).name;
    const doc = new SearchIndex(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires vectorStore', () => {
    const data = validIndex();
    delete (data as any).vectorStore;
    const doc = new SearchIndex(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.vectorStore).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid search index', () => {
    const doc = new SearchIndex(validIndex());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.slug).toBe('product-faq');
    expect(doc.name).toBe('Product FAQ Index');
    expect(doc.embeddingModel).toBe('text-embedding-3-small');
    expect(doc.embeddingDimensions).toBe(1536);
    expect(doc.vectorStore.provider).toBe('qdrant');
    expect(doc.vectorStore.collectionName).toBe('product_faq');
    expect(doc.searchDefaults.topK).toBe(10);
    expect(doc.searchDefaults.similarityThreshold).toBe(0.2);
    expect(doc.searchDefaults.includeMetadata).toBe(true);
    expect(doc.searchDefaults.includeContent).toBe(true);
    expect(doc.llmConfig).toBeNull();
    expect(doc.status).toBe('creating');
    expect(doc.documentCount).toBe(0);
    expect(doc.chunkCount).toBe(0);
    expect(doc.sourceCount).toBe(0);
    expect(doc.lastIndexedAt).toBeNull();
    expect(doc.indexError).toBeNull();
    expect(doc._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique tenantId+projectId+slug', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await SearchIndex.create(validIndex());
    await expect(SearchIndex.create(validIndex())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── SearchSource Model ─────────────────────────────────────────────────────

describe('SearchSource', () => {
  const validSource = () => ({
    tenantId: 'tenant-1',
    indexId: 'index-1',
    name: 'Zendesk Articles',
    sourceType: 'zendesk',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const doc = new SearchSource({ indexId: 'i', name: 'n', sourceType: 's' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires indexId', () => {
    const doc = new SearchSource({ tenantId: 't', name: 'n', sourceType: 's' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.indexId).toBeDefined();
  });

  it('requires name', () => {
    const doc = new SearchSource({ tenantId: 't', indexId: 'i', sourceType: 's' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires sourceType', () => {
    const doc = new SearchSource({ tenantId: 't', indexId: 'i', name: 'n' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceType).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid search source', () => {
    const doc = new SearchSource(validSource());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.indexId).toBe('index-1');
    expect(doc.name).toBe('Zendesk Articles');
    expect(doc.sourceType).toBe('zendesk');
    expect(doc.sourceConfig).toBeNull();
    expect(doc.status).toBe('pending');
    expect(doc.extractionConfig).toBeNull();
    expect(doc.enrichmentConfig).toBeNull();
    expect(doc.syncSchedule).toBeNull();
    expect(doc.documentCount).toBe(0);
    expect(doc.lastSyncAt).toBeNull();
    expect(doc.syncError).toBeNull();
    expect(doc._v).toBe(1);
  });
});

// ─── SearchDocument Model ───────────────────────────────────────────────────

describe('SearchDocument', () => {
  const validDoc = () => ({
    tenantId: 'tenant-1',
    indexId: 'index-1',
    sourceId: 'source-1',
    contentHash: 'sha256-abc123',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validDoc();
    delete (data as any).tenantId;
    const doc = new SearchDocument(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires indexId', () => {
    const data = validDoc();
    delete (data as any).indexId;
    const doc = new SearchDocument(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.indexId).toBeDefined();
  });

  it('requires sourceId', () => {
    const data = validDoc();
    delete (data as any).sourceId;
    const doc = new SearchDocument(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceId).toBeDefined();
  });

  it('requires contentHash', () => {
    const data = validDoc();
    delete (data as any).contentHash;
    const doc = new SearchDocument(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.contentHash).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid search document', () => {
    const doc = new SearchDocument(validDoc());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.indexId).toBe('index-1');
    expect(doc.sourceId).toBe('source-1');
    expect(doc.contentHash).toBe('sha256-abc123');
    expect(doc.originalReference).toBeNull();
    expect(doc.contentType).toBeNull();
    expect(doc.contentSizeBytes).toBe(0);
    expect(doc.extractedText).toBeNull();
    expect(doc.language).toBeNull();
    expect(doc.entities).toEqual([]);
    expect(doc.textPreview).toBeNull();
    expect(doc.sourceMetadata).toBeNull();
    expect(doc.status).toBe('pending');
    expect(doc.processingError).toBeNull();
    expect(doc.chunkCount).toBe(0);
    expect(doc._v).toBe(1);
  });

  it('stores entity subdocuments in-memory', () => {
    const doc = new SearchDocument({
      ...validDoc(),
      contentHash: 'unique-hash',
      entities: [{ type: 'person', value: 'John Doe', confidence: 0.95 }],
    });
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('person');
    expect(doc.entities[0].value).toBe('John Doe');
    expect(doc.entities[0].confidence).toBe(0.95);
  });

  // --- DB-dependent tests ---

  it('enforces unique indexId+contentHash', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await SearchDocument.create(validDoc());
    await expect(SearchDocument.create(validDoc())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── SearchChunk Model ──────────────────────────────────────────────────────

describe('SearchChunk', () => {
  const validChunk = () => ({
    tenantId: 'tenant-1',
    indexId: 'index-1',
    documentId: 'doc-1',
    content: 'This is a chunk of text from the document.',
    chunkIndex: 0,
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validChunk();
    delete (data as any).tenantId;
    const doc = new SearchChunk(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires indexId', () => {
    const data = validChunk();
    delete (data as any).indexId;
    const doc = new SearchChunk(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.indexId).toBeDefined();
  });

  it('requires documentId', () => {
    const data = validChunk();
    delete (data as any).documentId;
    const doc = new SearchChunk(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.documentId).toBeDefined();
  });

  it('requires content', () => {
    const data = validChunk();
    delete (data as any).content;
    const doc = new SearchChunk(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.content).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid search chunk', () => {
    const doc = new SearchChunk(validChunk());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.indexId).toBe('index-1');
    expect(doc.documentId).toBe('doc-1');
    expect(doc.pipelineId).toBeNull();
    expect(doc.content).toBe('This is a chunk of text from the document.');
    expect(doc.tokenCount).toBe(0);
    expect(doc.chunkIndex).toBe(0);
    expect(doc.vectorId).toBeNull();
    expect(doc.metadata).toBeNull();
    expect(doc.canonicalMetadata).toBeNull();
    expect(doc.status).toBe('pending');
    expect(doc._v).toBe(1);
  });

  it('accepts pipelineId when provided', () => {
    const doc = new SearchChunk({ ...validChunk(), pipelineId: 'pipeline-1' });
    expect(doc.pipelineId).toBe('pipeline-1');
  });

  it('defaults pipelineId to null when not provided', () => {
    const doc = new SearchChunk(validChunk());
    expect(doc.pipelineId).toBeNull();
  });
});

// ─── CanonicalSchema Model ──────────────────────────────────────────────────

describe('CanonicalSchema', () => {
  const validSchema = () => ({
    tenantId: 'tenant-1',
    knowledgeBaseId: 'kb-1',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const doc = new CanonicalSchema({ knowledgeBaseId: 'kb' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires knowledgeBaseId', () => {
    const doc = new CanonicalSchema({ tenantId: 't' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.knowledgeBaseId).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid canonical schema', () => {
    const doc = new CanonicalSchema(validSchema());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.knowledgeBaseId).toBe('kb-1');
    expect(doc.version).toBe(1);
    expect(doc.fields).toEqual([]);
    expect(doc.status).toBe('draft');
    expect(doc._v).toBe(1);
  });

  it('stores canonical fields in-memory', () => {
    const doc = new CanonicalSchema({
      ...validSchema(),
      knowledgeBaseId: 'kb-2',
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
    });
    expect(doc.fields).toHaveLength(1);
    expect(doc.fields[0].name).toBe('title');
    expect(doc.fields[0].indexed).toBe(true);
  });

  // --- DB-dependent tests ---

  it('enforces unique knowledgeBaseId+version', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await CanonicalSchema.create(validSchema());
    await expect(CanonicalSchema.create(validSchema())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ConnectorSchema Model ──────────────────────────────────────────────────

describe('ConnectorSchema', () => {
  const validConnectorSchema = () => ({
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const doc = new ConnectorSchema({ connectorId: 'c' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires connectorId', () => {
    const doc = new ConnectorSchema({ tenantId: 't' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.connectorId).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid connector schema', () => {
    const doc = new ConnectorSchema(validConnectorSchema());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.connectorId).toBe('conn-1');
    expect(doc.version).toBe(1);
    expect(doc.fields).toEqual([]);
    expect(doc.fieldCount).toBe(0);
    expect(doc.customFieldCount).toBe(0);
    expect(doc.status).toBe('draft');
    expect(doc.discoveredAt).toBeInstanceOf(Date);
    expect(doc._v).toBe(1);
  });

  it('stores connector schema fields in-memory', () => {
    const doc = new ConnectorSchema({
      ...validConnectorSchema(),
      connectorId: 'conn-2',
      fields: [
        {
          path: 'ticket.subject',
          label: 'Subject',
          type: 'string',
          isCustom: false,
          isRequired: true,
        },
      ],
    });
    expect(doc.fields).toHaveLength(1);
    expect(doc.fields[0].path).toBe('ticket.subject');
    expect(doc.fields[0].isRequired).toBe(true);
  });

  // --- DB-dependent tests ---

  it('enforces unique connectorId+version', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorSchema.create(validConnectorSchema());
    await expect(ConnectorSchema.create(validConnectorSchema())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── FieldMapping Model ─────────────────────────────────────────────────────

describe('FieldMapping', () => {
  const validMapping = () => ({
    tenantId: 'tenant-1',
    canonicalSchemaId: 'cs-1',
    canonicalField: 'title',
    connectorId: 'conn-1',
    sourcePath: 'ticket.subject',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validMapping();
    delete (data as any).tenantId;
    const doc = new FieldMapping(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires canonicalSchemaId', () => {
    const data = validMapping();
    delete (data as any).canonicalSchemaId;
    const doc = new FieldMapping(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.canonicalSchemaId).toBeDefined();
  });

  it('requires canonicalField', () => {
    const data = validMapping();
    delete (data as any).canonicalField;
    const doc = new FieldMapping(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.canonicalField).toBeDefined();
  });

  it('requires connectorId', () => {
    const data = validMapping();
    delete (data as any).connectorId;
    const doc = new FieldMapping(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.connectorId).toBeDefined();
  });

  it('requires sourcePath', () => {
    const data = validMapping();
    delete (data as any).sourcePath;
    const doc = new FieldMapping(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourcePath).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid field mapping', () => {
    const doc = new FieldMapping(validMapping());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.canonicalSchemaId).toBe('cs-1');
    expect(doc.canonicalField).toBe('title');
    expect(doc.connectorId).toBe('conn-1');
    expect(doc.sourcePath).toBe('ticket.subject');
    expect(doc.transform.type).toBe('direct');
    expect(doc.confidence).toBe(0);
    expect(doc.status).toBe('suggested');
    expect(doc.suggestedBy).toBe('user');
    expect(doc.reviewedBy).toBeNull();
    expect(doc.reviewedAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  // --- DB-dependent tests ---

  it('enforces unique canonicalSchemaId+canonicalField+connectorId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await FieldMapping.create(validMapping());
    await expect(FieldMapping.create(validMapping())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── SchemaChangeLog Model ──────────────────────────────────────────────────

describe('SchemaChangeLog', () => {
  const validLog = () => ({
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    schemaVersion: 2,
    changeType: 'field_added',
    fieldPath: 'ticket.priority',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const data = validLog();
    delete (data as any).tenantId;
    const doc = new SchemaChangeLog(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires connectorId', () => {
    const data = validLog();
    delete (data as any).connectorId;
    const doc = new SchemaChangeLog(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.connectorId).toBeDefined();
  });

  it('requires schemaVersion', () => {
    const data = validLog();
    delete (data as any).schemaVersion;
    const doc = new SchemaChangeLog(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.schemaVersion).toBeDefined();
  });

  it('requires changeType', () => {
    const data = validLog();
    delete (data as any).changeType;
    const doc = new SchemaChangeLog(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.changeType).toBeDefined();
  });

  it('requires fieldPath', () => {
    const data = validLog();
    delete (data as any).fieldPath;
    const doc = new SchemaChangeLog(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.fieldPath).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid schema change log', () => {
    const doc = new SchemaChangeLog(validLog());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.connectorId).toBe('conn-1');
    expect(doc.schemaVersion).toBe(2);
    expect(doc.changeType).toBe('field_added');
    expect(doc.fieldPath).toBe('ticket.priority');
    expect(doc.previousValue).toBeNull();
    expect(doc.newValue).toBeNull();
    expect(doc.reviewStatus).toBe('pending');
    expect(doc.affectsMapping).toBe(false);
    expect(doc._v).toBe(1);
  });
});

// ─── DomainVocabulary Model ─────────────────────────────────────────────────

describe('DomainVocabulary', () => {
  const validVocab = () => ({
    tenantId: 'tenant-1',
    projectKnowledgeBaseId: 'pkb-1',
  });

  // --- Validation tests (no DB needed) ---

  it('requires tenantId', () => {
    const doc = new DomainVocabulary({ projectKnowledgeBaseId: 'pkb' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectKnowledgeBaseId', () => {
    const doc = new DomainVocabulary({ tenantId: 't' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectKnowledgeBaseId).toBeDefined();
  });

  // --- Default value tests (no DB needed) ---

  it('sets default fields on a valid domain vocabulary', () => {
    const doc = new DomainVocabulary(validVocab());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectKnowledgeBaseId).toBe('pkb-1');
    expect(doc.version).toBe(1);
    expect(doc.status).toBe('draft');
    expect(doc.entries).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('stores vocabulary entries in-memory', () => {
    const doc = new DomainVocabulary({
      ...validVocab(),
      projectKnowledgeBaseId: 'pkb-2',
      entries: [
        {
          term: 'open tickets',
          aliases: ['active tickets', 'pending tickets'],
          description: 'Tickets not yet resolved',
          resolution: { type: 'filter', field: 'status', value: 'open' },
          enabled: true,
        },
      ],
    });
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].term).toBe('open tickets');
    expect(doc.entries[0].aliases).toEqual(['active tickets', 'pending tickets']);
    expect(doc.entries[0].enabled).toBe(true);
  });

  // --- DB-dependent tests ---

  it('enforces unique projectKnowledgeBaseId+version', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DomainVocabulary.create(validVocab());
    await expect(DomainVocabulary.create(validVocab())).rejects.toThrow(/duplicate key/i);
  });
});
