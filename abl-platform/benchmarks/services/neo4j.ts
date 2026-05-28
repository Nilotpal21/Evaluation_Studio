/**
 * Neo4j benchmark: Cypher traversals and batch node creation.
 *
 * Targets Neo4j HTTP API for graph operations typical of
 * agent topology, knowledge graphs, and relationship traversals.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import { dbQueryLatency, dbWriteLatency, successRate } from '../lib/metrics.ts';

const NEO4J_HTTP = config.neo4jUrl.replace('bolt://', 'http://').replace('7687', '7474');
const TENANT_ID = config.tenantId;

// ---------------------------------------------------------------------------
// Setup — direct service connection (no auth required)
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json;charset=UTF-8',
  };
  return { token: '', refreshToken: '', headers };
}

function cypher(
  statement: string,
  parameters: Record<string, unknown> = {},
  headers: Record<string, string>,
): http.RefinedResponse<'text'> {
  return http.post(
    `${NEO4J_HTTP}/db/neo4j/tx/commit`,
    JSON.stringify({
      statements: [{ statement, parameters }],
    }),
    { headers },
  );
}

export const options = {
  scenarios: {
    batchNodeCreation: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'batchNodeCreation',
    },
    singleHopTraversal: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'singleHopTraversal',
    },
    threeHopTraversal: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'threeHopTraversal',
    },
    fiveHopTraversal: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 5 },
        { duration: '1m', target: 10 },
      ],
      exec: 'fiveHopTraversal',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<400', 'p(99)<800'],
    abl_db_query_latency_ms: ['p(95)<500', 'p(99)<2000'],
    abl_success_rate: ['rate>0.99'],
  },
};

/** Batch create agent nodes with relationships in a single transaction. */
export function batchNodeCreation(data: SetupData): void {
  ensureFreshAuth(data);
  const batchSize = 20;
  const agentPrefix = `bench-agent-${__VU}-${__ITER}`;

  // Create agent nodes and DELEGATES_TO relationships
  const statement =
    `UNWIND range(0, $batchSize - 1) AS i ` +
    `CREATE (a:Agent {` +
    `  id: $prefix + '-' + toString(i), ` +
    `  tenantId: $tenantId, ` +
    `  type: CASE WHEN i % 3 = 0 THEN 'supervisor' ` +
    `              WHEN i % 3 = 1 THEN 'reasoning' ` +
    `              ELSE 'scripted' END, ` +
    `  createdAt: datetime()` +
    `}) ` +
    `WITH collect(a) AS agents ` +
    `UNWIND range(0, size(agents) - 2) AS i ` +
    `WITH agents[i] AS parent, agents[i + 1] AS child ` +
    `WHERE parent.type = 'supervisor' ` +
    `CREATE (parent)-[:DELEGATES_TO {weight: 1.0}]->(child) ` +
    `RETURN count(*) AS relCount`;

  const start = Date.now();
  const res = cypher(
    statement,
    { batchSize, prefix: agentPrefix, tenantId: TENANT_ID },
    data.headers,
  );
  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, { 'batch create 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[batch_node_creation] status=${res.status}`);

  sleep(0.1);
}

/** Single-hop traversal: find immediate delegates of a supervisor. */
export function singleHopTraversal(data: SetupData): void {
  ensureFreshAuth(data);
  const statement =
    `MATCH (s:Agent {tenantId: $tenantId, type: 'supervisor'})-[:DELEGATES_TO]->(d) ` +
    `RETURN s.id AS supervisor, collect(d.id) AS delegates, count(d) AS delegateCount ` +
    `LIMIT 50`;

  const start = Date.now();
  const res = cypher(statement, { tenantId: TENANT_ID }, data.headers);
  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { '1-hop 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[single_hop_traversal] status=${res.status}`);

  sleep(0.1);
}

/** Three-hop traversal: find delegation chains up to depth 3. */
export function threeHopTraversal(data: SetupData): void {
  ensureFreshAuth(data);
  const statement =
    `MATCH path = (s:Agent {tenantId: $tenantId, type: 'supervisor'})` +
    `-[:DELEGATES_TO*1..3]->(target) ` +
    `RETURN s.id AS root, ` +
    `  [n IN nodes(path) | n.id] AS chain, ` +
    `  length(path) AS depth ` +
    `ORDER BY depth DESC LIMIT 100`;

  const start = Date.now();
  const res = cypher(statement, { tenantId: TENANT_ID }, data.headers);
  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { '3-hop 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[three_hop_traversal] status=${res.status}`);

  sleep(0.15);
}

/** Five-hop traversal: deep graph exploration with property filtering. */
export function fiveHopTraversal(data: SetupData): void {
  ensureFreshAuth(data);
  const statement =
    `MATCH path = (s:Agent {tenantId: $tenantId})` +
    `-[:DELEGATES_TO|HANDOFF_TO*1..5]->(target) ` +
    `WHERE target.type IN ['reasoning', 'scripted'] ` +
    `WITH s, target, path, length(path) AS depth ` +
    `RETURN s.id AS source, target.id AS destination, ` +
    `  depth, [r IN relationships(path) | type(r)] AS relTypes ` +
    `ORDER BY depth DESC LIMIT 200`;

  const start = Date.now();
  const res = cypher(statement, { tenantId: TENANT_ID }, data.headers);
  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { '5-hop 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[five_hop_traversal] status=${res.status}`);

  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  batchNodeCreation(data);
}
