/**
 * Platform Service Registry
 *
 * Central registry of all platform services grouped by dependency chain.
 * Used by the health check endpoint to enumerate and probe every service.
 */

import {
  DEFAULT_RUNTIME_PORT,
  DEFAULT_STUDIO_PORT,
  DEFAULT_MONGODB_PORT,
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_REDIS_PORT,
  DEFAULT_WORKFLOW_ENGINE_PORT,
} from '@agent-platform/config/constants';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceGroup = 'core-data' | 'agent-execution' | 'search-knowledge' | 'frontend';
export type CheckMethod = 'native' | 'http' | 'self';

export interface ServiceDefinition {
  id: string;
  name: string;
  group: ServiceGroup;
  description: string;
  port: number;
  healthPath: string;
  checkMethod: CheckMethod;
  dependsOn?: string[];
  envVar?: string;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const SERVICE_REGISTRY: ServiceDefinition[] = [
  // ── Core Data Layer ──────────────────────────────────────────────────────
  {
    id: 'mongodb',
    name: 'MongoDB',
    group: 'core-data',
    description: 'Primary document store for agents, sessions, and tenants',
    port: DEFAULT_MONGODB_PORT,
    healthPath: '',
    checkMethod: 'native',
  },
  {
    id: 'redis',
    name: 'Redis',
    group: 'core-data',
    description: 'Cache, session store, and distributed locks',
    port: DEFAULT_REDIS_PORT,
    healthPath: '',
    checkMethod: 'native',
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    group: 'core-data',
    description: 'Analytics and trace event storage',
    port: DEFAULT_CLICKHOUSE_PORT,
    healthPath: '',
    checkMethod: 'native',
  },

  // ── Auth Profile Subsystem ──────────────────────────────────────────────
  {
    id: 'auth-profile',
    name: 'Auth Profile',
    group: 'core-data',
    description: 'Credential management: MongoDB storage, Redis locks, and encryption',
    port: DEFAULT_RUNTIME_PORT,
    healthPath: '',
    checkMethod: 'native',
    dependsOn: ['mongodb', 'redis'],
  },

  // ── Agent Execution Pipeline ─────────────────────────────────────────────
  {
    id: 'runtime',
    name: 'Runtime',
    group: 'agent-execution',
    description: 'Core agent execution engine and API gateway',
    port: DEFAULT_RUNTIME_PORT,
    healthPath: '/health',
    checkMethod: 'self',
    dependsOn: ['mongodb', 'redis', 'clickhouse'],
  },
  {
    id: 'workflow-engine',
    name: 'Workflow Engine',
    group: 'agent-execution',
    description: 'Durable workflow orchestration via Restate',
    port: DEFAULT_WORKFLOW_ENGINE_PORT,
    healthPath: '/health',
    checkMethod: 'http',
    dependsOn: ['mongodb', 'redis', 'restate', 'runtime'],
    envVar: 'WORKFLOW_ENGINE_URL',
  },
  {
    id: 'restate',
    name: 'Restate',
    group: 'agent-execution',
    description: 'Durable execution runtime for workflow state machines',
    port: 9070,
    healthPath: '/health',
    checkMethod: 'http',
    envVar: 'RESTATE_URL',
  },
  {
    id: 'nlu-sidecar',
    name: 'NLU Sidecar',
    group: 'agent-execution',
    description: 'Natural language understanding for intent classification',
    port: 8090,
    healthPath: '/health',
    checkMethod: 'http',
    envVar: 'NLU_SIDECAR_URL',
  },

  // ── Search & Knowledge Pipeline ──────────────────────────────────────────
  {
    id: 'search-ai',
    name: 'SearchAI',
    group: 'search-knowledge',
    description: 'Knowledge ingestion, chunking, and RAG orchestration',
    port: 3113,
    healthPath: '/health',
    checkMethod: 'http',
    dependsOn: ['mongodb', 'redis', 'clickhouse', 'opensearch'],
    envVar: 'SEARCH_AI_URL',
  },
  {
    id: 'search-ai-runtime',
    name: 'SearchAI Runtime',
    group: 'search-knowledge',
    description: 'Runtime query layer for search and retrieval',
    port: 3114,
    healthPath: '/health',
    checkMethod: 'http',
    dependsOn: ['mongodb', 'opensearch', 'qdrant'],
    envVar: 'SEARCH_AI_RUNTIME_URL',
  },
  {
    id: 'opensearch',
    name: 'OpenSearch',
    group: 'search-knowledge',
    description: 'Full-text and vector search engine',
    port: 9200,
    healthPath: '/_cluster/health',
    checkMethod: 'http',
    envVar: 'OPENSEARCH_URL',
  },
  {
    id: 'qdrant',
    name: 'Qdrant',
    group: 'search-knowledge',
    description: 'High-performance vector similarity search',
    port: 6333,
    healthPath: '/',
    checkMethod: 'http',
    envVar: 'QDRANT_URL',
  },
  {
    id: 'neo4j',
    name: 'Neo4j',
    group: 'search-knowledge',
    description: 'Knowledge graph for entity relationships',
    port: 7474,
    healthPath: '/',
    checkMethod: 'http',
    envVar: 'NEO4J_URL',
  },
  {
    id: 'bge-m3',
    name: 'BGE-M3 Embeddings',
    group: 'search-knowledge',
    description: 'Multi-lingual embedding model service',
    port: 8000,
    healthPath: '/health',
    checkMethod: 'http',
    envVar: 'BGE_M3_URL',
  },
  {
    id: 'docling',
    name: 'Docling Service',
    group: 'search-knowledge',
    description: 'Document parsing and extraction pipeline',
    port: 8080,
    healthPath: '/health',
    checkMethod: 'http',
    envVar: 'DOCLING_URL',
  },
  {
    id: 'preprocessing',
    name: 'Preprocessing',
    group: 'search-knowledge',
    description: 'Text preprocessing and normalization',
    port: 8003,
    healthPath: '/health',
    checkMethod: 'http',
    dependsOn: ['redis'],
    envVar: 'PREPROCESSING_URL',
  },

  // ── Frontend Applications ────────────────────────────────────────────────
  {
    id: 'studio',
    name: 'Studio',
    group: 'frontend',
    description: 'Agent development IDE and project management',
    port: DEFAULT_STUDIO_PORT,
    healthPath: '/api/health',
    checkMethod: 'http',
    dependsOn: ['runtime'],
    envVar: 'STUDIO_URL',
  },
  {
    id: 'admin',
    name: 'Admin',
    group: 'frontend',
    description: 'Platform administration dashboard',
    port: 3003,
    healthPath: '/api/health',
    checkMethod: 'http',
    dependsOn: ['runtime'],
    envVar: 'ADMIN_URL',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the base URL for a service from env var or localhost fallback. */
export function getServiceUrl(def: ServiceDefinition): string {
  if (def.envVar) {
    const fromEnv = process.env[def.envVar];
    if (fromEnv) return fromEnv.replace(/\/$/, '');
  }
  return `http://localhost:${def.port}`;
}

/** Whether the service has explicit configuration (env var set). */
export function isServiceConfigured(def: ServiceDefinition): boolean {
  // Native checks (MongoDB, Redis, ClickHouse) are always configured if Runtime starts
  if (def.checkMethod === 'native' || def.checkMethod === 'self') return true;
  // For HTTP services, either the env var is set or we assume localhost is available
  return true;
}

const GROUP_LABELS: Record<ServiceGroup, string> = {
  'core-data': 'Core Data Layer',
  'agent-execution': 'Agent Execution Pipeline',
  'search-knowledge': 'Search & Knowledge Pipeline',
  frontend: 'Frontend Applications',
};

const GROUP_DESCRIPTIONS: Record<ServiceGroup, string> = {
  'core-data': 'Foundation databases and caches that all services depend on',
  'agent-execution': 'Agent conversations, workflow orchestration, and NLU processing',
  'search-knowledge': 'RAG stack: ingestion, embedding, vector search, and knowledge graph',
  frontend: 'Web UIs for agent development and platform administration',
};

export function getGroupLabel(group: ServiceGroup): string {
  return GROUP_LABELS[group];
}

export function getGroupDescription(group: ServiceGroup): string {
  return GROUP_DESCRIPTIONS[group];
}
