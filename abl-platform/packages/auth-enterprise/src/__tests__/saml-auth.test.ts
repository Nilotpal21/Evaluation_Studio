import { describe, it, expect } from 'vitest';
import { applySamlAuth } from '../saml-auth.js';

describe('applySamlAuth', () => {
  const config = {
    idpMetadataUrl: 'https://idp.example.com/metadata',
    entityId: 'urn:example:sp',
    assertionConsumerServiceUrl: 'https://sp.example.com/acs',
  };
  const secrets = {
    privateKey: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhki...\n-----END PRIVATE KEY-----',
    certificate: '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW+gAwIB...\n-----END CERTIFICATE-----',
  };

  it('returns a samlAssertion string (stub when @node-saml not installed)', async () => {
    const result = await applySamlAuth(config, secrets);
    expect(result).toHaveProperty('samlAssertion');
    expect(typeof result.samlAssertion).toBe('string');
    expect(result.samlAssertion.length).toBeGreaterThan(0);
  });

  it('stub assertion contains entity and IDP info', async () => {
    const result = await applySamlAuth(config, secrets);

    // The stub is a base64-encoded JSON
    const decoded = JSON.parse(Buffer.from(result.samlAssertion, 'base64').toString('utf-8'));
    expect(decoded.type).toBe('saml-stub');
    expect(decoded.entityId).toBe('urn:example:sp');
    expect(decoded.idpMetadataUrl).toBe('https://idp.example.com/metadata');
    expect(decoded.assertionConsumerServiceUrl).toBe('https://sp.example.com/acs');
  });
});
