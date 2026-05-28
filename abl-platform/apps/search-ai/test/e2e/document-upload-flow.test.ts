/**
 * E2E Test: Document Upload Flow
 *
 * Tests the complete pipeline:
 * Upload → Docling/Plain Text → Pages → Chunks → Embedding → OpenSearch → Search
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createReadStream } from 'fs';
import path from 'path';
import FormData from 'form-data';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import {
  QUEUE_PAGE_PROCESSING,
  QUEUE_CANONICAL_MAP,
  QUEUE_EMBEDDING,
} from '@agent-platform/search-ai-sdk';

// Test helpers
import { JobWaiter } from '../helpers/job-waiter';
import { MongoDBAssertions } from '../helpers/mongodb-assertions';
import { OpenSearchAssertions } from '../helpers/opensearch-assertions';
import { TestDataFactory } from '../helpers/test-data-factory';

// Configuration
const SEARCH_AI_URL = process.env.SEARCH_AI_URL || 'http://localhost:3113';
const OPENSEARCH_URL = process.env.OPENSEARCH_URL || 'http://localhost:9200';
const BGE_M3_URL = process.env.BGE_M3_URL || 'http://localhost:8000';

describe('Document Upload E2E Flow', () => {
  let jobWaiter: JobWaiter;
  let mongoAssertions: MongoDBAssertions;
  let osAssertions: OpenSearchAssertions;
  let factory: TestDataFactory;
  let osClient: OpenSearchClient;

  beforeAll(async () => {
    console.log('\n🧪 Setting up E2E test environment...\n');

    // Connect to OpenSearch
    osClient = new OpenSearchClient({
      node: OPENSEARCH_URL,
      ssl: { rejectUnauthorized: false },
    });
    console.log('✓ Connected to OpenSearch');

    // Initialize helpers
    jobWaiter = new JobWaiter();
    mongoAssertions = new MongoDBAssertions();
    osAssertions = new OpenSearchAssertions(osClient);
    factory = new TestDataFactory();

    console.log('✓ Test helpers initialized\n');
  });

  afterAll(async () => {
    console.log('\n🧹 Cleaning up E2E test environment...\n');

    await mongoAssertions.close();
    await osClient.close();

    console.log('✓ Cleanup complete\n');
  });

  // FIXME: This E2E test requires running services:
  // - BGE-M3 embedding service (http://localhost:8000)
  // - OpenSearch cluster (http://localhost:9200)
  // - Background workers processing BullMQ jobs
  // Skip until infrastructure is set up for E2E tests
  it.skip('should process markdown document through entire pipeline', async () => {
    console.log('\n📄 TEST: Processing markdown document through pipeline\n');

    // ═══════════════════════════════════════════════════════════════════
    // Step 1: Create test data (index and source)
    // ═══════════════════════════════════════════════════════════════════

    const tenantId = factory.generateTenantId();
    const index = await factory.createTestIndex(tenantId);
    const source = await factory.createTestSource(tenantId, index._id);

    console.log(`\n📋 Test Setup:`);
    console.log(`   Tenant ID: ${tenantId}`);
    console.log(`   Index ID: ${index._id}`);
    console.log(`   Source ID: ${source._id}\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Step 2: Upload markdown document
    // ═══════════════════════════════════════════════════════════════════

    console.log('📤 Step 1: Uploading document...');

    const form = new FormData();
    const filePath = path.join(__dirname, '../fixtures/test-document.md');

    form.append('file', createReadStream(filePath), {
      filename: 'test-document.md',
      contentType: 'text/markdown',
    });
    form.append(
      'metadata',
      JSON.stringify({
        author: 'Test Author',
        category: 'technical',
      }),
    );

    const uploadResponse = await fetch(
      `${SEARCH_AI_URL}/api/indexes/${index._id}/sources/${source._id}/documents`,
      {
        method: 'POST',
        body: form as any,
        headers: {
          'x-tenant-id': tenantId,
          ...form.getHeaders(),
        },
      },
    );

    if (uploadResponse.status !== 201) {
      const errorBody = await uploadResponse.text();
      console.error(`Upload failed with status ${uploadResponse.status}: ${errorBody}`);
    }

    expect(uploadResponse.status, 'Upload should return 201 Created').toBe(201);

    const uploadData = await uploadResponse.json();
    const documentId = uploadData.id;

    console.log(`   ✓ Document uploaded: ${documentId}\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Step 3: Wait for page processing (markdown skips Docling)
    // ═══════════════════════════════════════════════════════════════════

    console.log('⏳ Step 2: Waiting for page processing...');

    await jobWaiter.waitForQueueIdle(QUEUE_PAGE_PROCESSING, 60000);

    console.log('   ✓ Page processing complete\n');

    // ═══════════════════════════════════════════════════════════════════
    // Step 4: Verify SearchChunks created
    // ═══════════════════════════════════════════════════════════════════

    console.log('🔍 Step 3: Verifying chunks in MongoDB...');

    // Wait a moment for data to be visible across connections
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const chunks = await mongoAssertions.assertChunksCreated(documentId);

    expect(chunks.length, 'Should create at least one chunk').toBeGreaterThan(0);
    console.log(`   ✓ Found ${chunks.length} chunks\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Step 5: Wait for canonical mapping
    // ═══════════════════════════════════════════════════════════════════

    console.log('⏳ Step 4: Waiting for canonical mapping...');

    await jobWaiter.waitForQueueIdle(QUEUE_CANONICAL_MAP, 30000);

    console.log('   ✓ Canonical mapping complete\n');

    // ═══════════════════════════════════════════════════════════════════
    // Step 6: Wait for embedding
    // ═══════════════════════════════════════════════════════════════════

    console.log('⏳ Step 5: Waiting for embedding...');

    await jobWaiter.waitForQueueIdle(QUEUE_EMBEDDING, 120000);

    console.log('   ✓ Embedding complete\n');

    // ═══════════════════════════════════════════════════════════════════
    // Step 7: Verify chunks are indexed in MongoDB
    // ═══════════════════════════════════════════════════════════════════

    console.log('🔍 Step 6: Verifying chunks are indexed...');

    await mongoAssertions.assertChunksIndexed(documentId);

    console.log('   ✓ All chunks have status: indexed\n');

    // ═══════════════════════════════════════════════════════════════════
    // Step 8: Verify vectors in OpenSearch
    // ═══════════════════════════════════════════════════════════════════

    console.log('🔍 Step 7: Verifying vectors in OpenSearch...');

    const opensearchIndex = 'search-vectors-v1'; // Default shared index
    const vectors = await osAssertions.assertVectorsExist(
      opensearchIndex,
      tenantId,
      index._id,
      documentId,
    );

    expect(vectors.length, 'Vector count should match chunk count').toBe(chunks.length);
    console.log(`   ✓ Found ${vectors.length} vectors in OpenSearch\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Step 9: Verify hybrid search works
    // ═══════════════════════════════════════════════════════════════════

    console.log('🔍 Step 8: Testing hybrid search...');

    // Generate query embedding
    const queryText = 'vector search and embeddings';
    const embeddingResponse = await fetch(`${BGE_M3_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: queryText }),
    });

    expect(embeddingResponse.ok, 'BGE-M3 should generate embedding').toBe(true);

    const queryEmbedding = (await embeddingResponse.json())[0];

    // Perform hybrid search
    const results = await osAssertions.assertHybridSearchWorks(
      opensearchIndex,
      queryEmbedding,
      {
        'metadata.sys.tenantId': tenantId,
        'metadata.sys.appId': index._id,
        'metadata.canonical.category': 'technical',
      },
      1,
    );

    console.log(`   ✓ Hybrid search returned ${results.length} results\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Step 10: Verify end-to-end latency
    // ═══════════════════════════════════════════════════════════════════

    console.log('⏱️  Step 9: Measuring end-to-end latency...');

    const document = await SearchDocument.findById(documentId).lean();
    const totalTimeMs = document!.updatedAt.getTime() - document!.createdAt.getTime();
    const totalTimeSec = (totalTimeMs / 1000).toFixed(2);

    console.log(`   ✓ Total processing time: ${totalTimeSec}s`);

    // Performance assertion (generous timeout for E2E test)
    expect(totalTimeMs, 'Should complete in < 5 minutes').toBeLessThan(5 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════════
    // Test complete
    // ═══════════════════════════════════════════════════════════════════

    console.log('\n✅ E2E Test Complete!\n');
    console.log('📊 Summary:');
    console.log(`   - Document: ${documentId}`);
    console.log(`   - Chunks: ${chunks.length}`);
    console.log(`   - Vectors: ${vectors.length}`);
    console.log(`   - Search Results: ${results.length}`);
    console.log(`   - Total Time: ${totalTimeSec}s\n`);

    // Cleanup test data via HTTP DELETE APIs
    await fetch(`${SEARCH_AI_URL}/api/indexes/${index._id}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': tenantId },
    });

    console.log('🧹 Test data cleaned up\n');
  }, 300000); // 5 minute timeout
});
