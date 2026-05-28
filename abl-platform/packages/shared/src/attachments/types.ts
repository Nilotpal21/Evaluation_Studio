import type { Readable } from 'stream';

export type AttachmentCategory = 'image' | 'document' | 'audio' | 'video';

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

export type EmbeddingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

export interface AttachmentInput {
  source:
    | { type: 'stream'; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
    | { type: 'base64'; data: string; filename: string; mimeType: string }
    | { type: 'url'; url: string; filename?: string; mimeType?: string };
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId?: string;
  channel: string;
}

export interface AttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxAttachmentsPerMessage: number;
  maxAttachmentsPerSession: number;
  maxTotalStorageBytesPerTenant: number;
  allowedCategories: AttachmentCategory[];
  retentionDays: {
    image: number;
    document: number;
    audio: number;
    video: number;
  };
  allowedMimeTypes: string[];
  quotas: {
    maxUploadsPerMinute: number;
    maxConcurrentProcessingJobs: number;
  };
}
