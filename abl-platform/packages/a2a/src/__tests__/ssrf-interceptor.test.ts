import { describe, it, expect } from 'vitest';
import { SsrfEndpointValidator } from '../infrastructure/ssrf-interceptor.js';

describe('SsrfEndpointValidator', () => {
  const validator = new SsrfEndpointValidator();

  it('accepts valid public HTTPS URL', () => {
    expect(() => validator.validate('https://remote-agent.example.com/a2a')).not.toThrow();
  });

  it('accepts valid public HTTP URL', () => {
    expect(() => validator.validate('http://remote-agent.example.com/a2a')).not.toThrow();
  });

  it('rejects private IP (127.0.0.1)', () => {
    expect(() => validator.validate('http://127.0.0.1/a2a')).toThrow();
  });

  it('rejects private IP (10.x)', () => {
    expect(() => validator.validate('http://10.0.0.1/a2a')).toThrow();
  });

  it('rejects metadata endpoint (169.254.169.254)', () => {
    expect(() => validator.validate('http://169.254.169.254/latest/meta-data')).toThrow();
  });

  it('allows private IP when allowPrivate is true', () => {
    expect(() => validator.validate('http://127.0.0.1/a2a', true)).not.toThrow();
  });
});
