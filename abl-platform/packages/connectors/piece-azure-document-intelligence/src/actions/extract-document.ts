/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Azure Document Intelligence — `extract_document` action.
 *
 * Production async path (when enqueueADIPollJob is wired):
 *   1. SSRF check + HEAD probe + rate-limit guard (pre-enqueue).
 *   2. POST `:analyze` to Azure → get operationLocation.
 *   3. Stash operationLocation in ctx.store (replay-safe across Restate retries).
 *   4. Encrypt callbackSecret; enqueue a `workflow-adi-poll` BullMQ job.
 *   5. Return AsyncParkingSentinel — Restate handler parks on an awakeable.
 *   6. AdiPollWorker (inside workflow-engine) polls Azure with exponential
 *      backoff, normalizes the analyzeResult, and POSTs the callback.
 *
 * Fallback (enqueueADIPollJob absent — non-workflow callers): throws
 * INTEGRATION_UNAVAILABLE to surface a clear misconfiguration error.
 */

import { randomBytes } from 'node:crypto';
import { createAction, Property } from '@activepieces/pieces-framework';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { assertUrlSafeForSSRF, safeFetch, SSRFError } from '../safe-fetch';
import { azureDocumentIntelligenceAuth } from '../auth';
import { parseRetryAfter } from '../parse-retry-after';
import type { AzureDocumentIntelligenceServices } from '../types';

/** Minimal local shape — structurally compatible with the engine's AsyncParkingSentinel. */
interface AsyncParkingSentinel {
  readonly __asyncParking: true;
  callbackId: string;
  callbackTimeoutMs: number;
  encryptedCallbackSecret?: string;
}

/** Minimal local shape for the callback context injected via ctx.abl. */
interface AdiCallbackContext {
  callbackId: string;
  callbackUrlBuilder: (executionId: string, stepId: string) => string;
  encryptSecret: (plaintext: string, tenantId: string) => Promise<string>;
  getSharedRedisClient?: () => { duplicate?: (opts?: Record<string, unknown>) => unknown } | null;
  enqueueADIPollJob?: (payload: {
    tenantId: string;
    projectId: string;
    workflowExecutionId: string;
    stepId: string;
    callbackId: string;
    callbackUrl: string;
    callbackSecret: string;
    operationLocation: string;
    endpoint: string;
    apiKey: string;
    apiVersion: string;
    sourceUrl: string;
    contentType: string;
    timeoutMs: number;
    startedAt: number;
    errorDelayMs: number;
    mode: 'workflow-adi-poll';
  }) => Promise<{ jobId: string }>;
}

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 1800;
const HEAD_PROBE_TIMEOUT_MS = 10_000;
/** Hard cap for the :analyze POST — Azure slow-gateway hangs block the Restate handler slot. */
const ANALYZE_POST_TIMEOUT_MS = 60_000;
const DEFAULT_INLINE_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_AZURE_DI_RATE_PER_MIN = 10;
const AZURE_DI_OPERATION_STORE_TTL_SECONDS = 86_400;

export class AzureDIActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AzureDIActionError';
    this.code = code;
  }
}

// F-5: Redis-backed rate limiter — shared across all replicas so the
// 10/min/tenant limit holds under horizontal scaling. Falls back to
// RateLimiterMemory when Redis is unavailable (dev / CI environments).
let _rateLimiter: RateLimiterMemory | RateLimiterRedis | null = null;

function getRateLimiter(
  redisClient: { duplicate?: (opts?: Record<string, unknown>) => unknown; status?: string } | null,
): RateLimiterMemory | RateLimiterRedis {
  // Return cached Redis limiter if already created — avoids recreating on every call.
  // Memory fallback is NOT cached so a future call with a live Redis client can upgrade.
  if (_rateLimiter) return _rateLimiter;
  const points = parsePositiveIntEnv('AZURE_DI_RATE_PER_MIN', DEFAULT_AZURE_DI_RATE_PER_MIN);
  if (redisClient && redisClient.status === 'ready') {
    _rateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      points,
      duration: 60,
      keyPrefix: 'azure-di-rate:',
    });
    return _rateLimiter;
  }
  // No Redis or Redis not yet connected — return a temporary in-memory limiter without
  // caching so the next call can try Redis again once it becomes ready.
  return new RateLimiterMemory({ points, duration: 60 });
}

