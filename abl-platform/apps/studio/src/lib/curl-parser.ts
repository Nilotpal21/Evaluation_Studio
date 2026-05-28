/**
 * CURL Command Parser
 *
 * Parses curl commands and extracts HTTP configuration:
 * - URL and method
 * - Headers
 * - Query parameters
 * - Request body
 * - Authentication
 *
 * Supports common curl flags: -X, -H, -d, --data, --header, --url, etc.
 */

import type { HttpConfig } from '../components/tools/HttpConfigForm';
import type { HeaderEntry, HttpMethod, HttpAuthType } from '../components/tools/shared-types';

interface ParsedCurl {
  url: string;
  method: string;
  headers: HeaderEntry[];
  body?: string;
  bodyType?: 'json' | 'form' | 'xml' | 'text';
  /** Non-fatal notes about things we couldn't fully replicate (e.g. -F, @file). */
  warnings?: string[];
}

/** Public shape of the import preview — HttpConfig fields plus any warnings. */
export interface CurlImportPreview {
  config: Partial<HttpConfig>;
  warnings: string[];
  /** Template refs detected in the imported config (auto-populated as params). */
  detectedInputs: string[];
}

// ─── Template-variable protection ───────────────────────────────────────────
// Our tool config supports template variables like `{{input.X}}` and
// `{{secrets.X}}`. These must survive verbatim through URL parsing and URL
// encoding. We swap them out for opaque ASCII sentinels before any encoding
// step, then restore afterwards.
//
// Sentinel format: `_ABLVAR{n}_` (all URL-safe chars, zero chance of being
// itself encoded or split).

const TEMPLATE_RE = /\{\{\s*[^{}]+?\s*\}\}/g;

function maskTemplates(input: string): { masked: string; table: string[] } {
  const table: string[] = [];
  const masked = input.replace(TEMPLATE_RE, (match) => {
    const idx = table.push(match) - 1;
    return `__ABLVAR${idx}__`;
  });
  return { masked, table };
}

function unmaskTemplates(input: string, table: string[]): string {
  if (table.length === 0) return input;
  // Case-insensitive: WHATWG URL parser lowercases the hostname, turning
  // `__ABLVAR0__` into `__ablvar0__`. The sentinel body is pure ASCII so
  // `i` flag is safe.
  return input.replace(/__ABLVAR(\d+)__/gi, (_match, n) => table[Number(n)] ?? _match);
}

/**
 * Parse a curl command and extract HTTP configuration
 */
