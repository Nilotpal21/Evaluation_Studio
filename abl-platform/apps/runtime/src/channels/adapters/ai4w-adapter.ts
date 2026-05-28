/**
 * AI4W Channel Adapter
 *
 * Implements ChannelAdapter for the AIforWork platform integration.
 * Handles dual-layer auth (HMAC + JWT), message parsing, and async delivery.
 */

import { Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type { AttachmentConfig } from '@agent-platform/shared';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelOutput,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { buildOutboundSignatureHeaders } from './ai4w-auth.js';
import { transformAI4WOutput } from './ai4w-content-transformer.js';
import { validateAndFetchSignedUrl, SSRFError } from './ai4w-ssrf.js';
import type { AI4WMessageInput } from './ai4w-types.js';
import { buildAI4WSessionKey } from './ai4w-types.js';
import { coerceSessionMetadata } from '../../services/session-metadata.js';
import { MultimodalServiceClient } from '../../attachments/multimodal-service-client.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('ai4w-adapter');

export class AI4WAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'ai4w';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: true,
  };

  /**
   * ChannelAdapter.verifyRequest is intentionally not implemented for AI4W:
   * AI4W has its own dedicated route (`/api/v1/channels/ai4w/:connectionId/message`)
   * that performs HMAC + JWT + replay + account-binding inline, bypassing the
   * generic webhook pipeline that drives other channels' verifyRequest. The
   * method is retained only to satisfy the ChannelAdapter interface.
   *
   * If this is ever invoked, the generic pipeline is routing AI4W traffic
   * through the wrong path — fail loudly instead of silently re-doing HMAC
   * (which would need the route-level replay nonce namespace to stay
   * consistent with the route handler, and drifting is worse than a crash).
   */
  async verifyRequest(): Promise<boolean> {
    throw new Error(
      'AI4WAdapter.verifyRequest must not be called; AI4W auth lives in the ' +
        'dedicated route handler (apps/runtime/src/routes/ai4w-channel.ts).',
    );
  }

  /**
   * Parse an inbound job payload into a normalized message.
   * If the original message included files, they have already been downloaded
   * during ingestion (in the route handler) and are in metadata.downloadedFiles.
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Download files from AI4W signed URLs with SSRF validation.
   * Called during ingestion (route handler), not during execution.
   * Returns downloaded file metadata to be attached to the normalized message.
   */
  async downloadIncomingFiles(
    files: AI4WMessageInput['files'],
    constraints?: {
      maxFileSizeBytes?: number;
      allowedMimeTypes?: string[];
    },
  ): Promise<Array<{ buffer: Buffer; contentType: string; filename: string }>> {
    if (!files || files.length === 0) return [];

    const results: Array<{ buffer: Buffer; contentType: string; filename: string }> = [];

    for (const file of files) {
      // Pre-filter by declared MIME type before downloading
      if (
        constraints?.allowedMimeTypes &&
        constraints.allowedMimeTypes.length > 0 &&
        !constraints.allowedMimeTypes.includes(file.mimeType)
      ) {
        log.warn('AI4W file MIME type not allowed, skipping download', {
          filename: file.name,
          mimeType: file.mimeType,
          allowedTypes: constraints.allowedMimeTypes,
        });
        continue;
      }

      try {
        const downloaded = await validateAndFetchSignedUrl(
          file.signedUrl,
          file.name,
          constraints?.maxFileSizeBytes,
        );
        results.push({
          buffer: downloaded.buffer,
          contentType: downloaded.contentType || file.mimeType,
          filename: downloaded.filename || file.name,
        });
      } catch (err: unknown) {
        if (err instanceof SSRFError) {
          log.warn('SSRF validation blocked file download', {
            filename: file.name,
            error: err.message,
          });
        } else {
          log.error('Failed to download file from signed URL', {
            filename: file.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return results;
  }

  /**
   * Build a NormalizedIncomingMessage from the parsed AI4W request body.
   * Called by the route handler after auth + validation.
   */
  buildNormalizedMessage(
    body: AI4WMessageInput,
    connectionId: string,
    email: string,
    downloadedFiles?: Array<{ buffer: Buffer; contentType: string; filename: string }>,
  ): NormalizedIncomingMessage {
    const externalSessionKey = buildAI4WSessionKey(connectionId, email, body.agentContextId);
    const sessionMetadata = coerceSessionMetadata(body.sessionMetadata);

    const metadata: Record<string, unknown> = {
      agentContextId: body.agentContextId,
      userEmail: email,
      channelSource: 'ai4w',
      ...(body.metadata ?? {}),
      ...(sessionMetadata ? { sessionMetadata } : {}),
    };

    if (body.conversationHistory && body.conversationHistory.length > 0) {
      metadata.conversationHistory = body.conversationHistory;
    }

    if (downloadedFiles && downloadedFiles.length > 0) {
      // Summary only — filename / contentType / sizeBytes. Raw Buffers are
      // deliberately NOT attached to session metadata: metadata flows through
      // session persistence, trace events, and Kafka projections, and a raw
      // Buffer there serializes as `{ type: 'Buffer', data: [...] }` which
      // explodes payload size and breaks compression invariants. If agent
      // execution later needs buffer access, pass them through a dedicated
      // request-scoped channel (e.g. req.locals), not through metadata.
      metadata.downloadedFiles = downloadedFiles.map((f) => ({
        filename: f.filename,
        contentType: f.contentType,
        sizeBytes: f.buffer.length,
      }));
    }

    return {
      externalMessageId: `ai4w-${connectionId}-${Date.now()}`,
      externalSessionKey,
      text: body.text,
      metadata,
      timestamp: new Date(),
    };
  }

  /**
   * Send a response to AI4W.
   *
   * - sync/stream: no-op (route handler sends directly)
   * - async: builds HMAC-signed headers for outbound callback delivery.
   *   The signed headers are returned in SendResult metadata for the delivery worker.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    // Read responseMode from message metadata (runtime mode) first,
    // then fall back to connection config (default mode)
    const responseMode =
      (message.metadata?.responseMode as string) ||
      (connection.config?.responseMode as string) ||
      'sync';

    if (responseMode === 'async') {
      const connectionSecret = connection.credentials?.connectionSecret as string | undefined;
      if (!connectionSecret) {
        log.warn(
          'Cannot build outbound signature',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'ai4w',
            code: 'CHANNEL_DELIVERY_CONFIGURATION',
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'ai4w',
          category: 'configuration',
          code: 'CHANNEL_DELIVERY_CONFIGURATION',
          operatorMessage: 'No AI4W connection secret was available for async outbound delivery.',
          retryable: false,
        });
      }

      const callbackBaseUrl = connection.config?.callbackBaseUrl as string | undefined;
      if (!callbackBaseUrl) {
        log.warn(
          'Cannot deliver async response',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'ai4w',
            code: 'CHANNEL_DELIVERY_CONFIGURATION',
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'ai4w',
          category: 'configuration',
          code: 'CHANNEL_DELIVERY_CONFIGURATION',
          operatorMessage: 'No AI4W callback base URL was configured for async outbound delivery.',
          retryable: false,
        });
      }

      // Build the outbound payload and HMAC-signed headers
      const bodyJson = JSON.stringify(message);
      const signatureHeaders = buildOutboundSignatureHeaders(connectionSecret, bodyJson);

      log.info('AI4W async delivery prepared', {
        connectionId: connection.id,
        callbackBaseUrl,
        responseModeSource: message.metadata?.responseMode ? 'request' : 'config',
      });

      return {
        success: true,
        metadata: {
          callbackUrl: callbackBaseUrl,
          signatureHeaders,
          body: bodyJson,
        },
      };
    }

    // sync/stream — route handler sends directly
    return { success: true };
  }

  /** Transform text + rich content + actions into markdown for AI4W rendering. */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    return transformAI4WOutput(text, actions, richContent);
  }

  /**
   * Upload downloaded files to the attachment service.
   * Called after downloadIncomingFiles() to persist files with metadata.
   *
   * @param downloadedFiles - Files downloaded from AI4W signed URLs
   * @param context - Session and tenant context for attachment ownership
   * @param config - Attachment configuration (size limits, allowed types, etc.)
   * @returns Array of successfully uploaded attachments with their IDs
   */
  async uploadDownloadedFilesToAttachmentService(
    downloadedFiles: Array<{ buffer: Buffer; contentType: string; filename: string }>,
    context: {
      tenantId: string;
      projectId: string;
      sessionId: string;
      messageId?: string;
    },
    config: AttachmentConfig,
  ): Promise<Array<{ attachmentId: string; filename: string; status: string }>> {
    if (downloadedFiles.length === 0) {
      return [];
    }

    const client = new MultimodalServiceClient();
    const results: Array<{ attachmentId: string; filename: string; status: string }> = [];

    for (const file of downloadedFiles) {
      try {
        // Validate file size against config
        if (file.buffer.length > config.maxFileSizeBytes) {
          log.warn('AI4W file exceeds size limit', {
            filename: file.filename,
            sizeBytes: file.buffer.length,
            maxSizeBytes: config.maxFileSizeBytes,
            tenantId: context.tenantId,
          });
          continue; // Skip this file but continue with others
        }

        // Validate MIME type against config
        if (
          config.allowedMimeTypes.length > 0 &&
          !config.allowedMimeTypes.includes(file.contentType)
        ) {
          log.warn('AI4W file type not allowed', {
            filename: file.filename,
            contentType: file.contentType,
            allowedTypes: config.allowedMimeTypes,
            tenantId: context.tenantId,
          });
          continue; // Skip this file but continue with others
        }

        const uploadResult = await client.upload({
          stream: Readable.from([file.buffer]),
          filename: file.filename,
          mimeType: file.contentType,
          sizeBytes: file.buffer.length,
          maxSizeBytes: config.maxFileSizeBytes,
          tenantId: context.tenantId,
          projectId: context.projectId,
          sessionId: context.sessionId,
          messageId: context.messageId,
          channel: 'ai4w',
          config,
        });

        if (uploadResult.success) {
          results.push({
            attachmentId: uploadResult.attachmentId,
            filename: file.filename,
            status: uploadResult.status,
          });
          log.info('AI4W file uploaded to attachment service', {
            attachmentId: uploadResult.attachmentId,
            filename: file.filename,
            sizeBytes: file.buffer.length,
            sessionId: context.sessionId,
          });
        } else {
          log.error('AI4W file upload failed', {
            filename: file.filename,
            error: uploadResult.error,
            sessionId: context.sessionId,
          });
        }
      } catch (err: unknown) {
        log.error('AI4W file upload exception', {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
          sessionId: context.sessionId,
        });
        // Continue with next file
      }
    }

    return results;
  }
}
