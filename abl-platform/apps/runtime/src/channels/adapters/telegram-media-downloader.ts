/**
 * Telegram Media Downloader
 *
 * Downloads media from Telegram Bot API using a two-step process:
 * 1. GET /bot{token}/getFile?file_id={id} -> returns { result: { file_path } }
 * 2. GET https://api.telegram.org/file/bot{token}/{file_path} -> binary stream
 */

import { Readable } from 'stream';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB (Telegram Bot API download limit)

export interface TelegramMediaReference {
  fileId: string;
  mimeType: string;
  mediaType: 'photo' | 'audio' | 'video' | 'document' | 'voice' | 'video_note' | 'sticker';
  fileSize?: number;
  filename?: string;
}

export type TelegramMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; fileId: string };

export interface DownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  apiBase?: string;
}

/** Map common MIME types to file extensions. */
function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
  };
  const baseMime = mimeType.split(';')[0].trim();
  return map[baseMime] || 'bin';
}

export async function downloadTelegramMedia(
  mediaRef: TelegramMediaReference,
  botToken: string,
  options?: DownloadOptions,
): Promise<TelegramMediaDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const apiBase = options?.apiBase ?? TELEGRAM_API_BASE;

  if (!mediaRef.fileId) {
    return { success: false, error: 'Missing fileId', fileId: mediaRef.fileId };
  }

  // Check known size before downloading
  if (mediaRef.fileSize && mediaRef.fileSize > maxSize) {
    return {
      success: false,
      error: `File (${mediaRef.fileSize} bytes) exceeds max size (${maxSize} bytes)`,
      fileId: mediaRef.fileId,
    };
  }

  try {
    // Step 1: Get file path from Telegram
    const getFileUrl = `${apiBase}/bot${botToken}/getFile?file_id=${encodeURIComponent(mediaRef.fileId)}`;
    const metadataResp = await fetch(getFileUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!metadataResp.ok) {
      return {
        success: false,
        error: `Telegram getFile failed: HTTP ${metadataResp.status}`,
        fileId: mediaRef.fileId,
      };
    }

    const metadata = (await metadataResp.json()) as {
      ok: boolean;
      result?: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string };
    };

    if (!metadata.ok || !metadata.result?.file_path) {
      return {
        success: false,
        error: 'Telegram getFile returned no file_path',
        fileId: mediaRef.fileId,
      };
    }

    const fileSize = metadata.result.file_size ?? 0;
    if (fileSize > maxSize) {
      return {
        success: false,
        error: `File (${fileSize} bytes) exceeds max size (${maxSize} bytes)`,
        fileId: mediaRef.fileId,
      };
    }

    // Step 2: Download the file
    const downloadUrl = `${apiBase}/file/bot${botToken}/${metadata.result.file_path}`;
    const fileResp = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!fileResp.ok) {
      return {
        success: false,
        error: `Telegram file download failed: HTTP ${fileResp.status}`,
        fileId: mediaRef.fileId,
      };
    }

    const webStream = fileResp.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Telegram file download returned no body',
        fileId: mediaRef.fileId,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    const filename =
      mediaRef.filename ||
      `${mediaRef.mediaType}_${mediaRef.fileId}.${mimeToExtension(mediaRef.mimeType)}`;

    return {
      success: true,
      stream: nodeStream,
      filename,
      mimeType: mediaRef.mimeType,
      sizeBytes: fileSize,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
      fileId: mediaRef.fileId,
    };
  }
}