export function parseCurlCommand(curlCommand: string): ParsedCurl | null {
  // Strip BOM, normalize CRLF → LF (Windows paste), trim, and require a leading
  // `curl` token. Without this guard, pasted `wget ...` or similar would also
  // be accepted.
  let cmd = curlCommand
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const leading = cmd.match(/^curl(?=$|[\s])/);
  if (!leading) return null;
  cmd = cmd.slice(4).trimStart();
  if (!cmd) return null;

  // Split command into tokens, respecting quotes and shell escapes
  const tokens = tokenizeCurlCommand(cmd);
  if (tokens.length === 0) return null;

  let url = '';
  let method = 'GET';
  let methodExplicit = false;
  const headers: HeaderEntry[] = [];
  const dataPieces: Array<{ kind: 'raw' | 'form'; value: string }> = [];
  let bodyType: 'json' | 'form' | 'xml' | 'text' | undefined;
  let useGet = false; // -G / --get: append body as query string, keep method GET
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const setMethod = (m: string, explicit: boolean): void => {
    method = m.toUpperCase();
    if (explicit) methodExplicit = true;
  };

  const appendJsonBody = (value: string): void => {
    // --json always replaces (curl only honors the last --json value).
    dataPieces.length = 0;
    dataPieces.push({ kind: 'raw', value });
    bodyType = 'json';
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) {
      headers.push({ key: 'Content-Type', value: 'application/json' });
    }
    if (!headers.some((h) => h.key.toLowerCase() === 'accept')) {
      headers.push({ key: 'Accept', value: 'application/json' });
    }
  };

  // Parse tokens
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    // Method
    if (token === '-X' || token === '--request') {
      const next = tokens[++i];
      if (next) setMethod(next, true);
      continue;
    }

    // Method attached without space (e.g. -XPOST)
    if (token.startsWith('-X') && token.length > 2 && !token.startsWith('-X-')) {
      setMethod(token.slice(2), true);
      continue;
    }

    // Method via long flag with `=` (e.g. --request=POST)
    if (token.startsWith('--request=')) {
      setMethod(token.slice('--request='.length), true);
      continue;
    }

    // Headers
    if (token === '-H' || token === '--header') {
      const headerValue = tokens[++i];
      if (headerValue) {
        addHeader(headers, headerValue);
      }
      continue;
    }

    // Headers with = separator (e.g. -H="Content-Type: application/json")
    if (token.startsWith('-H=') || token.startsWith('--header=')) {
      const headerValue = token.slice(token.indexOf('=') + 1);
      if (headerValue) {
        addHeader(headers, headerValue);
      }
      continue;
    }

    // -G / --get — append body as query string and force GET
    if (token === '-G' || token === '--get') {
      useGet = true;
      continue;
    }

    // Body/Data: raw forms (no URL encoding, concatenated with '&' by real curl
    // when repeated). We preserve multiple pieces and decide later how to join.
    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-ascii'
    ) {
      const next = tokens[++i];
      if (next !== undefined) dataPieces.push({ kind: 'raw', value: next });
      continue;
    }

    if (
      token.startsWith('--data=') ||
      token.startsWith('--data-raw=') ||
      token.startsWith('--data-binary=') ||
      token.startsWith('--data-ascii=')
    ) {
      const value = token.slice(token.indexOf('=') + 1);
      dataPieces.push({ kind: 'raw', value });
      continue;
    }

    // -d with no space (e.g. -d'{"a":1}')
    if (token.startsWith('-d') && token.length > 2 && !token.startsWith('-d-')) {
      dataPieces.push({ kind: 'raw', value: token.slice(2) });
      continue;
    }

    // URL-encoded data (curl percent-encodes the VALUE only).
    if (token === '--data-urlencode') {
      const data = tokens[++i];
      if (data !== undefined) {
        dataPieces.push({ kind: 'form', value: encodeDataUrlencode(data) });
      }
      continue;
    }

    if (token.startsWith('--data-urlencode=')) {
      const data = token.slice('--data-urlencode='.length);
      dataPieces.push({ kind: 'form', value: encodeDataUrlencode(data) });
      continue;
    }

    // JSON data (--json): curl treats the last --json as the full body
    // and sets Content-Type/Accept to application/json.
    if (token === '--json') {
      const jsonData = tokens[++i];
      if (jsonData !== undefined) appendJsonBody(jsonData);
      continue;
    }

    if (token.startsWith('--json=')) {
      appendJsonBody(token.slice('--json='.length));
      continue;
    }

    // URL via --url / --url=
    if (token === '--url') {
      url = tokens[++i] || url;
      continue;
    }
    if (token.startsWith('--url=')) {
      url = token.slice('--url='.length) || url;
      continue;
    }

    // Multipart form flags — not supported; surface a warning so the user knows
    // the body will not be reproduced.
    if (token === '-F' || token === '--form' || token === '--form-string') {
      i++; // skip the argument
      warn(
        'Multipart form data (-F/--form) is not supported yet — the body was dropped. Recreate it manually.',
      );
      continue;
    }
    if (token.startsWith('--form=') || token.startsWith('--form-string=')) {
      warn(
        'Multipart form data (-F/--form) is not supported yet — the body was dropped. Recreate it manually.',
      );
      continue;
    }

    // TLS / proxy flags — silently ignored but surfaced as a note.
    if (
      token === '--cacert' ||
      token === '--cert' ||
      token === '--key' ||
      token === '--proxy' ||
      token === '-x'
    ) {
      i++;
      warn(`Ignored transport flag: ${token} (configure network settings on the tool if needed).`);
      continue;
    }

    // Cookie flags — explicit warning so users don't expect them to stick.
    if (token === '--cookie' || token === '-b' || token === '--cookie-jar' || token === '-c') {
      i++;
      warn(
        `Cookie flag ${token} ignored — cookies from browser pastes are session-scoped and rarely valid for a saved tool.`,
      );
      continue;
    }
    if (token.startsWith('--cookie=')) {
      warn(
        'Cookie flag --cookie= ignored — cookies from browser pastes are session-scoped and rarely valid for a saved tool.',
      );
      continue;
    }

    // Flags that take an argument we want to silently ignore.
    if (
      token === '-A' ||
      token === '--user-agent' ||
      token === '-e' ||
      token === '--referer' ||
      token === '--output' ||
      token === '-o' ||
      token === '--resolve' ||
      token === '--retry' ||
      token === '--retry-delay' ||
      token === '--retry-max-time' ||
      token === '--max-time' ||
      token === '--connect-timeout'
    ) {
      i++; // skip the argument
      continue;
    }

    // Long-form "--flag=value" versions of the above — just ignore the whole token.
    if (
      token.startsWith('--user-agent=') ||
      token.startsWith('--referer=') ||
      token.startsWith('--output=')
    ) {
      continue;
    }

    // No-arg flags we silently accept.
    if (
      token === '--compressed' ||
      token === '-k' ||
      token === '--insecure' ||
      token === '-L' ||
      token === '--location' ||
      token === '-s' ||
      token === '--silent' ||
      token === '-S' ||
      token === '--show-error' ||
      token === '-i' ||
      token === '--include' ||
      token === '-v' ||
      token === '--verbose' ||
      token === '-f' ||
      token === '--fail' ||
      token === '-O' ||
      token === '--remote-name' ||
      token === '-j' ||
      token === '--junk-session-cookies' ||
      token === '-N' ||
      token === '--no-buffer' ||
      token === '--no-progress-meter' ||
      token === '--http1.1' ||
      token === '--http2' ||
      token === '--http2-prior-knowledge' ||
      token === '--http3'
    ) {
      continue;
    }

    // Basic auth: -u user:pass
    if (token === '-u' || token === '--user') {
      const auth = tokens[++i];
      if (auth) {
        headers.push({ key: 'Authorization', value: `Basic ${base64Encode(auth)}` });
      }
      continue;
    }
    if (token.startsWith('--user=')) {
      const auth = token.slice('--user='.length);
      if (auth) {
        headers.push({ key: 'Authorization', value: `Basic ${base64Encode(auth)}` });
      }
      continue;
    }

    // Bearer token
    if (token === '--bearer') {
      const bearerToken = tokens[++i];
      if (bearerToken) {
        headers.push({ key: 'Authorization', value: `Bearer ${bearerToken}` });
      }
      continue;
    }
    if (token.startsWith('--bearer=')) {
      const bearerToken = token.slice('--bearer='.length);
      if (bearerToken) {
        headers.push({ key: 'Authorization', value: `Bearer ${bearerToken}` });
      }
      continue;
    }

    // URL positional. Accept first token that looks like one and hasn't been assigned yet.
    if (!url && looksLikeUrl(token)) {
      url = token;
      continue;
    }

    // Unknown token — ignore. (Combined short flags like -sSL would have already
    // been tokenized as a single "-sSL" string; since it doesn't take args, fall
    // through silently.)
  }

  // Extract URL from quoted string if needed
  url = unquote(url);
  if (!url) return null;

  // Build the final body & bodyType. curl semantics:
  //   - If any --data-urlencode piece is present, treat the whole body as
  //     form-encoded and join all pieces with '&' (real curl joins every -d/-F
  //     with '&' regardless of type, but that corrupts JSON bodies that users
  //     split across `-d`. We bias to safety here: if every piece is JSON-ish
  //     and there is no form piece, concatenate them without '&' and keep
  //     type=json; otherwise '&'-join and mark as form.).
  let body: string | undefined;
  const hasForm = dataPieces.some((p) => p.kind === 'form');
  const allLookJson = dataPieces.length > 0 && dataPieces.every((p) => looksLikeJson(p.value));

  if (dataPieces.length === 1) {
    body = dataPieces[0].value;
    if (hasForm) bodyType = 'form';
  } else if (dataPieces.length > 1) {
    if (!hasForm && allLookJson) {
      // User pasted e.g. `-d '{"a":1}' -d '{"b":2}'`. Real curl would corrupt
      // this into `{"a":1}&{"b":2}`. Prefer the last piece (matches how most
      // copy-as-curl tools serialize) to avoid producing invalid JSON.
      body = dataPieces[dataPieces.length - 1].value;
      warn(
        `Multiple JSON bodies detected (${dataPieces.length} -d/--data flags) — kept the last one and discarded the others.`,
      );
    } else {
      body = dataPieces.map((p) => p.value).join('&');
      if (hasForm) bodyType = 'form';
    }
  }

  // @file references aren't resolvable in the UI.
  if (dataPieces.some((p) => p.kind === 'raw' && p.value.startsWith('@'))) {
    warn(
      'Detected a `@file` body reference — file-based bodies are not supported. Paste the file contents inline.',
    );
  }

  // Infer body type from Content-Type header if still unknown.
  if (body !== undefined && !bodyType) {
    const contentType = headers
      .find((h) => h.key.toLowerCase() === 'content-type')
      ?.value.toLowerCase();
    if (contentType) {
      if (contentType.includes('application/json')) {
        bodyType = 'json';
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        bodyType = 'form';
      } else if (contentType.includes('application/xml') || contentType.includes('text/xml')) {
        bodyType = 'xml';
      } else {
        bodyType = 'text';
      }
    } else if (looksLikeJson(body)) {
      bodyType = 'json';
    } else if (isFormPairList(body)) {
      bodyType = 'form';
    } else {
      bodyType = 'text';
    }
  }

  // `-G` + body: move body into URL as query string, clear body, force GET.
  if (useGet && body !== undefined) {
    const pairs = splitFormPairs(body);
    if (pairs.length > 0) {
      const hasQuery = url.includes('?');
      const suffix = pairs.map((p) => p).join('&');
      url = url + (hasQuery ? '&' : '?') + suffix;
    }
    body = undefined;
    bodyType = undefined;
    method = 'GET';
    methodExplicit = true;
  }

  // Only auto-upgrade GET → POST when the user did NOT set the method explicitly.
  if (body !== undefined && method === 'GET' && !methodExplicit) {
    method = 'POST';
  }

  return {
    url,
    method,
    headers,
    body,
    bodyType,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// Exact (case-insensitive) header names we treat as API keys.
const API_KEY_HEADER_NAMES = new Set([
  'x-api-key',
  'api-key',
  'apikey',
  'x-apikey',
  'x-auth-token',
  'x-access-token',
  'x-token',
]);

// Browser-injected headers that are not useful for API tool configuration
const BROWSER_NOISE_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'cookie',
  'origin',
  'pragma',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-gpc',
  'dnt',
  'priority',
  'te',
  'upgrade-insecure-requests',
  'user-agent',
]);

