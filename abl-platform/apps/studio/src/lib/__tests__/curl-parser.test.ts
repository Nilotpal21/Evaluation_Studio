/**
 * Tests for CURL Parser
 */

import { describe, it, expect } from 'vitest';
import {
  parseCurlCommand,
  curlToHttpConfig,
  validateCurlParse,
  buildCurlImportPreview,
} from '../curl-parser';
import { httpConfigToToolForm } from '../../components/tools/form-adapters';
import { parseParametersFromHttpConfig } from '../../components/tools/HttpConfigForm';
import type { HttpConfig } from '../../components/tools/shared-types';

describe('parseCurlCommand', () => {
  it('should parse simple GET request', () => {
    const curl = 'curl https://api.example.com/users';
    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/users');
    expect(result?.method).toBe('GET');
    expect(result?.headers).toEqual([]);
  });

  it('should parse POST request with JSON body', () => {
    const curl = `curl -X POST https://api.example.com/users \\
      -H "Content-Type: application/json" \\
      -d '{"name": "John", "email": "john@example.com"}'`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/users');
    expect(result?.method).toBe('POST');
    expect(result?.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
    expect(result?.body).toBe('{"name": "John", "email": "john@example.com"}');
    expect(result?.bodyType).toBe('json');
  });

  it('should parse request with Bearer token', () => {
    const curl = `curl https://api.example.com/data \\
      -H "Authorization: Bearer sk-1234567890"`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.headers).toContainEqual({
      key: 'Authorization',
      value: 'Bearer sk-1234567890',
    });
  });

  it('should parse request with multiple headers', () => {
    const curl = `curl https://api.example.com/resource \\
      -H "Accept: application/json" \\
      -H "X-API-Key: abc123" \\
      -H "User-Agent: MyApp/1.0"`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.headers).toHaveLength(3);
    expect(result?.headers).toContainEqual({
      key: 'Accept',
      value: 'application/json',
    });
    expect(result?.headers).toContainEqual({
      key: 'X-API-Key',
      value: 'abc123',
    });
  });

  it('should parse request with query parameters', () => {
    const curl = 'curl "https://api.example.com/search?q=test&limit=10"';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/search?q=test&limit=10');
  });

  it('should parse request with -u basic auth', () => {
    const curl = 'curl -u username:password https://api.example.com/protected';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.headers).toHaveLength(1);
    expect(result?.headers[0].key).toBe('Authorization');
    expect(result?.headers[0].value).toMatch(/^Basic /);
  });

  it('should handle --data-urlencode (percent-encodes the value like real curl)', () => {
    const curl = 'curl -X POST https://api.example.com/form --data-urlencode "name=John Doe"';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('name=John%20Doe');
    expect(result?.bodyType).toBe('form');
  });

  it('should handle PUT and PATCH methods', () => {
    const curlPut = 'curl -X PUT https://api.example.com/users/1 -d \'{"name": "Updated"}\'';
    const curlPatch = 'curl -X PATCH https://api.example.com/users/1 -d \'{"status": "active"}\'';

    const resultPut = parseCurlCommand(curlPut);
    const resultPatch = parseCurlCommand(curlPatch);

    expect(resultPut?.method).toBe('PUT');
    expect(resultPatch?.method).toBe('PATCH');
  });

  it('should handle URLs with --url flag', () => {
    const curl = 'curl --url https://api.example.com/endpoint -X GET';

    const result = parseCurlCommand(curl);

    expect(result?.url).toBe('https://api.example.com/endpoint');
    expect(result?.method).toBe('GET');
  });

  it('should ignore common flags like --compressed, --silent, -L', () => {
    const curl = 'curl -s -L --compressed https://api.example.com/data';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/data');
  });

  it('should handle headers with colons in value', () => {
    const curl = 'curl -H "Authorization: Bearer token:with:colons" https://api.example.com/data';

    const result = parseCurlCommand(curl);

    expect(result?.headers[0].value).toBe('Bearer token:with:colons');
  });

  it('should return null for invalid curl commands', () => {
    const curl = 'not a curl command';

    const result = parseCurlCommand(curl);

    expect(result).toBeNull();
  });

  it('should handle combined short flags like -sSL', () => {
    const curl = 'curl -sSL https://api.example.com/data';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/data');
    expect(result?.method).toBe('GET');
  });

  it('should handle combined flags -kL with a URL', () => {
    const curl = 'curl -kL https://api.example.com/data';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/data');
  });

  it('should preserve backslashes inside single-quoted strings', () => {
    // In shell, single quotes preserve everything literally including backslashes
    const curl = `curl -X POST https://api.example.com/data -H 'Content-Type: application/json' -d '{"path": "C:\\\\Users\\\\test"}'`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"path": "C:\\\\Users\\\\test"}');
  });

  it('should handle Windows-style line continuations (\\r\\n)', () => {
    const curl =
      'curl -X POST https://api.example.com/users \\\r\n  -H "Content-Type: application/json" \\\r\n  -d \'{"name": "John"}\'';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.method).toBe('POST');
    expect(result?.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
    expect(result?.body).toBe('{"name": "John"}');
  });

  it('should handle real-world Chrome DevTools cURL with many flags', () => {
    const curl = `curl 'https://api.example.com/v1/search?q=test' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test' \\
  -H 'content-type: application/json' \\
  --compressed`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/v1/search?q=test');
    expect(result?.method).toBe('GET');
    expect(result?.headers).toHaveLength(4);
    expect(result?.headers).toContainEqual({
      key: 'accept',
      value: 'application/json',
    });
    expect(result?.headers).toContainEqual({
      key: 'authorization',
      value: 'Bearer eyJhbGciOiJIUzI1NiJ9.test',
    });
    expect(result?.headers).toContainEqual({
      key: 'content-type',
      value: 'application/json',
    });
  });

  it('should handle -XPOST without space between flag and value', () => {
    const curl = 'curl -XPOST https://api.example.com/data -d \'{"key":"val"}\'';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.method).toBe('POST');
  });

  it('should handle --data with = separator', () => {
    const curl = 'curl -X POST https://api.example.com/data --data=\'{"key":"val"}\'';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"key":"val"}');
  });

  it('should not treat URL-like tokens after first URL as URLs', () => {
    const curl =
      'curl -X POST https://api.example.com/callback -H "Referer: https://other.com/page"';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/callback');
    // The Referer header value should NOT override the URL
    expect(result?.headers).toContainEqual({
      key: 'Referer',
      value: 'https://other.com/page',
    });
  });

  it('should handle --data-urlencode with = separator', () => {
    const curl = 'curl -X POST https://api.example.com/form --data-urlencode=name=John';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('name=John');
    expect(result?.bodyType).toBe('form');
  });

  it('should handle -d with no space (attached body)', () => {
    // Some tools generate -d'body' without a space
    const curl = 'curl -X POST https://api.example.com/data -d\'{"a":1}\'';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"a":1}');
  });

  it('should handle --json with = separator', () => {
    const curl = 'curl https://api.example.com/data --json=\'{"key":"val"}\'';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.body).toBe('{"key":"val"}');
    expect(result?.bodyType).toBe('json');
  });

  it('should handle multiple -d flags (should concatenate with &)', () => {
    const curl = 'curl -X POST https://api.example.com/form -d "name=John" -d "age=30"';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    // When multiple -d flags are used, curl concatenates them with &
    expect(result?.body).toContain('name=John');
    expect(result?.body).toContain('age=30');
  });

  it('should handle empty body with -d ""', () => {
    const curl = 'curl -X POST https://api.example.com/data -d ""';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.method).toBe('POST');
  });

  it('should handle the --bearer flag correctly', () => {
    const curl = 'curl --bearer my-token-123 https://api.example.com/data';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.headers).toContainEqual({
      key: 'Authorization',
      value: 'Bearer my-token-123',
    });
  });

  it('should parse full real-world Chrome "Copy as cURL" output', () => {
    const curl = `curl 'https://api.example.com/graphql' \\
  -H 'accept: */*' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'content-type: application/json' \\
  -H 'cookie: session=abc123' \\
  -H 'origin: https://app.example.com' \\
  -H 'referer: https://app.example.com/' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64)' \\
  --data-raw '{"query":"{ users { id name } }"}'`;

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://api.example.com/graphql');
    expect(result?.method).toBe('POST'); // auto-upgraded because of body
    expect(result?.body).toBe('{"query":"{ users { id name } }"}');
    expect(result?.bodyType).toBe('json');
    expect(result?.headers).toHaveLength(7);
    expect(result?.headers).toContainEqual({
      key: 'content-type',
      value: 'application/json',
    });
    expect(result?.headers).toContainEqual({
      key: 'cookie',
      value: 'session=abc123',
    });
  });

  it('should handle -H with = separator', () => {
    const curl = 'curl https://api.example.com/data -H="Content-Type: application/json"';

    const result = parseCurlCommand(curl);

    expect(result).not.toBeNull();
    expect(result?.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
  });
});

