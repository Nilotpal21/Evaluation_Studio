#!/usr/bin/env tsx
/**
 * Quick Search Benchmark - Uses real running services
 *
 * Runs against localhost:3004 (search-ai-runtime) with actual queries
 */

import http from 'http';

const RUNTIME_URL = 'http://localhost:3004';

// Test queries
const queries = [
  {
    name: 'Q1: Semantic short',
    body: {
      query: 'authentication',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q2: Semantic medium',
    body: {
      query: 'how does the platform handle user authentication and authorization',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q3: Semantic no rerank',
    body: {
      query: 'database configuration',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q4: Hybrid + rerank',
    body: {
      query: 'api documentation',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q5: Structured filter',
    body: {
      query: 'documents',
      queryType: 'structured',
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q6: Aggregation',
    body: {
      query: 'count by type',
      queryType: 'aggregation',
      aggregation: { field: 'source_type', function: 'count' },
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q7: Hybrid no rerank',
    body: {
      query: 'deployment guide',
      queryType: 'hybrid',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q8: Semantic long query',
    body: {
      query:
        'explain the complete architecture of the distributed system including how it handles failures, manages state, and ensures data consistency across nodes',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q9: Structured multi-filter',
    body: {
      query: 'list documents',
      queryType: 'structured',
      filters: [
        { field: 'source_type', operator: 'eq', value: 'markdown' },
        { field: 'language', operator: 'eq', value: 'en' },
      ],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q10: Hybrid + filter',
    body: {
      query: 'configuration',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q11: Semantic with preprocessing',
    body: {
      query: 'authentication security',
      queryType: 'semantic',
      topK: 10,
      rerank: true,
      skipPreprocessing: false,
      skipVocabularyResolution: false,
    },
  },
  {
    name: 'Q12: Vector only',
    body: {
      query: 'monitoring observability',
      queryType: 'vector',
      topK: 10,
      rerank: false,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q13: Structured date filter',
    body: {
      query: 'recent docs',
      queryType: 'structured',
      filters: [{ field: 'created_at', operator: 'gte', value: '2026-01-01' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q14: Aggregation with filter',
    body: {
      query: 'count markdown by lang',
      queryType: 'aggregation',
      aggregation: { field: 'language', function: 'count' },
      filters: [{ field: 'source_type', operator: 'eq', value: 'markdown' }],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q15: Hybrid full pipeline',
    body: {
      query: 'deployment configuration',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      skipPreprocessing: false,
      skipVocabularyResolution: false,
    },
  },
  {
    name: 'Q16: Semantic topK=5',
    body: {
      query: 'api endpoints',
      queryType: 'semantic',
      topK: 5,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q17: Semantic topK=20',
    body: {
      query: 'database schema',
      queryType: 'semantic',
      topK: 20,
      rerank: true,
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q18: Structured complex',
    body: {
      query: 'filtered docs',
      queryType: 'structured',
      filters: [
        { field: 'source_type', operator: 'in', value: ['markdown', 'text'] },
        { field: 'language', operator: 'eq', value: 'en' },
      ],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q19: Hybrid multi-filter',
    body: {
      query: 'api guide',
      queryType: 'hybrid',
      topK: 10,
      rerank: true,
      filters: [
        { field: 'source_type', operator: 'eq', value: 'markdown' },
        { field: 'language', operator: 'eq', value: 'en' },
      ],
      skipPreprocessing: true,
      skipVocabularyResolution: true,
    },
  },
  {
    name: 'Q20: Semantic extreme short',
    body: {
      query: 'api',
      queryType: 'semantic',
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
  statusCode?: number;
  error?: string;
  latency?: any;
  resultCount?: number;
  topScore?: number;
}

const results: Result[] = [];

async function querySearch(indexId: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const options = {
      hostname: 'localhost',
      port: 3004,
      path: `/api/search/${indexId}/query`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-tenant-id': 'tenant-1',
      },
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (err) {
          reject(new Error(`Parse error: ${err}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('QUICK SEARCH BENCHMARK');
  console.log('='.repeat(80));
  console.log(`Runtime: ${RUNTIME_URL}`);
  console.log(`Queries: ${queries.length}`);
  console.log('='.repeat(80));
  console.log('');

  // Use test index ID
  const indexId = 'test-index-1';

  for (let i = 0; i < queries.length; i++) {
    const test = queries[i];
    console.log(`[${i + 1}/${queries.length}] ${test.name}`);

    const start = Date.now();

    try {
      const response = await querySearch(indexId, test.body);
      const end = Date.now();
      const totalMs = end - start;

      const result: Result = {
        name: test.name,
        success: response.statusCode === 200,
        totalMs,
        statusCode: response.statusCode,
        latency: response.data.latency,
        resultCount: response.data.results?.length || response.data.aggregations?.length || 0,
        topScore: response.data.results?.[0]?.score,
      };

      results.push(result);
      console.log(`  ✓ ${totalMs}ms (${result.resultCount} results)`);
    } catch (error) {
      const end = Date.now();
      const totalMs = end - start;

      const result: Result = {
        name: test.name,
        success: false,
        totalMs,
        error: error instanceof Error ? error.message : String(error),
      };

      results.push(result);
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('');
  console.log('='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  console.log('');

  const successful = results.filter((r) => r.success);
  console.log(`Successful: ${successful.length}/${results.length}`);
  console.log('');

  if (successful.length === 0) {
    console.log('No successful queries.');
    return;
  }

  // Stats
  const latencies = successful.map((r) => r.totalMs);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  console.log('Latency Statistics:');
  console.log(`  Average: ${avg.toFixed(0)}ms`);
  console.log(`  Min: ${min}ms`);
  console.log(`  Max: ${max}ms`);
  console.log(`  P50: ${p50}ms`);
  console.log(`  P90: ${p90}ms`);
  console.log(`  P95: ${p95}ms`);
  console.log('');

  // Detailed table
  console.log(
    'Query                              | Total  | Perm | Vocab | Search | Rerank | Results',
  );
  console.log('-'.repeat(90));

  successful.forEach((r) => {
    const name = r.name.substring(0, 34).padEnd(34);
    const total = `${r.totalMs}ms`.padStart(6);
    const perm = r.latency?.permissionFilterMs
      ? `${r.latency.permissionFilterMs}ms`.padStart(4)
      : '  - ';
    const vocab = r.latency?.vocabularyResolveMs
      ? `${r.latency.vocabularyResolveMs}ms`.padStart(5)
      : '  -  ';
    const search =
      r.latency?.searchExecutionMs || r.latency?.vectorSearchMs
        ? `${(r.latency.searchExecutionMs || r.latency.vectorSearchMs).toFixed(0)}ms`.padStart(6)
        : '   -  ';
    const rerank = r.latency?.rerankMs
      ? `${r.latency.rerankMs.toFixed(0)}ms`.padStart(6)
      : '   -  ';
    const count = `${r.resultCount || 0}`.padStart(7);

    console.log(`${name} | ${total} | ${perm} | ${vocab} | ${search} | ${rerank} | ${count}`);
  });

  console.log('');

  // Save JSON
  const fs = await import('fs/promises');
  await fs.writeFile(
    'tools/quick-benchmark-results.json',
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );
  console.log('Results saved to: tools/quick-benchmark-results.json');
}

runBenchmark().catch(console.error);
