#!/usr/bin/env tsx
/**
 * Search Latency Benchmark
 *
 * Runs 20 real search queries against the search-ai-runtime service
 * and captures actual timing data for analysis.
 *
 * Usage: tsx tools/search-latency-benchmark.ts
 */

import { SearchAIClient } from '@agent-platform/search-ai-sdk';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('search-benchmark');

// =============================================================================
// CONFIG
// =============================================================================

const RUNTIME_URL = process.env.SEARCH_AI_RUNTIME_URL || 'http://localhost:3004';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TENANT_ID = process.env.TENANT_ID || '';
const INDEX_ID = process.env.INDEX_ID || '';

if (!TENANT_ID || !INDEX_ID) {
  console.error('ERROR: TENANT_ID and INDEX_ID environment variables are required');
  console.error('Usage: TENANT_ID=xxx INDEX_ID=xxx tsx tools/search-latency-benchmark.ts');
  process.exit(1);
}

// =============================================================================
// TEST QUERIES
// =============================================================================

interface TestQuery {
  name: string;
  query: string;
  queryType: 'semantic' | 'hybrid' | 'structured' | 'aggregation' | 'vector';
  rerank?: boolean;
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  aggregation?: { field: string; function: string };
  topK?: number;
  skipPreprocessing?: boolean;
  skipVocabularyResolution?: boolean;
}

