import type {
  ClusterTopology,
  ServiceTopology,
  DataStoreTopology,
} from '../types/topology.types.js';

/**
 * Generate Helm values YAML strings from a ClusterTopology.
 *
 * Returns a map of filename → YAML content for each component:
 * - Application services values
 * - Per-data-store operator values (Percona MongoDB, Altinity ClickHouse, etc.)
 */
export function generateHelmValues(topology: ClusterTopology): Record<string, string> {
  const values: Record<string, string> = {};

  // Application services
  values['app-services.yaml'] = generateAppServicesValues(topology);

  // Data store operator values
  for (const store of topology.dataStores) {
    const filename = `${store.name}-operator.yaml`;
    values[filename] = generateDataStoreValues(store, topology);
  }

  // Node pools (for Karpenter/cluster-autoscaler)
  values['node-pools.yaml'] = generateNodePoolValues(topology);

  return values;
}

function generateAppServicesValues(topology: ClusterTopology): string {
  const lines: string[] = ['# Application Services Helm Values', `# Tier: ${topology.tier}`, ''];

  for (const service of topology.services) {
    lines.push(...renderService(service));
    lines.push('');
  }

  return lines.join('\n');
}

function renderService(service: ServiceTopology): string[] {
  const name = service.name.replace(/-/g, '_');
  const lines: string[] = [];

  lines.push(`${name}:`);
  lines.push(`  replicas: ${service.replicas}`);
  lines.push(`  resources:`);
  lines.push(`    requests:`);
  lines.push(`      cpu: "${service.resources.cpu}"`);
  lines.push(`      memory: "${service.resources.memory}"`);
  lines.push(`    limits:`);
  lines.push(`      cpu: "${service.resources.cpu}"`);
  lines.push(`      memory: "${service.resources.memory}"`);

  if (service.resources.gpu) {
    lines.push(`      nvidia.com/gpu: "${service.resources.gpu}"`);
  }

  lines.push(`  nodeSelector:`);
  lines.push(`    node-role: ${service.nodePool}`);

  if (service.hpa) {
    lines.push(`  autoscaling:`);
    lines.push(`    enabled: true`);
    lines.push(`    minReplicas: ${service.hpa.minReplicas}`);
    lines.push(`    maxReplicas: ${service.hpa.maxReplicas}`);
    lines.push(`    targetCPUUtilizationPercentage: ${service.hpa.targetCPUPercent}`);
    if (service.hpa.targetMemoryPercent) {
      lines.push(`    targetMemoryUtilizationPercentage: ${service.hpa.targetMemoryPercent}`);
    }
    if (service.hpa.kedaTriggers?.length) {
      lines.push(`    keda:`);
      lines.push(`      enabled: true`);
      lines.push(`      triggers:`);
      for (const trigger of service.hpa.kedaTriggers) {
        lines.push(`        - type: ${trigger.type}`);
        lines.push(`          metadata:`);
        for (const [key, value] of Object.entries(trigger.metadata)) {
          lines.push(`            ${key}: "${value}"`);
        }
      }
    }
  }

  return lines;
}

function generateDataStoreValues(store: DataStoreTopology, topology: ClusterTopology): string {
  const lines: string[] = [
    `# ${store.name} Operator Values`,
    `# Tier: ${topology.tier}`,
    `# Cloud Provider: ${topology.cloudProvider}`,
    '',
  ];

  switch (store.name) {
    case 'mongodb':
      lines.push(...renderMongodbValues(store));
      break;
    case 'redis':
      lines.push(...renderRedisValues(store));
      break;
    case 'clickhouse':
      lines.push(...renderClickhouseValues(store));
      break;
    case 'opensearch':
      lines.push(...renderOpensearchValues(store));
      break;
    case 'neo4j':
      lines.push(...renderNeo4jValues(store));
      break;
    case 'qdrant':
      lines.push(...renderQdrantValues(store));
      break;
    case 'restate':
      lines.push(...renderRestateValues(store));
      break;
    default:
      lines.push(...renderGenericDataStoreValues(store));
  }

  return lines.join('\n');
}

function renderMongodbValues(store: DataStoreTopology): string[] {
  return [
    'psmdb:',
    `  replsets:`,
    `    - name: rs0`,
    `      size: ${store.replicationFactor}`,
    `      resources:`,
    `        requests:`,
    `          cpu: "${store.resources.cpu}"`,
    `          memory: "${store.resources.memory}"`,
    `      volumeSpec:`,
    `        persistentVolumeClaim:`,
    `          storageClassName: ${store.resources.storageClass ?? 'gp3'}`,
    `          resources:`,
    `            requests:`,
    `              storage: ${store.resources.storage ?? '100Gi'}`,
    ...(store.shardCount && store.shardCount > 1
      ? [
          `  sharding:`,
          `    enabled: true`,
          `    mongos:`,
          `      size: 2`,
          `    configsvrReplSet:`,
          `      size: 3`,
        ]
      : []),
    `  backup:`,
    `    enabled: true`,
    `    schedule: "${store.backupConfig.frequency === 'continuous' ? '*/10 * * * *' : '0 2 * * *'}"`,
    `    storages:`,
    `      s3-backup:`,
    `        type: s3`,
  ];
}

