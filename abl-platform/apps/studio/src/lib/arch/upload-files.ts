/**
 * Upload files to the arch-ai upload endpoint.
 * B03: Each file uploaded separately with progress callback.
 * B03 Phase 2: Image resize via Web Worker before upload.
 */

import { authHeaders } from '@/lib/api-client';
import {
  normalizeArchDeclaredMimeType,
  normalizeArchUploadMimeType,
} from '@/lib/arch-ai/file-mime';

export type UploadedFileStatus =
  | 'active'
  | 'processing'
  | 'failed'
  | 'blocked'
  | 'excluded'
  | 'evicted'
  | 'deleted';

export interface UploadResult {
  blobId: string;
  metadata: Record<string, unknown>;
  tokenCost: number;
  collision: boolean;
  existingBlobId?: string;
  status?: UploadedFileStatus;
  unavailableReason?: string | null;
}

export interface UploadFailure {
  fileName: string;
  message: string;
  code?: string;
  status?: number;
}

export interface UploadFilesOptions {
  /**
   * Wait until the multimodal pipeline has finished scanning/extracting the
   * attachment before resolving. Use this for one-shot send flows that do not
   * keep a visible "processing" attachment chip around.
   */
  waitForReady?: boolean;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
}

interface UploadErrorPayload {
  success?: boolean;
  data?: UploadResult;
  error?: {
    code?: string;
    message?: string;
  };
  errors?: Array<{
    code?: string;
    msg?: string;
  }>;
}

function formatUploadErrorMessage(failures: UploadFailure[]): string {
  const firstFailure = failures[0];
  if (!firstFailure) {
    return 'File upload failed. Your message was not sent.';
  }

  if (failures.length === 1) {
    return `Failed to upload "${firstFailure.fileName}": ${firstFailure.message}. Your message was not sent.`;
  }

  const remainingCount = failures.length - 1;
  const remainingLabel = remainingCount === 1 ? '1 other file' : `${remainingCount} other files`;
  return `Failed to upload "${firstFailure.fileName}" and ${remainingLabel}. Your message was not sent.`;
}

function extractUploadFailure(
  payload: UploadErrorPayload,
  status: number,
): Pick<UploadFailure, 'message' | 'code'> {
  const sharedError = Array.isArray(payload.errors)
    ? payload.errors.find((entry) => typeof entry?.msg === 'string' && entry.msg.trim().length > 0)
    : undefined;
  if (sharedError?.msg) {
    return {
      message: sharedError.msg,
      code: sharedError.code,
    };
  }

  if (payload.error?.message) {
    return {
      message: payload.error.message,
      code: payload.error.code,
    };
  }

  return {
    message: `Upload failed: ${status}`,
  };
}

export interface UploadedFileDetails {
  blobId: string;
  name: string;
  mediaType: string;
  size: number;
  status: UploadedFileStatus;
  tokenCost: number;
  metadata: Record<string, unknown>;
  unavailableReason?: string | null;
}

export class UploadFilesError extends Error {
  readonly failures: UploadFailure[];
  readonly uploadedCount: number;
  readonly attemptedCount: number;

  constructor(failures: UploadFailure[], uploadedCount: number, attemptedCount: number) {
    super(formatUploadErrorMessage(failures));
    this.name = 'UploadFilesError';
    this.failures = failures;
    this.uploadedCount = uploadedCount;
    this.attemptedCount = attemptedCount;
  }
}

/** Claude / Anthropic vision max dimension */
const IMAGE_MAX_DIM = 1568;

/** Timeout for worker resize (ms) */
const RESIZE_TIMEOUT_MS = 15_000;

/** Timeout for immediate-send flows waiting on scan/extraction (ms). */
const READY_TIMEOUT_MS = 90_000;

/** Polling interval while an uploaded attachment is still processing (ms). */
const READY_POLL_INTERVAL_MS = 1_000;

const UPLOAD_READY_STATUSES = new Set<UploadedFileStatus>(['active']);
const UPLOAD_PENDING_STATUSES = new Set<UploadedFileStatus>(['processing']);

// ─── Image Resize ──────────────────────────────────────────────────────────

interface ResizeResult {
  base64: string;
  width: number;
  height: number;
  /** The MIME type of the resized output (may differ from input, e.g. webp -> jpeg) */
  outputMimeType: string;
  /** True if image was actually resized (false = passthrough) */
  resized: boolean;
}

/**
 * Read a File as an ArrayBuffer.
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => {
      reject(new Error(`Failed to read file: ${file.name}`));
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Resize an image in a Web Worker using OffscreenCanvas.
 * Falls back to main-thread base64 if Worker/OffscreenCanvas unavailable.
 */
