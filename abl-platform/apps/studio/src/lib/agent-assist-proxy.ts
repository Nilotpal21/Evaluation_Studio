/**
 * Agentic Compat Proxy — shared helper for Studio → Runtime proxying.
 *
 * These routes are called by Kore.ai Agent Assist (not by Studio users),
 * so they do NOT require a Studio user JWT. Authentication is via
 * x-api-key header forwarded to runtime.
 *
 * Architecture: Kore.ai → Studio (public) → Runtime (private).
 */

import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { NextRequest, NextResponse } from 'next/server';

// ─── Constants ─────────────────────────────────────────────────────────

/** Read RUNTIME_URL at call time so tests can override it via process.env. */
function getRuntimeBase(): string {
  return process.env.RUNTIME_URL || 'http://localhost:3112';
}

/** Max request body size in bytes (512 KB). */
const MAX_BODY_BYTES = 512 * 1024;

/** Timeout for runtime requests (30s). */
const RUNTIME_TIMEOUT_MS = 30_000;

/** Headers to forward from the inbound request to runtime. */
const FORWARD_HEADER_PREFIXES = ['x-', 'kore-'];
const FORWARD_HEADER_EXACT = new Set(['content-type', 'accept', 'accept-encoding', 'user-agent']);

/** Redact an API key for logging: show first 8 chars max. */
export function redactApiKey(key: string): string {
  return key.length > 8 ? key.substring(0, 8) + '...' : key;
}

/**
 * Extract headers that should be forwarded to runtime.
 */
export function extractForwardHeaders(inbound: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  inbound.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (FORWARD_HEADER_EXACT.has(lower)) {
      out[name] = value;
      return;
    }
    for (const prefix of FORWARD_HEADER_PREFIXES) {
      if (lower.startsWith(prefix)) {
        out[name] = value;
        return;
      }
    }
  });
  return out;
}

/**
 * Build the full runtime URL for a facade path.
 */
export function buildRuntimeUrl(path: string): string {
  const base = getRuntimeBase().replace(/\/+$/, '');
  return `${base}${path}`;
}

function createAbortError(): Error {
  const error = new Error('Runtime request timed out or client disconnected');
  error.name = 'AbortError';
  return error;
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
}

async function readResponseBody(response: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}

async function sendRuntimeRequest(params: {
  bodyBytes: ArrayBuffer;
  headers: Record<string, string>;
  method: string;
  signal: AbortSignal;
  url: URL;
}): Promise<IncomingMessage> {
  const client = params.url.protocol === 'https:' ? https : http;

  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = client.request(
      params.url,
      {
        method: params.method,
        headers: params.headers,
      },
      (response) => {
        params.signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
    );

    const onAbort = () => {
      request.destroy(createAbortError());
    };

    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    request.on('error', (error) => {
      params.signal.removeEventListener('abort', onAbort);
      reject(error);
    });

    if (params.bodyBytes.byteLength > 0) {
      request.write(Buffer.from(params.bodyBytes));
    }

    request.end();
  });
}

function createResponseStream(response: IncomingMessage): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        response.off('data', onData);
        response.off('end', onEnd);
        response.off('error', onError);
        response.off('aborted', onAborted);
        response.off('close', onClose);
      };

      const onData = (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk),
        );
      };

      const onEnd = () => {
        cleanup();
        controller.close();
      };

      const onError = (error: Error) => {
        cleanup();
        controller.error(error);
      };

      const onAborted = () => {
        cleanup();
        controller.error(createAbortError());
      };

      const onClose = () => {
        if (!response.complete && !response.destroyed) {
          cleanup();
          controller.error(createAbortError());
        }
      };

      response.on('data', onData);
      response.on('end', onEnd);
      response.on('error', onError);
      response.on('aborted', onAborted);
      response.on('close', onClose);
    },
    cancel(reason) {
      if (!response.destroyed) {
        response.destroy(reason instanceof Error ? reason : undefined);
      }
    },
  });
}

/**
 * Proxy a POST request from Studio to Runtime.
 *
 * - Validates x-api-key is present.
 * - Enforces body size limit.
 * - Forwards selected headers.
 * - For SSE responses, pipes the ReadableStream with correct headers.
 * - For JSON responses, forwards status + body verbatim.
 * - Cancels the runtime request if the client disconnects.
 */
export async function proxyToRuntime(
  request: NextRequest,
  runtimePath: string,
  options?: { supportsSSE?: boolean },
): Promise<Response> {
  // ─── Guard: require x-api-key ────────────────────────────────────
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'API_KEY_REQUIRED', message: 'x-api-key header is required' },
      },
      { status: 401 },
    );
  }

  // ─── Guard: body size ────────────────────────────────────────────
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 512 KB limit' },
      },
      { status: 413 },
    );
  }

  // ─── Read body ───────────────────────────────────────────────────
  let bodyBytes: ArrayBuffer;
  try {
    bodyBytes = await request.arrayBuffer();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Failed to read request body' },
      },
      { status: 400 },
    );
  }

  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 512 KB limit' },
      },
      { status: 413 },
    );
  }

  // ─── Build forward headers ───────────────────────────────────────
  const forwardHeaders = extractForwardHeaders(request.headers);

  // ─── AbortController for client disconnect ───────────────────────
  const controller = new AbortController();
  // If the incoming request signals abort, forward it
  request.signal.addEventListener('abort', () => controller.abort(), { once: true });

  // ─── Timeout ─────────────────────────────────────────────────────
  const timeout = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);

  try {
    const runtimeUrl = new URL(buildRuntimeUrl(runtimePath));
    const runtimeRes = await sendRuntimeRequest({
      url: runtimeUrl,
      method: 'POST',
      headers: forwardHeaders,
      bodyBytes,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseContentType = getHeaderValue(runtimeRes.headers['content-type']);
    const responseStatus = runtimeRes.statusCode ?? 502;

    // ─── SSE streaming ─────────────────────────────────────────────
    if (
      options?.supportsSSE &&
      responseContentType.includes('text/event-stream') &&
      !runtimeRes.destroyed
    ) {
      return new Response(createResponseStream(runtimeRes), {
        status: responseStatus,
        headers: {
          'Content-Type': 'text/event-stream',
          // `no-transform` prevents proxies (including any gzip layer in Next.js
          // or ngrok) from buffering the stream to re-encode it.
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // ─── JSON / async-push (202 or other) ──────────────────────────
    const responseBody = await readResponseBody(runtimeRes);
    const responseHeaders = new Headers();
    if (responseContentType) {
      responseHeaders.set('Content-Type', responseContentType);
    }

    return new Response(responseBody, {
      status: responseStatus,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);

    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: 'Runtime request timed out or client disconnected',
          },
        },
        { status: 504 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: { code: 'RUNTIME_UNREACHABLE', message: 'Runtime service unavailable' },
      },
      { status: 502 },
    );
  }
}
