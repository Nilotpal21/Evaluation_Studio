/**
 * MultimodalServiceClient
 *
 * HTTP client for communicating with the multimodal-service internal API.
 * Wraps all attachment-related internal endpoints: upload, get, list, download URL,
 * status, and delete. Uses native fetch() (Node 18+).
 *
 * Reads MULTIMODAL_SERVICE_URL from environment; defaults to http://multimodal-service:3006.
 * Never throws on network errors -- returns null or structured error results.
 */

import type { Readable } from 'stream';
import type { IAttachment } from '@agent-platform/database';
import type { AttachmentConfig } from '@agent-platform/shared';
import { createLogger } from '@abl/compiler/platform';
import type { MultimodalCircuitBreaker } from './multimodal-circuit-breaker.js';

const log = createLogger('multimodal-client');

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://multimodal-service:3006';
const INTERNAL_PREFIX = '/internal/attachments';

/** Maximum time (ms) to wait for any single HTTP request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum time (ms) to wait for a frame download request. */
const FRAME_DOWNLOAD_TIMEOUT_MS = 5_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UploadParams {
  stream: Readable;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  maxSizeBytes?: number;
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId?: string;
  channel?: string;
  config?: AttachmentConfig;
}

export type UploadResult =
  | { success: true; attachmentId: string; status: string }
  | { success: false; error: { code: string; message: string } };

export interface AttachmentStatusResult {
  scanStatus: string;
  processingStatus: string;
  embeddingStatus: string;
}

