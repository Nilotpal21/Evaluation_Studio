/** Deployment tier classification */
export type Tier = 'S' | 'M' | 'L' | 'XL';

/** HPA (Horizontal Pod Autoscaler) configuration */
export interface HpaConfig {
  minReplicas: number;
  maxReplicas: number;
  targetCPUPercent: number;
  targetMemoryPercent?: number;
  kedaTriggers?: KedaTrigger[];
}

/** KEDA event-driven scaling trigger */
export interface KedaTrigger {
  type: string;
  metadata: Record<string, string>;
}

/** Node pool definition for K8s cluster */
export interface NodePool {
  name: string;
  instanceType: string;
  minNodes: number;
  maxNodes: number;
  taints?: NodeTaint[];
  labels: Record<string, string>;
}

/** K8s node taint */
export interface NodeTaint {
  key: string;
  value: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

/** Base resource specification for a service */
export interface ResourceSpec {
  cpu: string;
  memory: string;
  storage?: string;
  storageClass?: string;
  gpu?: string;
}

/** Per-service topology recommendation */
export interface ServiceTopology {
  name: string;
  replicas: number;
  resources: ResourceSpec;
  nodePool: string;
  hpa?: HpaConfig;
  notes?: string;
}

/** Data store topology extends service topology with clustering details */
export interface DataStoreTopology extends ServiceTopology {
  shardCount?: number;
  replicationFactor: number;
  partitionStrategy?: string;
  backupConfig: BackupConfig;
  ttlPolicies?: TtlPolicy[];
}

/** Backup configuration for data stores */
export interface BackupConfig {
  frequency: string;
  destination: string;
  retentionDays: number;
  pitr?: boolean;
}

/** TTL policy for data lifecycle management */
export interface TtlPolicy {
  collection: string;
  ttlDays: number;
  action: 'delete' | 'archive' | 'move-cold';
}

/** Disk growth projection per data store */
export interface DiskGrowthProjection {
  storeName: string;
  monthlyGB: number;
  yearlyGB: number;
  drivers: string[];
}

/** Managed service recommendation */
export interface ManagedServiceRecommendation {
  storeName: string;
  recommendation: 'self-hosted' | 'managed';
  managedService?: string;
  reason: string;
}

/** Complete cluster topology output */
export interface ClusterTopology {
  tier: Tier;
  cloudProvider: string;
  regionCount: number;
  services: ServiceTopology[];
  dataStores: DataStoreTopology[];
  nodePools: NodePool[];
  totalNodes: { min: number; max: number };
  diskGrowth: DiskGrowthProjection[];
  managedRecommendations: ManagedServiceRecommendation[];
  monthlyStorageGrowthGB: number;
}