// Methods supported by the backend DSL schema. HEAD / OPTIONS parse fine but
// the project-tool Zod schema rejects them, so we coerce to the closest safe
// equivalent (HEAD → GET, OPTIONS → GET) to avoid a confusing save error.
const BACKEND_SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeMethod(method: string): { method: HttpMethod; warning?: string } {
  const upper = method.toUpperCase();
  if (BACKEND_SUPPORTED_METHODS.has(upper)) return { method: upper as HttpMethod };
  if (upper === 'HEAD' || upper === 'OPTIONS') {
    return {
      method: 'GET',
      warning: `${upper} requests are not supported by the HTTP tool runtime — using GET instead.`,
    };
  }
  return {
    method: 'GET',
    warning: `Unknown method "${upper}" — defaulted to GET. Adjust in the form if needed.`,
  };
}

/**
 * Convert parsed curl to HttpConfig
 */
export function curlToHttpConfig(parsed: ParsedCurl): Partial<HttpConfig> {
  // Mask `{{input.X}}` / `{{secrets.X}}` before URL parsing so the WHATWG URL
  // parser cannot percent-encode the braces.
  const { masked: maskedUrl, table: urlTable } = maskTemplates(parsed.url);
  const url = new URL(maskedUrl);

  // If the URL carries userinfo (https://user:pass@host/...), strip it and
  // surface as an Authorization header (matches curl's own behavior).
  let userinfoHeader: HeaderEntry | null = null;
  if (url.username) {
    const user = decodeURIComponent(url.username);
    const pass = url.password ? decodeURIComponent(url.password) : '';
    userinfoHeader = {
      key: 'Authorization',
      value: `Basic ${base64Encode(`${user}:${pass}`)}`,
    };
    url.username = '';
    url.password = '';
  }

  const endpoint = unmaskTemplates(`${url.origin}${url.pathname}`, urlTable);

  // Extract query parameters from URL
  const queryParams: HeaderEntry[] = [];
  url.searchParams.forEach((value, key) => {
    queryParams.push({
      key: unmaskTemplates(key, urlTable),
      value: unmaskTemplates(value, urlTable),
    });
  });

  // Detect auth precedence: Authorization header wins over API-key-ish headers.
  // We do a first pass to find the authoritative auth type, then a second pass
  // to build the filtered headers so the order of pasted headers can't flip
  // which auth we pick.
  const headerList: HeaderEntry[] =
    userinfoHeader && !parsed.headers.some((h) => h.key.toLowerCase() === 'authorization')
      ? [userinfoHeader, ...parsed.headers]
      : parsed.headers;

  let authType: HttpAuthType = 'none';
  let authConfig: Record<string, string> | undefined;
  let authHeaderConsumed: string | null = null; // lowercase header key we consumed into authConfig

  const authHeader = headerList.find((h) => h.key.toLowerCase() === 'authorization');
  if (authHeader) {
    const value = authHeader.value.trim();
    if (/^Bearer\s+/i.test(value)) {
      authType = 'bearer';
      authConfig = { token: value.replace(/^Bearer\s+/i, '') };
      authHeaderConsumed = 'authorization';
    } else {
      // Basic, Token, Digest, etc. — keep the header as-is under custom auth.
      authType = 'custom';
    }
  } else {
    const apiKeyHeader = headerList.find((h) => API_KEY_HEADER_NAMES.has(h.key.toLowerCase()));
    if (apiKeyHeader) {
      authType = 'api_key';
      authConfig = {
        headerName: apiKeyHeader.key,
        apiKey: apiKeyHeader.value,
      };
      authHeaderConsumed = apiKeyHeader.key.toLowerCase();
    }
  }

  // Build filtered header list: drop the one we consumed into authConfig, and
  // drop browser-noise headers. Keep everything else (including duplicates).
  const filteredHeaders: HeaderEntry[] = [];
  const seen = new Set<string>();
  for (const header of headerList) {
    const lowerKey = header.key.toLowerCase();
    if (authHeaderConsumed && lowerKey === authHeaderConsumed) continue;
    if (BROWSER_NOISE_HEADERS.has(lowerKey)) continue;
    // Deduplicate identical (name+value) pairs — curl would send duplicates,
    // but the tool UI treats each entry as a unique row and users rarely want
    // literal duplicates.
    const dedupeKey = `${lowerKey}:${header.value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    filteredHeaders.push(header);
  }

  // Pretty-format JSON body for readability
  let body = parsed.body;
  if (body && parsed.bodyType === 'json') {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Not valid JSON — keep as-is
    }
  }

  const { method: normalizedMethod } = normalizeMethod(parsed.method);

  return {
    endpoint,
    method: normalizedMethod,
    authType,
    authConfig,
    headers: filteredHeaders,
    queryParams,
    body,
    bodyType: parsed.bodyType,
  };
}

// ─── Rich preview (config + warnings + detected template inputs) ──────────
const INPUT_REF_RE = /\{\{\s*input\.(\w+)\s*\}\}/g;
const SECRET_REF_RE = /\{\{\s*secrets\.(\w+)\s*\}\}/g;

function collectRefs(text: string | undefined, re: RegExp, out: Set<string>): void {
  if (!text) return;
  // `re` is shared — clone by reassigning `lastIndex` because we use matchAll.
  for (const m of text.matchAll(re)) out.add(m[1]);
}

export function buildCurlImportPreview(parsed: ParsedCurl): CurlImportPreview {
  const config = curlToHttpConfig(parsed);
  const warnings = [...(parsed.warnings ?? [])];

  // Re-check method coercion so we can emit a user-facing warning even though
  // curlToHttpConfig has already silently coerced.
  const coerced = normalizeMethod(parsed.method);
  if (coerced.warning) warnings.push(coerced.warning);

  // Collect template variable refs across every surface we stored.
  const inputs = new Set<string>();
  const secrets = new Set<string>();
  const scan = (text: string | undefined): void => {
    collectRefs(text, INPUT_REF_RE, inputs);
    collectRefs(text, SECRET_REF_RE, secrets);
  };
  scan(config.endpoint);
  scan(config.body);
  for (const h of config.headers ?? []) {
    scan(h.key);
    scan(h.value);
  }
  for (const q of config.queryParams ?? []) {
    scan(q.key);
    scan(q.value);
  }
  for (const v of Object.values(config.authConfig ?? {})) {
    if (typeof v === 'string') scan(v);
  }

  if (secrets.size > 0) {
    warnings.push(
      `Detected ${secrets.size === 1 ? 'a secret reference' : 'secret references'}: ${[...secrets]
        .map((s) => `{{secrets.${s}}}`)
        .join(
          ', ',
        )}. Make sure ${secrets.size === 1 ? 'it is' : 'they are'} defined in your project's secrets.`,
    );
  }

  return {
    config,
    warnings,
    detectedInputs: [...inputs],
  };
}