function renderRedisValues(store: DataStoreTopology): string[] {
  const isCluster = (store.shardCount ?? 1) > 1;
  return [
    `redisCluster:`,
    `  clusterSize: ${store.shardCount}`,
    `  followerReplicas: ${store.replicationFactor - 1}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  redisConfig:`,
    `    additionalConfig: maxmemory-policy noeviction`,
    ...(isCluster ? [`  clusterMode: true`] : []),
  ];
}

function renderClickhouseValues(store: DataStoreTopology): string[] {
  const dataReplicas = store.replicas - 3; // subtract 3 Keeper nodes
  return [
    `clickhouse:`,
    `  shardsCount: ${store.shardCount}`,
    `  replicasCount: ${store.replicationFactor}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  storage:`,
    `    type: pvc`,
    `    storageClass: ${store.resources.storageClass ?? 'gp3'}`,
    `    size: ${store.resources.storage ?? '50Gi'}`,
    `  keeper:`,
    `    replicas: 3`,
    `    resources:`,
    `      requests:`,
    `        cpu: "0.5"`,
    `        memory: "1Gi"`,
  ];
}

function renderOpensearchValues(store: DataStoreTopology): string[] {
  return [
    `opensearch:`,
    `  replicas: ${store.replicas}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  persistence:`,
    `    storageClass: ${store.resources.storageClass ?? 'gp3'}`,
    `    size: ${store.resources.storage ?? '50Gi'}`,
    `  config:`,
    `    opensearch.yml:`,
    `      plugins.security.ssl.http.enabled: true`,
  ];
}

function renderNeo4jValues(store: DataStoreTopology): string[] {
  return [
    `neo4j:`,
    `  core:`,
    `    numberOfServers: ${Math.min(store.replicationFactor, store.replicas)}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  volumes:`,
    `    data:`,
    `      mode: defaultStorageClass`,
    `      defaultStorageClass:`,
    `        requests:`,
    `          storage: ${store.resources.storage ?? '20Gi'}`,
  ];
}

function renderQdrantValues(store: DataStoreTopology): string[] {
  return [
    `qdrant:`,
    `  replicas: ${store.replicas}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  persistence:`,
    `    storageClassName: ${store.resources.storageClass ?? 'gp3'}`,
    `    size: ${store.resources.storage ?? '20Gi'}`,
    `  config:`,
    `    collection:`,
    `      replication_factor: ${store.replicationFactor}`,
    `      shard_number: ${store.shardCount}`,
  ];
}

function renderRestateValues(store: DataStoreTopology): string[] {
  return [
    `restate:`,
    `  replicas: ${store.replicas}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
    `  storage:`,
    `    storageClassName: ${store.resources.storageClass ?? 'gp3'}`,
    `    size: ${store.resources.storage ?? '20Gi'}`,
    `  config:`,
    `    num_partitions: ${store.shardCount}`,
  ];
}

function renderGenericDataStoreValues(store: DataStoreTopology): string[] {
  return [
    `${store.name}:`,
    `  replicas: ${store.replicas}`,
    `  resources:`,
    `    requests:`,
    `      cpu: "${store.resources.cpu}"`,
    `      memory: "${store.resources.memory}"`,
  ];
}

function generateNodePoolValues(topology: ClusterTopology): string {
  const lines: string[] = [
    '# Node Pool Configuration',
    `# Tier: ${topology.tier}`,
    `# Provider: ${topology.cloudProvider}`,
    '',
    'nodePools:',
  ];

  for (const pool of topology.nodePools) {
    lines.push(`  - name: ${pool.name}`);
    lines.push(`    instanceType: ${pool.instanceType}`);
    lines.push(`    minSize: ${pool.minNodes}`);
    lines.push(`    maxSize: ${pool.maxNodes}`);
    lines.push(`    labels:`);
    for (const [key, value] of Object.entries(pool.labels)) {
      lines.push(`      ${key}: "${value}"`);
    }
    if (pool.taints?.length) {
      lines.push(`    taints:`);
      for (const taint of pool.taints) {
        lines.push(`      - key: ${taint.key}`);
        lines.push(`        value: "${taint.value}"`);
        lines.push(`        effect: ${taint.effect}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
