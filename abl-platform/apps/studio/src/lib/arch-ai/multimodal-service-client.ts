import { Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAttachment } from '@agent-platform/database';
import type { AttachmentConfig } from '@agent-platform/shared';

const DEFAULT_BASE_URL = 'http://multimodal-service:3006';
const INTERNAL_PREFIX = '/internal/attachments';
const REQUEST_TIMEOUT_MS = 30_000;

const log = createLogger('lib:arch-ai:multimodal-service-client');

export interface ArchMultimodalUploadParams {
  stream: Readable;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  tenantId: string;
  projectId: string;
  sessionId: string;
  config?: AttachmentConfig;
}

export type ArchMultimodalUploadResult =
  | { success: true; attachmentId: string; status: string }
  | { success: false; error: { code: string; message: string } };

export interface DownloadedAttachmentContent {
  buffer: Buffer;
  contentType: string;
}

export class ArchMultimodalServiceClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env['MULTIMODAL_SERVICE_URL'] ?? DEFAULT_BASE_URL;
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl}${INTERNAL_PREFIX}${path}`;
  }

  async upload(params: ArchMultimodalUploadParams): Promise<ArchMultimodalUploadResult> {
    try {
      const buffer = await streamToBuffer(params.stream);
      const form = new FormData();
      const blob = new Blob([new Uint8Array(buffer)], { type: params.mimeType });
      form.append('file', blob, params.filename);
      form.append('sessionId', params.sessionId);
      form.append('sizeBytes', String(params.sizeBytes));
      if (params.config) {
        form.append('config', JSON.stringify(params.config));
      }

      const response = await fetch(this.buildUrl(''), {
        method: 'POST',
        headers: {
          'X-Tenant-Id': params.tenantId,
          'X-Project-Id': params.projectId,
        },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const body = (await response.json()) as {
        success: boolean;
        data?: { attachmentId: string; status: string };
        error?: { code: string; message: string };
      };

      if (!response.ok || !body.success || !body.data) {
        return {
          success: false,
          error: body.error ?? {
            code: 'UPLOAD_FAILED',
            message: `Upload failed with HTTP ${response.status}`,
          },
        };
      }

      return {
        success: true,
        attachmentId: body.data.attachmentId,
        status: body.data.status,
      };
    } catch (error: unknown) {
      log.error('multimodal upload failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async getAttachment(id: string, tenantId: string): Promise<IAttachment | null> {
    try {
      const response = await fetch(this.buildUrl(`/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers: {
          'X-Tenant-Id': tenantId,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        log.warn('multimodal getAttachment failed', { attachmentId: id, status: response.status });
        return null;
      }

      const body = (await response.json()) as {
        success: boolean;
        data?: { attachment: IAttachment };
      };

      return body.success && body.data ? body.data.attachment : null;
    } catch (error: unknown) {
      log.error('multimodal getAttachment failed', {
        attachmentId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getDownloadUrl(
    id: string,
    tenantId: string,
    opts?: { disposition?: 'inline' | 'attachment'; expiresIn?: number },
  ): Promise<string | null> {
    try {
      const query = new URLSearchParams();
      if (opts?.disposition) {
        query.set('disposition', opts.disposition);
      }
      if (typeof opts?.expiresIn === 'number') {
        query.set('expiresIn', String(opts.expiresIn));
      }

      const response = await fetch(
        this.buildUrl(
          `/${encodeURIComponent(id)}/url${query.toString() ? `?${query.toString()}` : ''}`,
        ),
        {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        log.warn('multimodal getDownloadUrl failed', { attachmentId: id, status: response.status });
        return null;
      }

      const body = (await response.json()) as {
        success: boolean;
        data?: { url: string };
      };

      return body.success && body.data ? body.data.url : null;
    } catch (error: unknown) {
      log.error('multimodal getDownloadUrl failed', {
        attachmentId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async downloadContent(
    id: string,
    tenantId: string,
    opts?: { disposition?: 'inline' | 'attachment' },
  ): Promise<DownloadedAttachmentContent | null> {
    try {
      const query = new URLSearchParams();
      if (opts?.disposition) {
        query.set('disposition', opts.disposition);
      }

      const response = await fetch(
        this.buildUrl(
          `/${encodeURIComponent(id)}/content${query.toString() ? `?${query.toString()}` : ''}`,
        ),
        {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        log.warn('multimodal content download failed', {
          attachmentId: id,
          status: response.status,
        });
        return null;
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType,
      };
    } catch (error: unknown) {
      log.error('multimodal content download failed', {
        attachmentId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
