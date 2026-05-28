/**
 * DNS-pinning SSRF-safe fetch wrapper.
 *
 * This module validates the URL, resolves DNS exactly once per request hop,
 * validates every resolved address against the canonical SSRF rules, and then
 * pins the outgoing socket to the validated address. Redirects are followed
 * manually so every Location target goes through the same validation path.
 */

import type { LookupAddress } from 'node:dns';
import { lookup as defaultLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import {
  validateHostnameForSSRF,
  validateUrlForSSRF,
  type SSRFValidationOptions,
} from './ssrf-validator.js';

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 304]);
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8';
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export class SSRFError extends Error {
  readonly code = 'SSRF_BLOCKED';
  readonly url?: string;
  readonly reason?: string;

  constructor(message: string, options: { url?: string; reason?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SSRFError';
    this.url = options.url;
    this.reason = options.reason;
  }
}

export type SafeFetchDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export interface SafeFetchOptions extends SSRFValidationOptions {
  /** Maximum number of redirects to follow. Defaults to 3. */
  maxRedirects?: number;
  /** Test seam for deterministic DNS resolution. Production callers should omit it. */
  dnsLookup?: SafeFetchDnsLookup;
  /** Optional TLS material for HTTPS callers that need mTLS or custom CAs. */
  tls?: {
    ca?: string | Buffer | Array<string | Buffer>;
    cert?: string | Buffer | Array<string | Buffer>;
    key?: string | Buffer | Array<string | Buffer>;
    rejectUnauthorized?: boolean;
  };
}

export interface SafeFetchResolution {
  url: string;
  hostname: string;
  address: string;
  family: 4 | 6;
}

type BodyBytes = {
  bytes: Buffer;
};

/**
 * Read `SSRF_ALLOWED_HOSTNAMES` (comma-separated) from process.env. Operators
 * use this to opt specific dev/internal targets back in after the platform-wide
 * SSRF deny-list lands. Returns an empty array when the env var is unset.
 *
 * Exposed as a helper rather than read inline so tests can stub it deterministically.
 */
export function getEnvSSRFAllowedHosts(): string[] {
  const raw = process.env.SSRF_ALLOWED_HOSTNAMES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function withEnvAllowedHosts(options: SafeFetchOptions): SafeFetchOptions {
  const envHosts = getEnvSSRFAllowedHosts();
  if (envHosts.length === 0) return options;
  const merged = new Set<string>([
    ...(options.additionalAllowedHosts ?? []).map((h) => h.toLowerCase()),
    ...envHosts,
  ]);
  return { ...options, additionalAllowedHosts: [...merged] };
}

function isHostnameInAllowlist(hostname: string, options: SafeFetchOptions): boolean {
  const allowed = options.additionalAllowedHosts;
  if (!allowed || allowed.length === 0) return false;
  const normalized = hostname.toLowerCase();
  return allowed.some((h) => h.toLowerCase() === normalized);
}

/**
 * Validate URL and DNS resolution without making a network request.
 * Use this at enqueue/persistence boundaries where a URL sink is stored for
 * later delivery.
 */
export async function validateUrlForSafeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResolution> {
  const effective = withEnvAllowedHosts(options);
  const url = parseUrl(input);
  validateParsedUrl(url, effective);

  const hostname = stripIpv6Brackets(url.hostname);
  const addresses = await resolveAddresses(hostname, effective);
  const hostnameAllowedByOperator = isHostnameInAllowlist(hostname, effective);

  // When the operator allowlists a hostname (e.g. via SSRF_ALLOWED_HOSTNAMES),
  // relax ONLY the RFC1918 private-range block — that is the case dev-cluster
  // service hostnames need. Metadata endpoints (169.254.169.254 and friends)
  // and loopback remain hard-blocked: a hostname allowlist must never let an
  // attacker-controlled or hijacked DNS record point at cloud metadata or 127.x.
  for (const address of addresses) {
    const ipOptions = hostnameAllowedByOperator
      ? { ...effective, allowPrivateRanges: true }
      : effective;
    const result = validateHostnameForSSRF(address.address, ipOptions);
    if (!result.safe) {
      throw new SSRFError('URL resolved to a blocked private or metadata address', {
        url: url.toString(),
        reason: result.reason,
      });
    }
  }

  const pinned = addresses[0];
  if (!pinned) {
    throw new SSRFError('URL hostname did not resolve to an address', { url: url.toString() });
  }

  return {
    url: url.toString(),
    hostname,
    address: pinned.address,
    family: pinned.family === 6 ? 6 : 4,
  };
}

export async function assertUrlSafeForFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<void> {
  await validateUrlForSafeFetch(input, options);
}

export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirectMode = init.redirect ?? 'follow';
  let currentUrl = parseUrl(input);
  let currentInit = { ...init };

  for (let redirectCount = 0; ; redirectCount++) {
    const resolution = await validateUrlForSafeFetch(currentUrl, options);
    const response = await performPinnedRequest(
      new URL(resolution.url),
      resolution,
      currentInit,
      options,
    );

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (redirectMode === 'manual') {
      return response;
    }

    if (redirectMode === 'error') {
      await discardBody(response);
      throw new SSRFError('Redirect blocked by safeFetch redirect policy', {
        url: currentUrl.toString(),
      });
    }

    if (redirectCount >= maxRedirects) {
      await discardBody(response);
      throw new SSRFError(`Too many redirects (max ${maxRedirects})`, {
        url: currentUrl.toString(),
      });
    }

    const location = response.headers.get('location');
    if (!location) {
      await discardBody(response);
      throw new SSRFError(`HTTP ${response.status} redirect missing Location header`, {
        url: currentUrl.toString(),
      });
    }

    const nextUrl = new URL(location, currentUrl);
    currentInit = nextRedirectInit(currentInit, response.status, currentUrl, nextUrl);
    currentUrl = nextUrl;
    await discardBody(response);
  }
}

function parseUrl(input: string | URL): URL {
  try {
    return input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch (cause) {
    throw new SSRFError('Invalid URL format', { cause });
  }
}

function validateParsedUrl(url: URL, options: SSRFValidationOptions): void {
  const result = validateUrlForSSRF(url.toString(), options);
  if (!result.safe) {
    throw new SSRFError(result.reason ?? 'URL blocked by SSRF protection', {
      url: url.toString(),
      reason: result.reason,
    });
  }
}

async function resolveAddresses(
  hostname: string,
  options: SafeFetchOptions,
): Promise<LookupAddress[]> {
  const dnsLookup = options.dnsLookup ?? (defaultLookup as SafeFetchDnsLookup);

  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new SSRFError('URL hostname did not resolve to an address');
    }
    return addresses;
  } catch (cause) {
    if (cause instanceof SSRFError) {
      throw cause;
    }
    throw new SSRFError('DNS resolution failed for URL hostname', { reason: String(cause), cause });
  }
}