/**
 * Parse a header string "Key: Value" and push to headers array.
 * Also accepts the HTTP/1-style `Name;` (with trailing semicolon and no value)
 * that curl uses to send empty headers.
 */
function addHeader(headers: HeaderEntry[], headerStr: string): void {
  const trimmed = headerStr.trim();
  if (!trimmed) return;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    // `Header;` syntax or malformed — skip silently.
    return;
  }
  const key = trimmed.slice(0, colonIdx).trim();
  const value = trimmed.slice(colonIdx + 1).trim();
  if (!key) return;
  headers.push({ key, value });
}

/**
 * Tokenize curl command respecting quotes and escape sequences.
 *
 * Supports:
 *   - single quotes `'...'` (everything literal, no escapes)
 *   - double quotes `"..."` (backslash escapes: \\, \", \$, \`, \n in POSIX,
 *     other backslashes are preserved verbatim)
 *   - unquoted backslash line continuations (bash `\<newline>` → whitespace)
 *   - ANSI-C quoting `$'...'` (C-style escape sequences: \n, \t, \\, \', \xNN)
 *   - `$"..."` (treated like plain double quotes)
 */
function tokenizeCurlCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | "$'" | null = null;
  let escaped = false;
  let quotedToken = false; // true if the current token has been through ≥1 quote

  const flush = (): void => {
    if (current !== '' || quotedToken) {
      tokens.push(current);
      current = '';
    }
    quotedToken = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    // Inside ANSI-C ($'...') — interpret C-style escape sequences.
    if (inQuote === "$'") {
      if (char === "'") {
        inQuote = null;
        continue;
      }
      if (char === '\\' && i + 1 < cmd.length) {
        const next = cmd[i + 1];
        const decoded = decodeAnsiCEscape(next, cmd, i + 1);
        current += decoded.value;
        i += decoded.consumed; // already points at the escape source char
        continue;
      }
      current += char;
      continue;
    }

    if (escaped) {
      // Inside double quotes, a backslash only escapes a small set of chars;
      // otherwise the backslash is preserved. Unquoted backslashes escape
      // anything (including whitespace and newline for line continuations).
      if (inQuote === '"') {
        if (char === '"' || char === '\\' || char === '$' || char === '`' || char === '\n') {
          // `\<newline>` inside double quotes still continues the line.
          if (char !== '\n') current += char;
        } else {
          current += '\\' + char;
        }
      } else {
        // Unquoted: `\<newline>` is a line continuation — emit nothing. Any
        // other escaped char is kept verbatim.
        if (char !== '\n') current += char;
      }
      escaped = false;
      continue;
    }

    if (char === '\\' && inQuote !== "'") {
      escaped = true;
      continue;
    }

    // Handle ANSI-C / locale quoting: $'...' or $"..." — strip the $ prefix
    // and enter the appropriate quote mode. `$'...'` gets special-cased above
    // with escape interpretation; `$"..."` behaves like a plain double quote.
    if (char === '$' && !inQuote && i + 1 < cmd.length) {
      const next = cmd[i + 1];
      if (next === "'") {
        inQuote = "$'";
        quotedToken = true;
        i += 1; // consume the single quote
        continue;
      }
      if (next === '"') {
        inQuote = '"';
        quotedToken = true;
        i += 1;
        continue;
      }
    }

    // Enter a plain quote
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = char;
      quotedToken = true;
      continue;
    }

    // Exit a plain quote
    if (char === inQuote) {
      inQuote = null;
      continue;
    }

    // Split on whitespace when not in quotes
    if (!inQuote && /\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  // If we ended mid-escape, preserve the trailing backslash so no input is lost.
  if (escaped) current += '\\';
  flush();
  return tokens;
}

