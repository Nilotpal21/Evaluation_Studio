import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock the provider modules so we can verify constructor args without
// performing real I/O or requiring AWS SDK at import time.
// =============================================================================

const { MockLocalStorageProvider, MockS3StorageProvider } = vi.hoisted(() => {
  class _MockLocalStorageProvider {
    readonly name = 'local';
    constructor(public opts: { basePath: string }) {}
  }

  class _MockS3StorageProvider {
    readonly name = 's3';
    constructor(
      public opts: {
        bucket: string;
        region: string;
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
      },
    ) {}
  }

  return {
    MockLocalStorageProvider: _MockLocalStorageProvider,
    MockS3StorageProvider: _MockS3StorageProvider,
  };
});

vi.mock('../local-storage.js', () => ({
  LocalStorageProvider: MockLocalStorageProvider,
}));

vi.mock('../s3-storage.js', () => ({
  S3StorageProvider: MockS3StorageProvider,
}));

// =============================================================================
// Import SUT after mocks
// =============================================================================

import { createStorageProvider } from '../storage-factory.js';
import type { StorageProviderConfig } from '../storage-factory.js';

// =============================================================================
// Tests
// =============================================================================

describe('createStorageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Local provider
  // ---------------------------------------------------------------------------

  it('returns LocalStorageProvider when provider is "local"', () => {
    const config: StorageProviderConfig = {
      provider: 'local',
      bucket: 'unused',
      basePath: '/data/attachments',
    };

    const provider = createStorageProvider(config);

    expect(provider.name).toBe('local');
    expect(provider).toBeInstanceOf(MockLocalStorageProvider);
  });

  it('defaults basePath to "./attachments" when not provided for local', () => {
    const config: StorageProviderConfig = {
      provider: 'local',
      bucket: 'unused',
    };

    const provider = createStorageProvider(config) as unknown as InstanceType<
      typeof MockLocalStorageProvider
    >;

    expect(provider.opts.basePath).toBe('./attachments');
  });

  it('passes custom basePath to LocalStorageProvider', () => {
    const config: StorageProviderConfig = {
      provider: 'local',
      bucket: 'unused',
      basePath: '/custom/path',
    };

    const provider = createStorageProvider(config) as unknown as InstanceType<
      typeof MockLocalStorageProvider
    >;

    expect(provider.opts.basePath).toBe('/custom/path');
  });

  // ---------------------------------------------------------------------------
  // S3 provider
  // ---------------------------------------------------------------------------

  it('returns S3StorageProvider when provider is "s3"', () => {
    const config: StorageProviderConfig = {
      provider: 's3',
      bucket: 'my-bucket',
      region: 'eu-west-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret123',
    };

    const provider = createStorageProvider(config);

    expect(provider.name).toBe('s3');
    expect(provider).toBeInstanceOf(MockS3StorageProvider);
  });

  it('passes S3 config correctly to S3StorageProvider', () => {
    const config: StorageProviderConfig = {
      provider: 's3',
      bucket: 'prod-bucket',
      region: 'ap-southeast-1',
      endpoint: 'https://custom-s3.example.com',
      accessKeyId: 'AKIA_PROD',
      secretAccessKey: 'prod-secret',
    };

    const provider = createStorageProvider(config) as unknown as InstanceType<
      typeof MockS3StorageProvider
    >;

    expect(provider.opts.bucket).toBe('prod-bucket');
    expect(provider.opts.region).toBe('ap-southeast-1');
    expect(provider.opts.endpoint).toBe('https://custom-s3.example.com');
    expect(provider.opts.accessKeyId).toBe('AKIA_PROD');
    expect(provider.opts.secretAccessKey).toBe('prod-secret');
  });

  it('defaults region to "us-east-1" when not provided for s3', () => {
    const config: StorageProviderConfig = {
      provider: 's3',
      bucket: 'my-bucket',
    };

    const provider = createStorageProvider(config) as unknown as InstanceType<
      typeof MockS3StorageProvider
    >;

    expect(provider.opts.region).toBe('us-east-1');
  });

  // ---------------------------------------------------------------------------
  // MinIO (S3-compatible)
  // ---------------------------------------------------------------------------

  it('returns S3StorageProvider when provider is "minio"', () => {
    const config: StorageProviderConfig = {
      provider: 'minio',
      bucket: 'minio-bucket',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    };

    const provider = createStorageProvider(config);

    expect(provider.name).toBe('s3');
    expect(provider).toBeInstanceOf(MockS3StorageProvider);
  });

  it('passes minio config to S3StorageProvider with endpoint', () => {
    const config: StorageProviderConfig = {
      provider: 'minio',
      bucket: 'minio-bucket',
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    };

    const provider = createStorageProvider(config) as unknown as InstanceType<
      typeof MockS3StorageProvider
    >;

    expect(provider.opts.bucket).toBe('minio-bucket');
    expect(provider.opts.endpoint).toBe('http://minio:9000');
    expect(provider.opts.accessKeyId).toBe('minioadmin');
    expect(provider.opts.secretAccessKey).toBe('minioadmin');
  });

  // ---------------------------------------------------------------------------
  // Unsupported provider
  // ---------------------------------------------------------------------------

  it('throws for unsupported provider type "gcs"', () => {
    const config: StorageProviderConfig = {
      provider: 'gcs',
      bucket: 'gcs-bucket',
    };

    expect(() => createStorageProvider(config)).toThrow(
      'Unsupported storage provider: gcs. Supported: local, s3, minio',
    );
  });

  it('throws for unsupported provider type "azure_blob"', () => {
    const config: StorageProviderConfig = {
      provider: 'azure_blob',
      bucket: 'az-container',
    };

    expect(() => createStorageProvider(config)).toThrow(
      'Unsupported storage provider: azure_blob. Supported: local, s3, minio',
    );
  });

  it('throws for unsupported provider type "gridfs"', () => {
    const config: StorageProviderConfig = {
      provider: 'gridfs',
      bucket: 'gridfs-bucket',
      connectionString: 'mongodb://localhost:27017',
    };

    expect(() => createStorageProvider(config)).toThrow(
      'Unsupported storage provider: gridfs. Supported: local, s3, minio',
    );
  });
});