describe('curlToHttpConfig', () => {
  it('should convert parsed curl to HttpConfig', () => {
    const parsed = {
      url: 'https://api.example.com/users?page=1',
      method: 'GET',
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer sk-test' },
      ],
    };

    const config = curlToHttpConfig(parsed);

    expect(config.endpoint).toBe('https://api.example.com/users');
    expect(config.method).toBe('GET');
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: 'sk-test' });
    expect(config.queryParams).toEqual([{ key: 'page', value: '1' }]);
    expect(config.headers).toEqual([{ key: 'Accept', value: 'application/json' }]);
  });

  it('should detect API key auth from headers', () => {
    const parsed = {
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: [{ key: 'X-API-Key', value: 'abc123' }],
    };

    const config = curlToHttpConfig(parsed);

    expect(config.authType).toBe('api_key');
    expect(config.authConfig).toEqual({
      headerName: 'X-API-Key',
      apiKey: 'abc123',
    });
    expect(config.headers).toEqual([]); // API key header removed
  });

  it('should handle body and bodyType', () => {
    const parsed = {
      url: 'https://api.example.com/users',
      method: 'POST',
      headers: [],
      body: '{"name": "John"}',
      bodyType: 'json' as const,
    };

    const config = curlToHttpConfig(parsed);

    // JSON body is auto-formatted
    expect(config.body).toBe('{\n  "name": "John"\n}');
    expect(config.bodyType).toBe('json');
  });

  it('should set auth to custom for Basic auth', () => {
    const parsed = {
      url: 'https://api.example.com/protected',
      method: 'GET',
      headers: [{ key: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
    };

    const config = curlToHttpConfig(parsed);

    expect(config.authType).toBe('custom');
    expect(config.headers).toContainEqual({
      key: 'Authorization',
      value: 'Basic dXNlcjpwYXNz',
    });
  });

  it('should preserve Content-Type header alongside auth headers', () => {
    const parsed = {
      url: 'https://api.example.com/users',
      method: 'POST',
      headers: [
        { key: 'Authorization', value: 'Bearer sk-test' },
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json' },
      ],
      body: '{"name": "John"}',
      bodyType: 'json' as const,
    };

    const config = curlToHttpConfig(parsed);

    expect(config.authType).toBe('bearer');
    // Content-Type and Accept should NOT be stripped
    expect(config.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
    expect(config.headers).toContainEqual({
      key: 'Accept',
      value: 'application/json',
    });
    expect(config.headers).toHaveLength(2);
  });

  it('should handle URL with trailing slash and no path', () => {
    const parsed = {
      url: 'https://api.example.com/',
      method: 'GET',
      headers: [],
    };

    const config = curlToHttpConfig(parsed);

    expect(config.endpoint).toBe('https://api.example.com/');
    expect(config.queryParams).toEqual([]);
  });

  it('should handle URL with port number', () => {
    const parsed = {
      url: 'http://localhost:3000/api/data?key=val',
      method: 'GET',
      headers: [],
    };

    const config = curlToHttpConfig(parsed);

    expect(config.endpoint).toBe('http://localhost:3000/api/data');
    expect(config.queryParams).toEqual([{ key: 'key', value: 'val' }]);
  });

  it('should not detect "api" in non-key headers as API key auth', () => {
    const parsed = {
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: [
        { key: 'X-Request-Id', value: 'api-request-123' },
        { key: 'Accept', value: 'application/json' },
      ],
    };

    const config = curlToHttpConfig(parsed);

    // Header value contains "api" but key does not contain both "api" and "key"
    expect(config.authType).toBe('none');
    expect(config.headers).toHaveLength(2);
  });
});

describe('end-to-end: parseCurlCommand → curlToHttpConfig', () => {
  it('should correctly map method from a POST cURL', () => {
    const curl = `curl -X POST https://api.example.com/users \\
  -H "Authorization: Bearer sk-123" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "John"}'`;

    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    const config = curlToHttpConfig(parsed!);

    // Method must be POST, not GET or fallback
    expect(config.method).toBe('POST');
    expect(config.endpoint).toBe('https://api.example.com/users');
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: 'sk-123' });
    // Content-Type should be in headers (not stripped as auth)
    expect(config.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
    // JSON body is auto-formatted for readability
    expect(config.body).toBe('{\n  "name": "John"\n}');
    expect(config.bodyType).toBe('json');
  });

  it('should correctly map method from a PUT cURL', () => {
    const curl =
      'curl -X PUT https://api.example.com/users/1 -H "Content-Type: application/json" -d \'{"name": "Updated"}\'';

    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    expect(config.method).toBe('PUT');
  });

  it('should auto-upgrade GET to POST when body is present and map it correctly', () => {
    // No -X flag, but has -d body → should become POST
    const curl =
      'curl https://api.example.com/data -H "Content-Type: application/json" -d \'{"q": "search"}\'';

    const parsed = parseCurlCommand(curl);
    expect(parsed!.method).toBe('POST'); // auto-upgrade in parser
    const config = curlToHttpConfig(parsed!);

    expect(config.method).toBe('POST');
    // JSON body is auto-formatted
    expect(config.body).toBe('{\n  "q": "search"\n}');
  });

  it('should preserve all non-auth headers through the full pipeline', () => {
    const curl = `curl -X POST https://api.example.com/data \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -H "X-Custom-Header: custom-value" \\
  -H "Authorization: Bearer my-token" \\
  -d '{"key": "val"}'`;

    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    // Authorization should be extracted to authConfig, not in headers
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: 'my-token' });

    // All OTHER headers must survive
    expect(config.headers).toHaveLength(3);
    expect(config.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });
    expect(config.headers).toContainEqual({
      key: 'Accept',
      value: 'application/json',
    });
    expect(config.headers).toContainEqual({
      key: 'X-Custom-Header',
      value: 'custom-value',
    });
  });

  it('should handle Chrome DevTools full cURL through the pipeline', () => {
    const curl = `curl 'https://api.example.com/v2/search?q=hello&limit=20' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.test' \\
  -H 'content-type: application/json' \\
  -H 'origin: https://app.example.com' \\
  -H 'x-request-id: req-abc-123' \\
  --data-raw '{"filters":{"status":"active"}}'`;

    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    const config = curlToHttpConfig(parsed!);

    // Method should be POST (auto-upgraded from GET due to body)
    expect(config.method).toBe('POST');

    // Endpoint should strip query params
    expect(config.endpoint).toBe('https://api.example.com/v2/search');

    // Query params extracted
    expect(config.queryParams).toEqual([
      { key: 'q', value: 'hello' },
      { key: 'limit', value: '20' },
    ]);

    // Auth extracted
    expect(config.authType).toBe('bearer');
    expect(config.authConfig?.token).toBe('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.test');

    // Remaining headers (authorization stripped, browser noise filtered)
    // accept-language and origin are browser noise headers and get filtered out
    expect(config.headers).toHaveLength(3);
    expect(config.headers).toContainEqual({
      key: 'accept',
      value: 'application/json, text/plain, */*',
    });
    expect(config.headers).toContainEqual({
      key: 'content-type',
      value: 'application/json',
    });
    expect(config.headers).toContainEqual({
      key: 'x-request-id',
      value: 'req-abc-123',
    });

    // Body (auto-formatted JSON)
    expect(config.body).toBe('{\n  "filters": {\n    "status": "active"\n  }\n}');
    expect(config.bodyType).toBe('json');
  });

  it('should simulate handleCurlImport merge correctly', () => {
    // Simulates what HttpToolWizard.handleCurlImport does
    const prevState = {
      endpoint: '',
      method: 'GET' as const,
      headers: [],
      queryParams: [],
      authType: 'none' as const,
      retryCount: 0,
      retryDelayMs: 1000,
    };

    const curl =
      'curl -X DELETE https://api.example.com/users/42 -H "Authorization: Bearer tok123"';
    const parsed = parseCurlCommand(curl);
    const importedConfig = curlToHttpConfig(parsed!);

    // Simulate the merge from handleCurlImport
    const merged = {
      ...prevState,
      ...importedConfig,
      retryCount: prevState.retryCount,
      retryDelayMs: prevState.retryDelayMs,
    };

    expect(merged.method).toBe('DELETE');
    expect(merged.endpoint).toBe('https://api.example.com/users/42');
    expect(merged.authType).toBe('bearer');
    expect(merged.retryCount).toBe(0);
    expect(merged.retryDelayMs).toBe(1000);
  });
});

