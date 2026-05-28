#!/usr/bin/env tsx
/**
 * Unique Queries Benchmark - No Cache Hits
 * Each query is completely different to measure true "cold" performance
 */

const RUNTIME_URL = 'http://localhost:5173/api/search-ai-runtime';
const INDEX_ID = '019d7c23-6b7a-7d73-a04d-b5788427fab7';
const TENANT_ID = 'tenant-dev-001';
const RAW_AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!RAW_AUTH_TOKEN) {
  throw new Error(
    'AUTH_TOKEN env var is required. Set it to a fresh dev access token, e.g. AUTH_TOKEN="Bearer eyJ..." pnpm tsx tools/unique-queries-benchmark.ts',
  );
}
const AUTH_TOKEN = RAW_AUTH_TOKEN.startsWith('Bearer ')
  ? RAW_AUTH_TOKEN
  : `Bearer ${RAW_AUTH_TOKEN}`;

// 20 completely unique queries - no repeats, different topics/intents
const queries = [
  // Semantic queries (conceptual understanding)
  {
    name: 'Q1: Semantic - Authentication methods',
    body: {
      query: 'what authentication methods are supported and how do they work',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q2: Semantic - Database configuration',
    body: {
      query: 'explain database setup and connection pooling strategies',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q3: Semantic - Error handling',
    body: {
      query: 'how are errors and exceptions handled in the system',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q4: Semantic - API endpoints',
    body: {
      query: 'list available REST API endpoints and their parameters',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Semantic without rerank
  {
    name: 'Q5: Semantic NoRerank - Deployment',
    body: {
      query: 'deployment procedures and rollback strategies',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q6: Semantic NoRerank - Testing',
    body: {
      query: 'unit testing framework and integration test patterns',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Hybrid queries (keyword + semantic)
  {
    name: 'Q7: Hybrid - Security best practices',
    body: {
      query: 'security vulnerabilities prevention and mitigation techniques',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q8: Hybrid - Performance optimization',
    body: {
      query: 'caching strategies and query optimization tips',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q9: Hybrid - Logging monitoring',
    body: {
      query: 'structured logging observability and metrics collection',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q10: Hybrid NoRerank - Rate limiting',
    body: {
      query: 'rate limiting throttling and backpressure mechanisms',
      queryType: 'hybrid',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Hybrid with filters
  {
    name: 'Q11: Hybrid+Filter - Markdown docs',
    body: {
      query: 'architecture patterns and design principles',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Structured queries (exact filtering)
  {
    name: 'Q12: Structured - PDF documents',
    body: {
      query: 'technical specifications',
      queryType: 'structured',
      filters: [{ field: 'source_type', operator: 'eq', value: 'pdf' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q13: Structured - Text files',
    body: {
      query: 'configuration files',
      queryType: 'structured',
      filters: [{ field: 'source_type', operator: 'eq', value: 'text' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q14: Structured - Multi-filter',
    body: {
      query: 'english documentation',
      queryType: 'structured',
      filters: [
        { field: 'source_type', operator: 'eq', value: 'markdown' },
        { field: 'language', operator: 'eq', value: 'en' },
      ],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Aggregations
  {
    name: 'Q15: Aggregation - By file type',
    body: {
      query: 'document statistics',
      queryType: 'aggregation',
      aggregation: { field: 'source_type', function: 'count' },
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q16: Aggregation - By language',
    body: {
      query: 'language distribution',
      queryType: 'aggregation',
      aggregation: { field: 'language', function: 'count' },
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Edge cases and variations
  {
    name: 'Q17: Semantic - Very specific question',
    body: {
      query:
        'what is the recommended way to handle concurrent write conflicts in distributed transactions',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q18: Semantic - Short single word',
    body: {
      query: 'migrations',
      queryType: 'semantic',
      topK: 5,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q19: Semantic - Large topK',
    body: {
      query: 'infrastructure components and service dependencies',
      queryType: 'semantic',
      topK: 20,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q20: Hybrid - Complex multi-topic',
    body: {
      query: 'microservices communication patterns including REST gRPC and message queues',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
];

interface Result {
  name: string;
  success: boolean;
  totalMs: number;
  latency?: any;
  resultCount: number;
  topScore?: number;
  queryType: string;
  rerank: boolean;
  error?: string;
}

const results: Result[] = [];

async function querySearch(body: any): Promise<any> {
  const startTime = Date.now();

  const response = await fetch(`${RUNTIME_URL}/search/${INDEX_ID}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: AUTH_TOKEN,
      'X-Tenant-Id': TENANT_ID,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const endTime = Date.now();

  return {
    statusCode: response.status,
    data,
    totalMs: endTime - startTime,
  };
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('UNIQUE QUERIES BENCHMARK (NO CACHE HITS)');
  console.log('='.repeat(80));
  console.log(`Index ID: ${INDEX_ID}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log(`Queries: ${queries.length} (all unique)`);
  console.log('='.repeat(80));
  console.log('');

  for (let i = 0; i < queries.length; i++) {
    const test = queries[i];
    console.log(`[${i + 1}/${queries.length}] ${test.name}`);
    console.log(
      `  Query: "${test.body.query.substring(0, 60)}${test.body.query.length > 60 ? '...' : ''}"`,
    );

    try {
      const response = await querySearch(test.body);

      const result: Result = {
        name: test.name,
        success: response.statusCode === 200,
        totalMs: response.totalMs,
        latency: response.data.latency,
        resultCount: response.data.results?.length || response.data.aggregations?.length || 0,
        topScore: response.data.results?.[0]?.score,
        queryType: test.body.queryType,
        rerank: test.body.rerank || false,
      };

      results.push(result);

      const latencyInfo = response.data.latency
        ? `embed=${response.data.latency.embeddingMs || 0}ms, os=${response.data.latency.opensearchMs || 0}ms, qp=${response.data.latency.questionParentMs || 0}ms, dsl=${response.data.latency.dslBuildMs || 0}ms`
        : 'no latency data';

      console.log(
        `  ✓ ${response.totalMs}ms (${result.resultCount} results, score=${result.topScore?.toFixed(2) || 'N/A'}) - ${latencyInfo}`,
      );
    } catch (error) {
      const result: Result = {
        name: test.name,
        success: false,
        totalMs: 0,
        resultCount: 0,
        queryType: test.body.queryType,
        rerank: test.body.rerank || false,
        error: error instanceof Error ? error.message : String(error),
      };

      results.push(result);
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }

    // Small delay between queries
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log('');
  analyzeResults();
}

function analyzeResults() {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log('='.repeat(80));
  console.log('ANALYTICS SUMMARY - UNIQUE QUERIES (COLD CACHE)');
  console.log('='.repeat(80));
  console.log('');

  console.log(`Total Queries: ${results.length}`);
  console.log(
    `Successful: ${successful.length} (${((successful.length / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Failed: ${failed.length}`);
  console.log('');

  if (successful.length === 0) {
    console.log('No successful queries to analyze.');
    return;
  }

  // Overall latency stats
  const latencies = successful.map((r) => r.totalMs);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  console.log('Overall Latency Statistics (Cold Cache):');
  console.log(`  Average: ${avg.toFixed(0)}ms`);
  console.log(`  Min: ${min}ms`);
  console.log(`  Max: ${max}ms`);
  console.log(`  P50 (median): ${p50}ms`);
  console.log(`  P75: ${p75}ms`);
  console.log(`  P90: ${p90}ms`);
  console.log(`  P95: ${p95}ms`);
  console.log(`  P99: ${p99}ms`);
  console.log('');

  // By query type
  const byType: Record<string, Result[]> = {};
  successful.forEach((r) => {
    if (!byType[r.queryType]) byType[r.queryType] = [];
    byType[r.queryType].push(r);
  });

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

  // Rerank impact
  const withRerank = successful.filter((r) => r.rerank);
  const withoutRerank = successful.filter((r) => !r.rerank);

  if (withRerank.length > 0 && withoutRerank.length > 0) {
    const avgWith = withRerank.reduce((sum, r) => sum + r.totalMs, 0) / withRerank.length;
    const avgWithout = withoutRerank.reduce((sum, r) => sum + r.totalMs, 0) / withoutRerank.length;
    const overhead = avgWith - avgWithout;

    console.log('Reranking Impact:');
    console.log(`  With Rerank: ${avgWith.toFixed(0)}ms (n=${withRerank.length})`);
    console.log(`  Without Rerank: ${avgWithout.toFixed(0)}ms (n=${withoutRerank.length})`);
    console.log(
      `  Overhead: ${overhead.toFixed(0)}ms (${((overhead / avgWith) * 100).toFixed(1)}%)`,
    );
    console.log('');
  }

  // Detailed stage breakdown
  const withLatency = successful.filter((r) => r.latency);
  if (withLatency.length > 0) {
    const avgPerm =
      withLatency.reduce((sum, r) => sum + (r.latency.permissionFilterMs || 0), 0) /
      withLatency.length;
    const avgPreproc =
      withLatency.reduce((sum, r) => sum + (r.latency.preprocessingMs || 0), 0) /
      withLatency.length;
    const avgVocab =
      withLatency.reduce((sum, r) => sum + (r.latency.vocabularyResolveMs || 0), 0) /
      withLatency.length;
    const avgAlias =
      withLatency.reduce((sum, r) => sum + (r.latency.aliasResolveMs || 0), 0) / withLatency.length;
    const avgSearch =
      withLatency.reduce(
        (sum, r) => sum + (r.latency.vectorSearchMs || r.latency.searchExecutionMs || 0),
        0,
      ) / withLatency.length;
    const avgRerank =
      withLatency.reduce((sum, r) => sum + (r.latency.rerankMs || 0), 0) / withLatency.length;
    const avgTotal = withLatency.reduce((sum, r) => sum + r.totalMs, 0) / withLatency.length;

    console.log('Average Stage Breakdown:');
    console.log(
      `  Permission Filter: ${avgPerm.toFixed(0)}ms (${((avgPerm / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Preprocessing: ${avgPreproc.toFixed(0)}ms (${((avgPreproc / avgTotal) * 100).toFixed(1)}%)`,
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
    console.log(
      `  Other/Overhead: ${(avgTotal - avgPerm - avgPreproc - avgVocab - avgAlias - avgSearch - avgRerank).toFixed(0)}ms`,
    );
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);
    console.log('');

    // Detailed component breakdown (new instrumentation)
    const avgEmbed =
      withLatency.reduce((sum, r) => sum + (r.latency.embeddingMs || 0), 0) / withLatency.length;
    const avgOS =
      withLatency.reduce((sum, r) => sum + (r.latency.opensearchMs || 0), 0) / withLatency.length;
    const avgQP =
      withLatency.reduce((sum, r) => sum + (r.latency.questionParentMs || 0), 0) /
      withLatency.length;
    const avgDSL =
      withLatency.reduce((sum, r) => sum + (r.latency.dslBuildMs || 0), 0) / withLatency.length;
    const nonEmbedding = avgOS + avgQP + avgDSL + (avgTotal - avgSearch);

    console.log('DETAILED COMPONENT BREAKDOWN (INSTRUMENTED):');
    console.log(
      `  Embedding Generation: ${avgEmbed.toFixed(0)}ms (${((avgEmbed / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  OpenSearch Query: ${avgOS.toFixed(0)}ms (${((avgOS / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Question→Parent: ${avgQP.toFixed(0)}ms (${((avgQP / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  DSL Building: ${avgDSL.toFixed(0)}ms (${((avgDSL / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  HTTP/Other: ${(avgTotal - avgEmbed - avgOS - avgQP - avgDSL).toFixed(0)}ms (${(((avgTotal - avgEmbed - avgOS - avgQP - avgDSL) / avgTotal) * 100).toFixed(1)}%)`,
    );
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);
    console.log('');
    console.log(
      `NON-EMBEDDING TIME: ${nonEmbedding.toFixed(0)}ms (${((nonEmbedding / avgTotal) * 100).toFixed(1)}% of total)`,
    );
    console.log('');
  }

  // Detailed table
  console.log('='.repeat(80));
  console.log('DETAILED RESULTS');
  console.log('='.repeat(80));
  console.log('');
  console.log(
    'Query                              | Type    | Total  | Search | Rerank | Results | Score',
  );
  console.log('-'.repeat(95));

  successful.forEach((r) => {
    const name = r.name.substring(0, 34).padEnd(34);
    const type = r.queryType.substring(0, 7).padEnd(7);
    const total = `${r.totalMs}ms`.padStart(6);
    const search =
      r.latency?.vectorSearchMs || r.latency?.searchExecutionMs
        ? `${(r.latency.vectorSearchMs || r.latency.searchExecutionMs).toFixed(0)}ms`.padStart(6)
        : '   -  ';
    const rerank = r.latency?.rerankMs
      ? `${r.latency.rerankMs.toFixed(0)}ms`.padStart(6)
      : '   -  ';
    const count = `${r.resultCount}`.padStart(7);
    const score = r.topScore ? r.topScore.toFixed(2).padStart(5) : '  -  ';

    console.log(`${name} | ${type} | ${total} | ${search} | ${rerank} | ${count} | ${score}`);
  });

  console.log('');

  // Save results
  const fs = require('fs');
  fs.writeFileSync(
    'tools/unique-queries-results.json',
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        indexId: INDEX_ID,
        tenantId: TENANT_ID,
        note: 'All unique queries - no cache hits',
        results,
      },
      null,
      2,
    ),
  );
  console.log('Results saved to: tools/unique-queries-results.json');
}

runBenchmark().catch(console.error);
