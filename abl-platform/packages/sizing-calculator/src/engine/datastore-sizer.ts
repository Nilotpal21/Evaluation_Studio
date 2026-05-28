import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { DataStoreTopology, Tier, TtlPolicy, BackupConfig } from '../types/topology.types.js';
import { DATA_STORE_SPECS } from './constants.js';

const RETENTION_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
  '2y': 730,
  '3y': 1095,
  '7y': 2555,
  indefinite: 36500,
  'until-deleted': 36500,
};

/**
 * Size all 7 data stores based on tier and questionnaire inputs.
 *
 * Produces DataStoreTopology entries for MongoDB, Redis, ClickHouse,
 * OpenSearch, Neo4j, Qdrant, and Restate with appropriate sharding,
 * replication, and TTL policies.
 */
export function sizeDataStores(tier: Tier, questionnaire: Questionnaire): DataStoreTopology[] {
  return [
    sizeMongodb(tier, questionnaire),
    sizeRedis(tier, questionnaire),
    sizeClickhouse(tier, questionnaire),
    sizeOpensearch(tier, questionnaire),
    sizeNeo4j(tier, questionnaire),
    sizeQdrant(tier, questionnaire),
    sizeRestate(tier, questionnaire),
  ];
}

function makeBackupConfig(frequency: string, q: Questionnaire): BackupConfig {
  return {
    frequency,
    destination: q.deployment.cloudProvider === 'aws' ? 's3' : 'object-storage',
    retentionDays: RETENTION_DAYS[q.observability.auditLogRetention] ?? 365,
    pitr: frequency === 'continuous',
  };
}

function sizeMongodb(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.mongodb[tier];
  const ttlPolicies: TtlPolicy[] = [
    {
      collection: 'messages',
      ttlDays: RETENTION_DAYS[q.retention.conversationRetention] ?? 90,
      action: 'delete',
    },
    {
      collection: 'sessions',
      ttlDays: RETENTION_DAYS[q.retention.conversationRetention] ?? 90,
      action: 'archive',
    },
    {
      collection: 'audit-logs',
      ttlDays: RETENTION_DAYS[q.observability.auditLogRetention] ?? 365,
      action: 'archive',
    },
  ];

  return {
    name: 'mongodb',
    replicas: spec.replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
    ttlPolicies,
  };
}

function sizeRedis(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.redis[tier];

  return {
    name: 'redis',
    replicas: spec.replicas,
    resources: { cpu: spec.cpu, memory: spec.memory },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
  };
}

function sizeClickhouse(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.clickhouse[tier];
  const ttlPolicies: TtlPolicy[] = [
    {
      collection: 'trace_events',
      ttlDays: RETENTION_DAYS[q.observability.traceRetention] ?? 30,
      action: 'delete',
    },
    {
      collection: 'metrics',
      ttlDays: RETENTION_DAYS[q.observability.metricsRetention] ?? 90,
      action: 'move-cold',
    },
    {
      collection: 'usage_events',
      ttlDays: RETENTION_DAYS[q.observability.metricsRetention] ?? 90,
      action: 'archive',
    },
  ];

  // Add 3 Keeper nodes for ClickHouse consensus
  const keeperNodes = 3;

  return {
    name: 'clickhouse',
    replicas: spec.replicas + keeperNodes,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
    ttlPolicies,
  };
}

function sizeOpensearch(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.opensearch[tier];
  const ttlPolicies: TtlPolicy[] = [
    {
      collection: 'search-chunks',
      ttlDays: RETENTION_DAYS[q.retention.documentRetention] ?? 365,
      action: 'delete',
    },
    {
      collection: 'search-vectors',
      ttlDays: RETENTION_DAYS[q.retention.documentRetention] ?? 365,
      action: 'delete',
    },
  ];

  return {
    name: 'opensearch',
    replicas: spec.replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
    ttlPolicies,
  };
}

function sizeNeo4j(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.neo4j[tier];

  return {
    name: 'neo4j',
    replicas: spec.replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
  };
}

function sizeQdrant(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.qdrant[tier];

  return {
    name: 'qdrant',
    replicas: spec.replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
  };
}

function sizeRestate(tier: Tier, q: Questionnaire): DataStoreTopology {
  const spec = DATA_STORE_SPECS.restate[tier];

  return {
    name: 'restate',
    replicas: spec.replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      storage: spec.storage,
      storageClass: spec.storageClass,
    },
    nodePool: spec.nodePool,
    shardCount: spec.shardCount,
    replicationFactor: spec.replicationFactor,
    partitionStrategy: spec.partitionStrategy,
    backupConfig: makeBackupConfig(spec.backupFrequency, q),
  };
}