describe('validateCurlParse', () => {
  it('should return null for valid parsed curl', () => {
    const parsed = {
      url: 'https://api.example.com/users',
      method: 'GET',
      headers: [],
    };

    const error = validateCurlParse(parsed);

    expect(error).toBeNull();
  });

  it('should return error for null parsed result', () => {
    const error = validateCurlParse(null);

    expect(error).toBe('Unable to parse curl command');
  });

  it('should return error for invalid URL', () => {
    const parsed = {
      url: 'not-a-valid-url',
      method: 'GET',
      headers: [],
    };

    const error = validateCurlParse(parsed);

    expect(error).toBe('Invalid URL in curl command');
  });
});

describe('ANSI-C quoting', () => {
  it("should handle $'...' quoting (common from Chrome DevTools)", () => {
    const curl = `curl 'https://api.example.com/graphql' -H 'content-type: application/json' --data-raw $'{"query":"{ users { id } }","variables":{}}'`;
    const parsed = parseCurlCommand(curl);

    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('{"query":"{ users { id } }","variables":{}}');
    expect(parsed!.bodyType).toBe('json');
  });

  it('should handle $"..." quoting', () => {
    const curl = `curl https://api.example.com/data -H $"Content-Type: application/json" -d $"{\\"key\\":\\"value\\"}"`;
    const parsed = parseCurlCommand(curl);

    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('{"key":"value"}');
  });
});