async function performPinnedRequest(
  url: URL,
  resolution: SafeFetchResolution,
  init: RequestInit,
  options: SafeFetchOptions,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const body = await normalizeBody(init.body ?? undefined, headers);

  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(body.bytes.byteLength));
  }

  if (!headers.has('host')) {
    headers.set('host', url.host);
  }

  const method = init.method ?? 'GET';
  const requestOptions: http.RequestOptions &
    Pick<https.RequestOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'servername'> = {
    protocol: url.protocol,
    hostname: resolution.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method,
    headers: headersToObject(headers),
    lookup: pinnedLookup(resolution),
  };

  if (url.protocol === 'https:') {
    requestOptions.servername = resolution.hostname;
    if (options.tls?.ca) requestOptions.ca = options.tls.ca;
    if (options.tls?.cert) requestOptions.cert = options.tls.cert;
    if (options.tls?.key) requestOptions.key = options.tls.key;
    if (options.tls?.rejectUnauthorized !== undefined) {
      requestOptions.rejectUnauthorized = options.tls.rejectUnauthorized;
    }
  }

  const transport = url.protocol === 'https:' ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      cleanup();
      resolve(responseFromIncomingMessage(res, method));
    });

    const abort = (): void => {
      const reason = init.signal?.reason;
      req.destroy(reason instanceof Error ? reason : new Error('Request aborted'));
    };

    const cleanup = (): void => {
      init.signal?.removeEventListener('abort', abort);
    };

    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener('abort', abort, { once: true });
    }

    req.on('error', (error) => {
      cleanup();
      reject(error);
    });

    if (body) {
      req.write(body.bytes);
    }
    req.end();
  });
}

function pinnedLookup(resolution: SafeFetchResolution): http.RequestOptions['lookup'] {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb === 'function') {
      if (typeof options === 'object' && options !== null && 'all' in options && options.all) {
        cb(null, [{ address: resolution.address, family: resolution.family }]);
        return;
      }
      cb(null, resolution.address, resolution.family);
    }
  };
}

function responseFromIncomingMessage(
  res: http.IncomingMessage,
  method: string | undefined,
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }

  const status = res.statusCode ?? 200;
  const hasBody = method?.toUpperCase() !== 'HEAD' && !BODYLESS_STATUSES.has(status);
  const body = hasBody ? (Readable.toWeb(res) as ReadableStream<Uint8Array>) : null;

  return new Response(body, {
    status,
    statusText: res.statusMessage,
    headers,
  });
}

async function normalizeBody(
  body: RequestInit['body'] | null | undefined,
  headers: Headers,
): Promise<BodyBytes | undefined> {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return { bytes: Buffer.from(body) };
  }

  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', FORM_CONTENT_TYPE);
    }
    return { bytes: Buffer.from(body.toString()) };
  }

  if (Buffer.isBuffer(body)) {
    return { bytes: body };
  }

  if (body instanceof ArrayBuffer) {
    return { bytes: Buffer.from(body) };
  }

  if (ArrayBuffer.isView(body)) {
    return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.type && !headers.has('content-type')) {
      headers.set('content-type', body.type);
    }
    return { bytes: Buffer.from(await body.arrayBuffer()) };
  }

  throw new TypeError('safeFetch does not support streaming request bodies');
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function nextRedirectInit(
  init: RequestInit,
  status: number,
  previousUrl: URL,
  nextUrl: URL,
): RequestInit {
  const nextInit: RequestInit = { ...init };
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();

  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    nextInit.method = 'GET';
    delete nextInit.body;
    headers.delete('content-length');
    headers.delete('content-type');
  }

  if (previousUrl.origin !== nextUrl.origin) {
    for (const header of SENSITIVE_REDIRECT_HEADERS) {
      headers.delete(header);
    }
  }

  nextInit.headers = headers;
  return nextInit;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: redirect bodies are not part of the caller-visible response.
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}
