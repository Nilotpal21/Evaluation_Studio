import { Readable } from 'stream';
import type { ReadableStream } from 'stream/web';

const LINE_DATA_API_BASE = 'https://api-data.line.me';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 20 * 1024 * 1024;

export interface LineMediaReference {
  messageId: string;
  mediaType: 'image' | 'video' | 'audio' | 'file';
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
}

export type LineMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; messageId: string };

export interface DownloadOptions {
  apiBase?: string;
  timeoutMs?: number;
  maxSizeBytes?: number;
}

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/octet-stream': 'bin',
  };

  const baseMime = mimeType.split(';')[0]?.trim() || 'application/octet-stream';
  return map[baseMime] || 'bin';
}

export async function downloadLineMedia(
  mediaRef: LineMediaReference,
  accessToken: string,
  options?: DownloadOptions,
): Promise<LineMediaDownloadResult> {
  const apiBase = options?.apiBase ?? LINE_DATA_API_BASE;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

  if (!mediaRef.messageId) {
    return { success: false, error: 'Missing messageId', messageId: mediaRef.messageId };
  }

  if (mediaRef.sizeBytes && mediaRef.sizeBytes > maxSizeBytes) {
    return {
      success: false,
      error: `File (${mediaRef.sizeBytes} bytes) exceeds max size (${maxSizeBytes} bytes)`,
      messageId: mediaRef.messageId,
    };
  }

  try {
    const response = await fetch(
      `${apiBase}/v2/bot/message/${encodeURIComponent(mediaRef.messageId)}/content`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      return {
        success: false,
        error: `LINE content download failed: HTTP ${response.status}`,
        messageId: mediaRef.messageId,
      };
    }

    const sizeBytes = Number(response.headers.get('content-length') || mediaRef.sizeBytes || 0);
    if (sizeBytes > maxSizeBytes) {
      return {
        success: false,
        error: `File (${sizeBytes} bytes) exceeds max size (${maxSizeBytes} bytes)`,
        messageId: mediaRef.messageId,
      };
    }

    if (!response.body) {
      return {
        success: false,
        error: 'LINE content download returned no body',
        messageId: mediaRef.messageId,
      };
    }

    const mimeType =
      response.headers.get('content-type') || mediaRef.mimeType || 'application/octet-stream';
    const filename =
      mediaRef.filename ||
      `${mediaRef.mediaType}_${mediaRef.messageId}.${mimeToExtension(mimeType)}`;

    return {
      success: true,
      stream: Readable.fromWeb(response.body as unknown as ReadableStream),
      filename,
      mimeType,
      sizeBytes,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown download error',
      messageId: mediaRef.messageId,
    };
  }
}
