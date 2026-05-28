/**
 * Enrichment Worker Tests
 *
 * Unit tests for enrichment worker status transitions.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';

// Mock database layer (workers use getLazyModel from db/index.js)
const mockSearchDocument = {
  findOne: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findOneAndUpdate: vi.fn(),
};
const mockSearchChunk = {
  find: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateMany: vi.fn(),
};
vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'SearchDocument') return mockSearchDocument;
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  }),
}));

// Mock database context
vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((context: any, callback: any) => callback()),
}));

// Mock shared functions
vi.mock('../shared.js', () => ({
  createQueue: vi.fn(() => ({
    add: vi.fn(),
    close: vi.fn(),
  })),
  createWorkerOptions: vi.fn(),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
  withTraceContext: vi.fn((_data: unknown, fn: () => Promise<unknown>) => fn()),
}));

// Mock status logger
vi.mock('../status-logger.js', () => ({
  logStatusTransition: vi.fn(),
}));

// Mock config and LLM config resolver
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeGraph: { enabled: false },
    multiModal: { enabled: false },
    treeBuilder: { enabled: false },
  })),
}));

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn(() => ({
    useCases: {
      questionSynthesis: { enabled: false },
      scopeClassification: { enabled: false },
    },
  })),
}));

import { logStatusTransition } from '../status-logger.js';

// Reference the mocks for assertions
const SearchDocument = mockSearchDocument;
const SearchChunk = mockSearchChunk;

describe('Enrichment Worker - Status Transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should set status to ENRICHING when starting enrichment', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      createdAt: new Date(Date.now() - 5000),
    };

    const mockChunks = [
      {
        _id: 'chunk-1',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content 1',
        canonicalMetadata: {},
      },
      {
        _id: 'chunk-2',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content 2',
        canonicalMetadata: {},
      },
    ];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchChunk.find as any).mockResolvedValue(mockChunks);
    (SearchChunk.findOneAndUpdate as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processEnrichmentJob } = await import('../enrichment-worker.js');

    await processEnrichmentJob({
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        chunkIds: ['chunk-1', 'chunk-2'],
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    } as any);

    // logStatusTransition is called for ENRICHING (not persisted to DB)
    const transitionCalls = (logStatusTransition as any).mock.calls;
    const enrichingCall = transitionCalls.find((c: any) => c[0]?.toStatus === 'ENRICHING');
    expect(enrichingCall).toBeDefined();
    expect(enrichingCall[0].fromStatus).toBe(DocumentStatus.EXTRACTED);

    // findOneAndUpdate is called for ENRICHED (persisted to DB)
    const updateCalls = (SearchDocument.findOneAndUpdate as any).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[1].status).toBe(DocumentStatus.ENRICHED);
  });

  test('should log status transition to ENRICHING', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      createdAt: new Date(Date.now() - 5000),
    };
    const mockChunks = [
      {
        _id: 'chunk-1',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content',
        canonicalMetadata: {},
      },
    ];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchChunk.find as any).mockResolvedValue(mockChunks);
    (SearchChunk.findOneAndUpdate as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processEnrichmentJob } = await import('../enrichment-worker.js');

    await processEnrichmentJob({
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        chunkIds: ['chunk-1'],
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    } as any);

    const transitionCalls = (logStatusTransition as any).mock.calls;
    expect(transitionCalls.length).toBeGreaterThanOrEqual(2);

    // ENRICHING transition (logged, not persisted)
    const enrichingCall = transitionCalls.find((c: any) => c[0]?.toStatus === 'ENRICHING');
    expect(enrichingCall).toBeDefined();
    expect(enrichingCall[0].worker).toBe('enrichment');
    expect(enrichingCall[0].documentId).toBe('doc-123');

    // ENRICHED transition (logged + persisted)
    const enrichedCall = transitionCalls.find(
      (c: any) => c[0]?.toStatus === DocumentStatus.ENRICHED,
    );
    expect(enrichedCall).toBeDefined();
    expect(enrichedCall[0].worker).toBe('enrichment');
  });

  test('should set status to ENRICHED when enrichment completes', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      createdAt: new Date(Date.now() - 5000),
    };
    const mockChunks = [
      {
        _id: 'chunk-1',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content',
        canonicalMetadata: {},
      },
    ];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchChunk.find as any).mockResolvedValue(mockChunks);
    (SearchChunk.findOneAndUpdate as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processEnrichmentJob } = await import('../enrichment-worker.js');

    await processEnrichmentJob({
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        chunkIds: ['chunk-1'],
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    } as any);

    const updateCalls = (SearchDocument.findOneAndUpdate as any).mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[1].status).toBe(DocumentStatus.ENRICHED);
    // textPreview: short raw text snippet (first 500 chars of first chunk) for UI display.
    // Document LLM summary is sourced from metadata.documentSummary (page-processing-worker).
    // Document entities are extracted by kg-enrichment-worker (taxonomy-scoped).
    expect(finalUpdate[1].textPreview).toBeDefined();
  });

  test('should include enrichment metadata in status transition log', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      createdAt: new Date(Date.now() - 5000),
    };
    const mockChunks = [
      {
        _id: 'chunk-1',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content',
        canonicalMetadata: {},
      },
      {
        _id: 'chunk-2',
        indexId: 'index-456',
        documentId: 'doc-123',
        content: 'test content 2',
        canonicalMetadata: {},
      },
    ];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchChunk.find as any).mockResolvedValue(mockChunks);
    (SearchChunk.findOneAndUpdate as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processEnrichmentJob } = await import('../enrichment-worker.js');

    await processEnrichmentJob({
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        chunkIds: ['chunk-1', 'chunk-2'],
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    } as any);

    const transitionCalls = (logStatusTransition as any).mock.calls;
    expect(transitionCalls.length).toBeGreaterThan(0);

    // ENRICHED transition should include metadata
    const enrichedCall = transitionCalls.find(
      (c: any) => c[0]?.toStatus === DocumentStatus.ENRICHED,
    );
    expect(enrichedCall).toBeDefined();
    expect(enrichedCall[0].metadata.chunkCount).toBe(2);
  });
});