export async function resizeImageInWorker(file: File, maxDim: number): Promise<ResizeResult> {
  // Check for OffscreenCanvas + Worker support
  if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') {
    return mainThreadFallback(file);
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);

  return new Promise<ResizeResult>((resolve, reject) => {
    let worker: Worker | undefined;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      worker?.terminate();
      // Fallback on timeout instead of rejecting
      mainThreadFallback(file).then(resolve, reject);
    }, RESIZE_TIMEOUT_MS);

    try {
      worker = new Worker('/workers/image-resize.worker.js');
    } catch {
      clearTimeout(timer);
      // Worker creation failed — fallback
      mainThreadFallback(file).then(resolve, reject);
      return;
    }

    worker.onmessage = (e: MessageEvent) => {
      if (timedOut) return;
      clearTimeout(timer);
      worker?.terminate();

      const msg = e.data as {
        type: string;
        base64?: string;
        width?: number;
        height?: number;
        outputMimeType?: string;
        message?: string;
      };

      if (msg.type === 'resized') {
        resolve({
          base64: msg.base64 ?? '',
          width: msg.width ?? 0,
          height: msg.height ?? 0,
          outputMimeType: msg.outputMimeType ?? file.type,
          resized: true,
        });
      } else if (msg.type === 'passthrough') {
        // No resize needed — read original as base64
        readFileAsBase64(file).then(
          (base64) =>
            resolve({
              base64,
              width: msg.width ?? 0,
              height: msg.height ?? 0,
              outputMimeType: file.type,
              resized: false,
            }),
          reject,
        );
      } else if (msg.type === 'error') {
        // Worker reported error — fallback
        mainThreadFallback(file).then(resolve, reject);
      }
    };

    worker.onerror = () => {
      if (timedOut) return;
      clearTimeout(timer);
      worker?.terminate();
      mainThreadFallback(file).then(resolve, reject);
    };

    worker.postMessage({ type: 'resize', imageData: arrayBuffer, maxDim, mimeType: file.type }, [
      arrayBuffer,
    ]);
  });
}

/**
 * Main-thread fallback: simply read file as base64 without resizing.
 */
async function mainThreadFallback(file: File): Promise<ResizeResult> {
  const base64 = await readFileAsBase64(file);
  return {
    base64,
    width: 0,
    height: 0,
    outputMimeType: file.type,
    resized: false,
  };
}

// ─── File Reading ──────────────────────────────────────────────────────────

/**
 * Read a File as base64 using FileReader.
 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = () => {
      reject(new Error(`Failed to read file: ${file.name}`));
    };
    reader.readAsDataURL(file);
  });
}

async function rollbackUploadedFiles(uploadedResults: UploadResult[]): Promise<number> {
  if (uploadedResults.length === 0) {
    return 0;
  }

  const uniqueBlobIds = Array.from(new Set(uploadedResults.map((result) => result.blobId)));
  const headers = authHeaders();
  const rollbackResults = await Promise.allSettled(
    uniqueBlobIds.map((blobId) =>
      fetch(`/api/arch-ai/files/${encodeURIComponent(blobId)}`, {
        method: 'DELETE',
        headers,
      }),
    ),
  );

  return rollbackResults.reduce((remainingCount, result) => {
    if (result.status === 'rejected') {
      return remainingCount + 1;
    }

    if (!result.value.ok && result.value.status !== 404) {
      return remainingCount + 1;
    }

    return remainingCount;
  }, 0);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeUploadDetails(result: UploadResult, details: UploadedFileDetails): UploadResult {
  return {
    ...result,
    metadata: details.metadata,
    tokenCost: details.tokenCost,
    status: details.status,
    unavailableReason: details.unavailableReason ?? null,
  };
}

function buildReadinessFailure(
  status: UploadedFileStatus,
  unavailableReason?: string | null,
): Pick<UploadFailure, 'message' | 'code'> {
  switch (status) {
    case 'blocked':
      return {
        message: unavailableReason ?? 'The uploaded file was blocked by the security scan',
        code: 'ATTACHMENT_BLOCKED',
      };
    case 'failed':
      return {
        message: unavailableReason ?? 'The uploaded file could not be prepared',
        code: 'ATTACHMENT_PREPARATION_FAILED',
      };
    case 'excluded':
    case 'evicted':
    case 'deleted':
      return {
        message: unavailableReason ?? 'The uploaded file is no longer available',
        code: 'ATTACHMENT_UNAVAILABLE',
      };
    case 'processing':
      return {
        message: unavailableReason ?? 'The uploaded file is still being prepared',
        code: 'ATTACHMENT_STILL_PROCESSING',
      };
    case 'active':
      return {
        message: unavailableReason ?? 'The uploaded file is ready',
      };
  }
}

async function waitForUploadReady(
  result: UploadResult,
  options: Required<Pick<UploadFilesOptions, 'readyTimeoutMs' | 'readyPollIntervalMs'>>,
): Promise<
  | { success: true; result: UploadResult }
  | { success: false; failure: Pick<UploadFailure, 'message' | 'code'> }
> {
  if (!result.status || UPLOAD_READY_STATUSES.has(result.status)) {
    return { success: true, result };
  }

  if (!UPLOAD_PENDING_STATUSES.has(result.status)) {
    return {
      success: false,
      failure: buildReadinessFailure(result.status, result.unavailableReason),
    };
  }

  const startedAt = Date.now();
  let latest = result;

  while (Date.now() - startedAt < options.readyTimeoutMs) {
    await wait(options.readyPollIntervalMs);

    try {
      const details = await fetchUploadedFile(result.blobId);
      latest = mergeUploadDetails(result, details);
    } catch {
      continue;
    }

    if (UPLOAD_READY_STATUSES.has(latest.status ?? 'failed')) {
      return { success: true, result: latest };
    }

    if (latest.status && !UPLOAD_PENDING_STATUSES.has(latest.status)) {
      return {
        success: false,
        failure: buildReadinessFailure(latest.status, latest.unavailableReason),
      };
    }
  }

  return {
    success: false,
    failure: {
      message:
        latest.unavailableReason ??
        'The uploaded file is still being prepared. Try sending again in a moment',
      code: 'ATTACHMENT_PROCESSING_TIMEOUT',
    },
  };
}

// ─── Upload ────────────────────────────────────────────────────────────────

/**
 * Upload files to the arch-ai upload endpoint.
 * Each file is uploaded separately. Any upload failure aborts the
 * batch so we never send a message with silently missing attachments.
 *
 * Images exceeding 1568px are resized via Web Worker before upload.
 */
