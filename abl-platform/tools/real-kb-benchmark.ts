#!/usr/bin/env tsx
/**
 * Real KB Search Benchmark
 * Uses actual KB with indexed data: 019d7c23-6b7a-7d73-a04d-b5788427fab7
 */

const RUNTIME_URL = 'http://localhost:5173/api/search-ai-runtime';
const INDEX_ID = '019d7c23-6b7a-7d73-a04d-b5788427fab7';
const TENANT_ID = 'tenant-dev-001';
const RAW_AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!RAW_AUTH_TOKEN) {
  throw new Error(
    'AUTH_TOKEN env var is required. Set it to a fresh dev access token, e.g. AUTH_TOKEN="Bearer eyJ..." pnpm tsx tools/real-kb-benchmark.ts',
  );
}
const AUTH_TOKEN = RAW_AUTH_TOKEN.startsWith('Bearer ')
  ? RAW_AUTH_TOKEN
  : `Bearer ${RAW_AUTH_TOKEN}`;

interface TestQuery {
  name: string;
  body: any;
}

const queries: TestQuery[] = [
  // Semantic queries
  {
    name: 'Q1: Semantic + Rerank (short)',
    body: {
      query: 'workspace configuration',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q2: Semantic + Rerank (medium)',
    body: {
      query: 'show me the workspace id leap details',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q3: Semantic No Rerank',
    body: {
      query: 'workspace settings and parameters',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q4: Semantic + Rerank (long)',
    body: {
      query:
        'explain the workspace configuration including all settings parameters and how to manage them',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Hybrid queries
  {
    name: 'Q5: Hybrid + Rerank',
    body: {
      query: 'workspace setup guide',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q6: Hybrid + Rerank + Filter',
    body: {
      query: 'configuration documentation',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q7: Hybrid No Rerank',
    body: {
      query: 'workspace management',
      queryType: 'hybrid',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Structured queries
  {
    name: 'Q8: Structured (single filter)',
    body: {
      query: 'all documents',
      queryType: 'structured',
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q9: Structured (multi filter)',
    body: {
      query: 'filtered docs',
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
    name: 'Q10: Aggregation (source_type)',
    body: {
      query: 'count by type',
      queryType: 'aggregation',
      aggregation: { field: 'source_type', function: 'count' },
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q11: Aggregation (language)',
    body: {
      query: 'count by language',
      queryType: 'aggregation',
      aggregation: { field: 'language', function: 'count' },
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // More semantic variations
  {
    name: 'Q12: Semantic Short Query',
    body: {
      query: 'workspace',
      queryType: 'semantic',
      topK: 5,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q13: Semantic topK=20',
    body: {
      query: 'configuration settings',
      queryType: 'semantic',
      topK: 20,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // With full pipeline
  {
    name: 'Q14: Semantic Full Pipeline',
    body: {
      query: 'workspace configuration',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: false,
      skipVocabularyResolution: false,
    },
  },
  {
    name: 'Q15: Hybrid Full Pipeline',
    body: {
      query: 'setup and configuration',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: false,
      skipVocabularyResolution: false,
    },
  },

  // More hybrid variations
  {
    name: 'Q16: Hybrid Multi-Filter',
    body: {
      query: 'documentation',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q17: Vector Only',
    body: {
      query: 'workspace details',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },

  // Edge cases
  {
    name: 'Q18: Very Short',
    body: {
      query: 'id',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q19: Complex Query',
    body: {
      query:
        'I need detailed information about workspace configuration settings including all parameters and how to properly set them up',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q20: Structured Complex',
    body: {
      query: 'filtered content',
      queryType: 'structured',
      filters: [{ field: 'source_type', operator: 'in', value: ['markdown', 'text'] }],
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
  console.log('REAL KB SEARCH BENCHMARK');
  console.log('='.repeat(80));
  console.log(`Index ID: ${INDEX_ID}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log(`Queries: ${queries.length}`);
  console.log('='.repeat(80));
  console.log('');

  for (let i = 0; i < queries.length; i++) {
    const test = queries[i];
    console.log(`[${i + 1}/${queries.length}] ${test.name}`);

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
        ? `search=${response.data.latency.vectorSearchMs || response.data.latency.searchExecutionMs || 0}ms, rerank=${response.data.latency.rerankMs || 0}ms`
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

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('');
  analyzeResults();
}

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

  console.log('Overall Latency Statistics:');
  console.log(`  Average: ${avg.toFixed(0)}ms`);
  console.log(`  Min: ${min}ms`);
  console.log(`  Max: ${max}ms`);
  console.log(`  P50 (median): ${p50}ms`);
  console.log(`  P75: ${p75}ms`);
  console.log(`  P90: ${p90}ms`);
  console.log(`  P95: ${p95}ms`);
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

  // Stage breakdown (if available)
  const withLatency = successful.filter((r) => r.latency);
  if (withLatency.length > 0) {
    const avgSearch =
      withLatency.reduce(
        (sum, r) => sum + (r.latency.vectorSearchMs || r.latency.searchExecutionMs || 0),
        0,
      ) / withLatency.length;
    const avgRerank =
      withLatency.reduce((sum, r) => sum + (r.latency.rerankMs || 0), 0) / withLatency.length;
    const avgVocab =
      withLatency.reduce((sum, r) => sum + (r.latency.vocabularyResolveMs || 0), 0) /
      withLatency.length;
    const avgTotal = withLatency.reduce((sum, r) => sum + r.totalMs, 0) / withLatency.length;

    console.log('Average Stage Breakdown (from latency object):');
    console.log(
      `  Vocabulary Resolution: ${avgVocab.toFixed(0)}ms (${((avgVocab / avgTotal) * 100).toFixed(1)}%)`,
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
    'tools/real-kb-benchmark-results.json',
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        indexId: INDEX_ID,
        tenantId: TENANT_ID,
        results,
      },
      null,
      2,
    ),
  );
  console.log('Results saved to: tools/real-kb-benchmark-results.json');
}

runBenchmark().catch(console.error);
