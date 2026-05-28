/**
 * Native Docling connector (LLD Phase 2 Task 2.3).
 *
 * Exposes a single `extract_document` action that:
 *   1. Validates inputs (Zod schema below).
 *   2. Re-validates the URL via `assertUrlSafeForSSRF` + a HEAD probe with a
 *      10s timeout that rejects oversized payloads and unsupported MIMEs
 *      before any rate-limit token or HMAC secret is consumed.
 *   3. Consumes a per-tenant rate-limit token from the shared
 *      `RateLimiterRedis` instance (FR-8).
 *   4. Generates a 32-byte plaintext HMAC secret, asks the workflow-engine
 *      to encrypt-at-rest a copy, and builds the callback URL.
 *   5. Enqueues a `WorkflowDoclingExtractionJobData` on the
 *      `workflow-docling-extraction` BullMQ queue with `attempts: 1`.
 *   6. Returns an `AsyncParkingSentinel` — the step dispatcher converts
 *      this into a Restate suspension request.
 *
 * The connector body is pure-ish: all side effects (rate-limit consume,
 * encrypt, enqueue) are workflow-engine-injected through `ctx.callbackContext`,
 * so the body itself is unit-testable with stub injections.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  assertUrlSafeForSSRF,
  type SSRFValidationOptions,
} from '@agent-platform/shared-kernel/security';
import {
  safeFetch,
  getEnvSSRFAllowedHosts,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import type {
  ActionContext,
  CallbackContext,
  Connector,
  ConnectorAction,
  AsyncParkingSentinel,
} from '../../types.js';
import { getDoclingRateLimiter } from './rate-limiter.js';

const DEFAULT_TIMEOUT_S = 60;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 1800;
const HEAD_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SIZE_HARD_CAP_BYTES = 500 * 1024 * 1024; // 500 MB

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/html',
  'text/markdown',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp',
  'image/webp',
]);

const ExtractDocumentParamsSchema = z.object({
  fileUrl: z.string().url(),
  extractImages: z.boolean().optional(),
  extractTables: z.boolean().optional(),
  ocrEnabled: z.boolean().optional(),
  language: z.string().optional(),
  timeout: z.number().int().min(MIN_TIMEOUT_S).max(MAX_TIMEOUT_S).optional(),
});

type ExtractDocumentParams = z.infer<typeof ExtractDocumentParamsSchema>;

export class DoclingActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DoclingActionError';
    this.code = code;
  }
}

const extractDocumentAction: ConnectorAction = {
  name: 'extract_document',
  displayName: 'Extract Document',
  description:
    'Extracts structured content (markdown, tables, images, page text) from a public document URL via Docling.',
  props: [
    {
      name: 'fileUrl',
      displayName: 'File URL',
      description: 'Public HTTP(S) URL of the document to extract.',
      type: 'string',
      required: true,
    },
    {
      name: 'extractImages',
      displayName: 'Extract Images',
      description: 'Include images in the result (default true).',
      type: 'boolean',
      required: false,
      defaultValue: true,
    },
    {
      name: 'extractTables',
      displayName: 'Extract Tables',
      description: 'Include tables in the result (default true).',
      type: 'boolean',
      required: false,
      defaultValue: true,
    },
    {
      name: 'ocrEnabled',
      displayName: 'OCR Enabled',
      description: 'Run OCR on scanned pages (default true).',
      type: 'boolean',
      required: false,
      defaultValue: true,
    },
    {
      name: 'language',
      displayName: 'Language Hint',
      description: 'ISO-639-1 language hint (e.g. "en").',
      type: 'string',
      required: false,
    },
    {
      name: 'timeout',
      displayName: 'Timeout (seconds)',
      description: 'Maximum extraction wall-clock seconds (5–1800; default 60).',
      type: 'number',
      required: false,
      defaultValue: DEFAULT_TIMEOUT_S,
    },
  ],
  async run(ctx: ActionContext): Promise<unknown> {
    return runExtractDocument(ctx);
  },
};

/**
 * Run the action. Exported for unit testing — production callers go through
 * the connector registry, which invokes `extractDocumentAction.run(ctx)`.
 */
