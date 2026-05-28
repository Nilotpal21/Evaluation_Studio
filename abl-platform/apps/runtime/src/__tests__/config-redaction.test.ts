/**
 * Tests for Redis URL redaction in config logging (H-10).
 */

import { describe, it, expect } from 'vitest';
import { redactUrl } from '../config/index.js';

describe('redactUrl', () => {
  it('redacts password from Redis URL', () => {
    const result = redactUrl('redis://user:redis-password@redis-host:6380/0');
    expect(result).not.toContain('redis-password');
    expect(result).toContain('***');
    expect(result).toContain('redis-host');
    expect(result).toContain('6380');
  });

  it('preserves host and port when no credentials', () => {
    const result = redactUrl('redis://redis-host:6380/0');
    expect(result).toContain('redis-host:6380');
  });

  it('handles URL without credentials gracefully', () => {
    const result = redactUrl('redis://localhost:6379');
    expect(result).toContain('localhost');
    expect(result).toContain('6379');
  });

  it('returns [invalid-url] for unparseable URLs', () => {
    const result = redactUrl('not-a-valid-url');
    expect(result).toBe('[invalid-url]');
  });

  it('redacts both username and password', () => {
    const result = redactUrl('redis://admin:secretpass@myredis.host:6379');
    expect(result).not.toContain('admin');
    expect(result).not.toContain('secretpass');
    expect(result).toContain('myredis.host');
  });
});
