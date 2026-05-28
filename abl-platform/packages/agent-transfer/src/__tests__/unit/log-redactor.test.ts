import { describe, it, expect } from 'vitest';
import { redact } from '../../security/log-redactor.js';

describe('redact', () => {
  it('redacts apiKey field', () => {
    const result = redact({ apiKey: 'secret-123', name: 'test' });
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.name).toBe('test');
  });

  it('redacts token, password, secret, authorization', () => {
    const result = redact({
      token: 'tok-abc',
      password: 'hunter2',
      secret: 'shh',
      authorization: 'Bearer xyz',
    });
    expect(result.token).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields (one level deep)', () => {
    const result = redact({
      config: { apiKey: 'nested-key', host: 'example.com' },
    });
    const nested = result.config as Record<string, unknown>;
    expect(nested.apiKey).toBe('[REDACTED]');
    expect(nested.host).toBe('example.com');
  });

  it('preserves non-sensitive fields', () => {
    const result = redact({
      tenantId: 'tenant-1',
      channel: 'chat',
      count: 42,
    });
    expect(result.tenantId).toBe('tenant-1');
    expect(result.channel).toBe('chat');
    expect(result.count).toBe(42);
  });

  it('handles empty objects', () => {
    const result = redact({});
    expect(result).toEqual({});
  });

  it('redacts mixed-case sensitive header keys', () => {
    const result = redact({
      Authorization: 'Bearer xyz',
      'X-API-Key': 'key-123',
      'X-Auth-Token': 'tok-456',
      safe: 'value',
    });

    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['X-API-Key']).toBe('[REDACTED]');
    expect(result['X-Auth-Token']).toBe('[REDACTED]');
    expect(result.safe).toBe('value');
  });

  it('redacts sensitive fields inside nested arrays', () => {
    const result = redact({
      attempts: [
        {
          Authorization: 'Bearer xyz',
          headers: [{ 'X-API-Key': 'key-123' }, { nested: { token: 'tok-456', safe: 'value' } }],
        },
      ],
    });

    expect(result).toEqual({
      attempts: [
        {
          Authorization: '[REDACTED]',
          headers: [
            { 'X-API-Key': '[REDACTED]' },
            { nested: { token: '[REDACTED]', safe: 'value' } },
          ],
        },
      ],
    });
  });

  it('does not modify original object', () => {
    const original = { apiKey: 'my-key', name: 'test' };
    const copy = { ...original };
    redact(original);
    expect(original).toEqual(copy);
  });

  it('redacts accessToken and refreshToken', () => {
    const result = redact({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
    });
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
  });

  it('redacts credentials and x-api-key', () => {
    const result = redact({
      credentials: 'creds',
      'x-api-key': 'key-abc',
      'x-auth-token': 'tok-xyz',
    });
    expect(result.credentials).toBe('[REDACTED]');
    expect(result['x-api-key']).toBe('[REDACTED]');
    expect(result['x-auth-token']).toBe('[REDACTED]');
  });
});
