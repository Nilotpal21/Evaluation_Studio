/**
 * Attachment Tool Executor
 *
 * Handles `get_attachment`, `list_attachments`, `upload_attachment`, and
 * `get_attachment_url` agent tool calls. Dispatches to MultimodalServiceClient
 * via HTTP — never queries the Attachment model directly.
 *
 * Follows the SearchAIToolHandler pattern: switch on tool name, return
 * structured results, never throw from public methods.
 */

import type { IAttachment } from '@agent-platform/database';
import type { UploadResult } from '../attachments/multimodal-service-client.js';

// ─── Tool Name Constants ─────────────────────────────────────────────────────

export const ATTACHMENT_TOOL_NAMES = [
  'get_attachment',
  'list_attachments',
  'upload_attachment',
  'get_attachment_url',
  'route_attachment',
] as const;
export type AttachmentToolName = (typeof ATTACHMENT_TOOL_NAMES)[number];

export function isAttachmentTool(name: string): name is AttachmentToolName {
  return (ATTACHMENT_TOOL_NAMES as readonly string[]).includes(name);
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum decoded size for base64 upload (20 MB). */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Default URL expiry in seconds (1 hour). */
const DEFAULT_EXPIRY_SECONDS = 3600;

/** MIME types allowed for agent-initiated upload. */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
  'application/json',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'application/octet-stream',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttachmentToolContext {
  tenantId: string;
  sessionId: string;
  projectId: string;
}

/**
 * Structural type for the subset of MultimodalServiceClient methods
 * required by the executor. Allows easy mocking in tests.
 */
export interface AttachmentServiceClient {
  getAttachment(id: string, tenantId: string): Promise<IAttachment | null>;
  listBySession(
    sessionId: string,
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<IAttachment[]>;
  getDownloadUrl(
    id: string,
    tenantId: string,
    opts?: { disposition?: 'inline' | 'attachment'; expiresIn?: number },
  ): Promise<string | null>;
  upload(params: {
    stream: import('stream').Readable;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    tenantId: string;
    projectId: string;
    sessionId: string;
  }): Promise<UploadResult>;
  retry(
    id: string,
    tenantId: string,
  ): Promise<
    | { success: true; retryCount: number }
    | { success: false; error: { code: string; message: string } }
  >;
}

/** Destination definition from the agent IR (compiled from DESTINATIONS: block) */
export interface DestinationDef {
  name: string;
  url: string;
  method: string;
  auth?: string;
  headers?: Record<string, string>;
}

export interface AttachmentToolExecutorDeps {
  serviceClient: AttachmentServiceClient;
  destinations?: DestinationDef[];
}

/** Fields returned for a single attachment in get_attachment results. */
interface AttachmentDetail {
  id: string;
  filename: string;
  mimeType: string;
  category: string;
  processingStatus: string;
  content: string | null;
  imageDescription: string | null;
}

/** Fields returned for each attachment in list_attachments results. */
interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  category: string;
  processingStatus: string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

/** SSRF blocked URL patterns */
const SSRF_BLOCKED_PATTERNS = [
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}/,
  /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}/,
  /^https?:\/\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /^https?:\/\/localhost(:\d+)?/i,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/\[::1\]/,
];

function isSSRFUrl(url: string): boolean {
  return SSRF_BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
}

export class AttachmentToolExecutor {
  private readonly serviceClient: AttachmentServiceClient;
  private readonly destinations: Map<string, DestinationDef>;

  constructor(deps: AttachmentToolExecutorDeps) {
    this.serviceClient = deps.serviceClient;
    this.destinations = new Map();
    if (deps.destinations) {
      for (const dest of deps.destinations) {
        this.destinations.set(dest.name, dest);
      }
    }
  }

