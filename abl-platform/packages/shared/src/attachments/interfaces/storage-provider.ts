import type { Readable } from 'stream';

export interface StorageProvider {
  readonly name: string;

  upload(params: {
    key: string;
    body: Readable;
    contentType: string;
    sizeBytes: number;
    metadata: Record<string, string>;
    encryption?: { algorithm: string; keyId: string };
  }): Promise<{ storageKey: string; etag: string }>;

  download(key: string): Promise<{
    body: Readable;
    contentType: string;
    sizeBytes: number;
  }>;

  getSignedUrl(
    key: string,
    opts: {
      expiresInSeconds: number;
      disposition?: 'inline' | 'attachment';
      filename?: string;
    },
  ): Promise<string>;

  delete(key: string): Promise<void>;

  deleteMany(prefix: string): Promise<{ deletedCount: number }>;

  exists(key: string): Promise<boolean>;

  copy(sourceKey: string, destKey: string): Promise<void>;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
