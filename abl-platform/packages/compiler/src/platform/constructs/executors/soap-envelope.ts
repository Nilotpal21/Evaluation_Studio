/**
 * SOAP Envelope Helpers
 *
 * Handles envelope construction, WS-Security injection, hardened XML parsing,
 * SOAP fault detection, and response body unwrapping for SOAP protocol tools.
 * Used exclusively by HttpToolExecutor when binding.protocol === 'soap'.
 */

import { applyWsSecurity } from '@agent-platform/auth-enterprise';
import { createLogger } from '../../logger.js';
import { XMLParser } from 'fast-xml-parser';
import type { HttpBindingIR } from '../../ir/schema.js';

const log = createLogger('soap-envelope');

// ─── Constants ────────────────────────────────────────────────────────────────

export type SoapVersion = NonNullable<HttpBindingIR['soap_version']>;

export const SOAP_CONTENT_TYPES: Record<SoapVersion, string> = {
  '1.1': 'text/xml; charset=utf-8',
  '1.2': 'application/soap+xml; charset=utf-8',
};

const SOAP_NAMESPACES: Record<SoapVersion, string> = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
};

// Configurable max nesting depth to defend against deep-nesting DoS
const SOAP_PARSER_MAX_DEPTH = (() => {
  const raw = process.env.HTTP_TOOL_SOAP_PARSER_MAX_DEPTH;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const depth = isNaN(parsed) ? 64 : parsed;
  log.debug('SOAP XML parser max depth configured', { maxDepth: depth });
  return depth;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WsSecurityCredentialsForExec {
  username: string;
  password: string;
  certificate?: string;
  mustUnderstand: boolean;
}

/** Transient runtime-only extension of HttpBindingIR. NOT persisted, NOT serialized. */
export interface SoapHttpBindingIR extends HttpBindingIR {
  _wsSecurityCredentials?: WsSecurityCredentialsForExec;
}

export interface RenderedSoapRequest {
  body: string;
  contentType: string;
  /** SOAPAction header value (SOAP 1.1 only; 1.2 uses Content-Type action param) */
  soapActionHeader?: string;
}

export interface ParsedSoapResponse {
  payload: unknown;
  isFault: boolean;
  fault?: { code: string; reason: string };
}

// ─── XML escape ──────────────────────────────────────────────────────────────

/**
 * XML-escape a value for safe insertion into SOAP body templates.
 * Used by HttpToolExecutor's placeholder resolver for SOAP body templates.
 */
export function xmlEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Envelope rendering ───────────────────────────────────────────────────────

/**
 * Build a complete SOAP envelope from a resolved body template.
 *
 * If the user-authored body already starts with a recognized <soap:Envelope>
 * prefix (any of the four common namespace prefixes), it is NOT double-wrapped.
 * WS-Security is injected into the existing header when credentials are present.
 */
export function renderSoapRequest(args: {
  binding: SoapHttpBindingIR;
  resolvedBody: string;
  resolvedSoapAction?: string;
}): RenderedSoapRequest {
  const { binding, resolvedBody, resolvedSoapAction } = args;
  const version = binding.soap_version ?? '1.1';
  const ns = SOAP_NAMESPACES[version];
  const contentType = SOAP_CONTENT_TYPES[version];
  const prefix = version === '1.2' ? 'env' : 'soap';
  const credentials = binding._wsSecurityCredentials;

  // Check for pre-wrapped envelope (case-sensitive prefix check per D-3)
  // Strip optional <?xml ...?> declaration before envelope detection — users
  // commonly prepend it to a full pre-written envelope and it must not trigger re-wrapping.
  const trimmedBody = resolvedBody.trimStart();
  const bodyForDetection = trimmedBody.replace(/^<\?xml[^?]*\?>\s*/i, '');
  const isPreWrapped =
    bodyForDetection.startsWith('<soap:Envelope') ||
    bodyForDetection.startsWith('<soapenv:Envelope') ||
    bodyForDetection.startsWith('<SOAP-ENV:Envelope') ||
    bodyForDetection.startsWith('<env:Envelope');

  let securityHeader = '';
  if (credentials) {
    try {
      const { wsSecurityHeader } = applyWsSecurity(
        { mustUnderstand: credentials.mustUnderstand },
        {
          username: credentials.username,
          password: credentials.password,
          certificate: credentials.certificate,
        },
      );
      securityHeader = wsSecurityHeader;
    } catch (err) {
      // applyWsSecurity failure is a pre-dispatch auth error; rethrow with context
      throw new Error(
        `WS-Security generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let body: string;

  if (isPreWrapped) {
    // Inject WS-Security into existing envelope if credentials present.
    // If the user already wrote a <wsse:Security> element, skip injection —
    // duplicate default-actor blocks are non-compliant and most servers reject.
    if (securityHeader) {
      if (/<wsse:Security[\s>]/.test(trimmedBody)) {
        log.warn('Pre-wrapped SOAP envelope already contains <wsse:Security>; skipping injection', {
          authProfileWillBeIgnored: true,
        });
        body = trimmedBody;
      } else {
        body = injectSecurityIntoExistingEnvelope(trimmedBody, securityHeader);
      }
    } else {
      body = trimmedBody;
    }
  } else {
    const headerBlock = securityHeader
      ? `<${prefix}:Header>${securityHeader}</${prefix}:Header>`
      : `<${prefix}:Header/>`;
    body = `<${prefix}:Envelope xmlns:${prefix}="${ns}">${headerBlock}<${prefix}:Body>${resolvedBody}</${prefix}:Body></${prefix}:Envelope>`;
  }

  // Build SOAP 1.1 SOAPAction header value.
  // RFC-compliant quoted-string per SOAP 1.1 spec (section 6.1.1).
  // .NET, Axis, and most real-world SOAP servers require the quoted form.
  // Avoid double-quoting if the value was already stored with surrounding quotes.
  let soapActionHeader: string | undefined;
  if (version === '1.1' && resolvedSoapAction != null && resolvedSoapAction !== '') {
    const alreadyQuoted = resolvedSoapAction.startsWith('"') && resolvedSoapAction.endsWith('"');
    soapActionHeader = alreadyQuoted ? resolvedSoapAction : `"${resolvedSoapAction}"`;
  }

  // For SOAP 1.2, append action to Content-Type
  let finalContentType = contentType;
  if (version === '1.2' && resolvedSoapAction != null && resolvedSoapAction !== '') {
    finalContentType = `${contentType}; action="${resolvedSoapAction}"`;
  }

  return { body, contentType: finalContentType, soapActionHeader };
}

function injectSecurityIntoExistingEnvelope(envelope: string, securityHeader: string): string {
  // Try to inject into existing Header element
  const headerEndMatch = envelope.match(/<\/(soap:|soapenv:|SOAP-ENV:|env:)?Header>/);
  if (headerEndMatch) {
    const idx = envelope.indexOf(headerEndMatch[0]);
    return envelope.slice(0, idx) + securityHeader + envelope.slice(idx);
  }
  // No Header element — inject one before Body
  const bodyMatch = envelope.match(/<(soap:|soapenv:|SOAP-ENV:|env:)?Body/);
  if (bodyMatch) {
    const idx = envelope.indexOf(bodyMatch[0]);
    const prefix = bodyMatch[1] ?? 'soap:';
    const headerOpen = `<${prefix}Header>`;
    const headerClose = `</${prefix}Header>`;
    return envelope.slice(0, idx) + headerOpen + securityHeader + headerClose + envelope.slice(idx);
  }
  // Fallback: prepend security header as-is (malformed envelope)
  return envelope;
}

// ─── Hardened XML parser factory ─────────────────────────────────────────────

function createHardenedParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    allowBooleanAttributes: false,
    parseTagValue: true,
    parseAttributeValue: false,
    trimValues: true,
    cdataPropName: '#cdata',
    maxNestedTags: SOAP_PARSER_MAX_DEPTH,
  });
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Parse a SOAP response envelope, detect <soap:Fault>, and unwrap the Body.
 *
 * Supports SOAP 1.1 and 1.2 with namespace prefix tolerance:
 * soap:, soapenv:, SOAP-ENV:, env:
 */
export function parseSoapResponse(args: {
  text: string;
  soapVersion: SoapVersion;
}): ParsedSoapResponse {
  const { text, soapVersion } = args;

  let parsed: Record<string, unknown>;
  try {
    const parser = createHardenedParser();
    parsed = parser.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `SOAP response XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Find Envelope — tolerate soap:, soapenv:, SOAP-ENV:, env: prefixes
  const envelopeKey = findKey(parsed, [
    'soap:Envelope',
    'soapenv:Envelope',
    'SOAP-ENV:Envelope',
    'env:Envelope',
    'Envelope',
  ]);
  if (!envelopeKey) {
    // Not a SOAP envelope — return as-is
    return { payload: parsed, isFault: false };
  }

  const envelope = parsed[envelopeKey] as Record<string, unknown>;

  // Find Body
  const bodyKey = findKey(envelope, [
    'soap:Body',
    'soapenv:Body',
    'SOAP-ENV:Body',
    'env:Body',
    'Body',
  ]);
  if (!bodyKey) {
    return { payload: envelope, isFault: false };
  }

  const body = envelope[bodyKey] as Record<string, unknown>;

  // Detect fault
  const fault = detectFault(body, soapVersion);
  if (fault) {
    return { payload: body, isFault: true, fault };
  }

  return { payload: body, isFault: false };
}

function findKey(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate in obj) return candidate;
  }
  // Also try case-insensitive search as final fallback
  const lower = candidates.map((c) => c.toLowerCase());
  return Object.keys(obj).find((k) => lower.includes(k.toLowerCase()));
}

function detectFault(
  body: Record<string, unknown>,
  soapVersion: SoapVersion,
): { code: string; reason: string } | null {
  // SOAP 1.1 fault: <faultcode> + <faultstring>
  const fault11Key = findKey(body, [
    'soap:Fault',
    'soapenv:Fault',
    'SOAP-ENV:Fault',
    'env:Fault',
    'Fault',
  ]);
  if (fault11Key) {
    const fault = body[fault11Key] as Record<string, unknown>;
    if (soapVersion === '1.1') {
      const code = extractText(fault, ['faultcode']) ?? 'Fault';
      const reason = extractText(fault, ['faultstring']) ?? 'SOAP fault';
      return { code, reason };
    }
    // SOAP 1.2 fault: <env:Code>/<env:Value> + <env:Reason>/<env:Text>
    const codeBlock = extractObject(fault, ['env:Code', 'soap:Code', 'Code']);
    const code = codeBlock
      ? (extractText(codeBlock, ['env:Value', 'soap:Value', 'Value']) ?? 'env:Sender')
      : 'env:Sender';
    const reasonBlock = extractObject(fault, ['env:Reason', 'soap:Reason', 'Reason']);
    const reason = reasonBlock
      ? (extractText(reasonBlock, ['env:Text', 'soap:Text', 'Text']) ?? 'SOAP fault')
      : 'SOAP fault';
    return { code, reason };
  }
  return null;
}

function extractText(obj: Record<string, unknown>, keys: string[]): string | null {
  const key = findKey(obj, keys);
  if (!key) return null;
  const val = obj[key];
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val && typeof val === 'object') {
    // fast-xml-parser may wrap text as { '#text': '...' }
    const text = (val as Record<string, unknown>)['#text'];
    if (text !== undefined) return String(text);
  }
  return null;
}

function extractObject(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  const key = findKey(obj, keys);
  if (!key) return null;
  const val = obj[key];
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}
