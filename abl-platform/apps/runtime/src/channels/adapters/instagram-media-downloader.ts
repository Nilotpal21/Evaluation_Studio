/**
 * Instagram Media Downloader
 *
 * Downloads attachments from Instagram/Meta CDN using the URL provided in the webhook payload.
 * Instagram attachment URLs contain embedded authentication signatures, so no additional
 * access token is needed for download. However, the URLs expire within minutes to hours,
 * so files must be downloaded promptly after receiving the webhook.
 *
 * Returns a Node.js Readable stream suitable for piping to MultimodalServiceClient.upload().
 */

import { Readable, Transform } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('instagram-media-downloader');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Allowed Instagram/Meta CDN host suffixes for SSRF protection. */
const ALLOWED_CDN_HOST_SUFFIXES = [
  '.cdninstagram.com',
  '.fbcdn.net',
  '.facebook.com',
  '.fb.com',
  '.fbsbx.com',
  '.instagram.com',
];

function isAllowedCdnHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ALLOWED_CDN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Map common MIME types to file extensions (avoids adding mime-types dependency). */
function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/aac': 'aac',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
  };
  // Handle mime types with parameters (e.g. "audio/ogg; codecs=opus")
  const baseMime = mimeType.split(';')[0].trim();
  return map[baseMime] || 'bin';
}

export interface InstagramMediaReference {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
}

export type InstagramMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string };

export interface DownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export async function downloadInstagramMedia(
  mediaRef: InstagramMediaReference,
  options?: DownloadOptions,
): Promise<InstagramMediaDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  if (!mediaRef.url) {
    return { success: false, error: 'Missing media URL' };
  }

  if (!isAllowedCdnHost(mediaRef.url)) {
    log.warn('Blocked download from non-Meta CDN host', {
      url: mediaRef.url.substring(0, 80),
      type: mediaRef.type,
    });
    return {
      success: false,
      error: `Download blocked: URL host is not a recognized Meta CDN domain`,
    };
  }

  try {
    const response = await fetch(mediaRef.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Instagram media download failed: HTTP ${response.status} ${response.statusText}`,
      };
    }

    // Verify the response is not an HTML error page (e.g. expired URL redirect)
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (contentType.includes('text/html')) {
      return {
        success: false,
        error: `Instagram returned HTML instead of media — URL may have expired (content-type: ${contentType})`,
      };
    }

    // Check size via Content-Length when available (fast reject for known-large files)
    const contentLength = response.headers.get('content-length');
    const declaredSize = contentLength ? parseInt(contentLength, 10) : 0;
    if (declaredSize > maxSize) {
      return {
        success: false,
        error: `File (${declaredSize} bytes) exceeds max size (${maxSize} bytes)`,
      };
    }

    const webStream = response.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Instagram media download returned no body',
      };
    }

    // Wrap in a size-limiting transform to enforce the cap during streaming.
    // This catches chunked responses that omit Content-Length.
    let receivedBytes = 0;
    const sizeLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxSize) {
          callback(
            new Error(
              `Stream exceeded max size (${maxSize} bytes) after receiving ${receivedBytes} bytes`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    const rawStream = Readable.fromWeb(webStream as any);
    const limitedStream = rawStream.pipe(sizeLimiter);

    // Propagate destroy upstream so the HTTP connection is torn down on abort
    limitedStream.on('error', () => {
      if (!rawStream.destroyed) rawStream.destroy();
    });

    const baseMime = contentType.split(';')[0].trim();
    const ext = mimeToExtension(baseMime);
    const filename = `instagram_${mediaRef.type}_${Date.now()}.${ext}`;

    return {
      success: true,
      stream: limitedStream,
      filename,
      mimeType: baseMime,
      sizeBytes: declaredSize,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
    };
  }
}