describe('browser noise header filtering', () => {
  it('should filter out common browser-injected headers in curlToHttpConfig', () => {
    const curl = `curl 'https://api.example.com/data' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'cookie: session=abc123' \\
  -H 'origin: https://app.example.com' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'user-agent: Mozilla/5.0' \\
  -H 'x-custom: important-value' \\
  -H 'content-type: application/json' \\
  -d '{"key":"val"}'`;

    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    // Only non-noise headers should survive
    expect(config.headers).toHaveLength(3);
    expect(config.headers).toContainEqual({ key: 'accept', value: 'application/json' });
    expect(config.headers).toContainEqual({ key: 'x-custom', value: 'important-value' });
    expect(config.headers).toContainEqual({ key: 'content-type', value: 'application/json' });
  });
});

describe('bash line continuations and shell quoting', () => {
  it("does not leak a stray '\\n' token between tokens", () => {
    const curl = 'curl -X POST https://api.example.com/x \\\n  -H "X-A: 1"';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://api.example.com/x');
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: '1' });
  });

  it('keeps URL split across a line continuation', () => {
    const curl = 'curl -X POST \\\n  https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://api.example.com/x');
  });

  it('normalizes CRLF line continuations too', () => {
    const curl = 'curl -X POST https://api.example.com/x \\\r\n  -H "X-A: 1"';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: '1' });
  });

  it("interprets $'\\n' ANSI-C escapes", () => {
    const curl = `curl https://api.example.com/x -d $'line1\\nline2'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('line1\nline2');
  });

  it("interprets $'\\x41' hex escapes", () => {
    const curl = `curl https://api.example.com/x -d $'\\x41'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('A');
  });

  it('preserves trailing backslash without crashing', () => {
    const curl = 'curl https://api.example.com/x -H "X-A: 1" \\';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://api.example.com/x');
  });
});

describe('-G / --get flag', () => {
  it('moves body pairs into query string and forces GET', () => {
    const curl = 'curl -G https://api.example.com/search --data-urlencode "q=hello world"';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('GET');
    expect(parsed!.body).toBeUndefined();
    expect(parsed!.url).toBe('https://api.example.com/search?q=hello%20world');
  });

  it('appends to an existing query string with &', () => {
    const curl = 'curl -G "https://api.example.com/search?lang=en" -d "q=hello"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/search?lang=en&q=hello');
  });
});

describe('explicit method respected even when body present', () => {
  it('does not flip explicit GET to POST when a body is present', () => {
    const curl = 'curl -X GET https://api.example.com/x -d foo=bar';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.method).toBe('GET');
  });

  it('auto-upgrades GET → POST only when method was not explicit', () => {
    const curl = 'curl https://api.example.com/x -d foo=bar';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.method).toBe('POST');
  });
});

describe('multiple -d with JSON', () => {
  it('does not corrupt JSON bodies with an extra "&"', () => {
    const curl = `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '{"a":1}' -d '{"b":2}'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    // Prefer the last JSON piece rather than producing `{"a":1}&{"b":2}`.
    expect(parsed!.body).toBe('{"b":2}');
    expect(parsed!.bodyType).toBe('json');
    expect(() => JSON.parse(parsed!.body!)).not.toThrow();
  });
});

describe('--data-urlencode actually URL-encodes', () => {
  it('encodes spaces and reserved characters in the VALUE', () => {
    const curl = 'curl -X POST https://api.example.com/x --data-urlencode "q=cats & dogs"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('q=cats%20%26%20dogs');
    expect(parsed!.bodyType).toBe('form');
  });

  it('encodes arg without a name', () => {
    const curl = 'curl -X POST https://api.example.com/x --data-urlencode "hello world"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('hello%20world');
  });
});

describe('auth detection precedence', () => {
  it('Authorization: Bearer wins over api-key-looking headers regardless of order', () => {
    const curl = `curl https://api.example.com/x -H 'x-api-key: abc' -H 'Authorization: Bearer tok'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: 'tok' });
    // The api-key header is preserved as a static header (auth came from Authorization).
    expect(config.headers).toContainEqual({ key: 'x-api-key', value: 'abc' });
  });

  it('does not treat arbitrary "apikey"-ish values in non-key headers as API keys', () => {
    const curl = `curl https://api.example.com/x -H 'X-Apikey-Signature: abc'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.authType).toBe('none');
    expect(config.headers).toContainEqual({ key: 'X-Apikey-Signature', value: 'abc' });
  });

  it('Basic auth stays as custom and keeps Authorization header intact', () => {
    const curl = `curl -u admin:s3cret https://api.example.com/x`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.authType).toBe('custom');
    expect(config.headers).toContainEqual({
      key: 'Authorization',
      value: 'Basic YWRtaW46czNjcmV0',
    });
  });
});

describe('unknown flags with arguments are consumed', () => {
  it('does not treat --proxy value as a URL', () => {
    const curl = 'curl --proxy http://proxy.corp:8080 https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
  });

  it('does not treat --max-time value as a URL or body', () => {
    const curl = 'curl --max-time 30 https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
    expect(parsed!.body).toBeUndefined();
  });
});

describe('malformed input tolerance', () => {
  it('skips empty -H values safely', () => {
    const curl = 'curl https://api.example.com/x -H "" -H "X-A: 1"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.headers).toEqual([{ key: 'X-A', value: '1' }]);
  });

  it('strips a leading BOM on pasted input', () => {
    const curl = '\uFEFFcurl https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
  });
});

