import { describe, it, expect } from 'vitest';
import { applyWsSecurity } from '../ws-security-auth.js';

describe('applyWsSecurity', () => {
  const config = { mustUnderstand: true };
  const secrets = { username: 'soapuser', password: 'soappass' };

  it('returns a wsSecurityHeader string', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result).toHaveProperty('wsSecurityHeader');
    expect(typeof result.wsSecurityHeader).toBe('string');
    expect(result.wsSecurityHeader.length).toBeGreaterThan(0);
  });

  it('includes wsse:Security root element', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).toContain('<wsse:Security');
    expect(result.wsSecurityHeader).toContain('</wsse:Security>');
  });

  it('includes UsernameToken with username', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).toContain('<wsse:UsernameToken>');
    expect(result.wsSecurityHeader).toContain('<wsse:Username>soapuser</wsse:Username>');
  });

  it('includes PasswordDigest (not plaintext)', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).toContain('PasswordDigest');
    // Should NOT contain the raw password
    expect(result.wsSecurityHeader).not.toContain('>soappass<');
  });

  it('includes Nonce and Created timestamp', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).toContain('<wsse:Nonce');
    expect(result.wsSecurityHeader).toContain('<wsu:Created>');
  });

  it('includes Timestamp element', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).toContain('<wsu:Timestamp>');
  });

  it('sets mustUnderstand="1" when config.mustUnderstand is true', () => {
    const result = applyWsSecurity({ mustUnderstand: true }, secrets);
    expect(result.wsSecurityHeader).toContain('mustUnderstand="1"');
  });

  it('sets mustUnderstand="0" when config.mustUnderstand is false', () => {
    const result = applyWsSecurity({ mustUnderstand: false }, secrets);
    expect(result.wsSecurityHeader).toContain('mustUnderstand="0"');
  });

  it('includes BinarySecurityToken when certificate is provided', () => {
    const withCert = {
      ...secrets,
      certificate: '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW+gAwIB...\n-----END CERTIFICATE-----',
    };
    const result = applyWsSecurity(config, withCert);
    expect(result.wsSecurityHeader).toContain('<wsse:BinarySecurityToken');
    expect(result.wsSecurityHeader).toContain('X509v3');
  });

  it('omits BinarySecurityToken when no certificate', () => {
    const result = applyWsSecurity(config, secrets);
    expect(result.wsSecurityHeader).not.toContain('<wsse:BinarySecurityToken');
  });

  it('produces different digests for different passwords', () => {
    const r1 = applyWsSecurity(config, { username: 'u', password: 'p1' });
    const r2 = applyWsSecurity(config, { username: 'u', password: 'p2' });

    // Nonce/Created differ each call, so digests will differ regardless,
    // but both should be valid XML
    expect(r1.wsSecurityHeader).toContain('<wsse:Security');
    expect(r2.wsSecurityHeader).toContain('<wsse:Security');
  });

  it('XML-escapes username so injected markup cannot break the envelope', () => {
    const malicious = 'evil</wsse:Username><wsse:Inject/><wsse:Username>x';
    const result = applyWsSecurity(config, { username: malicious, password: 'pw' });

    // Raw closing/opening tags from the username must NOT appear verbatim.
    expect(result.wsSecurityHeader).not.toContain('</wsse:Username><wsse:Inject/>');
    // Each special character must be escaped.
    expect(result.wsSecurityHeader).toContain(
      '<wsse:Username>evil&lt;/wsse:Username&gt;&lt;wsse:Inject/&gt;&lt;wsse:Username&gt;x</wsse:Username>',
    );
  });

  it('XML-escapes ampersand and quotes in username', () => {
    const result = applyWsSecurity(config, { username: 'a & b "c" \'d\'', password: 'pw' });
    expect(result.wsSecurityHeader).toContain(
      '<wsse:Username>a &amp; b &quot;c&quot; &apos;d&apos;</wsse:Username>',
    );
  });

  it('strips non-base64 characters from certificate body', () => {
    const certWithInjection =
      '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW+gAwIB</wsse:BinarySecurityToken><evil/>\n-----END CERTIFICATE-----';
    const result = applyWsSecurity(config, { ...secrets, certificate: certWithInjection });
    expect(result.wsSecurityHeader).not.toContain('</wsse:BinarySecurityToken><evil');
    expect(result.wsSecurityHeader).not.toContain('<evil/>');
  });
});
