import { describe, expect, it } from 'vitest';
import { maskRawDslForDisplay } from '../utils/mask-sensitive-data';

describe('maskRawDslForDisplay', () => {
  it('redacts HTTP auth secrets while preserving non-secret auth metadata', () => {
    const bearerToken = 'bearer-secret-value';
    const apiKey = 'short-key';
    const clientSecret = 'oauth-client-secret';
    const rawDsl = [
      'weather_tool() -> object',
      '  type: http',
      '  endpoint: "https://api.example.com/weather"',
      '  auth: oauth2_client',
      '  auth_config:',
      `    token: "${bearerToken}"`,
      `    api_key: "${apiKey}"`,
      '    token_url: "https://idp.example.com/oauth/token"',
      '    client_id: "public-client-id"',
      `    client_secret: "${clientSecret}"`,
      '    header_name: "X-API-Key"',
    ].join('\n');

    const masked = maskRawDslForDisplay(rawDsl);

    expect(masked).toContain('token: "***REDACTED***"');
    expect(masked).toContain('api_key: "***REDACTED***"');
    expect(masked).toContain('client_secret: "***REDACTED***"');
    expect(masked).toContain('token_url: "https://idp.example.com/oauth/token"');
    expect(masked).toContain('client_id: "public-client-id"');
    expect(masked).toContain('header_name: "X-API-Key"');
    expect(masked).not.toContain(bearerToken);
    expect(masked).not.toContain(apiKey);
    expect(masked).not.toContain(clientSecret);
  });

  it('redacts sensitive custom auth headers and bearer header values', () => {
    const apiKey = 'custom-header-secret';
    const bearerToken = 'bearer-header-secret';
    const rawDsl = [
      'custom_auth_tool() -> object',
      '  type: http',
      '  auth: custom',
      '  auth_config:',
      '    custom_headers:',
      `      X-API-Key: "${apiKey}"`,
      `      Authorization: "Bearer ${bearerToken}"`,
      '      X-Trace-Id: "trace-id"',
    ].join('\n');

    const masked = maskRawDslForDisplay(rawDsl);

    expect(masked).toContain('X-API-Key: "***REDACTED***"');
    expect(masked).toContain('Authorization: "***REDACTED***"');
    expect(masked).toContain('X-Trace-Id: "trace-id"');
    expect(masked).not.toContain(apiKey);
    expect(masked).not.toContain(bearerToken);
  });
});