/**
 * Decode a single ANSI-C escape sequence.
 * Returns the decoded string and how many extra characters (beyond the backslash)
 * were consumed.
 */
function decodeAnsiCEscape(
  next: string,
  source: string,
  nextIdx: number,
): { value: string; consumed: number } {
  switch (next) {
    case 'n':
      return { value: '\n', consumed: 1 };
    case 't':
      return { value: '\t', consumed: 1 };
    case 'r':
      return { value: '\r', consumed: 1 };
    case 'b':
      return { value: '\b', consumed: 1 };
    case 'f':
      return { value: '\f', consumed: 1 };
    case 'v':
      return { value: '\v', consumed: 1 };
    case '0':
      return { value: '\0', consumed: 1 };
    case '\\':
      return { value: '\\', consumed: 1 };
    case "'":
      return { value: "'", consumed: 1 };
    case '"':
      return { value: '"', consumed: 1 };
    case 'x': {
      const hex = source.slice(nextIdx + 1, nextIdx + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { value: String.fromCharCode(parseInt(hex, 16)), consumed: 3 };
      }
      return { value: 'x', consumed: 1 };
    }
    default:
      // Unknown escape — preserve both characters so no data is lost.
      return { value: '\\' + next, consumed: 1 };
  }
}

/**
 * Remove surrounding quotes from a string
 */
