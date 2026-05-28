/**
 * POST /api/projects/:id/sessions/:sessionId/attachments
 * GET  /api/projects/:id/sessions/:sessionId/attachments
 *
 * Proxies attachment upload (POST multipart/form-data) and list (GET)
 * to the runtime service at:
 *   /api/projects/:projectId/sessions/:sessionId/attachments
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:api:project-session-attachments');

const PROXY_TIMEOUT_MS = 30_000;
const MAX_PROXY_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_ATTACHMENT_LIMIT = 50;
const MAX_ATTACHMENT_LIMIT = 200;
const DEFAULT_ATTACHMENT_OFFSET = 0;

type RouteParams = { params: Promise<{ id: string; sessionId: string }> };

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

class UploadBodyTimeoutError extends Error {
  constructor() {
    super('Upload body did not complete within 30s');
    this.name = 'UploadBodyTimeoutError';
  }
}

function payloadTooLargeResponse() {
  return NextResponse.json(
    {
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large (max 20MB)' },
    },
    { status: 413 },
  );
}

function getContentLength(request: NextRequest): number | null {
  const contentLength = request.headers.get('Content-Length');
  if (!contentLength) return null;

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePaginationValue(
  rawValue: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!rawValue) return fallback;

  if (!/^\d+$/.test(rawValue)) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, min), max);
}

function buildAttachmentsUrl(
  runtimeUrl: string,
  projectId: string,
  sessionId: string,
  searchParams?: URLSearchParams,
): string {
  const target = new URL(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
    runtimeUrl,
  );

  if (searchParams) {
    const limit = normalizePaginationValue(
      searchParams.get('limit'),
      DEFAULT_ATTACHMENT_LIMIT,
      1,
      MAX_ATTACHMENT_LIMIT,
    );
    const offset = normalizePaginationValue(
      searchParams.get('offset'),
      DEFAULT_ATTACHMENT_OFFSET,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    target.searchParams.set('limit', String(limit));
    target.searchParams.set('offset', String(offset));
  }

  return target.toString();
}

async function readRequestBodyWithLimit(request: NextRequest): Promise<ArrayBuffer> {
  if (!request.body) {
    return new ArrayBuffer(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new UploadBodyTimeoutError());
    }, PROXY_TIMEOUT_MS);
  });

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROXY_UPLOAD_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }

      chunks.push(value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return body.buffer;
  })();

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be closed or canceled.
    }
  }
}

async function buildProxyResponse(response: Response): Promise<NextResponse> {
  const contentType = response.headers.get('content-type');
  const text = await response.text();

  if (!text) {
    return new NextResponse(null, { status: response.status });
  }

  if (contentType?.includes('application/json')) {
    try {
      return NextResponse.json(JSON.parse(text), { status: response.status });
    } catch (error) {
      log.warn('Runtime attachment proxy returned invalid JSON', {
        status: response.status,
        contentType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return new NextResponse(text, {
    status: response.status,
    headers: contentType ? { 'Content-Type': contentType } : undefined,
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, sessionId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const contentLength = getContentLength(request);
    if (contentLength !== null && contentLength > MAX_PROXY_UPLOAD_BYTES) {
      return payloadTooLargeResponse();
    }

    const runtimeUrl = getRuntimeUrl();
    const target = buildAttachmentsUrl(runtimeUrl, projectId, sessionId);

    const headers: Record<string, string> = {};
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const contentType = request.headers.get('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;

    const body = await readRequestBodyWithLimit(request);

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    return await buildProxyResponse(response);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return payloadTooLargeResponse();
    }

    if (error instanceof UploadBodyTimeoutError) {
      log.error('Timeout reading attachment upload body', {
        projectId,
        sessionId,
        error: error.message,
      });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UPLOAD_TIMEOUT', message: 'Upload did not complete within 30s' },
        },
        { status: 408 },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(
      isTimeout ? 'Timeout proxying attachment upload' : 'Error proxying attachment upload',
      {
        projectId,
        sessionId,
        error: message,
      },
    );
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 30s' }
          : { code: 'PROXY_ERROR', message: 'Failed to proxy attachment upload to runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, sessionId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const runtimeUrl = getRuntimeUrl();
    const target = buildAttachmentsUrl(
      runtimeUrl,
      projectId,
      sessionId,
      request.nextUrl.searchParams,
    );

    const headers: Record<string, string> = {};
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const response = await fetch(target, { headers, signal: controller.signal });
    return await buildProxyResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(isTimeout ? 'Timeout proxying attachment list' : 'Error proxying attachment list', {
      projectId,
      sessionId,
      error: message,
    });
    return NextResponse.json(
      {
        success: false,
        error: isTimeout
          ? { code: 'PROXY_TIMEOUT', message: 'Runtime did not respond within 30s' }
          : { code: 'PROXY_ERROR', message: 'Failed to fetch attachments from runtime' },
      },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
