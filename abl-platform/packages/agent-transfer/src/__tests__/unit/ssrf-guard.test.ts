import { describe, it, expect, vi } from 'vitest';
import { assertAllowedUrlSync as assertAllowedUrl } from '../../security/ssrf-guard.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('assertAllowedUrl', () => {
  it('allows valid public URLs', () => {
    expect(() => assertAllowedUrl('https://api.example.com')).not.toThrow();
    expect(() => assertAllowedUrl('https://smartassist.kore.ai/api/v1')).not.toThrow();
  });

  it('blocks 10.x.x.x private range', () => {
    expect(() => assertAllowedUrl('https://10.0.0.1/api')).toThrow('SSRF blocked');
    expect(() => assertAllowedUrl('https://10.255.255.255')).toThrow('SSRF blocked');
  });

  it('blocks 172.16-31.x.x private range', () => {
    expect(() => assertAllowedUrl('https://172.16.0.1')).toThrow('SSRF blocked');
    expect(() => assertAllowedUrl('https://172.31.255.255')).toThrow('SSRF blocked');
  });

  it('does not block 172.15.x.x or 172.32.x.x', () => {
    expect(() => assertAllowedUrl('https://172.15.0.1')).not.toThrow();
    expect(() => assertAllowedUrl('https://172.32.0.1')).not.toThrow();
  });

  it('blocks 192.168.x.x private range', () => {
    expect(() => assertAllowedUrl('https://192.168.1.1')).toThrow('SSRF blocked');
    expect(() => assertAllowedUrl('https://192.168.0.0')).toThrow('SSRF blocked');
  });

  it('blocks 127.x.x.x loopback', () => {
    expect(() => assertAllowedUrl('https://127.0.0.1')).toThrow('SSRF blocked');
    expect(() => assertAllowedUrl('https://127.255.255.255')).toThrow('SSRF blocked');
  });

  it('blocks localhost', () => {
    expect(() => assertAllowedUrl('https://localhost')).toThrow('SSRF blocked');
    expect(() => assertAllowedUrl('https://localhost:8080')).toThrow('SSRF blocked');
  });

  it('blocks ::1 IPv6 loopback', () => {
    expect(() => assertAllowedUrl('https://[::1]')).toThrow('SSRF blocked');
  });

  it('blocks 169.254.x.x link-local', () => {
    expect(() => assertAllowedUrl('https://169.254.169.254')).toThrow('SSRF blocked');
  });

  it('blocks fe80:: IPv6 link-local', () => {
    // fe80 with zone ID may throw Invalid URL in some runtimes,
    // but plain fe80 addresses should be caught by the link-local check
    expect(() => assertAllowedUrl('https://[fe80::1]')).toThrow('SSRF blocked');
  });

  it('blocks 0.0.0.0', () => {
    expect(() => assertAllowedUrl('https://0.0.0.0')).toThrow('SSRF blocked');
  });

  it('throws on invalid URL', () => {
    expect(() => assertAllowedUrl('not-a-url')).toThrow();
  });
});