export const extractDocumentAction = createAction({
  auth: azureDocumentIntelligenceAuth,
  name: 'extract_document',
  displayName: 'Extract Document',
  description:
    'Extract layout-aware content from a public document URL via Azure Document Intelligence.',
  props: {
    fileUrl: Property.ShortText({
      displayName: 'File URL',
      description:
        'Public HTTP(S) URL of the document to extract. Max response size: 10 MB (configurable via AZURE_DI_WORKFLOW_INLINE_CAP_BYTES). Azure supports PDF, DOCX, PPTX, JPEG, PNG, BMP, TIFF, HEIF.',
      required: true,
    }),
    // Azure DI prebuilt model — see
    // https://learn.microsoft.com/azure/ai-services/document-intelligence/model-overview
    // for the canonical list. Grouped here by document family so the workflow
    // canvas dropdown is scannable. `prebuilt-layout` is the safe default for
    // unstructured documents (text + tables + structure).
    model: Property.StaticDropdown({
      displayName: 'Model',
      description: 'Azure DI prebuilt model for this extraction.',
      required: false,
      defaultValue: 'prebuilt-layout',
      options: {
        disabled: false,
        options: [
          // Document analysis
          { label: 'Read — OCR + text', value: 'prebuilt-read' },
          { label: 'Layout — text + tables + structure', value: 'prebuilt-layout' },
          { label: 'Contract', value: 'prebuilt-contract' },
          // Financial / business
          { label: 'Invoice', value: 'prebuilt-invoice' },
          { label: 'Receipt', value: 'prebuilt-receipt' },
          { label: 'Bank statement', value: 'prebuilt-bankStatement' },
          { label: 'US bank check', value: 'prebuilt-check.us' },
          { label: 'US pay stub', value: 'prebuilt-payStub.us' },
          { label: 'Credit card', value: 'prebuilt-creditCard' },
          // Identity / healthcare
          { label: 'ID document', value: 'prebuilt-idDocument' },
          { label: 'US health insurance card', value: 'prebuilt-healthInsuranceCard.us' },
          { label: 'US marriage certificate', value: 'prebuilt-marriageCertificate.us' },
          // US tax forms
          { label: 'US tax — unified', value: 'prebuilt-tax.us' },
          { label: 'US tax — W-2', value: 'prebuilt-tax.us.w2' },
          { label: 'US tax — W-4', value: 'prebuilt-tax.us.w4' },
          { label: 'US tax — 1040 (variations)', value: 'prebuilt-tax.us.1040' },
          { label: 'US tax — 1095-A', value: 'prebuilt-tax.us.1095A' },
          { label: 'US tax — 1095-C', value: 'prebuilt-tax.us.1095C' },
          { label: 'US tax — 1098 (variations)', value: 'prebuilt-tax.us.1098' },
          { label: 'US tax — 1099 (variations)', value: 'prebuilt-tax.us.1099' },
          { label: 'US tax — 1099-SSA', value: 'prebuilt-tax.us.1099SSA' },
          // US mortgage
          { label: 'US mortgage — 1003 URLA', value: 'prebuilt-mortgage.us.1003' },
          { label: 'US mortgage — 1004 URAR', value: 'prebuilt-mortgage.us.1004' },
          {
            label: 'US mortgage — 1005 employment verification',
            value: 'prebuilt-mortgage.us.1005',
          },
          { label: 'US mortgage — 1008 summary', value: 'prebuilt-mortgage.us.1008' },
          {
            label: 'US mortgage — Closing Disclosure',
            value: 'prebuilt-mortgage.us.closingDisclosure',
          },
        ],
      },
    }),
    pages: Property.ShortText({
      displayName: 'Pages',
      description: 'Optional page range, e.g. "1-5" or "1,3,7".',
      required: false,
    }),
    timeout: Property.Number({
      displayName: 'Timeout (seconds)',
      description: 'Maximum wall-clock seconds (5-1800; default 120).',
      required: false,
      defaultValue: DEFAULT_TIMEOUT_S,
    }),
  },
  async run(ctx: any): Promise<AsyncParkingSentinel> {
    return runExtractDocument(ctx);
  },
});