export async function uploadFiles(
  sessionId: string,
  files: File[],
  onProgress?: (fileIndex: number, progress: number) => void,
  options: UploadFilesOptions = {},
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  const readinessOptions = {
    readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
    readyPollIntervalMs: options.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS,
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i, 0);

    try {
      let content: string;
      let uploadType = normalizeArchUploadMimeType(file.name, file.type);
      let uploadSize = file.size;

      // Resize images that exceed the vision model max dimension
      if (uploadType.startsWith('image/') && uploadType !== 'image/svg+xml') {
        const resizeResult = await resizeImageInWorker(file, IMAGE_MAX_DIM);
        content = resizeResult.base64;
        if (resizeResult.resized) {
          uploadType = normalizeArchDeclaredMimeType(resizeResult.outputMimeType);
          // Estimate resized size from base64 length (base64 is ~4/3 of binary)
          uploadSize = Math.ceil((content.length * 3) / 4);
        }
      } else {
        content = await readFileAsBase64(file);
      }

      const res = await fetch('/api/arch-ai/files', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          file: {
            name: file.name,
            type: uploadType,
            size: uploadSize,
            content,
          },
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as UploadErrorPayload;
        const failure = extractUploadFailure(errData, res.status);
        throw new UploadFilesError(
          [
            {
              fileName: file.name,
              status: res.status,
              ...failure,
            },
          ],
          results.length,
          files.length,
        );
      }

      const data = (await res.json()) as UploadErrorPayload;
      if (!data.success || !data.data) {
        const failure = extractUploadFailure(data, res.status);
        throw new UploadFilesError(
          [
            {
              fileName: file.name,
              status: res.status,
              ...failure,
            },
          ],
          results.length,
          files.length,
        );
      }
      const resultIndex = results.length;
      results.push(data.data);
      let uploadResult = data.data;
      if (options.waitForReady) {
        const readiness = await waitForUploadReady(uploadResult, readinessOptions);
        if (!readiness.success) {
          throw new UploadFilesError(
            [
              {
                fileName: file.name,
                ...readiness.failure,
              },
            ],
            results.length,
            files.length,
          );
        }
        uploadResult = readiness.result;
      }

      results[resultIndex] = uploadResult;
      onProgress?.(i, 1);
    } catch (err: unknown) {
      const uploadError =
        err instanceof UploadFilesError
          ? err
          : new UploadFilesError(
              [
                {
                  fileName: file.name,
                  message: err instanceof Error ? err.message : String(err),
                },
              ],
              results.length,
              files.length,
            );

      const uploadedCount = await rollbackUploadedFiles(results);
      throw new UploadFilesError(uploadError.failures, uploadedCount, files.length);
    }
  }

  return results;
}

export async function fetchUploadedFile(blobId: string): Promise<UploadedFileDetails> {
  const response = await fetch(`/api/arch-ai/files/${encodeURIComponent(blobId)}`, {
    headers: authHeaders(),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: UploadedFileDetails;
    errors?: Array<{ msg?: string }>;
  };

  if (!response.ok || !payload.success || !payload.data) {
    const message =
      payload.errors?.find((entry) => typeof entry.msg === 'string' && entry.msg.trim().length > 0)
        ?.msg ?? `Failed to fetch file status: ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}
