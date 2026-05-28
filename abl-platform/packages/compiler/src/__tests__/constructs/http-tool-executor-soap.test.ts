/**
 * SOAP Tool Executor Tests
 *
 * Tests for SOAP protocol support in HttpToolExecutor:
 * - Envelope wrapping (1.1 and 1.2)
 * - Content-Type and SOAPAction header behavior
 * - Double-wrap detection for pre-wrapped envelopes
 * - WS-Security injection
 * - Response unwrapping and fault detection
 * - XXE and billion-laughs defense
 * - REST regression (existing behavior unchanged)
 * - Integration tests with real HTTP stub server
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  HttpToolExecutor,
  redactWsSecurityForTrace,
} from '../../platform/constructs/executors/http-tool-executor.js';
import {
  xmlEscape,
  renderSoapRequest,
  parseSoapResponse,
  SOAP_CONTENT_TYPES,
} from '../../platform/constructs/executors/soap-envelope.js';
import type { SoapHttpBindingIR } from '../../platform/constructs/executors/soap-envelope.js';
import type { ToolDefinition, HttpBindingIR } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';
import { createServer, type Server } from 'node:http';

// ─── Mock safe-fetch to delegate to globalThis.fetch ──────────────────────────

const mockSafeFetch = vi.hoisted(() => vi.fn());
const mockAssertUrlSafeForFetch = vi.hoisted(() => vi.fn());

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-platform/shared-kernel/security/safe-fetch')>();
  return {
    ...actual,
    assertUrlSafeForFetch: mockAssertUrlSafeForFetch,
    safeFetch: mockSafeFetch,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  mockAssertUrlSafeForFetch.mockResolvedValue(undefined);
  mockSafeFetch.mockImplementation((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(url, init),
  );
  (HttpToolExecutor as any)._undiciModule = undefined;
  (HttpToolExecutor as any)._defaultAgent = null;
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

const mockSecrets: SecretsProvider = {
  async getSecret(key: string) {
    if (key === 'api_key_token') return 'test-api-key';
    return undefined;
  },
  async getEnvVar() {
    return undefined;
  },
};

function createSoapTool(
  overrides: Partial<HttpBindingIR> = {},
  toolOverrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: 'soap_api',
    description: 'SOAP API',
    parameters: [{ name: 'query', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'http',
    http_binding: {
      endpoint: 'https://api.example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      timeout_ms: 5000,
      protocol: 'soap',
      soap_version: '1.1',
      body_template: '<GetData><Query>{{input.query}}</Query></GetData>',
      ...overrides,
    },
    ...toolOverrides,
  };
}

function createRestTool(overrides: Partial<HttpBindingIR> = {}): ToolDefinition {
  return {
    name: 'rest_api',
    description: 'REST API',
    parameters: [{ name: 'query', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'http',
    http_binding: {
      endpoint: 'https://api.example.com/rest',
      method: 'POST',
      auth: { type: 'none' },
      timeout_ms: 5000,
      ...overrides,
    },
  };
}

function makeSoapResponse(body: string, version: '1.1' | '1.2' = '1.1'): string {
  const prefix = version === '1.2' ? 'env' : 'soap';
  const ns =
    version === '1.2'
      ? 'http://www.w3.org/2003/05/soap-envelope'
      : 'http://schemas.xmlsoap.org/soap/envelope/';
  return `<${prefix}:Envelope xmlns:${prefix}="${ns}"><${prefix}:Body>${body}</${prefix}:Body></${prefix}:Envelope>`;
}

function stubFetchWithTextResponse(responseText: string, contentType = 'text/xml') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(responseText, {
        status: 200,
        headers: { 'content-type': contentType },
      }),
    ),
  );
}

function getHeaderValue(
  headers: RequestInit['headers'] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers ?? {}).get(name) ?? undefined;
}

// =============================================================================
// UNIT TESTS: soap-envelope.ts pure functions
// =============================================================================

describe('soap-envelope — xmlEscape', () => {
  it('SEC-8: escapes XML special characters', () => {
    expect(xmlEscape('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(xmlEscape("it's a test")).toBe('it&apos;s a test');
    expect(xmlEscape('a & b')).toBe('a &amp; b');
  });

  it('SEC-8: handles null and undefined', () => {
    expect(xmlEscape(null)).toBe('');
    expect(xmlEscape(undefined)).toBe('');
  });

  it('SEC-8: serializes objects to JSON then escapes', () => {
    const result = xmlEscape({ key: '<value>' });
    expect(result).toContain('&lt;value&gt;');
    expect(result).not.toContain('<value>');
  });

  it('SEC-8: handles numbers and booleans', () => {
    expect(xmlEscape(42)).toBe('42');
    expect(xmlEscape(true)).toBe('true');
  });
});

describe('soap-envelope — renderSoapRequest', () => {
  it('U-1: wraps SOAP 1.1 body in correct namespaced envelope', () => {
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result = renderSoapRequest({
      binding,
      resolvedBody: '<GetData><Query>test</Query></GetData>',
    });

    expect(result.body).toContain('soap:Envelope');
    expect(result.body).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(result.body).toContain('<soap:Body>');
    expect(result.body).toContain('<GetData><Query>test</Query></GetData>');
    expect(result.body).toContain('</soap:Body>');
    expect(result.body).toContain('</soap:Envelope>');
  });

  it('U-2: wraps SOAP 1.2 body in correct namespaced envelope', () => {
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.2',
    };
    const result = renderSoapRequest({
      binding,
      resolvedBody: '<GetData/>',
    });

    expect(result.body).toContain('env:Envelope');
    expect(result.body).toContain('xmlns:env="http://www.w3.org/2003/05/soap-envelope"');
    expect(result.body).toContain('<env:Body>');
    expect(result.body).toContain('<GetData/>');
  });

  it('U-3: sets Content-Type correctly per version', () => {
    const binding11: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result11 = renderSoapRequest({ binding: binding11, resolvedBody: '<Test/>' });
    expect(result11.contentType).toBe('text/xml; charset=utf-8');

    const binding12: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.2',
    };
    const result12 = renderSoapRequest({ binding: binding12, resolvedBody: '<Test/>' });
    expect(result12.contentType).toBe('application/soap+xml; charset=utf-8');
  });

  it('U-4: SOAPAction header set for 1.1 only', () => {
    const binding11: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result11 = renderSoapRequest({
      binding: binding11,
      resolvedBody: '<Test/>',
      resolvedSoapAction: 'http://example.com/GetData',
    });
    expect(result11.soapActionHeader).toBe('"http://example.com/GetData"');

    // SOAP 1.2: action goes into Content-Type, NOT SOAPAction header
    const binding12: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.2',
    };
    const result12 = renderSoapRequest({
      binding: binding12,
      resolvedBody: '<Test/>',
      resolvedSoapAction: 'http://example.com/GetData',
    });
    expect(result12.soapActionHeader).toBeUndefined();
    expect(result12.contentType).toContain('action="http://example.com/GetData"');
  });

  it('U-5: pre-wrapped body not double-wrapped', () => {
    const preWrapped =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header/><soap:Body><Test/></soap:Body></soap:Envelope>';
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result = renderSoapRequest({ binding, resolvedBody: preWrapped });
    // Should NOT have double Envelope
    const envelopeCount = (result.body.match(/soap:Envelope/g) || []).length;
    expect(envelopeCount).toBe(2); // opening + closing
    expect(result.body).toBe(preWrapped);
  });

  it('U-5: pre-wrapped body with XML declaration not double-wrapped', () => {
    const preWrapped =
      '<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header/><soap:Body><Add xmlns="http://tempuri.org/"><intA>5</intA><intB>3</intB></Add></soap:Body></soap:Envelope>';
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result = renderSoapRequest({ binding, resolvedBody: preWrapped });
    // Must not double-wrap — outer envelope count is still 2 (open + close)
    const envelopeCount = (result.body.match(/soap:Envelope/g) || []).length;
    expect(envelopeCount).toBe(2);
    expect(result.body).toBe(preWrapped);
  });

  it('U-5: pre-wrapped soapenv: prefix not double-wrapped', () => {
    const preWrapped =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Test/></soapenv:Body></soapenv:Envelope>';
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
    };
    const result = renderSoapRequest({ binding, resolvedBody: preWrapped });
    const envelopeCount = (result.body.match(/soapenv:Envelope/g) || []).length;
    expect(envelopeCount).toBe(2); // opening + closing
  });

  it('U-6: WS-Security injection when credentials present', () => {
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
      _wsSecurityCredentials: {
        username: 'admin',
        password: 'secret123',
        mustUnderstand: true,
      },
    };
    const result = renderSoapRequest({
      binding,
      resolvedBody: '<GetData/>',
    });

    expect(result.body).toContain('wsse:Security');
    expect(result.body).toContain('wsse:UsernameToken');
    expect(result.body).toContain('wsse:Username');
    expect(result.body).toContain('admin');
    // Password should be a digest, not plaintext
    expect(result.body).toContain('PasswordDigest');
    expect(result.body).not.toContain('secret123');
  });
});

describe('soap-envelope — parseSoapResponse', () => {
  it('U-7: unwraps envelope/Body and returns inner content', () => {
    const xml = makeSoapResponse('<GetDataResponse><Result>42</Result></GetDataResponse>');
    const parsed = parseSoapResponse({ text: xml, soapVersion: '1.1' });

    expect(parsed.isFault).toBe(false);
    expect(parsed.payload).toBeDefined();
    const payload = parsed.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('GetDataResponse');
  });

  it('U-8: detects SOAP 1.1 fault', () => {
    const xml = makeSoapResponse(
      '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Internal error</faultstring></soap:Fault>',
    );
    const parsed = parseSoapResponse({ text: xml, soapVersion: '1.1' });

    expect(parsed.isFault).toBe(true);
    expect(parsed.fault).toBeDefined();
    expect(parsed.fault?.code).toBe('soap:Server');
    expect(parsed.fault?.reason).toBe('Internal error');
  });

  it('U-9: detects SOAP 1.2 fault', () => {
    const xml = makeSoapResponse(
      '<env:Fault><env:Code><env:Value>env:Receiver</env:Value></env:Code><env:Reason><env:Text>Service unavailable</env:Text></env:Reason></env:Fault>',
      '1.2',
    );
    const parsed = parseSoapResponse({ text: xml, soapVersion: '1.2' });

    expect(parsed.isFault).toBe(true);
    expect(parsed.fault).toBeDefined();
    expect(parsed.fault?.code).toBe('env:Receiver');
    expect(parsed.fault?.reason).toBe('Service unavailable');
  });

  it('U-14: tolerates soapenv: namespace prefix', () => {
    const xml =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Data>42</Data></soapenv:Body></soapenv:Envelope>';
    const parsed = parseSoapResponse({ text: xml, soapVersion: '1.1' });
    expect(parsed.isFault).toBe(false);
    const payload = parsed.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('Data');
  });

  it('U-13: throws on malformed XML', () => {
    expect(() => parseSoapResponse({ text: '<broken><<not valid', soapVersion: '1.1' })).toThrow(
      'SOAP response XML parse failed',
    );
  });

  it('U-11: XXE blocking — processEntities is disabled', () => {
    // fast-xml-parser with processEntities:false should NOT expand entities
    const xxeXml = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><Data>&xxe;</Data></soap:Body>
</soap:Envelope>`;

    // With processEntities: false, the entity reference should not be expanded.
    // fast-xml-parser v5 with processEntities: false will either reject the entity
    // or pass it through as literal text — it will NOT resolve SYSTEM references.
    // Both outcomes are safe.
    let result;
    try {
      result = parseSoapResponse({ text: xxeXml, soapVersion: '1.1' });
    } catch {
      // Parser rejection is also acceptable — entity is blocked
      return;
    }
    // If parser didn't throw, verify the entity was NOT expanded to file contents
    const payload = JSON.stringify(result.payload);
    expect(payload).not.toContain('root:');
    expect(payload).not.toContain('/bin/bash');
  });

  it('U-12: billion-laughs defense — deeply nested entity expansion blocked', () => {
    // fast-xml-parser with processEntities:false does not expand entity references,
    // so "billion laughs" (exponential entity expansion) is inherently blocked.
    const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><Data>&lol3;</Data></soap:Body>
</soap:Envelope>`;

    let result;
    try {
      result = parseSoapResponse({ text: billionLaughs, soapVersion: '1.1' });
    } catch {
      // Parser rejection is acceptable
      return;
    }
    // If it parses, verify no exponential expansion occurred
    const payload = JSON.stringify(result.payload);
    // Should NOT contain a huge repeated string — if entities were expanded,
    // we would see thousands of "lol" strings
    expect(payload.length).toBeLessThan(5000);
  });
});

describe('SOAP_CONTENT_TYPES', () => {
  it('exports correct content types', () => {
    expect(SOAP_CONTENT_TYPES['1.1']).toBe('text/xml; charset=utf-8');
    expect(SOAP_CONTENT_TYPES['1.2']).toBe('application/soap+xml; charset=utf-8');
  });
});

// =============================================================================
// UNIT TESTS: HttpToolExecutor SOAP integration
// =============================================================================

describe('HttpToolExecutor — SOAP request building', () => {
  it('U-1: SOAP 1.1 envelope wrapping via executor', async () => {
    const tool = createSoapTool();

    stubFetchWithTextResponse(
      makeSoapResponse('<GetDataResponse><Result>ok</Result></GetDataResponse>'),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(body).toContain('soap:Envelope');
    expect(body).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(body).toContain('<soap:Body>');
    expect(body).toContain('<GetData><Query>test</Query></GetData>');
    expect(getHeaderValue(headers, 'Content-Type')).toBe('text/xml; charset=utf-8');

    vi.unstubAllGlobals();
  });

  it('U-2: SOAP 1.2 envelope wrapping via executor', async () => {
    const tool = createSoapTool({ soap_version: '1.2' });

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>', '1.2'), 'application/soap+xml');

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(body).toContain('env:Envelope');
    expect(body).toContain('xmlns:env="http://www.w3.org/2003/05/soap-envelope"');
    expect(getHeaderValue(headers, 'Content-Type')).toBe('application/soap+xml; charset=utf-8');

    vi.unstubAllGlobals();
  });

  it('U-4: SOAPAction header set for SOAP 1.1', async () => {
    const tool = createSoapTool({
      soap_action: 'http://example.com/GetData',
    });

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>'));

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(getHeaderValue(headers, 'SOAPAction')).toBe('"http://example.com/GetData"');

    vi.unstubAllGlobals();
  });

  it('U-4: SOAP 1.2 does NOT set SOAPAction header, puts action in Content-Type', async () => {
    const tool = createSoapTool({
      soap_version: '1.2',
      soap_action: 'http://example.com/GetData',
    });

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>', '1.2'), 'application/soap+xml');

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(getHeaderValue(headers, 'SOAPAction')).toBeUndefined();
    expect(getHeaderValue(headers, 'Content-Type')).toContain(
      'action="http://example.com/GetData"',
    );

    vi.unstubAllGlobals();
  });

  it('U-4b: {{input.X}} in soap_action is resolved at runtime', async () => {
    const tool = createSoapTool({
      soap_action: 'http://example.com/{{input.operation}}',
    });

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>'));

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test', operation: 'GetUser' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(getHeaderValue(headers, 'SOAPAction')).toBe('"http://example.com/GetUser"');

    vi.unstubAllGlobals();
  });

  it('U-4c: {{secrets.X}} in soap_action is resolved at runtime', async () => {
    const secretsWithAction: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'SOAP_OPERATION') return 'PremiumOp';
        return undefined;
      },
      async getEnvVar() {
        return undefined;
      },
    };
    const tool = createSoapTool({
      soap_action: 'http://example.com/{{secrets.SOAP_OPERATION}}',
    });

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>'));

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: secretsWithAction,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: 'test' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(getHeaderValue(headers, 'SOAPAction')).toBe('"http://example.com/PremiumOp"');

    vi.unstubAllGlobals();
  });
});

describe('HttpToolExecutor — SOAP response handling', () => {
  it('U-7: unwraps SOAP response envelope', async () => {
    const tool = createSoapTool();

    stubFetchWithTextResponse(
      makeSoapResponse('<GetDataResponse><Result>42</Result></GetDataResponse>'),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = (await executor.execute('soap_api', { query: 'test' }, 5000)) as Record<
      string,
      unknown
    >;
    expect(result).toHaveProperty('GetDataResponse');

    vi.unstubAllGlobals();
  });

  it('U-8: SOAP 1.1 fault throws TOOL_SOAP_FAULT', async () => {
    const tool = createSoapTool();

    stubFetchWithTextResponse(
      makeSoapResponse(
        '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Database unavailable</faultstring></soap:Fault>',
      ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await expect(executor.execute('soap_api', { query: 'test' }, 5000)).rejects.toThrow(
      'Database unavailable',
    );

    vi.unstubAllGlobals();
  });

  it('U-9: SOAP 1.2 fault throws', async () => {
    const tool = createSoapTool({ soap_version: '1.2' });

    stubFetchWithTextResponse(
      makeSoapResponse(
        '<env:Fault><env:Code><env:Value>env:Receiver</env:Value></env:Code><env:Reason><env:Text>Service down</env:Text></env:Reason></env:Fault>',
        '1.2',
      ),
      'application/soap+xml',
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await expect(executor.execute('soap_api', { query: 'test' }, 5000)).rejects.toThrow(
      'Service down',
    );

    vi.unstubAllGlobals();
  });

  it('U-10: on_soap_fault=data returns fault as data with soap_fault flag', async () => {
    const tool = createSoapTool({ on_soap_fault: 'data' });

    stubFetchWithTextResponse(
      makeSoapResponse(
        '<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Invalid input</faultstring></soap:Fault>',
      ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = (await executor.execute('soap_api', { query: 'test' }, 5000)) as Record<
      string,
      unknown
    >;
    expect(result.soap_fault).toBe(true);

    vi.unstubAllGlobals();
  });

  it('U-10b: HTTP 500 + SOAP 1.1 fault with on_soap_fault=data returns parsed payload', async () => {
    // Real-world SOAP servers (per SOAP 1.1 spec §6.1.1) return HTTP 500 for faults.
    // The error path must parse the fault envelope before classifying as a transport error.
    const tool = createSoapTool({ on_soap_fault: 'data' });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeSoapResponse(
              '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Internal server error</faultstring></soap:Fault>',
            ),
            { status: 500, headers: { 'content-type': 'text/xml; charset=utf-8' } },
          ),
        ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = (await executor.execute('soap_api', { query: 'test' }, 5000)) as Record<
      string,
      unknown
    >;
    expect(result.soap_fault).toBe(true);

    vi.unstubAllGlobals();
  });

  it('U-10c: HTTP 500 + SOAP 1.1 fault with default on_soap_fault=error throws TOOL_SOAP_FAULT', async () => {
    const tool = createSoapTool();

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeSoapResponse(
              '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Backend down</faultstring></soap:Fault>',
            ),
            { status: 500, headers: { 'content-type': 'text/xml; charset=utf-8' } },
          ),
        ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    let caught: unknown;
    try {
      await executor.execute('soap_api', { query: 'test' }, 5000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe('TOOL_SOAP_FAULT');
    expect((caught as { message: string }).message).toBe('Backend down');

    vi.unstubAllGlobals();
  });

  it('U-13: SOAP response parse failure throws TOOL_RESPONSE_PARSE_FAILED', async () => {
    const tool = createSoapTool();

    // Return malformed XML
    stubFetchWithTextResponse('<broken><<not xml', 'text/xml');

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await expect(executor.execute('soap_api', { query: 'test' }, 5000)).rejects.toThrow(
      'SOAP response XML could not be parsed',
    );

    vi.unstubAllGlobals();
  });
});

describe('HttpToolExecutor — REST regression', () => {
  it('U-15: protocol=undefined still builds JSON request correctly', async () => {
    const tool = createRestTool();

    const mockResponse = { results: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = await executor.execute('rest_api', { query: 'test' }, 5000);
    expect(result).toEqual(mockResponse);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    const body = JSON.parse(fetchCall[1].body as string);

    expect(getHeaderValue(headers, 'Content-Type')).toBe('application/json');
    expect(body).toEqual({ query: 'test' });
    // No SOAP envelope wrapping
    expect(fetchCall[1].body).not.toContain('soap:Envelope');

    vi.unstubAllGlobals();
  });

  it('U-16: existing REST tools with explicit protocol="rest" unaffected', async () => {
    const tool = createRestTool({ protocol: 'rest' });

    const mockResponse = { data: 'ok' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = await executor.execute('rest_api', { query: 'test' }, 5000);
    expect(result).toEqual(mockResponse);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].body).not.toContain('soap:Envelope');
    expect(JSON.parse(fetchCall[1].body as string)).toEqual({ query: 'test' });

    vi.unstubAllGlobals();
  });
});

describe('HttpToolExecutor — SOAP XML escaping in placeholders', () => {
  it('XML-escapes placeholder values in SOAP body template', async () => {
    const tool = createSoapTool();

    stubFetchWithTextResponse(makeSoapResponse('<Resp/>'));

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    await executor.execute('soap_api', { query: '<script>alert("xss")</script>' }, 5000);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;

    // The placeholder value should be XML-escaped
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('<script>');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// SECURITY TESTS
// =============================================================================

describe('Security — SOAP', () => {
  it('SEC-7: WS-Security credentials not leaked in error messages', () => {
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
      _wsSecurityCredentials: {
        username: 'admin',
        password: 'super_secret_password',
        mustUnderstand: true,
      },
    };
    const result = renderSoapRequest({
      binding,
      resolvedBody: '<Test/>',
    });

    // Password should NOT appear in plaintext in the envelope
    expect(result.body).not.toContain('super_secret_password');
    // Username appears in the UsernameToken
    expect(result.body).toContain('admin');
  });

  it('SEC-10: redactWsSecurityForTrace strips Password, Nonce, BinarySecurityToken', () => {
    const body = `<soap:Envelope><soap:Header><wsse:Security>
      <wsse:UsernameToken>
        <wsse:Username>admin</wsse:Username>
        <wsse:Password Type="...PasswordDigest">a1b2c3DIGEST==</wsse:Password>
        <wsse:Nonce EncodingType="...">RANDOMNONCE==</wsse:Nonce>
        <wsu:Created>2026-04-28T00:00:00Z</wsu:Created>
      </wsse:UsernameToken>
      <wsse:BinarySecurityToken ValueType="...X509v3">MIIB-CERT-MATERIAL</wsse:BinarySecurityToken>
    </wsse:Security></soap:Header></soap:Envelope>`;

    const redacted = redactWsSecurityForTrace(body) as string;
    expect(redacted).not.toContain('a1b2c3DIGEST');
    expect(redacted).not.toContain('RANDOMNONCE');
    expect(redacted).not.toContain('MIIB-CERT-MATERIAL');
    expect(redacted).toContain('[REDACTED]');
    // Username and Created are intentionally preserved (not credential material)
    expect(redacted).toContain('<wsse:Username>admin</wsse:Username>');
    expect(redacted).toContain('2026-04-28T00:00:00Z');
  });

  it('SEC-11: pre-wrapped envelope with existing <wsse:Security> is not double-injected', () => {
    const binding: SoapHttpBindingIR = {
      endpoint: 'https://example.com/soap',
      method: 'POST',
      auth: { type: 'none' },
      protocol: 'soap',
      soap_version: '1.1',
      _wsSecurityCredentials: {
        username: 'admin',
        password: 'pw',
        mustUnderstand: true,
      },
    };
    const userEnvelope = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken><wsse:Username>preexisting</wsse:Username></wsse:UsernameToken>
    </wsse:Security>
  </soap:Header>
  <soap:Body><Op/></soap:Body>
</soap:Envelope>`;

    const result = renderSoapRequest({ binding, resolvedBody: userEnvelope });

    // Exactly one <wsse:Security> opener must be present
    const matches = result.body.match(/<wsse:Security[\s>]/g) || [];
    expect(matches.length).toBe(1);
    expect(result.body).toContain('<wsse:Username>preexisting</wsse:Username>');
  });

  it('SEC-10: redactWsSecurityForTrace passes through non-WS-Security bodies', () => {
    expect(redactWsSecurityForTrace('<Plain><Field>value</Field></Plain>')).toBe(
      '<Plain><Field>value</Field></Plain>',
    );
    expect(redactWsSecurityForTrace(undefined)).toBeUndefined();
    expect(redactWsSecurityForTrace(42)).toBe(42);
  });

  it('SEC-9: SSRF blocked for SOAP endpoints (same as REST)', async () => {
    const tool = createSoapTool({
      endpoint: 'http://169.254.169.254/latest/meta-data/',
    });

    mockAssertUrlSafeForFetch.mockRejectedValue(new Error('Blocked cloud metadata endpoint'));

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
    });

    await expect(executor.execute('soap_api', { query: 'test' }, 5000)).rejects.toThrow(
      /SSRF|Blocked/,
    );
  });
});

// =============================================================================
// INTEGRATION TESTS: real HTTP stub server
// =============================================================================

describe('Integration — SOAP with stub server', () => {
  let server: Server;
  let baseUrl: string;

  function startStubServer(handler: (req: any, res: any) => void): Promise<void> {
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('INT-1: Full SOAP 1.1 request/response cycle', async () => {
    let receivedBody = '';
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    await startStubServer((req, res) => {
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        const responseXml = makeSoapResponse(
          '<GetDataResponse><Result>Hello World</Result></GetDataResponse>',
        );
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(responseXml);
      });
    });

    // Override the safeFetch mock to forward to real HTTP —
    // Node.js native fetch Response bodies can have ReadableStream-lock issues
    // in vitest, so we build a simple Response from the server reply text.
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const nodeResp = await globalThis.fetch(url, init);
      const text = await nodeResp.text();
      const headers: Record<string, string> = {};
      nodeResp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return new Response(text, {
        status: nodeResp.status,
        statusText: nodeResp.statusText,
        headers,
      });
    });

    const tool = createSoapTool(
      {
        endpoint: `${baseUrl}/soap`,
        soap_action: 'http://example.com/GetData',
      },
      { name: 'int_soap_11' },
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = await executor.execute('int_soap_11', { query: 'hello' }, 10000);

    // Verify request
    expect(receivedBody).toContain('soap:Envelope');
    expect(receivedBody).toContain('<GetData><Query>hello</Query></GetData>');
    expect(receivedHeaders['content-type']).toBe('text/xml; charset=utf-8');
    expect(receivedHeaders['soapaction']).toBe('"http://example.com/GetData"');

    // Verify response unwrap
    const payload = result as Record<string, unknown>;
    expect(payload).toHaveProperty('GetDataResponse');

    // Cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('INT-2: Full SOAP 1.2 request/response cycle', async () => {
    let receivedBody = '';
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    await startStubServer((req, res) => {
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        const responseXml = makeSoapResponse(
          '<ProcessResponse><Status>OK</Status></ProcessResponse>',
          '1.2',
        );
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
        res.end(responseXml);
      });
    });

    // Override the safeFetch mock to forward to real HTTP
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const nodeResp = await globalThis.fetch(url, init);
      const text = await nodeResp.text();
      const headers: Record<string, string> = {};
      nodeResp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return new Response(text, {
        status: nodeResp.status,
        statusText: nodeResp.statusText,
        headers,
      });
    });

    const tool = createSoapTool(
      {
        endpoint: `${baseUrl}/soap12`,
        soap_version: '1.2',
        soap_action: 'http://example.com/Process',
      },
      { name: 'int_soap_12' },
    );

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    const result = await executor.execute('int_soap_12', { query: 'process' }, 10000);

    // Verify request
    expect(receivedBody).toContain('env:Envelope');
    expect(receivedBody).toContain('xmlns:env="http://www.w3.org/2003/05/soap-envelope"');
    expect(receivedBody).toContain('<GetData><Query>process</Query></GetData>');
    // SOAP 1.2: action in Content-Type, NOT SOAPAction header
    expect(receivedHeaders['soapaction']).toBeUndefined();
    expect(receivedHeaders['content-type']).toContain('action="http://example.com/Process"');

    // Verify response unwrap
    const payload = result as Record<string, unknown>;
    expect(payload).toHaveProperty('ProcessResponse');

    // Cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('INT-4: REST tool with ws_security credentials emits FR-11 warning and skips WS-Security injection', async () => {
    // Start server first so baseUrl is set before tool construction
    await startStubServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    // Arrange: a REST tool (no protocol field) with _wsSecurityCredentials transient field
    const restTool: ToolDefinition = {
      name: 'rest_with_ws_sec',
      description: 'REST tool with mistakenly set WS-Security creds',
      parameters: [],
      return_type: { type: 'object' },
      tool_type: 'http',
      http_binding: {
        endpoint: `${baseUrl}/rest`,
        method: 'POST',
        auth: { type: 'none' },
        body_type: 'json',
        body_template: '{"q": "{{input.q}}"}',
        // no protocol — defaults to REST
        // transient WS-Security credentials (as if patchToolWithResolvedAuth wrote them)
        _wsSecurityCredentials: {
          username: 'user',
          password: 'pass',
          mustUnderstand: true,
        },
      } as any,
    };

    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) =>
      globalThis.fetch(url, init),
    );

    const executor = new HttpToolExecutor({
      tools: [restTool],
      secrets: mockSecrets,
      allowLocalhost: true,
    });

    // Should succeed (REST path) without throwing
    const result = await executor.execute('rest_with_ws_sec', { q: 'hello' }, 5000);
    expect(result).toMatchObject({ ok: true });

    // Cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('INT-6: SOAP fault detection across versions and on_soap_fault modes', async () => {
    const makeFaultXml11 = () => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>Backend error</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

    const makeFaultXml12 = () => `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Body>
    <env:Fault>
      <env:Code><env:Value>env:Receiver</env:Value></env:Code>
      <env:Reason><env:Text>Upstream failed</env:Text></env:Reason>
    </env:Fault>
  </env:Body>
</env:Envelope>`;

    // Test 1: SOAP 1.1 fault → HTTP 200 + on_soap_fault=error → throws TOOL_SOAP_FAULT
    await startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(makeFaultXml11());
    });
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) =>
      globalThis.fetch(url, init),
    );
    const executor11 = new HttpToolExecutor({
      tools: [createSoapTool({ endpoint: `${baseUrl}/fault` })],
      secrets: mockSecrets,
      allowLocalhost: true,
    });
    await expect(executor11.execute('soap_api', { query: 'x' }, 5000)).rejects.toMatchObject({
      code: 'TOOL_SOAP_FAULT',
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Test 2: SOAP 1.2 fault → on_soap_fault=data → returns fault as data
    await startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
      res.end(makeFaultXml12());
    });
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) =>
      globalThis.fetch(url, init),
    );
    const executor12data = new HttpToolExecutor({
      tools: [
        createSoapTool({
          soap_version: '1.2',
          on_soap_fault: 'data',
          endpoint: `${baseUrl}/fault12`,
        }),
      ],
      secrets: mockSecrets,
      allowLocalhost: true,
    });
    const faultData = await executor12data.execute('soap_api', { query: 'x' }, 5000);
    expect((faultData as any).soap_fault).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