export async function runExtractDocument(ctx: ActionContext): Promise<AsyncParkingSentinel> {
  const params = parseParams(ctx.params);
  const callbackContext = requireCallbackContext(ctx);
  const { tenantId, projectId, workflowExecutionId, stepId } = requireWorkflowContext(ctx);

  // 1. Static SSRF re-check (defense-in-depth before any work)
  const ssrfOptions = buildSSRFOptions();
  try {
    assertUrlSafeForSSRF(params.fileUrl, ssrfOptions);
  } catch (err) {
    throw new DoclingActionError(
      'SSRF_BLOCKED',
      err instanceof Error ? err.message : 'URL blocked by SSRF guard',
    );
  }

  // 2. HEAD probe — rejects unsupported MIME / oversized files before
  // consuming a rate-limit token or generating a callback secret.
  const headResult = await headProbe(params.fileUrl, ssrfOptions);
  if (!ALLOWED_CONTENT_TYPES.has(headResult.contentType)) {
    const supportedList = Array.from(ALLOWED_CONTENT_TYPES).slice(0, 6).join(', ');
    throw new DoclingActionError(
      'UNSUPPORTED_CONTENT_TYPE',
      `Content type "${headResult.contentType || 'unknown'}" is not supported by Docling. ` +
        `Supported types include: ${supportedList}…`,
    );
  }
  const hardCap = sizeHardCapBytes();
  if (headResult.sizeBytes !== null && headResult.sizeBytes > hardCap) {
    const sizeMb = (headResult.sizeBytes / (1024 * 1024)).toFixed(1);
    const capMb = (hardCap / (1024 * 1024)).toFixed(0);
    throw new DoclingActionError(
      'EXTRACTION_TOO_LARGE',
      `File is ${sizeMb} MB but the Docling size cap is ${capMb} MB. ` +
        `Lower the file size or raise DOCLING_WORKFLOW_SIZE_HARD_CAP_BYTES on the workflow-engine.`,
    );
  }
  // If `sizeBytes === null` (no Content-Length on the HEAD response), the
  // worker-side stream-to-Docling pipeline (apps/search-ai
  // streamUrlToDocling) still enforces a cap during download and aborts
  // with EXTRACTION_TOO_LARGE if the bytes-read exceeds the limit. So
  // accepting here is safe — we don't need a separate pre-check warning.

  // 3. Per-tenant rate-limit
  const limiter = getDoclingRateLimiter(callbackContext.getSharedRedisClient?.() ?? null);
  try {
    await limiter.consume(tenantId, 1);
  } catch (err) {
    const msBeforeNext =
      typeof err === 'object' && err !== null && 'msBeforeNext' in err
        ? Number((err as { msBeforeNext: unknown }).msBeforeNext)
        : 0;
    const retryAfterSeconds = Math.ceil((Number.isFinite(msBeforeNext) ? msBeforeNext : 0) / 1000);
    throw new DoclingActionError(
      'RATE_LIMITED',
      `Tenant rate limit exceeded; retry after ${retryAfterSeconds}s`,
    );
  }

  // 4. Generate + encrypt the per-step HMAC secret; build callback URL.
  //    These run inside the outer `restateCtx.run('step:<stepId>')` wrap in
  //    workflow-handler.ts, so the action body is journaled as part of the
  //    step's dispatch result — no nested ctx.run needed.
  const plaintext = randomBytes(32).toString('hex');
  const encryptedCallbackSecret = await callbackContext.encryptSecret(plaintext, tenantId);
  const callbackUrl = callbackContext.callbackUrlBuilder(workflowExecutionId, stepId);
  const callbackId = `${workflowExecutionId}:${stepId}`;
  const callbackTimeoutMs = (params.timeout ?? DEFAULT_TIMEOUT_S) * 1000;

  // 5. Enqueue (workflow-engine-injected)
  if (!callbackContext.enqueueWorkflowDoclingJob) {
    throw new DoclingActionError(
      'INTEGRATION_UNAVAILABLE',
      'Workflow Docling queue is not configured on this engine instance',
    );
  }
  await callbackContext.enqueueWorkflowDoclingJob({
    tenantId,
    projectId,
    sourceUrl: params.fileUrl,
    workflowExecutionId,
    stepId,
    callbackId,
    callbackUrl,
    callbackSecret: plaintext,
    mode: 'extraction-only',
    options: {
      ...(params.extractImages !== undefined ? { extractImages: params.extractImages } : {}),
      ...(params.extractTables !== undefined ? { extractTables: params.extractTables } : {}),
      ...(params.ocrEnabled !== undefined ? { ocrEnabled: params.ocrEnabled } : {}),
      ...(params.language !== undefined ? { language: params.language } : {}),
      ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
    },
  });

  // 6. Return the sentinel — the step dispatcher converts it.
  const sentinel: AsyncParkingSentinel = {
    __asyncParking: true,
    callbackId,
    callbackTimeoutMs,
    encryptedCallbackSecret,
  };
  return sentinel;
}

