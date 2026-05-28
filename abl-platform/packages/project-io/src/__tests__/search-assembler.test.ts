import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchAssembler } from '../export/layer-assemblers/search-assembler.js';

vi.mock('@agent-platform/database/models', () => ({
  SearchIndex: { find: vi.fn(), countDocuments: vi.fn() },
  SearchSource: { find: vi.fn(), countDocuments: vi.fn() },
  KnowledgeBase: { find: vi.fn(), countDocuments: vi.fn() },
  CrawlPattern: { find: vi.fn(), countDocuments: vi.fn() },
}));

import {
  SearchIndex,
  SearchSource,
  KnowledgeBase,
  CrawlPattern,
} from '@agent-platform/database/models';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  return { lean: () => ({ select: () => Promise.resolve(data) }) };
}

describe('SearchAssembler', () => {
  let assembler: SearchAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new SearchAssembler();
  });

  it('should have layer name "search"', () => {
    expect(assembler.layer).toBe('search');
  });

  it('should assemble search indexes as config only', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'idx-1',
          slug: 'main-index',
          name: 'Main Index',
          description: 'Primary search index',
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
          tokenChunkStrategy: null,
          vectorStore: { provider: 'qdrant', collectionName: 'main' },
          searchDefaults: { topK: 10, similarityThreshold: 0.7 },
          status: 'ready',
          documentCount: 500,
          chunkCount: 2000,
          sourceCount: 3,
          lastIndexedAt: new Date(),
          indexError: null,
        },
      ]),
    );
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('search/indexes/main-index.index.json')).toBe(true);
    const indexJson = JSON.parse(result.files.get('search/indexes/main-index.index.json')!);

    // Config fields present
    expect(indexJson.embeddingModel).toBe('text-embedding-3-small');
    expect(indexJson.vectorStore.provider).toBe('qdrant');

    // Runtime stats stripped
    expect(indexJson).not.toHaveProperty('documentCount');
    expect(indexJson).not.toHaveProperty('chunkCount');
    expect(indexJson).not.toHaveProperty('sourceCount');
    expect(indexJson).not.toHaveProperty('lastIndexedAt');
    expect(indexJson).not.toHaveProperty('indexError');
  });

  it('should strip sourceConfig from sources (may contain credentials)', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'idx-1',
          slug: 'docs',
          name: 'Docs Index',
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
          status: 'ready',
        },
      ]),
    );
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'src-1',
          indexId: 'idx-1',
          name: 'Google Drive',
          sourceType: 'google_drive',
          sourceConfig: { credentials: 'secret-oauth-token' },
          extractionConfig: { ocr: true },
          status: 'active',
          documentCount: 100,
          lastSyncAt: new Date(),
        },
      ]),
    );
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    const sourceJson = JSON.parse(result.files.get('search/sources/google_drive.source.json')!);
    expect(sourceJson).not.toHaveProperty('sourceConfig');
    expect(sourceJson).not.toHaveProperty('documentCount');
    expect(sourceJson).not.toHaveProperty('lastSyncAt');
    expect(sourceJson.name).toBe('Google Drive');
    expect(sourceJson.sourceType).toBe('google_drive');
  });

  it('should export knowledge bases as config only', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'kb-1',
          name: 'Support KB',
          description: 'Customer support knowledge',
          searchIndexId: 'idx-1',
          connectorCount: 2,
          status: 'ready',
          documentCount: 300,
          lastIndexedAt: new Date(),
          isPublic: false,
        },
      ]),
    );
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('search/knowledge-bases/support_kb.kb.json')).toBe(true);
    const kbJson = JSON.parse(result.files.get('search/knowledge-bases/support_kb.kb.json')!);
    expect(kbJson.name).toBe('Support KB');
    expect(kbJson._exportedId).toBe('kb-1');
    expect(kbJson).not.toHaveProperty('documentCount');
    expect(kbJson).not.toHaveProperty('lastIndexedAt');
  });

  it('should handle empty project', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
  });

  it('should count entities correctly', async () => {
    (SearchIndex.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (KnowledgeBase.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (CrawlPattern.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(6);

    // Verify queries are scoped to both projectId and tenantId
    expect(SearchIndex.countDocuments).toHaveBeenCalledWith({
      projectId: CTX.projectId,
      tenantId: CTX.tenantId,
    });
    expect(KnowledgeBase.countDocuments).toHaveBeenCalledWith({
      projectId: CTX.projectId,
      tenantId: CTX.tenantId,
    });
    expect(CrawlPattern.countDocuments).toHaveBeenCalledWith({
      tenantId: CTX.tenantId,
    });
  });

  it('should export tenant crawl patterns as tenant-level search cache data', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          domain: 'example.com',
          siteType: 'documentation',
          framework: 'next.js',
          jsRequired: true,
          linkDensity: 0.4,
          estimatedSize: 500,
          avgResponseTime: 200,
          rateLimitDetected: false,
          maxConcurrency: 5,
          confidence: 0.95,
          metadata: { language: 'en' },
          // Runtime stats that should be stripped
          lastCrawlAt: new Date(),
          totalCrawlsCompleted: 10,
          avgCrawlDurationMs: 1500,
          lastCrawlSuccess: true,
          lastCrawlError: null,
          profiledAt: new Date(),
          lastAccessedAt: new Date(),
          _id: 'cp-1',
          tenantId: 'tenant-1',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('search/crawl-patterns.json')).toBe(true);

    const patterns = JSON.parse(result.files.get('search/crawl-patterns.json')!);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].domain).toBe('example.com');
    expect(patterns[0].siteType).toBe('documentation');
    expect(patterns[0].confidence).toBe(0.95);

    // Runtime stats stripped
    expect(patterns[0]).not.toHaveProperty('lastCrawlAt');
    expect(patterns[0]).not.toHaveProperty('totalCrawlsCompleted');
    expect(patterns[0]).not.toHaveProperty('avgCrawlDurationMs');
    expect(patterns[0]).not.toHaveProperty('lastCrawlSuccess');
    expect(patterns[0]).not.toHaveProperty('lastCrawlError');
    expect(patterns[0]).not.toHaveProperty('profiledAt');
    expect(patterns[0]).not.toHaveProperty('lastAccessedAt');
    // Internal fields stripped
    expect(patterns[0]).not.toHaveProperty('_id');
    expect(patterns[0]).not.toHaveProperty('tenantId');

    // Entity count includes crawl patterns
    expect(result.entityCount).toBe(1);
    expect(CrawlPattern.find).toHaveBeenCalledWith({ tenantId: CTX.tenantId });
  });

  it('should use slug fallback to name for index file path', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'idx-no-slug',
          slug: '',
          name: 'Fallback Index',
          description: 'Index without slug',
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
          status: 'ready',
        },
      ]),
    );
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    // slug is empty string (falsy), should fall back to name
    expect(result.files.has('search/indexes/fallback_index.index.json')).toBe(true);
  });

  it('should key sources by indexId and export multiple indexes with sources', async () => {
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'idx-1',
          slug: 'primary',
          name: 'Primary',
          embeddingModel: 'text-embedding-3-small',
          embeddingDimensions: 1536,
          status: 'ready',
        },
        {
          _id: 'idx-2',
          slug: 'secondary',
          name: 'Secondary',
          embeddingModel: 'text-embedding-3-large',
          embeddingDimensions: 3072,
          status: 'ready',
        },
      ]),
    );
    (KnowledgeBase.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'src-1',
          indexId: 'idx-1',
          name: 'Web Crawl',
          sourceType: 'web',
          extractionConfig: { depth: 3 },
          status: 'active',
          sourceConfig: { url: 'https://example.com' },
          documentCount: 50,
          lastSyncAt: new Date(),
        },
        {
          _id: 'src-2',
          indexId: 'idx-2',
          name: 'S3 Bucket',
          sourceType: 's3',
          extractionConfig: { format: 'pdf' },
          status: 'active',
          sourceConfig: { bucket: 'my-bucket', secretKey: 'secret' },
          documentCount: 200,
          lastSyncAt: new Date(),
        },
      ]),
    );
    (CrawlPattern.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    // Both indexes present
    expect(result.files.has('search/indexes/primary.index.json')).toBe(true);
    expect(result.files.has('search/indexes/secondary.index.json')).toBe(true);

    // Both sources present
    expect(result.files.has('search/sources/web_crawl.source.json')).toBe(true);
    expect(result.files.has('search/sources/s3_bucket.source.json')).toBe(true);

    const webSource = JSON.parse(result.files.get('search/sources/web_crawl.source.json')!);
    expect(webSource.sourceType).toBe('web');
    expect(webSource).not.toHaveProperty('sourceConfig');
    expect(webSource).not.toHaveProperty('documentCount');
    expect(webSource).not.toHaveProperty('lastSyncAt');

    // 2 indexes + 2 sources = 4
    expect(result.entityCount).toBe(4);
  });
});
