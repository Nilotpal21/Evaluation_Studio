/**
 * WhatsApp Media Downloader
 *
 * Downloads media from WhatsApp's Cloud API using a two-step process:
 * 1. GET /{version}/{media_id} with Bearer token → returns { url, mime_type, file_size }
 * 2. GET {url} with Bearer token → returns binary file stream
 *
 * The URL from step 1 expires in 5 minutes.
 * Returns a Node.js Readable stream suitable for piping to MultimodalServiceClient.upload().
 */

import { Readable } from 'stream';
import { META_GRAPH_API_VERSION, META_GRAPH_API_BASE } from '../meta-constants.js';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface WhatsAppMediaReference {
  mediaId: string;
  mimeType: string;
  mediaType: 'image' | 'audio' | 'video' | 'document';
  filename?: string;
}

export type WhatsAppMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; mediaId: string };

export interface DownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  graphApiBase?: string;
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
    'audio/aac': 'aac',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/amr': 'amr',
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

export async function downloadWhatsAppMedia(
  mediaRef: WhatsAppMediaReference,
  accessToken: string,
  options?: DownloadOptions,
): Promise<WhatsAppMediaDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const graphBase = options?.graphApiBase ?? META_GRAPH_API_BASE;

  if (!mediaRef.mediaId) {
    return { success: false, error: 'Missing mediaId', mediaId: mediaRef.mediaId };
  }

  try {
    // Step 1: Retrieve media URL from Graph API
    const metadataUrl = `${graphBase}/${META_GRAPH_API_VERSION}/${mediaRef.mediaId}`;
    const metadataResp = await fetch(metadataUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!metadataResp.ok) {
      return {
        success: false,
        error: `WhatsApp media URL retrieval failed: HTTP ${metadataResp.status} ${metadataResp.statusText}`,
        mediaId: mediaRef.mediaId,
      };
    }

    const metadata = (await metadataResp.json()) as {
      url: string;
      mime_type: string;
      file_size: number;
      id: string;
    };

    if (!metadata.url) {
      return {
        success: false,
        error: 'WhatsApp media metadata missing download URL',
        mediaId: mediaRef.mediaId,
      };
    }

    // Check size before downloading the actual file
    if (metadata.file_size > maxSize) {
      return {
        success: false,
        error: `File (${metadata.file_size} bytes) exceeds max size (${maxSize} bytes)`,
        mediaId: mediaRef.mediaId,
      };
    }

    // Step 2: Download the actual file from the temporary URL
    const fileResp = await fetch(metadata.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!fileResp.ok) {
      return {
        success: false,
        error: `WhatsApp media download failed: HTTP ${fileResp.status} ${fileResp.statusText}`,
        mediaId: mediaRef.mediaId,
      };
    }

    const webStream = fileResp.body;
    if (!webStream) {
      return {
        success: false,
        error: 'WhatsApp media download returned no body',
        mediaId: mediaRef.mediaId,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    // Determine filename: use document filename, or generate from mediaType + ID
    const filename =
      mediaRef.filename ||
      `${mediaRef.mediaType}_${mediaRef.mediaId}.${mimeToExtension(metadata.mime_type)}`;

    return {
      success: true,
      stream: nodeStream,
      filename,
      mimeType: metadata.mime_type,
      sizeBytes: metadata.file_size,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
      mediaId: mediaRef.mediaId,
    };
  }
}
