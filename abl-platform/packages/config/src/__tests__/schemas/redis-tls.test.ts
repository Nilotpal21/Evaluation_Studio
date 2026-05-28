import { describe, it, expect } from 'vitest';
import { RedisConfigSchema } from '../../schemas/redis.schema.js';

describe('RedisConfigSchema TLS', () => {
  it('accepts full TLS config object with caFile and rejectUnauthorized', () => {
    const result = RedisConfigSchema.parse({
      url: 'rediss://redis.example.com:6380',
      enabled: true,
      tls: {
        enabled: true,
        caFile: '/etc/ssl/certs/redis-ca.pem',
        rejectUnauthorized: false,
      },
    });

    expect(result.tls).toEqual({
      enabled: true,
      caFile: '/etc/ssl/certs/redis-ca.pem',
      rejectUnauthorized: false,
    });
  });

  it('defaults rejectUnauthorized to true when not specified', () => {
    const result = RedisConfigSchema.parse({
      url: 'rediss://redis.example.com:6380',
      enabled: true,
      tls: {
        enabled: true,
        caFile: '/etc/ssl/certs/redis-ca.pem',
      },
    });

    expect(result.tls.rejectUnauthorized).toBe(true);
  });

  it('accepts boolean tls for backward compatibility and transforms to object', () => {
    const result = RedisConfigSchema.parse({
      url: 'rediss://redis.example.com:6380',
      enabled: true,
      tls: true,
    });

    expect(result.tls).toEqual({
      enabled: true,
      rejectUnauthorized: true,
    });
  });
});
