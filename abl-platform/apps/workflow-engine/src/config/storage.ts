/**
 * Workflow-engine storage config — mirrors apps/search-ai/src/config/index.ts.
 *
 * Identical env var names, identical defaults. When STORAGE_PROVIDER=local
 * (default), the writer drops files at STORAGE_BASE_PATH (default ./uploads).
 * In cluster, that path is the NFS-backed PVC mount at /app/uploads.
 *
 * S3/MinIO modes are supported for parity with search-ai but not used by
 * any environment today.
 */

export type StorageProvider = 'local' | 's3' | 'minio';

export interface WorkflowEngineStorageConfig {
  provider: StorageProvider;
  bucket?: string;
  region?: string;
  endpoint?: string;
  basePath?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function parseProvider(value: string | undefined): StorageProvider {
  if (value === 's3' || value === 'minio' || value === 'local') return value;
  return 'local';
}

let cached: WorkflowEngineStorageConfig | null = null;

export function getStorageConfig(): WorkflowEngineStorageConfig {
  if (cached) return cached;
  cached = {
    provider: parseProvider(process.env.STORAGE_PROVIDER),
    bucket: process.env.STORAGE_BUCKET || 'abl-platform-workflow-attachments',
    region: process.env.STORAGE_REGION,
    endpoint: process.env.STORAGE_ENDPOINT,
    basePath: process.env.STORAGE_BASE_PATH || './uploads',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
  return cached;
}

/** Test-only: reset memoized config so env-var changes between tests take effect. */
export function __resetStorageConfigForTests(): void {
  cached = null;
}