describe('JSON body auto-formatting', () => {
  it('should pretty-print JSON body in curlToHttpConfig', () => {
    const curl = `curl -X POST https://api.example.com/data -H 'Content-Type: application/json' -d '{"name":"John","nested":{"a":1}}'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    expect(config.body).toBe('{\n  "name": "John",\n  "nested": {\n    "a": 1\n  }\n}');
  });

  it('should leave non-JSON body as-is', () => {
    const curl = `curl -X POST https://api.example.com/form -d 'username=admin&password=secret'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    expect(config.body).toBe('username=admin&password=secret');
  });

  it('should leave invalid JSON body as-is', () => {
    const curl = `curl -X POST https://api.example.com/data -H 'Content-Type: application/json' -d '{invalid json}'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);

    // Body type inferred as json from Content-Type, but formatting fails gracefully
    expect(config.body).toBe('{invalid json}');
  });
});

// ---------------------------------------------------------------------------
// Real-world edge cases
// ---------------------------------------------------------------------------

describe('edge cases: whitespace, quoting & structure', () => {
  it('handles leading/trailing whitespace and multiline paste', () => {
    const curl = `
       curl  \\
         -X POST \\
         -H 'X-A: 1' \\
         https://api.example.com/x
    `;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('POST');
    expect(parsed!.url).toBe('https://api.example.com/x');
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: '1' });
  });

  it('handles tabs as token separators', () => {
    const curl = 'curl\t-X\tPOST\thttps://api.example.com/x\t-H\t"X-A: 1"';
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('POST');
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: '1' });
  });

  it("handles a $'...' body with embedded escaped single quote", () => {
    const curl = `curl https://api.example.com/x -d $'it\\'s fine'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe("it's fine");
  });

  it('treats $"..." as double quotes (escape processing active)', () => {
    const curl = `curl https://api.example.com/x -d $"path=C:\\\\Users"`;
    const parsed = parseCurlCommand(curl);
    // inside double quotes, `\\` reduces to a single backslash.
    expect(parsed!.body).toBe('path=C:\\Users');
  });

  it('supports concatenated quotes like "foo""bar" → foobar', () => {
    const curl = `curl https://api.example.com/x -H "X-A: ""hello""world"""`;
    const parsed = parseCurlCommand(curl);
    // Concatenated quoted strings merge; inner "" becomes empty string.
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: 'helloworld' });
  });

  it('preserves = inside a value without treating it as a flag separator', () => {
    const curl = 'curl https://api.example.com/x -H "X-Eq: a=b=c"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.headers).toContainEqual({ key: 'X-Eq', value: 'a=b=c' });
  });

  it('handles URLs with fragments, ports, and userinfo (→ Basic auth header)', () => {
    const curl = 'curl "https://user:pass@api.example.com:8443/path?x=1#frag"';
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    // userinfo is stripped from the endpoint and surfaced as Basic auth.
    expect(config.endpoint).toBe('https://api.example.com:8443/path');
    expect(config.queryParams).toEqual([{ key: 'x', value: '1' }]);
    // Authorization header is auto-added from userinfo — left as a custom
    // header (auth type stays "custom") because it is not Bearer.
    expect(config.authType).toBe('custom');
    expect(config.headers).toContainEqual(
      expect.objectContaining({ key: 'Authorization', value: expect.stringMatching(/^Basic /) }),
    );
  });
});

describe('edge cases: methods, URLs & placement', () => {
  it('ignores tokens that only look like flags after the URL is set', () => {
    const curl = 'curl https://api.example.com/x -X POST';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
    expect(parsed!.method).toBe('POST');
  });

  it('supports --request=POST equivalent to -X POST', () => {
    const curl = 'curl --request=PATCH https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.method).toBe('PATCH');
  });

  it('supports --url= form', () => {
    const curl = 'curl --url=https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
  });

  it('accepts http:// URLs as valid', () => {
    const parsed = parseCurlCommand('curl http://plaintext.example.com/x')!;
    expect(parsed.url).toBe('http://plaintext.example.com/x');
    expect(validateCurlParse(parsed)).toBeNull();
  });

  it('parses non-http schemes but rejects them in validateCurlParse', () => {
    const parsed = parseCurlCommand('curl ws://ws.example.com/x')!;
    expect(parsed.url).toBe('ws://ws.example.com/x');
    // Backend only accepts http(s); validateCurlParse surfaces a clear error.
    expect(validateCurlParse(parsed)).toMatch(/Unsupported URL scheme/);
  });

  it('returns null for a bare "curl" with nothing else', () => {
    expect(parseCurlCommand('curl')).toBeNull();
    expect(parseCurlCommand('curl   ')).toBeNull();
  });

  it('returns null for non-curl text', () => {
    expect(parseCurlCommand('wget https://example.com')).toBeNull();
  });
});