function unquote(str: string): string {
  if (
    str.length >= 2 &&
    ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'")))
  ) {
    return str.slice(1, -1);
  }
  return str;
}

/** Does this token look like a URL (so we can treat it as the positional arg)? */
function looksLikeUrl(token: string): boolean {
  const trimmed = unquote(token);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
}

/** Does this string parse as JSON? Used to avoid clobbering JSON bodies. */
function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Does the body look like a list of `k=v&k=v` pairs? */
function isFormPairList(body: string): boolean {
  if (!body.includes('=')) return false;
  return /^[^=&]+=[^&]*(?:&[^=&]+=[^&]*)*$/.test(body);
}

/** Split a form-encoded body into pairs, preserving already-encoded values. */
function splitFormPairs(body: string): string[] {
  return body.split('&').filter(Boolean);
}

/**
 * Encode a `--data-urlencode` argument the way curl does.
 *
 * Forms accepted by curl:
 *   - `name=content`   → `name=<url-encoded content>`
 *   - `name@file`      → unsupported in this parser; leave as literal
 *   - `@file`          → unsupported; leave as literal
 *   - `content`        → `<url-encoded content>` (no name)
 */
function encodeDataUrlencode(arg: string): string {
  if (arg === '') return '';
  if (arg.startsWith('@')) return arg; // file refs aren't resolvable in the UI

  // Mask template variables before percent-encoding so `{{input.X}}` doesn't
  // turn into `%7B%7Binput.X%7D%7D`.
  const encodeWithTemplates = (raw: string): string => {
    const { masked, table } = maskTemplates(raw);
    return unmaskTemplates(encodeURIComponent(masked), table);
  };

  const eq = arg.indexOf('=');
  if (eq === -1) {
    return encodeWithTemplates(arg);
  }
  const name = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  // `name@file` form isn't supported — encode the literal as-is.
  if (value.startsWith('@')) return `${name}${value}`;
  return `${name}=${encodeWithTemplates(value)}`;
}

