/**
 * Infobip Media Downloader
 *
 * Downloads media from Infobip using a single-step direct URL download.
 * Unlike Meta's two-step Graph API flow, Infobip webhook payloads include
 * a direct download URL. The caller provides a pre-built Authorization header
 * (either "App {api_key}" or "Basic base64(user:pass)").
 *
 * Returns the same shape as WhatsAppMediaDownloadResult so the shared
 * whatsapp-media-processor.ts works without changes.
 */

import { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('infobip-media-downloader');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface InfobipMediaReference {
  mediaId: string; // 'infobip-direct' (not a real ID)
  mimeType: string; // May be empty from webhook
  mediaType: 'image' | 'audio' | 'video' | 'document';
  url: string; // Direct download URL from Infobip
  filename?: string;
}

export type InfobipMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; mediaId: string };

export interface InfobipDownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export async function downloadInfobipMedia(
  mediaRef: InfobipMediaReference,
  authHeader: string,
  options?: InfobipDownloadOptions,
): Promise<InfobipMediaDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  if (!mediaRef.url) {
    log.warn('Missing media URL in download request');
    return { success: false, error: 'Missing media URL', mediaId: mediaRef.mediaId };
  }

  try {
    const resp = await fetch(mediaRef.url, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      log.error('Infobip media download failed', {
        mediaId: mediaRef.mediaId,
        status: resp.status,
      });
      return {
        success: false,
        error: `Infobip media download failed: HTTP ${resp.status} ${resp.statusText}`,
        mediaId: mediaRef.mediaId,
      };
    }

    const webStream = resp.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Infobip media download returned no body',
        mediaId: mediaRef.mediaId,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    // Get size from Content-Length header (may not always be present)
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > maxSize) {
      nodeStream.destroy();
      log.warn('Infobip media exceeds size limit', {
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

    // Generate filename from URL or media type
    const filename =
      mediaRef.filename || generateFilename(mediaRef.url, mediaRef.mediaType, mimeType);

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

/** Generate a filename from the URL path or fall back to mediaType + extension. */
function generateFilename(url: string, mediaType: string, mimeType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const basename = pathname.split('/').pop();
    if (basename && basename.includes('.')) return basename;
  } catch {
    // URL parsing failed, fall back
  }
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
