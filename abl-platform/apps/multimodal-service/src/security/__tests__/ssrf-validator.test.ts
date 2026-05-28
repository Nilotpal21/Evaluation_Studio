import { describe, it, expect } from 'vitest';
import { validateAttachmentUrl } from '../ssrf-validator.js';

describe('SSRF Validator', () => {
  it('allows public URLs', () => {
    expect(validateAttachmentUrl('https://example.com/image.png').safe).toBe(true);
  });

  it('allows public HTTP URLs', () => {
    expect(validateAttachmentUrl('http://cdn.example.com/media/photo.jpg').safe).toBe(true);
  });

  it('blocks private IP ranges', () => {
    expect(validateAttachmentUrl('http://10.0.0.1/secret').safe).toBe(false);
    expect(validateAttachmentUrl('http://172.16.0.1/secret').safe).toBe(false);
    expect(validateAttachmentUrl('http://192.168.1.1/secret').safe).toBe(false);
  });

  it('returns reason when blocking private IPs', () => {
    const result = validateAttachmentUrl('http://10.0.0.1/secret');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('blocks link-local (AWS metadata)', () => {
    expect(validateAttachmentUrl('http://169.254.169.254/latest/meta-data/').safe).toBe(false);
  });

  it('blocks loopback', () => {
    expect(validateAttachmentUrl('http://127.0.0.1/').safe).toBe(false);
    expect(validateAttachmentUrl('http://localhost/').safe).toBe(false);
  });

  it('blocks non-http schemes', () => {
    expect(validateAttachmentUrl('file:///etc/passwd').safe).toBe(false);
    expect(validateAttachmentUrl('ftp://evil.com/payload').safe).toBe(false);
  });

  it('returns reason for non-http schemes', () => {
    const result = validateAttachmentUrl('file:///etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('scheme');
  });

  it('blocks unparseable URLs', () => {
    expect(validateAttachmentUrl('not a url').safe).toBe(false);
    expect(validateAttachmentUrl('').safe).toBe(false);
  });

  it('returns reason for unparseable URLs', () => {
    const result = validateAttachmentUrl('not a url');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('blocks data: URIs', () => {
    expect(validateAttachmentUrl('data:text/html,<script>alert(1)</script>').safe).toBe(false);
  });

  it('blocks javascript: URIs', () => {
    expect(validateAttachmentUrl('javascript:alert(1)').safe).toBe(false);
  });

  it('no reason when URL is safe', () => {
    const result = validateAttachmentUrl('https://example.com/image.png');
    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('blocks ws: and wss: schemes (stricter than shared utility)', () => {
    expect(validateAttachmentUrl('ws://example.com/socket').safe).toBe(false);
    expect(validateAttachmentUrl('wss://example.com/socket').safe).toBe(false);
  });
});