/** Base64-encode a string using a runtime-appropriate primitive. */
function base64Encode(input: string): string {
  if (typeof btoa === 'function') {
    // Convert UTF-8 to latin-1 first to avoid btoa's "InvalidCharacterError" on
    // characters outside the latin-1 range.
    return btoa(unescape(encodeURIComponent(input)));
  }
  // Node / SSR fallback.
  const nodeBuffer = (
    globalThis as {
      Buffer?: { from(input: string, enc: string): { toString(enc: string): string } };
    }
  ).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(input, 'utf8').toString('base64');
  }
  throw new Error('No base64 encoder available');
}

/**
 * Validate parsed curl command
 */
export function validateCurlParse(parsed: ParsedCurl | null): string | null {
  if (!parsed) {
    return 'Unable to parse curl command';
  }

  if (!parsed.url) {
    return 'No URL found in curl command';
  }

  let parsedUrl: URL;
  try {
    // Mask template variables so `https://{{input.host}}/...` can still be
    // URL-parsed (the WHATWG parser rejects `{` / `}` inside the host).
    const { masked } = maskTemplates(parsed.url);
    parsedUrl = new URL(masked);
  } catch {
    return 'Invalid URL in curl command';
  }

  // Mirror the HTTP tool form: only http(s) URLs are accepted by the backend.
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return `Unsupported URL scheme: ${parsedUrl.protocol.replace(':', '')} (only http and https are supported)`;
  }

  return null;
}
