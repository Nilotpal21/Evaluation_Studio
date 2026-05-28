/**
 * Slack File Downloader
 *
 * Downloads files from Slack's CDN using the bot token for authentication.
 * Returns a Node.js Readable stream suitable for piping to MultimodalServiceClient.upload().
 *
 * Slack requires: GET url_private_download with Authorization: Bearer <bot_token>
 */

import { Readable } from 'stream';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const FAILURE_SNIPPET_MAX_CHARS = 300;

export interface SlackFileReference {
  slackFileId: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  downloadUrl: string;
}

export interface DownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export interface SlackFileDownloadFailureDetails {
  reason: 'file_too_large' | 'http_error' | 'html_error_page' | 'empty_body' | 'network_error';
  statusCode?: number;
  statusText?: string;
  contentType?: string;
  responseSnippet?: string;
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export type SlackFileDownloadFailure = {
  success: false;
  error: string;
  slackFileId: string;
  details?: SlackFileDownloadFailureDetails;
};

export type SlackFileDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | SlackFileDownloadFailure;

function buildDownloadFailure(
  fileRef: SlackFileReference,
  error: string,
  details?: SlackFileDownloadFailureDetails,
): SlackFileDownloadFailure {
  return {
    success: false,
    error,
    slackFileId: fileRef.slackFileId,
    ...(details && { details }),
  };
}

async function readFailureSnippet(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim();
    if (!text) {
      return undefined;
    }

    return text.slice(0, FAILURE_SNIPPET_MAX_CHARS);
  } catch {
    return undefined;
  }
}

export async function downloadSlackFile(
  fileRef: SlackFileReference,
  botToken: string,
  options?: DownloadOptions,
): Promise<SlackFileDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  // Pre-check size before downloading
  if (fileRef.size > maxSize) {
    return buildDownloadFailure(
      fileRef,
      `File "${fileRef.name}" (${fileRef.size} bytes) exceeds max size (${maxSize} bytes)`,
      {
        reason: 'file_too_large',
        maxSizeBytes: maxSize,
      },
    );
  }

  try {
    const response = await fetch(fileRef.downloadUrl, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || undefined;
      const responseSnippet = await readFailureSnippet(response.clone());
      return buildDownloadFailure(
        fileRef,
        `Slack file download failed: HTTP ${response.status} ${response.statusText}`,
        {
          reason: 'http_error',
          statusCode: response.status,
          statusText: response.statusText,
          ...(contentType && { contentType }),
          ...(responseSnippet && { responseSnippet }),
        },
      );
    }

    // Verify the response is the expected file, not an HTML auth/error page.
    // Slack returns 200 with HTML when the bot token lacks files:read scope.
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const responseSnippet = await readFailureSnippet(response.clone());
      return buildDownloadFailure(
        fileRef,
        `Slack returned HTML instead of file — bot token may lack files:read scope (content-type: ${contentType})`,
        {
          reason: 'html_error_page',
          contentType,
          ...(responseSnippet && { responseSnippet }),
        },
      );
    }

    // Convert web ReadableStream to Node.js Readable
    const webStream = response.body;
    if (!webStream) {
      return buildDownloadFailure(fileRef, 'Slack file download returned no body', {
        reason: 'empty_body',
        ...(contentType && { contentType }),
      });
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    return {
      success: true,
      stream: nodeStream,
      filename: fileRef.name,
      mimeType: fileRef.mimetype,
      sizeBytes: fileRef.size,
    };
  } catch (err) {
    return buildDownloadFailure(
      fileRef,
      err instanceof Error ? err.message : 'Unknown download error',
      {
        reason: 'network_error',
        timeoutMs,
      },
    );
  }
}
