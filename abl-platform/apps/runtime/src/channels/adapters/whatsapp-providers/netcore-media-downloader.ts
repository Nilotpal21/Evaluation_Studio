/**
 * Netcore Media Downloader
 *
 * Downloads media from Netcore's WhatsApp API using a media ID.
 * Netcore provides a single endpoint that returns the file as a stream
 * when called with the media ID and a Bearer token.
 *
 * Returns the same shape as WhatsAppMediaDownloadResult so the shared
 * whatsapp-media-processor.ts works without changes.
 */

import { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('netcore-media-downloader');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MEDIA_API_URL = 'https://waapi.pepipost.com/api/v2/media';

export interface NetcoreMediaReference {
  mediaId: string;
  mimeType: string;
  mediaType: 'image' | 'audio' | 'video' | 'document';
  filename?: string;
}

export type NetcoreMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; mediaId: string };

export interface NetcoreDownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  mediaApiUrl?: string;
}

export async function downloadNetcoreMedia(
  mediaRef: NetcoreMediaReference,
  apiKey: string,
  options?: NetcoreDownloadOptions,
): Promise<NetcoreMediaDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const baseUrl = options?.mediaApiUrl ?? DEFAULT_MEDIA_API_URL;

  if (!mediaRef.mediaId) {
    log.warn('Missing media ID in download request');
    return { success: false, error: 'Missing media ID', mediaId: mediaRef.mediaId };
  }

  const url = `${baseUrl}/${mediaRef.mediaId}`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      log.error('Netcore media download failed', {
        mediaId: mediaRef.mediaId,
        status: resp.status,
      });
      return {
        success: false,
        error: `Netcore media download failed: HTTP ${resp.status} ${resp.statusText}`,
        mediaId: mediaRef.mediaId,
      };
    }

    const webStream = resp.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Netcore media download returned no body',
        mediaId: mediaRef.mediaId,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    // Get size from Content-Length header (may not always be present)
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > maxSize) {
      nodeStream.destroy();
      log.warn('Netcore media exceeds size limit', {
        mediaId: mediaRef.mediaId,
        contentLength,
        maxSize,
      });
      return {
        success: false,
        error: `File (${contentLength} bytes) exceeds max size (${maxSize} bytes)`,
        mediaId: mediaRef.mediaId,
      };
    }

    // Get MIME type from response headers (more reliable than webhook data)
    const mimeType =
      resp.headers.get('content-type')?.split(';')[0].trim() ||
      mediaRef.mimeType ||
      'application/octet-stream';

    // Generate filename from media type + timestamp + extension
    const filename = mediaRef.filename || generateFilename(mediaRef.mediaType, mimeType);

    return {
      success: true,
      stream: nodeStream,
      filename,
      mimeType,
      sizeBytes: contentLength,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
      mediaId: mediaRef.mediaId,
    };
  }
}

/** Generate a filename from mediaType + timestamp + extension. */
function generateFilename(mediaType: string, mimeType: string): string {
  const ext = mimeToExtension(mimeType);
  return `${mediaType}_${Date.now()}.${ext}`;
}

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  };
  const baseMime = mimeType.split(';')[0].trim();
  return map[baseMime] || 'bin';
}
