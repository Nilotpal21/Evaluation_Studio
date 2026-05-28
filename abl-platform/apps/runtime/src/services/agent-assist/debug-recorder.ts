/**
 * Per-request debug recorder for the Agent Assist V1 facade.
 *
 * Appends one JSON-lines entry per request to the file named in
 * AGENT_ASSIST_DEBUG_LOG (default `/tmp/agent-assist-debug.log`).
 * Each line captures: timestamp, path, method, body, headers (x-api-key redacted),
 * isAsync / callbackUrl / stream flags, response status + body shape.
 *
 * Disabled unless AGENT_ASSIST_DEBUG_RECORD=true — keeps zero-overhead for
 * production paths.
 */

import { appendFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';

const DEFAULT_PATH = '/tmp/agent-assist-debug.log';
/** Hard cap on captured response bytes per request — SSE streams could otherwise grow unboundedly. */
const MAX_CAPTURED_RESPONSE_BYTES = 64 * 1024;
const SENSITIVE_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'cookie',
  'x-abl-signature',
  'apikey',
]);

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (v === undefined) continue;
    const val = Array.isArray(v) ? v.join(',') : v;
    if (SENSITIVE_HEADERS.has(key)) {
      out[key] = val.length > 0 ? `REDACTED(len=${val.length})` : 'REDACTED';
    } else {
      out[key] = val;
    }
  }
  return out;
}

function previewBody(body: unknown): unknown {
  // Keep full body but clip large text fields so huge aa_uamsgs histories
  // don't blow the log.
  if (!body || typeof body !== 'object') return body;
  try {
    return JSON.parse(
      JSON.stringify(body, (_k, v) => {
        if (typeof v === 'string' && v.length > 4000) {
          return v.slice(0, 4000) + `…(truncated ${v.length - 4000} chars)`;
        }
        return v;
      }),
    );
  } catch {
    return '<<unserializable>>';
  }
}

function enabled(): boolean {
  return process.env.AGENT_ASSIST_DEBUG_RECORD === 'true';
}

function logPath(): string {
  return process.env.AGENT_ASSIST_DEBUG_LOG || DEFAULT_PATH;
}

/** Express middleware. Mount once at the top of the agent-assist router. */
export function debugRecorderMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled()) return next();

    const startedAt = Date.now();
    const requestEntry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      phase: 'request',
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      headers: sanitizeHeaders(req.headers),
      body: previewBody(req.body),
    };

    // Pick out the fields the user flagged for special attention so they are
    // easy to scan without parsing the full body.
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') {
      requestEntry.flags = {
        isAsync: body.isAsync ?? null,
        callbackUrl: typeof body.callbackUrl === 'string' ? body.callbackUrl : null,
        streamEnable:
          typeof body.stream === 'object' && body.stream !== null
            ? (body.stream as Record<string, unknown>).enable
            : null,
        streamMode:
          typeof body.stream === 'object' && body.stream !== null
            ? (body.stream as Record<string, unknown>).streamMode
            : null,
        source: typeof body.source === 'string' ? body.source : null,
      };
    }

    // Capture response body with a hard byte cap (MAX_CAPTURED_RESPONSE_BYTES)
    // so long SSE streams cannot grow the capture buffer unboundedly.
    let capturedBytes = 0;
    let capturedTruncated = false;
    const capturedWrites: Buffer[] = [];
    let capturedJson: unknown;

    const origJson = res.json.bind(res);
    res.json = (body: unknown) => {
      capturedJson = body;
      return origJson(body);
    };
    const origWrite = res.write.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      if (capturedBytes < MAX_CAPTURED_RESPONSE_BYTES) {
        try {
          let buf: Buffer | null = null;
          if (typeof chunk === 'string') buf = Buffer.from(chunk);
          else if (chunk && (chunk as Buffer).byteLength !== undefined) {
            buf = Buffer.from(chunk as Buffer);
          }
          if (buf) {
            const remaining = MAX_CAPTURED_RESPONSE_BYTES - capturedBytes;
            const slice = buf.length <= remaining ? buf : buf.subarray(0, remaining);
            capturedWrites.push(slice);
            capturedBytes += slice.length;
            if (buf.length > remaining) capturedTruncated = true;
          }
        } catch {
          // Ignore capture errors — never break the response.
        }
      } else {
        capturedTruncated = true;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    };

    res.on('finish', () => {
      const responseEntry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        phase: 'response',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (capturedJson !== undefined) {
        responseEntry.json = previewBody(capturedJson);
      } else if (capturedWrites.length > 0) {
        const text = Buffer.concat(capturedWrites).toString('utf8');
        responseEntry.stream = text;
        if (capturedTruncated) responseEntry.streamTruncated = true;
      }
      const line = JSON.stringify(requestEntry) + '\n' + JSON.stringify(responseEntry) + '\n---\n';
      appendFile(logPath(), line).catch(() => {
        // Best-effort; debug recorder must never break the runtime.
      });
    });

    next();
  };
}