describe('edge cases: bodies', () => {
  it('does not over-format an XML body (JSON formatter is skipped)', () => {
    const curl = `curl -X POST https://api.example.com/x -H 'Content-Type: application/xml' -d '<root><a>1</a></root>'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(parsed!.bodyType).toBe('xml');
    expect(config.body).toBe('<root><a>1</a></root>');
  });

  it('infers "form" bodyType from a k=v&k=v body when content-type is missing', () => {
    const curl = 'curl -X POST https://api.example.com/x -d "a=1&b=2"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.bodyType).toBe('form');
  });

  it('infers "json" bodyType from a `[...]` body when content-type is missing', () => {
    const curl = `curl -X POST https://api.example.com/x -d '[{"a":1}]'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.bodyType).toBe('json');
  });

  it('keeps body raw when it is neither JSON nor a form pair list', () => {
    const curl = 'curl -X POST https://api.example.com/x -d "hello world"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.bodyType).toBe('text');
  });

  it('treats only the last --json as the body', () => {
    const curl = `curl https://api.example.com/x --json '{"a":1}' --json '{"b":2}'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('{"b":2}');
    expect(parsed!.bodyType).toBe('json');
  });

  it('multiple --data-urlencode joins with & (form-style)', () => {
    const curl = `curl -X POST https://api.example.com/x --data-urlencode "a=1" --data-urlencode "b=hello world"`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('a=1&b=hello%20world');
    expect(parsed!.bodyType).toBe('form');
  });

  it('mixes -d and --data-urlencode into form body', () => {
    const curl = `curl -X POST https://api.example.com/x -d "a=1" --data-urlencode "q=hello world"`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('a=1&q=hello%20world');
    expect(parsed!.bodyType).toBe('form');
  });

  it('--data-urlencode without "=" is treated as a raw URL-encoded value', () => {
    const curl = `curl -X POST https://api.example.com/x --data-urlencode "raw value"`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('raw%20value');
  });

  it('preserves non-ASCII characters in JSON body through round-trip', () => {
    const curl = `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '{"msg":"héllo → 世界"}'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed!.body).toBe('{"msg":"héllo → 世界"}');
    const config = curlToHttpConfig(parsed!);
    expect(JSON.parse(config.body!)).toEqual({ msg: 'héllo → 世界' });
  });
});

describe('edge cases: auth detection', () => {
  it('Bearer in any case ("bearer xxx") is recognized', () => {
    const curl = `curl https://api.example.com/x -H 'authorization: bearer tok'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: 'tok' });
  });

  it('api_key via "apikey" header is recognized', () => {
    const curl = `curl https://api.example.com/x -H 'apikey: abc'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('api_key');
    expect(config.authConfig).toEqual({ headerName: 'apikey', apiKey: 'abc' });
  });

  it('api_key via "x-auth-token" header is recognized', () => {
    const curl = `curl https://api.example.com/x -H 'X-Auth-Token: abc'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('api_key');
    expect(config.authConfig?.headerName).toBe('X-Auth-Token');
  });

  it('duplicate Authorization headers → only one consumed, others preserved', () => {
    const curl = `curl https://api.example.com/x -H 'Authorization: Bearer tok1' -H 'Authorization: Bearer tok2'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('bearer');
    // Only the first Authorization is consumed as auth; the rest should not be
    // re-added. We do drop duplicates here to avoid two rows in the UI for the
    // same thing.
    expect(config.headers?.filter((h) => h.key.toLowerCase() === 'authorization')).toHaveLength(0);
  });

  it('deduplicates identical header (name, value) pairs', () => {
    const curl = `curl https://api.example.com/x -H 'X-A: 1' -H 'X-A: 1'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.headers?.filter((h) => h.key.toLowerCase() === 'x-a')).toHaveLength(1);
  });

  it('keeps distinct same-name headers with different values', () => {
    const curl = `curl https://api.example.com/x -H 'X-A: 1' -H 'X-A: 2'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.headers?.filter((h) => h.key.toLowerCase() === 'x-a')).toHaveLength(2);
  });
});

describe('edge cases: query params / -G', () => {
  it('-G with an already-encoded query does not double-encode', () => {
    const curl = 'curl -G "https://api.example.com/x?a=1" --data-urlencode "q=foo bar"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x?a=1&q=foo%20bar');
  });

  it('-G with no body leaves URL untouched', () => {
    const curl = 'curl -G https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
    expect(parsed!.body).toBeUndefined();
    expect(parsed!.method).toBe('GET');
  });
});

describe('real-world: provider-shaped pastes', () => {
  it('parses an Anthropic-like Messages API example', () => {
    const curl = `curl https://api.anthropic.com/v1/messages \\
  --header "x-api-key: sk-ant-xxxx" \\
  --header "anthropic-version: 2023-06-01" \\
  --header "content-type: application/json" \\
  --data '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect(config.method).toBe('POST');
    expect(config.authType).toBe('api_key');
    expect(config.authConfig).toEqual({ headerName: 'x-api-key', apiKey: 'sk-ant-xxxx' });
    expect(config.headers).toContainEqual({ key: 'anthropic-version', value: '2023-06-01' });
    expect(config.headers).toContainEqual({ key: 'content-type', value: 'application/json' });
    expect(config.bodyType).toBe('json');
    expect(JSON.parse(config.body!).model).toBe('claude-opus-4-7');
  });

  it('parses a GitHub API GET with Bearer token and multiple query params', () => {
    const curl = `curl -L \\
  -H "Accept: application/vnd.github+json" \\
  -H "Authorization: Bearer ghp_xxx" \\
  -H "X-GitHub-Api-Version: 2022-11-28" \\
  "https://api.github.com/repos/OWNER/REPO/issues?state=open&per_page=50"`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.method).toBe('GET');
    expect(config.authType).toBe('bearer');
    expect(config.endpoint).toBe('https://api.github.com/repos/OWNER/REPO/issues');
    expect(config.queryParams).toEqual([
      { key: 'state', value: 'open' },
      { key: 'per_page', value: '50' },
    ]);
  });

  it('parses a Stripe-style POST with -u basic auth and -d pairs', () => {
    const curl = `curl https://api.stripe.com/v1/charges \\
  -u sk_test_xxx: \\
  -d "amount=2000" \\
  -d "currency=usd" \\
  -d "source=tok_visa" \\
  -d "description=Test charge"`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.method).toBe('POST');
    expect(config.authType).toBe('custom');
    expect(config.headers).toContainEqual(
      expect.objectContaining({ key: 'Authorization', value: expect.stringMatching(/^Basic /) }),
    );
    expect(config.body).toContain('amount=2000');
    expect(config.body).toContain('source=tok_visa');
    expect(config.bodyType).toBe('form');
  });

  it('parses a Chrome DevTools "Copy as cURL (bash)" with $\'...\' body', () => {
    const curl = `curl 'https://api.example.com/graphql' \\
  -H 'authority: api.example.com' \\
  -H 'accept: */*' \\
  -H 'authorization: Bearer tok' \\
  -H 'content-type: application/json' \\
  --data-raw $'{"query":"{ me { id } }","variables":{}}'`;
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(config.method).toBe('POST');
    expect(config.authType).toBe('bearer');
    expect(config.authConfig?.token).toBe('tok');
    expect(JSON.parse(config.body!).query).toBe('{ me { id } }');
  });

  it('parses Windows-pasted curl with CRLF line continuations and mixed quotes', () => {
    const curl = `curl "https://api.example.com/x" ^\r\n  -H "Content-Type: application/json" ^\r\n  -d "{\\"a\\":1}"`;
    // Windows cmd.exe uses `^` as continuation — we don't support that (we strip
    // CRLF normalisation only), but the parser should still pull out a useful
    // URL + headers rather than crashing.
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://api.example.com/x');
  });
});

describe('edge cases: misc flags', () => {
  it('ignores -F (multipart) safely without consuming the URL', () => {
    const curl = 'curl -F "file=@test.txt" https://api.example.com/upload';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/upload');
    // We do NOT fabricate a multipart body from -F (would require file I/O).
    expect(parsed!.body).toBeUndefined();
  });

  it('ignores -o/--output flags without eating the URL', () => {
    const curl = 'curl -o /tmp/out.json https://api.example.com/x';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
  });

  it('handles --header= (long form with equals)', () => {
    const curl = 'curl https://api.example.com/x --header="X-A: 1"';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.headers).toContainEqual({ key: 'X-A', value: '1' });
  });
});

