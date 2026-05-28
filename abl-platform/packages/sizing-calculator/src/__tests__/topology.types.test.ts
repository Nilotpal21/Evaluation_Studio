import { describe, it, expect } from 'vitest';
import type {
  ClusterTopology,
  ServiceTopology,
  DataStoreTopology,
  NodePool,
  HpaConfig,
} from '../types/topology.types.js';

describe('Topology types', () => {
  it('creates a valid ServiceTopology', () => {
    const service: ServiceTopology = {
      name: 'runtime',
      replicas: 3,
      resources: { cpu: '2', memory: '4Gi' },
      nodePool: 'general',
      hpa: {
        minReplicas: 3,
        maxReplicas: 10,
        targetCPUPercent: 70,
      },
    };
    expect(service.name).toBe('runtime');
    expect(service.replicas).toBe(3);
    expect(service.hpa?.maxReplicas).toBe(10);
  });

  it('creates a valid DataStoreTopology', () => {
    const store: DataStoreTopology = {
      name: 'mongodb',
      replicas: 3,
      resources: { cpu: '4', memory: '16Gi', storage: '500Gi', storageClass: 'gp3' },
      nodePool: 'data',
      replicationFactor: 3,
      shardCount: 1,
      partitionStrategy: 'none',
      backupConfig: {
        frequency: 'daily',
        destination: 's3',
        retentionDays: 30,
        pitr: false,
      },
      ttlPolicies: [
        { collection: 'messages', ttlDays: 90, action: 'delete' },
        { collection: 'audit-logs', ttlDays: 365, action: 'archive' },
      ],
    };
    expect(store.shardCount).toBe(1);
    expect(store.replicationFactor).toBe(3);
    expect(store.ttlPolicies).toHaveLength(2);
  });

  it('creates a valid NodePool', () => {
    const pool: NodePool = {
      name: 'gpu',
      instanceType: 'p4d.24xlarge',
      minNodes: 1,
      maxNodes: 4,
      taints: [{ key: 'nvidia.com/gpu', value: 'true', effect: 'NoSchedule' }],
      labels: { 'node-type': 'gpu', accelerator: 'nvidia-a100' },
    };
    expect(pool.taints).toHaveLength(1);
    expect(pool.labels['node-type']).toBe('gpu');
  });

  it('creates a valid HpaConfig with KEDA triggers', () => {
    const hpa: HpaConfig = {
      minReplicas: 2,
      maxReplicas: 20,
      targetCPUPercent: 70,
      targetMemoryPercent: 80,
      kedaTriggers: [
        {
          type: 'redis',
          metadata: { address: 'redis:6379', listName: 'queue:embedding', listLength: '100' },
        },
      ],
    };
    expect(hpa.kedaTriggers).toHaveLength(1);
    expect(hpa.kedaTriggers![0].type).toBe('redis');
  });

  it('creates a complete ClusterTopology', () => {
    const topology: ClusterTopology = {
      tier: 'M',
      cloudProvider: 'aws',
      regionCount: 1,
      services: [
        {
          name: 'runtime',
          replicas: 3,
          resources: { cpu: '2', memory: '4Gi' },
          nodePool: 'general',
        },
      ],
      dataStores: [
        {
          name: 'mongodb',
          replicas: 3,
          resources: { cpu: '4', memory: '16Gi', storage: '500Gi' },
          nodePool: 'data',
          replicationFactor: 3,
          backupConfig: { frequency: 'daily', destination: 's3', retentionDays: 30 },
        },
      ],
      nodePools: [
        { name: 'general', instanceType: 'm5.xlarge', minNodes: 3, maxNodes: 8, labels: {} },
        { name: 'data', instanceType: 'r5.2xlarge', minNodes: 2, maxNodes: 6, labels: {} },
      ],
      totalNodes: { min: 5, max: 14 },
      diskGrowth: [{ storeName: 'mongodb', monthlyGB: 50, yearlyGB: 600, drivers: ['messages'] }],
      managedRecommendations: [
        { storeName: 'mongodb', recommendation: 'managed', managedService: 'Atlas', reason: 'HA' },
      ],
      monthlyStorageGrowthGB: 150,
    };
    expect(topology.tier).toBe('M');
    expect(topology.services).toHaveLength(1);
    expect(topology.dataStores).toHaveLength(1);
    expect(topology.nodePools).toHaveLength(2);
  });
});
