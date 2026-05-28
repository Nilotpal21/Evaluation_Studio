import { describe, it, expect } from 'vitest';
import { serializeToolFormToDsl } from '../tools/serialize-tool-form-to-dsl.js';
import { parseDslToToolForm } from '../tools/parse-dsl-to-tool-form.js';
import type { HttpToolFormData } from '../types/project-tool-form.js';

// =============================================================================
// U-17: SOAP form → DSL emits all 4 SOAP lines
// =============================================================================

describe('serializeToolFormToDsl — SOAP protocol', () => {
  it('U-17: emits all 4 SOAP lines in correct order', () => {
    const form: HttpToolFormData = {
      name: 'get_account',
      toolType: 'http',
      description: 'Get account via SOAP',
      parameters: [
        { name: 'accountId', type: 'string', description: 'Account ID', required: true },
      ],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.2',
      soapAction: 'urn:GetAccount',
      onSoapFault: 'data',
    };

    const dsl = serializeToolFormToDsl(form);

    // All 4 SOAP lines present
    expect(dsl).toContain('  protocol: soap');
    expect(dsl).toContain('  soap_version: 1.2');
    // urn:GetAccount contains a colon, so inlineQuote wraps it in quotes
    expect(dsl).toContain('  soap_action: "urn:GetAccount"');
    expect(dsl).toContain('  on_soap_fault: data');

    // Verify ordering: protocol before soap_version before soap_action before on_soap_fault
    const lines = dsl.split('\n');
    const protocolIdx = lines.findIndex((l) => l.trim().startsWith('protocol:'));
    const versionIdx = lines.findIndex((l) => l.trim().startsWith('soap_version:'));
    const actionIdx = lines.findIndex((l) => l.trim().startsWith('soap_action:'));
    const faultIdx = lines.findIndex((l) => l.trim().startsWith('on_soap_fault:'));

    expect(protocolIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeGreaterThan(protocolIdx);
    expect(actionIdx).toBeGreaterThan(versionIdx);
    expect(faultIdx).toBeGreaterThan(actionIdx);
  });

  it('U-17: soapAction with special characters is quoted', () => {
    const form: HttpToolFormData = {
      name: 'soap_tool',
      toolType: 'http',
      description: 'SOAP tool',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.1',
      soapAction: 'http://example.com/GetAccount Action',
    };

    const dsl = serializeToolFormToDsl(form);

    // soapAction with spaces should be quoted
    expect(dsl).toContain('soap_action: "http://example.com/GetAccount Action"');
  });

  it('U-17: omitting onSoapFault does not emit on_soap_fault line (default is error)', () => {
    const form: HttpToolFormData = {
      name: 'soap_tool',
      toolType: 'http',
      description: 'SOAP tool',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.1',
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('  protocol: soap');
    expect(dsl).toContain('  soap_version: 1.1');
    expect(dsl).not.toContain('on_soap_fault');
  });

  it('U-17: onSoapFault=error does not emit on_soap_fault line', () => {
    const form: HttpToolFormData = {
      name: 'soap_tool',
      toolType: 'http',
      description: 'SOAP tool',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.1',
      onSoapFault: 'error',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).not.toContain('on_soap_fault');
  });

  // ===========================================================================
  // U-18: REST form — no protocol/soap_* lines
  // ===========================================================================

  it('U-18: REST form (no protocol field) has NO protocol/soap_* lines', () => {
    const form: HttpToolFormData = {
      name: 'rest_api',
      toolType: 'http',
      description: 'REST API call',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).not.toContain('protocol');
    expect(dsl).not.toContain('soap_version');
    expect(dsl).not.toContain('soap_action');
    expect(dsl).not.toContain('on_soap_fault');
  });

  it('U-18: REST form with explicit protocol=rest has NO protocol/soap_* lines', () => {
    const form: HttpToolFormData = {
      name: 'rest_api',
      toolType: 'http',
      description: 'REST API call',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'none',
      protocol: 'rest',
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).not.toContain('protocol');
    expect(dsl).not.toContain('soap_version');
    expect(dsl).not.toContain('soap_action');
    expect(dsl).not.toContain('on_soap_fault');
  });

  // ===========================================================================
  // U-19: Round-trip SOAP DSL → parse form → serialize → original DSL
  // ===========================================================================

  it('U-19: round-trip — SOAP DSL → parse → serialize produces byte-identical DSL', () => {
    // Note: parameters without descriptions avoid a known parseDslProperties
    // limitation where nested 'description:' keys overwrite the tool-level one.
    const form: HttpToolFormData = {
      name: 'get_account',
      toolType: 'http',
      description: 'SOAP-account',
      parameters: [{ name: 'accountId', type: 'string', description: '', required: true }],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.2',
      soapAction: 'urn:GetAccount',
      onSoapFault: 'data',
    };

    // Serialize form → DSL
    const dsl1 = serializeToolFormToDsl(form);

    // Parse DSL → form
    const parsedForm = parseDslToToolForm(dsl1, 'http');
    expect(parsedForm).not.toBeNull();

    const httpForm = parsedForm as HttpToolFormData;
    expect(httpForm.protocol).toBe('soap');
    expect(httpForm.soapVersion).toBe('1.2');
    expect(httpForm.soapAction).toBe('urn:GetAccount');
    expect(httpForm.onSoapFault).toBe('data');

    // Serialize again → DSL
    const dsl2 = serializeToolFormToDsl(httpForm);

    // Byte-identical
    expect(dsl2).toBe(dsl1);
  });

  it('U-19: round-trip — SOAP DSL with default soapVersion', () => {
    const form: HttpToolFormData = {
      name: 'soap_call',
      toolType: 'http',
      description: 'SOAP call',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://example.com/ws',
      method: 'POST',
      auth: 'none',
      protocol: 'soap',
      soapVersion: '1.1',
    };

    const dsl1 = serializeToolFormToDsl(form);
    const parsedForm = parseDslToToolForm(dsl1, 'http') as HttpToolFormData;
    expect(parsedForm.protocol).toBe('soap');
    expect(parsedForm.soapVersion).toBe('1.1');

    const dsl2 = serializeToolFormToDsl(parsedForm);
    expect(dsl2).toBe(dsl1);
  });
});