describe('template variables ({{input.X}} / {{secrets.X}})', () => {
  it('preserves {{input.X}} in the URL path (no percent-encoding)', () => {
    const curl = `curl 'https://api.example.com/users/{{input.userId}}/profile'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.endpoint).toBe('https://api.example.com/users/{{input.userId}}/profile');
  });

  it('preserves {{secrets.X}} in query string values', () => {
    const curl = `curl 'https://api.example.com/x?q={{input.query}}&tok={{secrets.TOK}}'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.queryParams).toContainEqual({ key: 'q', value: '{{input.query}}' });
    expect(config.queryParams).toContainEqual({ key: 'tok', value: '{{secrets.TOK}}' });
  });

  it('preserves templates in header values (api_key detection intact)', () => {
    const curl = `curl https://api.example.com/x -H 'X-Api-Key: {{secrets.API_KEY}}'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('api_key');
    expect(config.authConfig).toEqual({
      headerName: 'X-Api-Key',
      apiKey: '{{secrets.API_KEY}}',
    });
  });

  it('preserves templates inside a Bearer token', () => {
    const curl = `curl https://api.example.com/x -H 'Authorization: Bearer {{secrets.TOKEN}}'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.authType).toBe('bearer');
    expect(config.authConfig).toEqual({ token: '{{secrets.TOKEN}}' });
  });

  it('preserves templates in a JSON body', () => {
    const curl = `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '{"tok":"{{secrets.TOK}}","q":"{{input.q}}"}'`;
    const parsed = parseCurlCommand(curl)!;
    expect(parsed.body).toContain('{{secrets.TOK}}');
    expect(parsed.body).toContain('{{input.q}}');
  });

  it('does NOT percent-encode templates in --data-urlencode values', () => {
    const curl = `curl -X POST https://api.example.com/f --data-urlencode 'q={{input.query}}'`;
    const parsed = parseCurlCommand(curl)!;
    expect(parsed.body).toBe('q={{input.query}}');
  });

  it('encodes surrounding chars while preserving templates in --data-urlencode', () => {
    const curl = `curl -X POST https://api.example.com/f --data-urlencode 'q=hello {{input.query}} world'`;
    const parsed = parseCurlCommand(curl)!;
    // Spaces get %20 but the template braces stay literal.
    expect(parsed.body).toBe('q=hello%20{{input.query}}%20world');
  });

  it('-G with templated --data-urlencode value', () => {
    const curl = `curl -G https://api.example.com/search --data-urlencode 'q={{input.search}}'`;
    const parsed = parseCurlCommand(curl)!;
    expect(parsed.method).toBe('GET');
    expect(parsed.url).toBe(
      'https://api.example.com/search?q={{input.query}}'.replace(
        '{{input.query}}',
        '{{input.search}}',
      ),
    );
  });

  it('templated host is accepted by validateCurlParse', () => {
    const curl = `curl https://{{input.host}}/api/x`;
    const parsed = parseCurlCommand(curl);
    expect(validateCurlParse(parsed)).toBeNull();
  });

  it('templated host survives in the endpoint (no lowercased sentinel leak)', () => {
    const curl = `curl https://{{input.host}}/api/x`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.endpoint).toBe('https://{{input.host}}/api/x');
  });

  it('auto-extracts parameter stubs from every templated surface (url, query, headers, body)', () => {
    const curl = `curl -X POST 'https://{{input.host}}/users/{{input.userId}}?q={{input.query}}' \\
      -H 'Authorization: Bearer {{input.token}}' \\
      -H 'Content-Type: application/json' \\
      -d '{"name":"{{input.name}}","email":"{{input.email}}"}'`;
    const imported = curlToHttpConfig(parseCurlCommand(curl)!);
    const seed: HttpConfig = {
      endpoint: '',
      method: 'GET',
      authType: 'none',
      headers: [],
      queryParams: [],
    };
    const merged = { ...seed, ...imported };
    // This mirrors what HttpToolWizard.handleCurlImport now does after import.
    merged.parameters = parseParametersFromHttpConfig(merged);
    const names = merged.parameters.map((p) => p.name).sort();
    expect(names).toEqual(['email', 'host', 'name', 'query', 'token', 'userId'].sort());
    // All auto-stubs default to required string params.
    for (const p of merged.parameters) {
      expect(p.type).toBe('string');
      expect(p.required).toBe(true);
    }
  });

  it('multiple templates in one string all restore', () => {
    const curl = `curl 'https://{{input.host}}/{{input.path}}?a={{input.a}}&b={{input.b}}'`;
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.endpoint).toBe('https://{{input.host}}/{{input.path}}');
    expect(config.queryParams).toEqual([
      { key: 'a', value: '{{input.a}}' },
      { key: 'b', value: '{{input.b}}' },
    ]);
  });
});

describe('backend compatibility: full curl → toolForm round-trip', () => {
  // Minimal HttpConfig seed used by the wizard before a curl import.
  const seedConfig = (): HttpConfig => ({
    endpoint: '',
    method: 'GET',
    authType: 'none',
    headers: [],
    queryParams: [],
  });

  it('produces a tool-form whose method is always in the backend enum', () => {
    for (const m of ['HEAD', 'OPTIONS', 'MKCOL']) {
      const parsed = parseCurlCommand(`curl -X ${m} https://api.example.com/x`);
      const imported = curlToHttpConfig(parsed!);
      const merged = { ...seedConfig(), ...imported };
      const form = httpConfigToToolForm('t', 'd', merged, null);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(form.method);
    }
  });

  it('produces a tool-form with a valid HTTP(s) endpoint', () => {
    const parsed = parseCurlCommand(
      'curl -X POST https://api.example.com/v1/users -H "Authorization: Bearer tok" -d \'{"a":1}\'',
    );
    const imported = curlToHttpConfig(parsed!);
    const merged = { ...seedConfig(), ...imported };
    const form = httpConfigToToolForm('t', 'd', merged, null);
    expect(form.endpoint).toBe('https://api.example.com/v1/users');
    expect(form.auth).toBe('bearer');
    expect(form.authConfig).toEqual({ token: 'tok' });
    expect(form.bodyType).toBe('json');
  });

  it('api_key auth survives the adapter', () => {
    const parsed = parseCurlCommand(
      `curl https://api.example.com/x -H 'x-api-key: k' -H 'Accept: application/json'`,
    );
    const imported = curlToHttpConfig(parsed!);
    const merged = { ...seedConfig(), ...imported };
    const form = httpConfigToToolForm('t', 'd', merged, null);
    expect(form.auth).toBe('api_key');
    expect(form.authConfig).toEqual({ headerName: 'x-api-key', apiKey: 'k' });
    expect(form.headers).toContainEqual({ key: 'Accept', value: 'application/json' });
  });

  it('form-encoded body survives the adapter', () => {
    const parsed = parseCurlCommand(
      'curl -X POST https://api.example.com/f --data-urlencode "q=hello world"',
    );
    const imported = curlToHttpConfig(parsed!);
    const merged = { ...seedConfig(), ...imported };
    const form = httpConfigToToolForm('t', 'd', merged, null);
    expect(form.method).toBe('POST');
    expect(form.body).toBe('q=hello%20world');
    expect(form.bodyType).toBe('form');
  });
});

