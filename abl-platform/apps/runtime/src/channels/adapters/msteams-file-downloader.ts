/**
 * MS Teams File Downloader
 *
 * Downloads inbound Teams attachment references as streams for upload to the
 * multimodal-service attachment pipeline.
 */

import { Readable } from 'stream';
import { assertAllowedCallbackUrl } from '../security/callback-url-policy.js';

const DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.MSTEAMS_ATTACHMENT_DOWNLOAD_TIMEOUT_MS || '30000',
  10,
);
const DEFAULT_MAX_SIZE_BYTES = parseInt(
  process.env.MSTEAMS_ATTACHMENT_MAX_SIZE_BYTES || '52428800',
  10,
);
const DEFAULT_BOT_TOKEN_ALLOWED_HOSTS = [
  'smba.trafficmanager.net',
  '.teams.microsoft.com',
  '.sharepoint.com',
  '.sharepoint-df.com',
  '.onedrive.com',
];

export type MSTeamsFileSource = 'file_download_info' | 'inline_image';

export interface MSTeamsFileReference {
  source: MSTeamsFileSource;
  name: string;
  mimeType: string;
  downloadUrl: string;
  fileType?: string;
  uniqueId?: string;
  sizeBytes?: number;
  requiresBotToken?: boolean;
}

export type MSTeamsFileDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; filename: string };

export interface TeamsDownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  botToken?: string;
}

function parseBotTokenAllowedHosts(): string[] {
  const raw = process.env.MSTEAMS_ATTACHMENT_BEARER_ALLOWED_HOSTS;
  if (!raw?.trim()) return DEFAULT_BOT_TOKEN_ALLOWED_HOSTS;
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('.')) {
    const suffix = pattern.slice(1);
    return hostname === suffix || hostname.endsWith(pattern);
  }
  return hostname === pattern;
}

function isBotTokenAllowedForUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return parseBotTokenAllowedHosts().some((pattern) => hostMatchesPattern(hostname, pattern));
  } catch {
    return false;
  }
}

function isHtmlResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes('text/html');
}

async function fetchFile(url: string, timeoutMs: number, botToken?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (botToken) {
    headers.Authorization = `Bearer ${botToken}`;
  }
  return fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function downloadMSTeamsFile(
  fileRef: MSTeamsFileReference,
  options?: TeamsDownloadOptions,
): Promise<MSTeamsFileDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const botToken = options?.botToken;
  const canAttachBotToken = !!botToken && isBotTokenAllowedForUrl(fileRef.downloadUrl);

  if (typeof fileRef.sizeBytes === 'number' && fileRef.sizeBytes > maxSize) {
    return {
      success: false,
      error: `File "${fileRef.name}" (${fileRef.sizeBytes} bytes) exceeds max size (${maxSize} bytes)`,
      filename: fileRef.name,
    };
  }

  try {
    await assertAllowedCallbackUrl(fileRef.downloadUrl, process.env.NODE_ENV === 'production');
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Blocked download URL',
      filename: fileRef.name,
    };
  }

  if (fileRef.requiresBotToken && !canAttachBotToken) {
    return {
      success: false,
      error: `Refusing to send Teams bot token to untrusted attachment host: ${fileRef.downloadUrl}`,
      filename: fileRef.name,
    };
  }

  try {
    let response = await fetchFile(
      fileRef.downloadUrl,
      timeoutMs,
      fileRef.requiresBotToken && canAttachBotToken ? botToken : undefined,
    );

    // Some Teams file URLs require bearer auth; retry with token on auth failure.
    if (
      !response.ok &&
      (response.status === 401 || response.status === 403) &&
      canAttachBotToken &&
      !fileRef.requiresBotToken
    ) {
      response = await fetchFile(fileRef.downloadUrl, timeoutMs, botToken);
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Teams file download failed: HTTP ${response.status} ${response.statusText}`,
        filename: fileRef.name,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    if (isHtmlResponse(contentType)) {
      return {
        success: false,
        error: `Teams returned HTML instead of file (content-type: ${contentType})`,
        filename: fileRef.name,
      };
    }

    const headerSizeRaw = response.headers.get('content-length');
    const headerSize = headerSizeRaw ? parseInt(headerSizeRaw, 10) : NaN;
    if (!Number.isNaN(headerSize) && headerSize > maxSize) {
      return {
        success: false,
        error: `File "${fileRef.name}" (${headerSize} bytes) exceeds max size (${maxSize} bytes)`,
        filename: fileRef.name,
      };
    }

    const webStream = response.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Teams file download returned no body',
        filename: fileRef.name,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);
    return {
      success: true,
      stream: nodeStream,
      filename: fileRef.name,
      mimeType: fileRef.mimeType || 'application/octet-stream',
      sizeBytes: Number.isNaN(headerSize) ? fileRef.sizeBytes || 0 : headerSize,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
      filename: fileRef.name,
    };
  }
}