const TEST_QUERIES: TestQuery[] = [
  // Semantic queries
  {
    name: 'Q1: Semantic + Rerank (conceptual)',
    query: 'What are the main features of the platform?',
    queryType: 'semantic',
    rerank: true,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q2: Semantic + Rerank (technical)',
    query: 'How does the authentication system work?',
    queryType: 'semantic',
    rerank: true,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q3: Semantic No Rerank',
    query: 'container orchestration and deployment',
    queryType: 'vector',
    rerank: false,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q4: Semantic + Rerank (long query)',
    query:
      'Explain the database replication strategy and how it handles failover scenarios in production',
    queryType: 'semantic',
    rerank: true,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },

  // Hybrid queries
  {
    name: 'Q5: Hybrid + Rerank',
    query: 'kubernetes deployment configuration',
    queryType: 'hybrid',
    rerank: true,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q6: Hybrid + Rerank + Filter',
    query: 'api documentation',
    queryType: 'hybrid',
    rerank: true,
    filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q7: Hybrid No Rerank',
    query: 'database schema design',
    queryType: 'hybrid',
    rerank: false,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },

  // Structured queries
  {
    name: 'Q8: Structured (single filter)',
    query: 'list all PDF documents',
    queryType: 'structured',
    rerank: false,
    filters: [{ field: 'source_type', operator: 'eq', value: 'pdf' }],
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q9: Structured (multi filter)',
    query: 'show markdown documentation',
    queryType: 'structured',
    rerank: false,
    filters: [
      { field: 'source_type', operator: 'eq', value: 'markdown' },
      { field: 'language', operator: 'eq', value: 'en' },
    ],
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q10: Structured (complex filters)',
    query: 'recent documentation',
    queryType: 'structured',
    rerank: false,
    filters: [
      { field: 'source_type', operator: 'in', value: ['markdown', 'text'] },
      { field: 'language', operator: 'eq', value: 'en' },
    ],
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },

  // Aggregations
  {
    name: 'Q11: Aggregation (source_type)',
    query: 'count documents by file type',
    queryType: 'aggregation',
    aggregation: { field: 'source_type', function: 'count' },
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q12: Aggregation (language)',
    query: 'count documents by language',
    queryType: 'aggregation',
    aggregation: { field: 'language', function: 'count' },
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q13: Aggregation + Filter',
    query: 'count markdown by language',
    queryType: 'aggregation',
    aggregation: { field: 'language', function: 'count' },
    filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },

  // Edge cases
  {
    name: 'Q14: Short query semantic',
    query: 'api',
    queryType: 'semantic',
    rerank: true,
    topK: 5,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q15: Very long query semantic',
    query:
      'I need comprehensive information about how the distributed system handles concurrent requests, manages state consistency across multiple nodes, handles network partitions, implements consensus algorithms, and ensures data durability in case of failures',
    queryType: 'semantic',
    rerank: true,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q16: Hybrid multiple filters',
    query: 'configuration guide',
    queryType: 'hybrid',
    rerank: true,
    filters: [
      { field: 'source_type', operator: 'eq', value: 'markdown' },
      { field: 'language', operator: 'eq', value: 'en' },
    ],
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },

  // With preprocessing/vocab (slower path)
  {
    name: 'Q17: Semantic + Full Pipeline',
    query: 'authentication and security',
    queryType: 'semantic',
    rerank: true,
    topK: 10,
    skipPreprocessing: false,
    skipVocabularyResolution: false,
  },
  {
    name: 'Q18: Hybrid + Full Pipeline',
    query: 'deployment and configuration',
    queryType: 'hybrid',
    rerank: true,
    topK: 10,
    skipPreprocessing: false,
    skipVocabularyResolution: false,
  },

  // More variations
  {
    name: 'Q19: Vector search (no BM25)',
    query: 'monitoring and observability tools',
    queryType: 'vector',
    rerank: false,
    topK: 10,
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
  {
    name: 'Q20: Structured (date filter)',
    query: 'recent documents',
    queryType: 'structured',
    rerank: false,
    filters: [{ field: 'created_at', operator: 'gte', value: '2026-01-01' }],
    skipPreprocessing: true,
    skipVocabularyResolution: true,
  },
];

// =============================================================================
// RESULT TRACKING
// =============================================================================

interface QueryResult {
  name: string;
  queryType: string;
  success: boolean;
  error?: string;

  // Timing data
  totalMs: number;
  permissionFilterMs?: number;
  preprocessingMs?: number;
  vocabularyResolveMs?: number;
  aliasResolveMs?: number;
  vectorSearchMs?: number;
  searchExecutionMs?: number;
  rerankMs?: number;

  // Result data
  resultCount: number;
  topScore?: number;

  // Flags
  rerank: boolean;
  skipPreprocessing: boolean;
  skipVocabularyResolution: boolean;
  filterCount: number;

  // Raw response
  rawLatency?: any;
}

const results: QueryResult[] = [];

// =============================================================================
// BENCHMARK EXECUTION
// =============================================================================

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('SEARCH LATENCY BENCHMARK');
  console.log('='.repeat(80));
  console.log(`Runtime URL: ${RUNTIME_URL}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log(`Index ID: ${INDEX_ID}`);
  console.log(`Queries: ${TEST_QUERIES.length}`);
  console.log('='.repeat(80));
  console.log('');

  const client = new SearchAIClient({
    runtimeUrl: RUNTIME_URL,
    engineUrl: '',
    authToken: AUTH_TOKEN,
    timeoutMs: 30000,
  });

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const testQuery = TEST_QUERIES[i];
    const queryNum = i + 1;

    console.log(`[${queryNum}/${TEST_QUERIES.length}] Running: ${testQuery.name}`);
    console.log(
      `  Query: "${testQuery.query.substring(0, 60)}${testQuery.query.length > 60 ? '...' : ''}"`,
    );

    const startTime = Date.now();

    try {
      const body: any = {
        query: testQuery.query,
        queryType: testQuery.queryType,
        topK: testQuery.topK,
        rerank: testQuery.rerank,
        filters: testQuery.filters,
        aggregation: testQuery.aggregation,
        skipPreprocessing: testQuery.skipPreprocessing,
        skipVocabularyResolution: testQuery.skipVocabularyResolution,
        debug: false,
      };

      // Remove undefined values
      Object.keys(body).forEach((key) => {
        if (body[key] === undefined) delete body[key];
      });

      const response = await client.unifiedSearch(INDEX_ID, body);
      const endTime = Date.now();
      const totalMs = endTime - startTime;

      const result: QueryResult = {
        name: testQuery.name,
        queryType: testQuery.queryType,
        success: true,
        totalMs,
        resultCount: response.results?.length || response.aggregations?.length || 0,
        topScore: response.results?.[0]?.score,
        rerank: testQuery.rerank || false,
        skipPreprocessing: testQuery.skipPreprocessing || false,
        skipVocabularyResolution: testQuery.skipVocabularyResolution || false,
        filterCount: testQuery.filters?.length || 0,
        rawLatency: response.latency,
      };

      // Extract latency breakdown
      if (response.latency) {
        result.permissionFilterMs = response.latency.permissionFilterMs;
        result.preprocessingMs = response.latency.preprocessingMs;
        result.vocabularyResolveMs = response.latency.vocabularyResolveMs;
        result.aliasResolveMs = response.latency.aliasResolveMs;
        result.vectorSearchMs = response.latency.vectorSearchMs;
        result.searchExecutionMs = response.latency.searchExecutionMs;
        result.rerankMs = response.latency.rerankMs;
      }

      results.push(result);

      console.log(
        `  ✓ Success: ${totalMs}ms (${result.resultCount} results, top score: ${result.topScore?.toFixed(2) || 'N/A'})`,
      );
    } catch (error) {
      const endTime = Date.now();
      const totalMs = endTime - startTime;

      const result: QueryResult = {
        name: testQuery.name,
        queryType: testQuery.queryType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        totalMs,
        resultCount: 0,
        rerank: testQuery.rerank || false,
        skipPreprocessing: testQuery.skipPreprocessing || false,
        skipVocabularyResolution: testQuery.skipVocabularyResolution || false,
        filterCount: testQuery.filters?.length || 0,
      };

      results.push(result);
      console.log(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log('');

    // Small delay between queries to avoid overwhelming the system
    if (i < TEST_QUERIES.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log('='.repeat(80));
  console.log('BENCHMARK COMPLETE');
  console.log('='.repeat(80));
  console.log('');
}

// =============================================================================
// ANALYTICS
// =============================================================================

function analyzeResults() {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log('='.repeat(80));
  console.log('ANALYTICS SUMMARY');
  console.log('='.repeat(80));
  console.log('');

  console.log(`Total Queries: ${results.length}`);
  console.log(
    `Successful: ${successful.length} (${((successful.length / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Failed: ${failed.length} (${((failed.length / results.length) * 100).toFixed(1)}%)`);
  console.log('');

  if (failed.length > 0) {
    console.log('Failed Queries:');
    failed.forEach((r) => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    console.log('');
  }

  if (successful.length === 0) {
    console.log('No successful queries to analyze.');
    return;
  }

  // Overall stats
  const latencies = successful.map((r) => r.totalMs);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)];
  const p75 = sortedLatencies[Math.floor(sortedLatencies.length * 0.75)];
  const p90 = sortedLatencies[Math.floor(sortedLatencies.length * 0.9)];
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)];
  const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)];

  console.log('Overall Latency Statistics:');
  console.log(`  Average: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Min: ${minLatency}ms`);
  console.log(`  Max: ${maxLatency}ms`);
  console.log(`  P50 (median): ${p50}ms`);
  console.log(`  P75: ${p75}ms`);
  console.log(`  P90: ${p90}ms`);
  console.log(`  P95: ${p95}ms`);
  console.log(`  P99: ${p99}ms`);
  console.log('');

  // By query type
  const byType = successful.reduce(
    (acc, r) => {
      if (!acc[r.queryType]) {
        acc[r.queryType] = [];
      }
      acc[r.queryType].push(r);
      return acc;
    },
    {} as Record<string, QueryResult[]>,
  );

  console.log('Latency by Query Type:');
  Object.entries(byType).forEach(([type, queries]) => {
    const avg = queries.reduce((sum, q) => sum + q.totalMs, 0) / queries.length;
    const min = Math.min(...queries.map((q) => q.totalMs));
    const max = Math.max(...queries.map((q) => q.totalMs));
    console.log(
      `  ${type.toUpperCase()}: avg=${avg.toFixed(0)}ms, min=${min}ms, max=${max}ms (n=${queries.length})`,
    );
  });
  console.log('');

  // With vs without rerank
  const withRerank = successful.filter((r) => r.rerank);
  const withoutRerank = successful.filter((r) => !r.rerank);

  if (withRerank.length > 0 && withoutRerank.length > 0) {
    const avgWithRerank = withRerank.reduce((sum, r) => sum + r.totalMs, 0) / withRerank.length;
    const avgWithoutRerank =
      withoutRerank.reduce((sum, r) => sum + r.totalMs, 0) / withoutRerank.length;
    const rerankOverhead = avgWithRerank - avgWithoutRerank;

    console.log('Reranking Impact:');
    console.log(`  With Rerank: ${avgWithRerank.toFixed(0)}ms (n=${withRerank.length})`);
    console.log(`  Without Rerank: ${avgWithoutRerank.toFixed(0)}ms (n=${withoutRerank.length})`);
    console.log(
      `  Overhead: ${rerankOverhead.toFixed(0)}ms (${((rerankOverhead / avgWithRerank) * 100).toFixed(1)}%)`,
    );
    console.log('');
  }

  // Stage breakdown (average across all queries with latency data)
  const withLatency = successful.filter((r) => r.rawLatency);
  if (withLatency.length > 0) {
    const avgPermission =
      withLatency.reduce((sum, r) => sum + (r.permissionFilterMs || 0), 0) / withLatency.length;
    const avgPreprocessing =
      withLatency.reduce((sum, r) => sum + (r.preprocessingMs || 0), 0) / withLatency.length;
    const avgVocab =
      withLatency.reduce((sum, r) => sum + (r.vocabularyResolveMs || 0), 0) / withLatency.length;
    const avgAlias =
      withLatency.reduce((sum, r) => sum + (r.aliasResolveMs || 0), 0) / withLatency.length;
    const avgSearch =
      withLatency.reduce((sum, r) => sum + (r.searchExecutionMs || r.vectorSearchMs || 0), 0) /
      withLatency.length;
    const avgRerank =
      withLatency.reduce((sum, r) => sum + (r.rerankMs || 0), 0) / withLatency.length;
    const avgTotal = withLatency.reduce((sum, r) => sum + r.totalMs, 0) / withLatency.length;

    console.log('Average Stage Breakdown:');
    console.log(
      `  Permission Filter: ${avgPermission.toFixed(0)}ms (${((avgPermission / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Preprocessing: ${avgPreprocessing.toFixed(0)}ms (${((avgPreprocessing / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Vocabulary Resolution: ${avgVocab.toFixed(0)}ms (${((avgVocab / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Alias Resolution: ${avgAlias.toFixed(0)}ms (${((avgAlias / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Search Execution: ${avgSearch.toFixed(0)}ms (${((avgSearch / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Rerank: ${avgRerank.toFixed(0)}ms (${((avgRerank / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);
    console.log('');
  }

  // Detailed results table
  console.log('='.repeat(80));
  console.log('DETAILED RESULTS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Query                                 | Total  | Search | Rerank | Results | Score');
  console.log('-'.repeat(90));

  successful.forEach((r) => {
    const name = r.name.substring(0, 37).padEnd(37);
    const total = `${r.totalMs}ms`.padStart(6);
    const search = `${(r.searchExecutionMs || r.vectorSearchMs || 0).toFixed(0)}ms`.padStart(6);
    const rerank = r.rerank ? `${(r.rerankMs || 0).toFixed(0)}ms`.padStart(6) : '  -   ';
    const results = `${r.resultCount}`.padStart(7);
    const score = r.topScore ? r.topScore.toFixed(2).padStart(5) : '  -  ';

    console.log(`${name} | ${total} | ${search} | ${rerank} | ${results} | ${score}`);
  });
  console.log('');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  try {
    await runBenchmark();
    analyzeResults();

    // Save results to JSON
    const outputPath = 'tools/search-latency-results.json';
    const fs = await import('fs/promises');
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          runtimeUrl: RUNTIME_URL,
          tenantId: TENANT_ID,
          indexId: INDEX_ID,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Results saved to: ${outputPath}`);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

main();