function parseParams(raw: Record<string, unknown>): ExtractDocumentParams {
  const result = ExtractDocumentParamsSchema.safeParse(raw);
  if (!result.success) {
    throw new DoclingActionError(
      'INVALID_PARAMS',
      `Docling action params invalid: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return result.data;
}

function requireCallbackContext(ctx: ActionContext): CallbackContext {
  if (!ctx.callbackContext) {
    throw new DoclingActionError(
      'INTEGRATION_UNAVAILABLE',
      'Docling action requires the workflow-engine callback context — invoke through a workflow step',
    );
  }
  return ctx.callbackContext;
}

function requireWorkflowContext(ctx: ActionContext): {
  tenantId: string;
  projectId: string;
  workflowExecutionId: string;
  stepId: string;
} {
  const { tenantId, projectId, workflowExecutionId, stepId } = ctx;
  if (!workflowExecutionId || !stepId) {
    throw new DoclingActionError(
      'INTEGRATION_UNAVAILABLE',
      'Docling action requires workflow execution context (workflowExecutionId + stepId)',
    );
  }
  return { tenantId, projectId, workflowExecutionId, stepId };
}

function buildSSRFOptions(): SSRFValidationOptions {
  const allowed = getEnvSSRFAllowedHosts();
  return allowed.length > 0 ? { additionalAllowedHosts: allowed } : {};
}

async function headProbe(
  url: string,
  ssrfOptions: SSRFValidationOptions,
): Promise<{ contentType: string; sizeBytes: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_PROBE_TIMEOUT_MS);
  try {
    const response = await safeFetch(
      url,
      { method: 'HEAD', signal: controller.signal },
      ssrfOptions,
    );
    if (!response.ok) {
      throw new DoclingActionError(
        'EXTRACTION_FAILED',
        `HEAD probe returned HTTP ${response.status}`,
      );
    }
    const contentType =
      (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
    const lengthHeader = response.headers.get('content-length');
    const sizeBytes = lengthHeader ? Number(lengthHeader) : null;
    return {
      contentType,
      sizeBytes: sizeBytes !== null && Number.isFinite(sizeBytes) ? sizeBytes : null,
    };
  } catch (err) {
    if (err instanceof DoclingActionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DoclingActionError('EXTRACTION_TIMEOUT', 'HEAD probe timed out after 10s');
    }
    if (err instanceof Error && err.name === 'SSRFError') {
      throw new DoclingActionError('SSRF_BLOCKED', err.message);
    }
    throw new DoclingActionError(
      'EXTRACTION_FAILED',
      `HEAD probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function sizeHardCapBytes(): number {
  const raw = process.env.DOCLING_WORKFLOW_SIZE_HARD_CAP_BYTES;
  if (!raw) return DEFAULT_SIZE_HARD_CAP_BYTES;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SIZE_HARD_CAP_BYTES;
}

export const doclingConnector: Connector = {
  name: 'docling',
  displayName: 'Docling',
  version: '1.0.0',
  description: 'Layout-aware document extraction (PDF / DOCX / PPTX / HTML / images) via Docling.',
  auth: { type: 'none' },
  triggers: [],
  actions: [extractDocumentAction],
};
