/**
 * Core types for configuration management.
 */

/** Supported deployment regions */
export type Region = 'us-east-1' | 'eu-west-1' | 'ap-southeast-1';

/** Deployment context injected at load time */
export interface DeploymentContext {
  region?: Region;
  clusterName?: string;
  namespace?: string;
  podName?: string;
}

/** A single recorded config change event for audit trail */
export interface ConfigChangeEvent {
  timestamp: Date;
  source: 'vault' | 'file' | 'mongodb' | 'api' | 'env';
  triggeredBy?: string;
  changes: Array<{
    path: string;
    status: 'added' | 'removed' | 'changed';
    isSensitive: boolean;
  }>;
  reason?: string;
}

/** Metadata about the loaded configuration */
export interface ConfigMeta {
  loadedAt: Date;
  environment: string;
  vaultType: string;
  region?: Region;
  validationWarnings: string[];
  /** SHA-256 hash of the loaded config */
  configHash?: string;
  /** Schema version from @agent-platform/config */
  configSchemaVersion?: string;
  /** Count of non-null secret values that were resolved */
  secretsResolved?: number;
  /** Count of null/missing secret values */
  secretsMissing?: number;
  /** Name of the vault provider used */
  vaultProvider?: string;
  /** Error message from the last failed reload attempt */
  lastReloadError?: string;
  /** Audit trail of config change events */
  changeHistory?: ConfigChangeEvent[];
}

/** Identity of a specific deployment for config resolution */
export interface DeploymentIdentity {
  environment: 'dev' | 'staging' | 'production';
  region: string;
  deploymentType:
    | 'shared-dev'
    | 'saas-multi-tenant'
    | 'saas-dedicated'
    | 'private-vpc'
    | 'on-premise';
  customerId?: string;
  vaultPath?: string;
}

/** Manifest describing the build that produced the running artifact */
export interface BuildManifest {
  productVersion: string;
  buildHash: string;
  buildTimestamp: string;
  configSchemaVersion: string;
}
