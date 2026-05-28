import { describe, it, expect } from 'vitest';
import {
  CreateProjectToolSchema,
  CreateHttpToolSchema,
  validateHttpToolEndpoint,
} from '../validation/project-tool-schemas.js';

// =============================================================================
// Helpers
// =============================================================================

/** Minimal valid HTTP tool payload with SOAP fields */
function validSoapPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'soap_tool',
    toolType: 'http',
    description: 'A SOAP tool',
    endpoint: 'https://example.com/ws',
    method: 'POST',
    protocol: 'soap',
    soapVersion: '1.1',
    ...overrides,
  };
}

/** Minimal valid HTTP tool payload (REST, no SOAP fields) */
function validRestPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'rest_tool',
    toolType: 'http',
    description: 'A REST tool',
    endpoint: 'https://api.example.com/data',
    method: 'GET',
    ...overrides,
  };
}

// =============================================================================
// U-20: Valid SOAP payload passes validation
// =============================================================================

describe('CreateProjectToolSchema — SOAP validation (U-20)', () => {
  it('valid SOAP payload with all fields passes', () => {
    const payload = validSoapPayload({
      soapAction: 'urn:GetAccount',
      onSoapFault: 'data',
    });

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.protocol).toBe('soap');
      expect(result.data.soapVersion).toBe('1.1');
      expect(result.data.soapAction).toBe('urn:GetAccount');
      expect(result.data.onSoapFault).toBe('data');
    }
  });

  it('valid SOAP payload with soapVersion 1.2 passes', () => {
    const payload = validSoapPayload({ soapVersion: '1.2' });

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.soapVersion).toBe('1.2');
    }
  });

  it('valid SOAP payload without soapAction passes', () => {
    const payload = validSoapPayload();

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// U-21: FR-12 cross-field violations
// =============================================================================

describe('CreateProjectToolSchema — FR-12 cross-field validation (U-21)', () => {
  it('soapAction on REST tool fails', () => {
    const payload = validRestPayload({ soapAction: 'urn:GetAccount' });

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const soapActionIssues = result.error.issues.filter((i) => i.path.includes('soapAction'));
      expect(soapActionIssues.length).toBeGreaterThan(0);
      expect(soapActionIssues[0].message).toContain(
        'soapAction can only be set when protocol is soap',
      );
    }
  });

  it('protocol=soap without soapVersion fails', () => {
    const payload = validSoapPayload();
    // Remove soapVersion
    delete (payload as Record<string, unknown>).soapVersion;

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const versionIssues = result.error.issues.filter((i) => i.path.includes('soapVersion'));
      expect(versionIssues.length).toBeGreaterThan(0);
      expect(versionIssues[0].message).toContain('soapVersion is required when protocol is soap');
    }
  });

  it('protocol=soap WITH soapVersion passes', () => {
    const payload = validSoapPayload({ soapVersion: '1.2' });

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('protocol=soap with non-POST method fails', () => {
    const payload = validSoapPayload({ method: 'GET' });

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const methodIssues = result.error.issues.filter((i) => i.path.includes('method'));
      expect(methodIssues.length).toBeGreaterThan(0);
      expect(methodIssues[0].message).toContain('method must be POST when protocol is soap');
    }
  });
});

// =============================================================================
// U-22: Defaults applied correctly
// =============================================================================

describe('CreateProjectToolSchema — SOAP defaults (U-22)', () => {
  it('omitting protocol defaults to rest', () => {
    const payload = validRestPayload();
    // No protocol field

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.protocol).toBe('rest');
    }
  });

  it('omitting onSoapFault defaults to error', () => {
    const payload = validSoapPayload();
    // No onSoapFault

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onSoapFault).toBe('error');
    }
  });

  it('soapVersion missing on REST tool causes no error', () => {
    const payload = validRestPayload();
    // No soapVersion, no protocol

    const result = CreateProjectToolSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.soapVersion).toBeUndefined();
    }
  });

  it('invalid soapVersion value fails', () => {
    const payload = validSoapPayload({ soapVersion: '2.0' });

    const result = CreateHttpToolSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('invalid protocol value fails', () => {
    const payload = validRestPayload({ protocol: 'graphql' });

    const result = CreateHttpToolSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('validateHttpToolEndpoint — template URLs', () => {
  it('allows unresolved env placeholder URLs without a literal absolute prefix', () => {
    expect(validateHttpToolEndpoint('{{env.TOOL_BASE_URL}}/events')).toEqual({ safe: true });
  });

  it('blocks unsafe literal URL prefixes even when the path contains an env placeholder', () => {
    expect(validateHttpToolEndpoint('http://169.254.169.254/{{env.METADATA_PATH}}')).toEqual({
      safe: false,
      message: 'Endpoint blocked by SSRF protection',
    });
  });
});
