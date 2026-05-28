/**
 * Local type definitions for MongoDB configuration.
 *
 * Mirrors the MongoDBConfig from @agent-platform/config to avoid
 * circular dependency during build. Runtime code should use the
 * config package types where possible.
 */

export interface MongoDBConfig {
  enabled: boolean;
  url: string;
  database: string;
  minPoolSize: number;
  maxPoolSize: number;
  maxIdleTimeMs: number;
  waitQueueTimeoutMs?: number;
  connectTimeoutMs: number;
  socketTimeoutMs: number;
  serverSelectionTimeoutMs: number;
  heartbeatFrequencyMs: number;
  tls: boolean;
  tlsCAFile?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsAllowInvalidCertificates: boolean;
  replicaSet?: string;
  authSource: string;
  authMechanism?: 'SCRAM-SHA-256' | 'SCRAM-SHA-1' | 'MONGODB-X509' | 'MONGODB-AWS';
  writeConcern: '0' | '1' | 'majority';
  readPreference: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
  readConcern?: 'local' | 'majority' | 'linearizable' | 'snapshot';
  retryWrites: boolean;
  retryReads: boolean;
  compressors?: string;
  directConnection: boolean;
  autoIndex: boolean;
  slowQueryThresholdMs: number;
  appName: string;
}