/** Exported for direct unit testing. */
export async function runExtractDocument(ctx: any): Promise<AsyncParkingSentinel> {
  const params = parseParams(ctx.propsValue ?? {});
  const auth = parseAuth(ctx.auth ?? {});
  const ablCtx = (ctx.abl ?? {}) as {
    tenantId?: string;
    projectId?: string;
    workflowExecutionId?: string;
    stepId?: string;
    connectionId?: string;
    azureDocumentIntelligence?: AzureDocumentIntelligenceServices;
    callbackContext?: AdiCallbackContext;
  };

  const tenantId = ablCtx.tenantId ?? '';
  const projectId = ablCtx.projectId ?? '';
  const workflowExecutionId = ablCtx.workflowExecutionId ?? '';
  const stepId = ablCtx.stepId ?? '';
  const connectionId = ablCtx.connectionId ?? '';
  const callbackContext = ablCtx.callbackContext;
  const usageService = ablCtx.azureDocumentIntelligence;

  if (!tenantId || !projectId) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Azure Document Intelligence action requires tenantId + projectId — invoke through the workflow-engine',
    );
  }
  if (!workflowExecutionId || !stepId) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Azure Document Intelligence action requires workflow execution context (workflowExecutionId + stepId)',
    );
  }
  if (!connectionId) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Azure Document Intelligence action requires a resolved ConnectorConnection',
    );
  }
  if (!callbackContext?.enqueueADIPollJob) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Azure Document Intelligence action requires enqueueADIPollJob — invoke through the workflow-engine',
    );
  }

  // 1. SSRF + HEAD probe (defense-in-depth before rate-limit token consumed).
  try {
    await assertUrlSafeForSSRF(params.fileUrl);
  } catch (err) {
    throw new AzureDIActionError(
      'SSRF_BLOCKED',
      err instanceof Error ? err.message : 'URL blocked by SSRF guard',
    );
  }
  const headResult = await headProbe(params.fileUrl);
  if (headResult.sizeBytes !== null && headResult.sizeBytes > inlineCapBytes()) {
    throw new AzureDIActionError(
      'EXTRACTION_TOO_LARGE',
      `File ${headResult.sizeBytes} bytes exceeds inline cap ${inlineCapBytes()} bytes`,
    );
  }

  // 2. Per-tenant rate limit (Redis-backed across replicas, memory fallback in dev).
  const rateLimiter = getRateLimiter(callbackContext?.getSharedRedisClient?.() ?? null);
  try {
    await rateLimiter.consume(tenantId, 1);
  } catch (err) {
    const msBeforeNext =
      typeof err === 'object' && err !== null && 'msBeforeNext' in err
        ? Number((err as { msBeforeNext: unknown }).msBeforeNext)
        : 0;
    const retryAfterSeconds = Math.ceil((Number.isFinite(msBeforeNext) ? msBeforeNext : 0) / 1000);
    throw new AzureDIActionError(
      'RATE_LIMITED',
      `Tenant rate limit exceeded; retry after ${retryAfterSeconds}s`,
    );
  }

  // 2.5. Usage-cap enforcement. The route docs (apps/workflow-engine/src/routes/azure-di-usage.ts)
  //      promise "next call rejects with QUOTA_EXCEEDED" once usageCount >= usageHardCap; that
  //      contract only holds if the action consults the service before the billable POST below.
  //      Soft cap is informational and surfaced via the observability metric in recordUsage —
  //      no rejection here. Missing usageService is treated as no cap configured (dev / non-workflow
  //      callers) rather than fail-closed; the workflow-engine always injects it in production.
  if (usageService && connectionId) {
    const snapshot = await usageService.checkUsage(connectionId);
    if (
      snapshot &&
      typeof snapshot.usageHardCap === 'number' &&
      snapshot.usageCount >= snapshot.usageHardCap
    ) {
      throw new AzureDIActionError(
        'QUOTA_EXCEEDED',
        `Azure DI monthly hard cap reached (${snapshot.usageCount}/${snapshot.usageHardCap})`,
      );
    }
  }

  // 3. POST to Azure → get operationLocation. Replay-safe: stash in ctx.store
  //    so a Restate retry doesn't re-issue the POST (Azure charges per page).
  const endpointBase = auth.endpoint.replace(/\/+$/, '');
  const model = params.model ?? 'prebuilt-layout';
  const storeKey = `azuredi:${workflowExecutionId}:${stepId}`;

  let operationLocation = ((await ctx.store.get(storeKey)) as string | null | undefined) ?? '';
  if (!operationLocation) {
    operationLocation = await postAnalyze({
      endpointBase,
      model,
      apiVersion: auth.apiVersion,
      apiKey: auth.apiKey,
      fileUrl: params.fileUrl,
      pages: params.pages,
    });
    await ctx.store.put(storeKey, operationLocation, AZURE_DI_OPERATION_STORE_TTL_SECONDS * 1000);
  }
  assertOperationLocationHost(operationLocation, endpointBase);

  // 4. Encrypt HMAC secret for callback verification (stored on step record).
  const plainSecret = randomBytes(32).toString('hex');
  const encryptedCallbackSecret = await callbackContext.encryptSecret(plainSecret, tenantId);

  // 5. Enqueue poll job — workflow-engine's AdiPollWorker takes it from here.
  const callbackUrl = callbackContext.callbackUrlBuilder(workflowExecutionId, stepId);
  const timeoutMs = params.timeout * 1_000;
  await callbackContext.enqueueADIPollJob({
    tenantId,
    projectId,
    workflowExecutionId,
    stepId,
    callbackId: callbackContext.callbackId,
    callbackUrl,
    callbackSecret: plainSecret,
    operationLocation,
    endpoint: endpointBase,
    apiKey: auth.apiKey,
    apiVersion: auth.apiVersion,
    sourceUrl: params.fileUrl,
    contentType: headResult.contentType || 'application/octet-stream',
    timeoutMs,
    startedAt: Date.now(),
    errorDelayMs: 0,
    mode: 'workflow-adi-poll',
  });

  // 5.5. Record usage post-enqueue. The Azure :analyze POST has been issued
  //      (Azure bills per page from that point); the poll worker handles the
  //      result asynchronously. Increment is best-effort so transient counter
  //      errors don't break the workflow — surfaced via the cap-usage metric.
  if (usageService && connectionId) {
    try {
      await usageService.recordUsage(connectionId);
    } catch {
      // Counter failures are non-fatal — the audit + observability paths
      // emit their own signals; suppressing here keeps the workflow alive.
    }
  }

  // 6. Return sentinel — step-dispatcher converts this to a callbackRequest
  //    and the workflow-handler parks the Restate run on an awakeable.
  return {
    __asyncParking: true,
    callbackId: callbackContext.callbackId,
    callbackTimeoutMs: timeoutMs + 30_000,
    encryptedCallbackSecret,
  };
}

