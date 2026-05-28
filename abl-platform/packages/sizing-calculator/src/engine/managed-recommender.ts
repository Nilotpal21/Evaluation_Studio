import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { Tier, ManagedServiceRecommendation } from '../types/topology.types.js';

/**
 * Recommend managed vs self-hosted for each data store based on
 * cloud provider, tier, and network isolation from design doc Section 9.
 *
 * Decision rules:
 * - Air-gapped → always self-hosted
 * - XL tier → managed recommended for reduced ops burden
 * - Restate → always self-hosted (no managed offering)
 */
export function recommendManagedServices(
  tier: Tier,
  questionnaire: Questionnaire,
): ManagedServiceRecommendation[] {
  const { cloudProvider, networkIsolation } = questionnaire.deployment;
  const isAirGapped = networkIsolation === 'air-gapped';

  return [
    recommendMongodb(cloudProvider, tier, isAirGapped),
    recommendRedis(cloudProvider, tier, isAirGapped),
    recommendClickhouse(cloudProvider, tier, isAirGapped),
    recommendOpensearch(cloudProvider, tier, isAirGapped),
    recommendNeo4j(cloudProvider, tier, isAirGapped),
    recommendQdrant(cloudProvider, tier, isAirGapped),
    recommendRestate(),
  ];
}

function recommendMongodb(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return { storeName: 'mongodb', recommendation: 'self-hosted', reason: 'Air-gapped deployment' };
  }
  if (tier === 'S') {
    return {
      storeName: 'mongodb',
      recommendation: 'self-hosted',
      reason: 'Small scale — self-hosted is cost-effective',
    };
  }

  const managed: Record<string, string> = {
    aws: 'MongoDB Atlas (DocumentDB has feature gaps)',
    azure: 'MongoDB Atlas (CosmosDB vCore has ~32% API compatibility)',
    gcp: 'MongoDB Atlas',
  };

  return {
    storeName: 'mongodb',
    recommendation: 'managed',
    managedService: managed[provider] ?? 'MongoDB Atlas',
    reason: 'HA, automated backups, scaling',
  };
}

function recommendRedis(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return { storeName: 'redis', recommendation: 'self-hosted', reason: 'Air-gapped deployment' };
  }
  if (tier === 'S') {
    return {
      storeName: 'redis',
      recommendation: 'self-hosted',
      reason: 'Low volume — self-hosted is sufficient',
    };
  }

  const managed: Record<string, string> = {
    aws: 'ElastiCache (provisioned, Valkey engine — NOT serverless)',
    azure: 'Azure Cache for Redis Enterprise',
    gcp: 'Memorystore for Redis Cluster',
  };

  return {
    storeName: 'redis',
    recommendation: 'managed',
    managedService: managed[provider] ?? 'Managed Redis Cluster',
    reason:
      'Cluster mode, auto-failover, encryption. Note: use provisioned, not serverless (BullMQ)',
  };
}

function recommendClickhouse(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return {
      storeName: 'clickhouse',
      recommendation: 'self-hosted',
      reason: 'Air-gapped deployment',
    };
  }
  if (tier === 'S' || tier === 'M') {
    return {
      storeName: 'clickhouse',
      recommendation: 'self-hosted',
      reason: 'Moderate scale — Altinity Operator is well-suited',
    };
  }

  return {
    storeName: 'clickhouse',
    recommendation: 'managed',
    managedService: 'ClickHouse Cloud',
    reason: 'Auto-scaling, lower ops burden at enterprise scale',
  };
}

function recommendOpensearch(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return {
      storeName: 'opensearch',
      recommendation: 'self-hosted',
      reason: 'Air-gapped deployment',
    };
  }

  if (tier === 'S') {
    return {
      storeName: 'opensearch',
      recommendation: 'self-hosted',
      reason: 'Small scale — K8s operator is sufficient',
    };
  }

  const managed: Record<string, string> = {
    aws: 'AWS OpenSearch Service',
    azure: 'Azure AI Search / Elastic Cloud',
    gcp: 'Elastic Cloud on GCP',
  };

  return {
    storeName: 'opensearch',
    recommendation: 'managed',
    managedService: managed[provider] ?? 'Managed OpenSearch',
    reason: 'Auto-scaling, GPU acceleration, serverless vector engine',
  };
}

function recommendNeo4j(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return { storeName: 'neo4j', recommendation: 'self-hosted', reason: 'Air-gapped deployment' };
  }
  if (tier === 'S' || tier === 'M') {
    return {
      storeName: 'neo4j',
      recommendation: 'self-hosted',
      reason: '<100K nodes — self-hosted is cost-effective',
    };
  }

  return {
    storeName: 'neo4j',
    recommendation: 'managed',
    managedService: 'Neo4j AuraDB Enterprise',
    reason: 'Managed backups, enterprise features, scaling',
  };
}

function recommendQdrant(
  provider: string,
  tier: Tier,
  airGapped: boolean,
): ManagedServiceRecommendation {
  if (airGapped) {
    return { storeName: 'qdrant', recommendation: 'self-hosted', reason: 'Air-gapped deployment' };
  }
  if (tier === 'S' || tier === 'M') {
    return {
      storeName: 'qdrant',
      recommendation: 'self-hosted',
      reason: 'Fixed infra cost is lower at moderate scale',
    };
  }

  return {
    storeName: 'qdrant',
    recommendation: 'managed',
    managedService: 'Qdrant Cloud',
    reason: 'Zero ops, Hybrid Cloud option for middle ground',
  };
}

function recommendRestate(): ManagedServiceRecommendation {
  return {
    storeName: 'restate',
    recommendation: 'self-hosted',
    reason: 'No managed offering available',
  };
}