describe('backend compatibility: method & URL normalization', () => {
  it('coerces HEAD to GET in curlToHttpConfig (backend schema does not accept HEAD)', () => {
    const curl = 'curl -X HEAD https://api.example.com/x';
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.method).toBe('GET');
  });

  it('coerces OPTIONS to GET (backend schema does not accept OPTIONS)', () => {
    const curl = 'curl -X OPTIONS https://api.example.com/x';
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.method).toBe('GET');
  });

  it('coerces unknown methods (e.g. WebDAV MKCOL) to GET', () => {
    const curl = 'curl -X MKCOL https://api.example.com/x';
    const config = curlToHttpConfig(parseCurlCommand(curl)!);
    expect(config.method).toBe('GET');
  });

  it('keeps the full set of supported methods intact', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const config = curlToHttpConfig(parseCurlCommand(`curl -X ${m} https://api.example.com/x`)!);
      expect(config.method).toBe(m);
    }
  });
});

describe('stress: pathological inputs', () => {
  it('survives a deeply nested JSON body with escapes', () => {
    const curl = `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '${JSON.stringify(
      {
        a: 'line1\nline2',
        b: { c: [1, 2, { d: 'x' }] },
        e: 'quote "x"',
      },
    )}'`;
    const parsed = parseCurlCommand(curl);
    expect(parsed).not.toBeNull();
    expect(JSON.parse(parsed!.body!)).toEqual({
      a: 'line1\nline2',
      b: { c: [1, 2, { d: 'x' }] },
      e: 'quote "x"',
    });
  });

  it('survives pathological whitespace around a single token', () => {
    const curl = '   curl   \t\t  https://api.example.com/x   ';
    const parsed = parseCurlCommand(curl);
    expect(parsed!.url).toBe('https://api.example.com/x');
  });

  it('treats #fragment in URL as part of URL but stripped in endpoint', () => {
    const curl = 'curl "https://api.example.com/x#section"';
    const parsed = parseCurlCommand(curl);
    const config = curlToHttpConfig(parsed!);
    expect(parsed!.url).toBe('https://api.example.com/x#section');
    expect(config.endpoint).toBe('https://api.example.com/x');
  });

  it('unterminated quote still returns something (best-effort)', () => {
    const curl = `curl https://api.example.com/x -H 'X-A: broken`;
    const parsed = parseCurlCommand(curl);
    // Even though the quote never closes, we should not crash.
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://api.example.com/x');
  });
});

// ---------------------------------------------------------------------------
// Rich import preview (warnings + detectedInputs)
// ---------------------------------------------------------------------------

describe('buildCurlImportPreview', () => {
  it('no warnings for a clean happy-path paste', () => {
    const parsed = parseCurlCommand(
      'curl -X POST https://api.example.com/x -H "Authorization: Bearer tok" -d \'{"a":1}\'',
    )!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings).toEqual([]);
    expect(preview.detectedInputs).toEqual([]);
    expect(preview.config.method).toBe('POST');
  });

  it('warns on -F (multipart)', () => {
    const parsed = parseCurlCommand('curl -F "file=@x.txt" https://api.example.com/upload')!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /Multipart/i.test(w))).toBe(true);
  });

  it('warns when HEAD is coerced to GET', () => {
    const parsed = parseCurlCommand('curl -X HEAD https://api.example.com/x')!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /HEAD.*GET/i.test(w))).toBe(true);
    expect(preview.config.method).toBe('GET');
  });

  it('warns on multiple JSON -d bodies and keeps the last', () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' -d '{"a":1}' -d '{"b":2}'`,
    )!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /Multiple JSON bodies/i.test(w))).toBe(true);
    expect(preview.config.body).toBe('{\n  "b": 2\n}');
  });

  it('warns on TLS / proxy flags', () => {
    const parsed = parseCurlCommand(
      'curl --proxy http://proxy.corp:8080 --cacert /path/ca.pem https://api.example.com/x',
    )!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /transport flag/i.test(w))).toBe(true);
  });

  it('warns on cookie flags', () => {
    const parsed = parseCurlCommand('curl --cookie "sid=abc" https://api.example.com/x')!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /cookie/i.test(w.toLowerCase()))).toBe(true);
  });

  it('warns on @file body references', () => {
    const parsed = parseCurlCommand('curl -d @body.json https://api.example.com/x')!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.warnings.some((w) => /@file/i.test(w))).toBe(true);
  });

  it('collects {{input.X}} refs from every surface as detectedInputs', () => {
    const parsed = parseCurlCommand(
      `curl -X POST 'https://{{input.host}}/users/{{input.userId}}?lang={{input.lang}}' \\
        -H 'Authorization: Bearer {{input.token}}' \\
        -H 'Content-Type: application/json' \\
        -d '{"name":"{{input.name}}"}'`,
    )!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.detectedInputs.sort()).toEqual(
      ['host', 'lang', 'name', 'token', 'userId'].sort(),
    );
  });

  it('surfaces {{secrets.X}} references as a warning (not as input params)', () => {
    const parsed = parseCurlCommand(
      `curl https://api.example.com/x -H 'X-Api-Key: {{secrets.API_KEY}}'`,
    )!;
    const preview = buildCurlImportPreview(parsed);
    expect(preview.detectedInputs).toEqual([]);
    expect(preview.warnings.some((w) => /secret/i.test(w) && /API_KEY/.test(w))).toBe(true);
  });
});
