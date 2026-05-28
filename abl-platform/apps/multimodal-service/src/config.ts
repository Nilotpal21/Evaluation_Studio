/**
 * Multimodal Service Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Composes the base config schema with multimodal-specific extensions.
 */

import { z } from 'zod';
import {
  composeConfigSchema,
  createConfigLoader,
  validateProductionConfig,
  type BaseAppConfig,
} from '@agent-platform/config';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('multimodal-config');

// =============================================================================
// MULTIMODAL-SPECIFIC EXTENSIONS
// =============================================================================

const StorageConfigSchema = z.object({
  /** Storage backend provider */
  provider: z.enum(['local', 's3', 'gcs', 'azure_blob', 'minio', 'gridfs']).default('local'),
  /** Storage bucket or container name */
  bucket: z.string().default('attachments'),
  /** Cloud region (S3, GCS) */
  region: z.string().optional(),
  /** Custom endpoint (MinIO, S3-compatible) */
  endpoint: z.string().optional(),
  /** Local filesystem base path for 'local' provider */
  basePath: z.string().default('./data/attachments'),
});

const ScanConfigSchema = z.object({
  /** Whether virus scanning is enabled */
  enabled: z.coerce.boolean().default(false),
  /** ClamAV daemon host */
  clamavHost: z.string().default('localhost'),
  /** ClamAV daemon port */
  clamavPort: z.coerce.number().int().positive().default(3310),
});

const ProcessingConfigSchema = z.object({
  /** Maximum file size in bytes (default: 50MB) */
  maxFileSizeBytes: z.coerce.number().int().positive().default(52428800),
  /** Maximum image dimension for resize (default: 2048px) */
  imageMaxDimension: z.coerce.number().int().positive().default(2048),
  /** Thumbnail size in pixels (default: 256px) */
  thumbnailSize: z.coerce.number().int().positive().default(256),
  /** Apache Tika server URL for document parsing */
  tikaUrl: z.string().default('http://localhost:9998'),
  /** Whisper server URL for audio transcription */
  whisperUrl: z.string().default('http://localhost:8080'),
  /** Maximum concurrent processing jobs */
  maxConcurrentJobs: z.coerce.number().int().positive().default(5),
});

// =============================================================================
// COMPOSED SCHEMA
// =============================================================================

export const MultimodalServiceConfigSchema = composeConfigSchema({
  storage: StorageConfigSchema.default({}),
  scan: ScanConfigSchema.default({}),
  processing: ProcessingConfigSchema.default({}),
});

export type MultimodalServiceConfig = z.infer<typeof MultimodalServiceConfigSchema>;

// =============================================================================
// CONFIG LOADER
// =============================================================================

const ENV_MAPPING = {
  // Storage
  STORAGE_PROVIDER: 'storage.provider',
  STORAGE_BUCKET: 'storage.bucket',
  STORAGE_REGION: 'storage.region',
  STORAGE_ENDPOINT: 'storage.endpoint',
  STORAGE_BASE_PATH: 'storage.basePath',

  // Scanning
  SCAN_ENABLED: 'scan.enabled',
  CLAMAV_HOST: 'scan.clamavHost',
  CLAMAV_PORT: 'scan.clamavPort',

  // Processing
  MAX_FILE_SIZE_BYTES: 'processing.maxFileSizeBytes',
  IMAGE_MAX_DIMENSION: 'processing.imageMaxDimension',
  THUMBNAIL_SIZE: 'processing.thumbnailSize',
  TIKA_URL: 'processing.tikaUrl',
  WHISPER_URL: 'processing.whisperUrl',
  PROCESSING_MAX_CONCURRENT_JOBS: 'processing.maxConcurrentJobs',
};

function logConfigSummary(cfg: unknown): void {
  const c = cfg as MultimodalServiceConfig;
  log.info('Multimodal Service configuration loaded', {
    environment: c.env,
    server: `${c.server.host}:${c.server.port}`,
    storage: { provider: c.storage.provider, bucket: c.storage.bucket },
    scan: c.scan.enabled
      ? { enabled: true, host: c.scan.clamavHost, port: c.scan.clamavPort }
      : { enabled: false },
    processing: {
      maxFileSizeBytes: c.processing.maxFileSizeBytes,
      concurrency: c.processing.maxConcurrentJobs,
    },
  });
}

const loader = createConfigLoader(MultimodalServiceConfigSchema, {
  envMapping: ENV_MAPPING,
  productionChecks: (cfg) => validateProductionConfig(cfg as BaseAppConfig).map((w) => w.message),
  logSummary: logConfigSummary,
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
export const reloadConfig = loader.reloadConfig;
export const getConfigMeta = loader.getConfigMeta;
