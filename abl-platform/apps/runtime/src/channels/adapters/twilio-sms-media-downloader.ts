/**
 * Twilio SMS/MMS Media Downloader
 *
 * Downloads MMS media attachments from Twilio's API. Twilio media URLs
 * (e.g. https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Media/{MediaSid})
 * require HTTP Basic Auth (AccountSid:AuthToken) for access.
 *
 * Returns a Node.js Readable stream suitable for piping to MultimodalServiceClient.upload().
 */

import { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('twilio-sms-media-downloader');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Allowed host suffixes for SSRF protection. */
const ALLOWED_HOST_SUFFIXES = ['.twilio.com'];

function normalizeHostnameFromUrl(url: string | undefined): string | null {
  try {
    return new URL(url ?? '').hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHost(url: string, apiBaseUrl?: string): boolean {
  const hostname = normalizeHostnameFromUrl(url);
  if (!hostname) {
    return false;
  }

  if (ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }

  const configuredHostname = normalizeHostnameFromUrl(apiBaseUrl);
  return configuredHostname !== null && hostname === configuredHostname;
}

function summarizeAllowedHosts(apiBaseUrl?: string): string {
  const configuredHostname = normalizeHostnameFromUrl(apiBaseUrl);
  return configuredHostname
    ? `.twilio.com or configured host ${configuredHostname}`
    : '.twilio.com';
}

/** Map common MIME types to file extensions. */
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
    'text/plain': 'txt',
  };
  const baseMime = mimeType.split(';')[0].trim();
  return map[baseMime] || 'bin';
}

export interface TwilioMediaReference {
  url: string;
  contentType: string;
  index: number;
}

export type TwilioMediaDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string };

export interface DownloadOptions {
  accountSid: string;
  authToken: string;
  apiBaseUrl?: string;
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export async function downloadTwilioMedia(
  mediaRef: TwilioMediaReference,
  options: DownloadOptions,
): Promise<TwilioMediaDownloadResult> {
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  if (!mediaRef.url) {
    return { success: false, error: 'Missing media URL' };
  }

  if (!isAllowedHost(mediaRef.url, options.apiBaseUrl)) {
    log.warn('Blocked download from non-Twilio host', {
      url: mediaRef.url.substring(0, 80),
    });
    return {
      success: false,
      error: `Download blocked: URL host is not an allowed Twilio domain (${summarizeAllowedHosts(options.apiBaseUrl)})`,
    };
  }

  try {
    const basicAuth = Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64');

    const response = await fetch(mediaRef.url, {
      headers: { Authorization: `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Twilio media download failed: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const contentType =
      response.headers.get('content-type') || mediaRef.contentType || 'application/octet-stream';
    const baseMime = contentType.split(';')[0].trim();

    const contentLength = response.headers.get('content-length');
    const sizeBytes = contentLength ? parseInt(contentLength, 10) : 0;
    if (sizeBytes > maxSize) {
      return {
        success: false,
        error: `File (${sizeBytes} bytes) exceeds max size (${maxSize} bytes)`,
      };
    }

    const webStream = response.body;
    if (!webStream) {
      return { success: false, error: 'Twilio media download returned no body' };
    }

    const nodeStream = Readable.fromWeb(webStream as any);
    const ext = mimeToExtension(baseMime);
    const filename = `twilio_mms_${mediaRef.index}_${Date.now()}.${ext}`;

    return {
      success: true,
      stream: nodeStream,
      filename,
      mimeType: baseMime,
      sizeBytes,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
    };
  }
}