export interface AttachmentContentResult {
  content: Buffer;
  contentType: string;
  sizeBytes: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function streamToBufferWithLimit(stream: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (typeof maxBytes === 'number' && totalBytes > maxBytes) {
      throw new Error(`Attachment stream exceeds max size (${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class MultimodalServiceClient {
  private readonly baseUrl: string;
  private readonly circuitBreaker?: MultimodalCircuitBreaker;

  constructor(baseUrl?: string, circuitBreaker?: MultimodalCircuitBreaker) {
    this.baseUrl = baseUrl ?? process.env.MULTIMODAL_SERVICE_URL ?? DEFAULT_BASE_URL;
    this.circuitBreaker = circuitBreaker;
  }

  /**
   * Execute an operation through the circuit breaker (if configured).
   * When no circuit breaker is set, the operation runs directly.
   */
  private async withCircuitBreaker<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (this.circuitBreaker) {
      return this.circuitBreaker.execute(operation, fn);
    }
    return fn();
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async upload(params: UploadParams): Promise<UploadResult> {
    const {
      stream,
      filename,
      mimeType,
      sizeBytes,
      maxSizeBytes,
      tenantId,
      projectId,
      sessionId,
      messageId,
      channel,
      config,
    } = params;

    try {
      return await this.withCircuitBreaker('upload', async () => {
        const effectiveMaxSize =
          typeof maxSizeBytes === 'number' && maxSizeBytes > 0 ? maxSizeBytes : undefined;
        const buffer = await streamToBufferWithLimit(stream, effectiveMaxSize);
        const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });

        const form = new FormData();
        form.append('file', blob, filename);
        form.append('sessionId', sessionId);
        if (messageId) {
          form.append('messageId', messageId);
        }
        if (channel) {
          form.append('channel', channel);
        }
        if (config) {
          form.append('config', JSON.stringify(config));
        }
        form.append('sizeBytes', String(sizeBytes));

        const url = `${this.baseUrl}${INTERNAL_PREFIX}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Tenant-Id': tenantId,
            'X-Project-Id': projectId,
          },
          body: form,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const body = (await res.json()) as {
          success: boolean;
          data?: { attachmentId: string; status: string };
          error?: { code: string; message: string };
        };

        if (!res.ok || !body.success) {
          return {
            success: false,
            error: body.error ?? {
              code: 'UPLOAD_FAILED',
              message: `Upload failed with HTTP ${res.status}`,
            },
          } as UploadResult;
        }

        return {
          success: true,
          attachmentId: body.data!.attachmentId,
          status: body.data!.status,
        } as UploadResult;
      });
    } catch (err) {
      log.error('upload failed', { error: err instanceof Error ? err.message : String(err) });
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      };
    }
  }

  // ── Get Single ───────────────────────────────────────────────────────────

  async getAttachment(id: string, tenantId: string): Promise<IAttachment | null> {
    try {
      return await this.withCircuitBreaker('getAttachment', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 404) {
          return null;
        }

        if (!res.ok) {
          log.error('getAttachment failed', { status: res.status });
          return null;
        }

        const body = (await res.json()) as {
          success: boolean;
          data?: { attachment: IAttachment };
        };

        if (!body.success || !body.data) {
          return null;
        }

        return body.data.attachment;
      });
    } catch (err) {
      log.error('getAttachment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── List by Session ──────────────────────────────────────────────────────

  async listBySession(
    sessionId: string,
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<IAttachment[]> {
    try {
      return await this.withCircuitBreaker('listBySession', async () => {
        const query = new URLSearchParams();
        if (opts?.limit !== undefined) {
          query.set('limit', String(opts.limit));
        }
        if (opts?.offset !== undefined) {
          query.set('offset', String(opts.offset));
        }

        const qs = query.toString();
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/session/${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ''}`;

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!res.ok) {
          log.error('listBySession failed', { status: res.status });
          return [];
        }

        const body = (await res.json()) as {
          success: boolean;
          data?: { attachments: IAttachment[] };
        };

        if (!body.success || !body.data) {
          return [];
        }

        return body.data.attachments;
      });
    } catch (err) {
      log.error('listBySession failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── Download URL ─────────────────────────────────────────────────────────

  async getDownloadUrl(
    id: string,
    tenantId: string,
    opts?: { disposition?: 'inline' | 'attachment'; expiresIn?: number },
  ): Promise<string | null> {
    try {
      return await this.withCircuitBreaker('getDownloadUrl', async () => {
        const query = new URLSearchParams();
        if (opts?.disposition) {
          query.set('disposition', opts.disposition);
        }
        if (opts?.expiresIn !== undefined) {
          query.set('expiresIn', String(opts.expiresIn));
        }

        const qs = query.toString();
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/url${qs ? `?${qs}` : ''}`;

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 404) {
          return null;
        }

        if (!res.ok) {
          log.error('getDownloadUrl failed', { status: res.status });
          return null;
        }

        const body = (await res.json()) as {
          success: boolean;
          data?: { url: string; expiresInSeconds: number };
        };

        if (!body.success || !body.data) {
          return null;
        }

        return body.data.url;
      });
    } catch (err) {
      log.error('getDownloadUrl failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Download Content ─────────────────────────────────────────────────────

  async downloadAttachmentContent(
    id: string,
    tenantId: string,
  ): Promise<AttachmentContentResult | null> {
    try {
      return await this.withCircuitBreaker('downloadAttachmentContent', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/content`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 404) {
          return null;
        }

        if (!res.ok) {
          log.error('downloadAttachmentContent failed', { status: res.status });
          return null;
        }

        const content = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
        const contentLengthHeader = res.headers.get('content-length');
        const sizeBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : content.length;

        return {
          content,
          contentType,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : content.length,
        };
      });
    } catch (err) {
      log.error('downloadAttachmentContent failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Download Resized Content ─────────────────────────────────────────────

  async downloadResizedContent(
    id: string,
    tenantId: string,
  ): Promise<AttachmentContentResult | null> {
    try {
      return await this.withCircuitBreaker('downloadResizedContent', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/content?variant=resized`;
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'X-Tenant-Id': tenantId },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 404) return null;
        if (!res.ok) {
          log.error('downloadResizedContent failed', { status: res.status });
          return null;
        }
        const content = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
        return { content, contentType, sizeBytes: content.length };
      });
    } catch (err) {
      log.error('downloadResizedContent failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: try original
      return this.downloadAttachmentContent(id, tenantId);
    }
  }

  // ── Download Frame Content ──────────────────────────────────────────────

  async downloadFrameContent(
    id: string,
    tenantId: string,
    frameIndex: number,
  ): Promise<AttachmentContentResult | null> {
    try {
      return await this.withCircuitBreaker('downloadFrameContent', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/frames/${frameIndex}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'X-Tenant-Id': tenantId },
          signal: AbortSignal.timeout(FRAME_DOWNLOAD_TIMEOUT_MS),
        });
        if (res.status === 404) return null;
        if (!res.ok) {
          log.error('downloadFrameContent failed', { status: res.status, frameIndex });
          return null;
        }
        const content = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? 'image/png';
        return { content, contentType, sizeBytes: content.length };
      });
    } catch (err) {
      log.error('downloadFrameContent failed', {
        error: err instanceof Error ? err.message : String(err),
        frameIndex,
      });
      return null;
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────

  async getStatus(id: string, tenantId: string): Promise<AttachmentStatusResult | null> {
    try {
      return await this.withCircuitBreaker('getStatus', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/status`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 404) {
          return null;
        }

        if (!res.ok) {
          log.error('getStatus failed', { status: res.status });
          return null;
        }

        const body = (await res.json()) as {
          success: boolean;
          data?: {
            scanStatus: string;
            processingStatus: string;
            embeddingStatus: string;
          };
        };

        if (!body.success || !body.data) {
          return null;
        }

        return {
          scanStatus: body.data.scanStatus,
          processingStatus: body.data.processingStatus,
          embeddingStatus: body.data.embeddingStatus,
        };
      });
    } catch (err) {
      log.error('getStatus failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ── Delete Single ────────────────────────────────────────────────────────

  async deleteAttachment(id: string, tenantId: string): Promise<void> {
    try {
      await this.withCircuitBreaker('deleteAttachment', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}`;
        const res = await fetch(url, {
          method: 'DELETE',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!res.ok && res.status !== 204) {
          log.error('deleteAttachment failed', { status: res.status });
        }
      });
    } catch (err) {
      log.error('deleteAttachment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Delete by Session ────────────────────────────────────────────────────

  async deleteBySession(sessionId: string, tenantId: string): Promise<void> {
    try {
      await this.withCircuitBreaker('deleteBySession', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/session/${encodeURIComponent(sessionId)}`;
        const res = await fetch(url, {
          method: 'DELETE',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!res.ok && res.status !== 204) {
          log.error('deleteBySession failed', { status: res.status });
        }
      });
    } catch (err) {
      log.error('deleteBySession failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Retry Processing ──────────────────────────────────────────────────────

  async retry(
    id: string,
    tenantId: string,
  ): Promise<
    | { success: true; retryCount: number }
    | { success: false; error: { code: string; message: string } }
  > {
    try {
      return await this.withCircuitBreaker('retry', async () => {
        const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/retry`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Tenant-Id': tenantId,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const body = (await res.json()) as {
          success: boolean;
          data?: { retryCount: number };
          error?: { code: string; message: string };
        };

        if (!res.ok || !body.success) {
          return {
            success: false as const,
            error: body.error ?? {
              code: 'RETRY_FAILED',
              message: `Retry failed with HTTP ${res.status}`,
            },
          };
        }

        return {
          success: true as const,
          retryCount: body.data!.retryCount,
        };
      });
    } catch (err) {
      log.error('retry failed', { error: err instanceof Error ? err.message : String(err) });
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      };
    }
  }
}