async function postAnalyze(args: {
  endpointBase: string;
  model: string;
  apiVersion: string;
  apiKey: string;
  fileUrl: string;
  pages?: string;
}): Promise<string> {
  // `pages` is a QUERY STRING parameter in the Azure DI REST API
  // (v4.0/2024-11-30 and prior GA versions). Sending it in the request body
  // is silently ignored by Azure, so the model processes every page.
  // Reference: https://learn.microsoft.com/en-us/rest/api/aiservices/document-models/analyze-document
  const pagesQuery = args.pages ? `&pages=${encodeURIComponent(args.pages)}` : '';
  const url = `${args.endpointBase}/documentintelligence/documentModels/${encodeURIComponent(
    args.model,
  )}:analyze?api-version=${encodeURIComponent(args.apiVersion)}${pagesQuery}`;

  const body: Record<string, unknown> = { urlSource: args.fileUrl };

  const analyzeController = new AbortController();
  const analyzeTimer = setTimeout(() => analyzeController.abort(), ANALYZE_POST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await safeFetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': args.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: analyzeController.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AzureDIActionError(
        'EXTRACTION_FAILED',
        `Azure DI :analyze timed out after ${ANALYZE_POST_TIMEOUT_MS / 1_000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(analyzeTimer);
  }

  if (resp.status !== 202) {
    const detail = await resp.text().catch(() => '<unreadable>');
    throw new AzureDIActionError(
      'EXTRACTION_FAILED',
      `Azure DI :analyze returned HTTP ${resp.status}: ${detail}`,
    );
  }

  const operationLocation =
    resp.headers.get('operation-location') ?? resp.headers.get('Operation-Location');
  if (!operationLocation) {
    throw new AzureDIActionError(
      'EXTRACTION_FAILED',
      'Azure DI :analyze response missing Operation-Location header',
    );
  }
  return operationLocation;
}

function assertOperationLocationHost(operationLocation: string, endpointBase: string): void {
  let opHost: string;
  let endpointHost: string;
  try {
    opHost = new URL(operationLocation).hostname;
    endpointHost = new URL(endpointBase).hostname;
  } catch {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Failed to parse Azure DI operation-location or endpoint URL',
    );
  }
  if (opHost !== endpointHost) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      `Azure DI operation-location hostname ${opHost} does not match endpoint ${endpointHost}`,
    );
  }
}

async function headProbe(url: string): Promise<{ contentType: string; sizeBytes: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_PROBE_TIMEOUT_MS);
  try {
    const response = await safeFetch(url, { method: 'HEAD', signal: controller.signal });
    if (!response.ok) {
      throw new AzureDIActionError(
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
    if (err instanceof AzureDIActionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AzureDIActionError('EXTRACTION_TIMEOUT', 'HEAD probe timed out after 10s');
    }
    if (err instanceof SSRFError) {
      throw new AzureDIActionError('SSRF_BLOCKED', err.message);
    }
    throw new AzureDIActionError(
      'EXTRACTION_FAILED',
      `HEAD probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseParams(raw: Record<string, unknown>): {
  fileUrl: string;
  pages?: string;
  model?: string;
  timeout: number;
} {
  const fileUrl = typeof raw.fileUrl === 'string' ? raw.fileUrl.trim() : '';
  if (!fileUrl) {
    throw new AzureDIActionError('INVALID_PARAMS', 'fileUrl is required');
  }
  try {
    // URL constructor throws on malformed input; rely on the SSRF assertion
    // for protocol/host checks.
    new URL(fileUrl);
  } catch {
    throw new AzureDIActionError('INVALID_PARAMS', 'fileUrl is not a valid URL');
  }
  const pages = typeof raw.pages === 'string' && raw.pages.length > 0 ? raw.pages : undefined;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : undefined;
  let timeout = DEFAULT_TIMEOUT_S;
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout)) {
    timeout = Math.round(raw.timeout);
  } else if (typeof raw.timeout === 'string' && raw.timeout.length > 0) {
    const parsed = Number.parseInt(raw.timeout, 10);
    if (Number.isFinite(parsed)) timeout = parsed;
  }
  if (timeout < MIN_TIMEOUT_S || timeout > MAX_TIMEOUT_S) {
    throw new AzureDIActionError(
      'INVALID_PARAMS',
      `timeout must be between ${MIN_TIMEOUT_S} and ${MAX_TIMEOUT_S} seconds`,
    );
  }
  return { fileUrl, ...(pages ? { pages } : {}), ...(model ? { model } : {}), timeout };
}

function parseAuth(raw: Record<string, unknown>): {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
} {
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  const apiVersion =
    typeof raw.apiVersion === 'string' && raw.apiVersion.length > 0 ? raw.apiVersion : '2024-11-30';
  if (!endpoint || !apiKey) {
    throw new AzureDIActionError(
      'INTEGRATION_UNAVAILABLE',
      'Azure DI auth missing endpoint or apiKey — check the bound auth profile',
    );
  }
  return { endpoint, apiKey, apiVersion };
}

function inlineCapBytes(): number {
  return parsePositiveIntEnv('AZURE_DI_WORKFLOW_INLINE_CAP_BYTES', DEFAULT_INLINE_CAP_BYTES);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