  /**
   * Execute an attachment tool by name.
   * Never throws — all errors are returned as structured `{ error }` results.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    try {
      switch (toolName) {
        case 'get_attachment':
          return await this.handleGetAttachment(params, context);
        case 'list_attachments':
          return await this.handleListAttachments(params, context);
        case 'upload_attachment':
          return await this.handleUploadAttachment(params, context);
        case 'get_attachment_url':
          return await this.handleGetAttachmentUrl(params, context);
        case 'route_attachment':
          return await this.handleRouteAttachment(params, context);
        default:
          return { error: `Unknown attachment tool: ${toolName}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Attachment tool '${toolName}' failed: ${message}` };
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────────────

  private async handleGetAttachment(
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    const attachmentId = params.attachmentId ?? params.attachment_id;
    if (!attachmentId || typeof attachmentId !== 'string') {
      return { error: 'Missing required parameter: attachmentId' };
    }

    const attachment = await this.serviceClient.getAttachment(attachmentId, context.tenantId);
    if (!attachment) {
      return { error: 'Attachment not found' };
    }

    const detail: AttachmentDetail = {
      id: attachment._id,
      filename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      category: attachment.category,
      processingStatus: attachment.processingStatus,
      content: attachment.processedContent,
      imageDescription: attachment.imageDescription,
    };

    return detail as unknown as Record<string, unknown>;
  }

  private async handleUploadAttachment(
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    const filename = params.filename;
    const contentBase64 = params.content_base64;
    const mimeType = params.mime_type;

    if (!filename || typeof filename !== 'string') {
      return {
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing required parameter: filename' },
      };
    }
    if (!contentBase64 || typeof contentBase64 !== 'string') {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAMETER',
          message: 'Missing required parameter: content_base64',
        },
      };
    }
    if (!mimeType || typeof mimeType !== 'string') {
      return {
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing required parameter: mime_type' },
      };
    }

    // Validate MIME type
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_MIME_TYPE',
          message: `MIME type '${mimeType}' is not supported for upload`,
        },
      };
    }

    // Validate and decode base64
    let buffer: Buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
      // Verify it's actually valid base64 by re-encoding and comparing
      if (buffer.length === 0 && contentBase64.length > 0) {
        return {
          success: false,
          error: { code: 'INVALID_BASE64', message: 'Content is not valid base64' },
        };
      }
      // Check for non-base64 characters (strict validation)
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      const stripped = contentBase64.replace(/\s/g, '');
      if (!base64Regex.test(stripped)) {
        return {
          success: false,
          error: { code: 'INVALID_BASE64', message: 'Content is not valid base64' },
        };
      }
    } catch {
      return {
        success: false,
        error: { code: 'INVALID_BASE64', message: 'Content is not valid base64' },
      };
    }

    // Validate size
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return {
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size ${buffer.length} bytes exceeds maximum ${MAX_UPLOAD_BYTES} bytes`,
        },
      };
    }

    const { Readable } = await import('stream');
    const stream = Readable.from([buffer]);

    const uploadResult = await this.serviceClient.upload({
      stream,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      tenantId: context.tenantId,
      projectId: context.projectId,
      sessionId: context.sessionId,
    });

    if (!uploadResult.success) {
      return {
        success: false,
        error: uploadResult.error,
      };
    }

    return {
      success: true,
      data: {
        attachmentId: uploadResult.attachmentId,
        filename,
        status: uploadResult.status,
      },
    };
  }

  private async handleGetAttachmentUrl(
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    const attachmentId = params.attachment_id ?? params.attachmentId;
    if (!attachmentId || typeof attachmentId !== 'string') {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAMETER',
          message: 'Missing required parameter: attachment_id',
        },
      };
    }

    const expiresInSeconds =
      typeof params.expires_in_seconds === 'number'
        ? params.expires_in_seconds
        : DEFAULT_EXPIRY_SECONDS;

    const url = await this.serviceClient.getDownloadUrl(attachmentId, context.tenantId, {
      expiresIn: expiresInSeconds,
    });

    if (!url) {
      return {
        success: false,
        error: {
          code: 'ATTACHMENT_NOT_FOUND',
          message: `Attachment not found: ${attachmentId}. Use list_attachments to see available files.`,
        },
      };
    }

    return {
      success: true,
      data: {
        url,
        expiresInSeconds,
      },
    };
  }

  private async handleListAttachments(
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    const limit = asPositiveInt(params.limit);
    const offset = asPositiveInt(params.offset);
    const category = typeof params.category === 'string' ? params.category : undefined;

    const attachments = await this.serviceClient.listBySession(
      context.sessionId,
      context.tenantId,
      { limit, offset },
    );

    // Apply client-side category filter if provided.
    // The underlying service may or may not support category filtering in the API,
    // so we filter defensively here.
    const filtered = category ? attachments.filter((a) => a.category === category) : attachments;

    const summaries: AttachmentSummary[] = filtered.map((a) => ({
      id: a._id,
      filename: a.originalFilename,
      mimeType: a.mimeType,
      category: a.category,
      processingStatus: a.processingStatus,
    }));

    return {
      attachments: summaries,
      total: summaries.length,
    };
  }

  // ─── Route Attachment ─────────────────────────────────────────────────────

  private async handleRouteAttachment(
    params: Record<string, unknown>,
    context: AttachmentToolContext,
  ): Promise<Record<string, unknown>> {
    const attachmentId = params.attachment_id ?? params.attachmentId;
    if (!attachmentId || typeof attachmentId !== 'string') {
      return {
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing required parameter: attachment_id' },
      };
    }

    const destinationName = params.destination;
    if (!destinationName || typeof destinationName !== 'string') {
      return {
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing required parameter: destination' },
      };
    }

    // Look up the destination
    const dest = this.destinations.get(destinationName);
    if (!dest) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_DESTINATION',
          message: `Unknown destination '${destinationName}'. Available: ${[...this.destinations.keys()].join(', ') || 'none'}`,
        },
      };
    }

    // SSRF protection at runtime (defense in depth — compiler also checks)
    if (isSSRFUrl(dest.url)) {
      return {
        success: false,
        error: {
          code: 'SSRF_BLOCKED',
          message: 'Destination URL targets a private/internal network address and is not allowed',
        },
      };
    }

    // Fetch attachment metadata to verify it exists and is accessible
    const attachment = await this.serviceClient.getAttachment(attachmentId, context.tenantId);
    if (!attachment) {
      return {
        success: false,
        error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' },
      };
    }

    // Get a download URL for the attachment
    const downloadUrl = await this.serviceClient.getDownloadUrl(attachmentId, context.tenantId);

    // Build request headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(dest.headers ?? {}),
    };

    // Build request body
    const body = JSON.stringify({
      attachment_id: attachmentId,
      filename: attachment.originalFilename,
      mime_type: attachment.mimeType,
      category: attachment.category,
      size_bytes: attachment.sizeBytes,
      download_url: downloadUrl,
      ...(typeof params.metadata === 'object' && params.metadata !== null
        ? { metadata: params.metadata }
        : {}),
    });

    // Send the HTTP request to the destination
    try {
      const response = await fetch(dest.url, {
        method: dest.method || 'POST',
        headers,
        body: dest.method === 'GET' || dest.method === 'HEAD' ? undefined : body,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        return {
          success: false,
          error: {
            code: 'DESTINATION_ERROR',
            message: `Destination '${destinationName}' returned HTTP ${response.status}`,
            details: responseText.slice(0, 500),
          },
        };
      }

      return {
        success: true,
        data: {
          destination: destinationName,
          status: response.status,
          attachment_id: attachmentId,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          code: 'DESTINATION_ERROR',
          message: `Failed to route attachment to '${destinationName}': ${message}`,
        },
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asPositiveInt(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  if (isNaN(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}
