import { describe, it, expect } from 'vitest';
import { applyKerberosAuth } from '../kerberos-auth.js';

describe('applyKerberosAuth', () => {
  const config = {
    realm: 'EXAMPLE.COM',
    kdc: 'kdc.example.com',
    servicePrincipal: 'HTTP/api.example.com',
  };
  const secrets = {
    principal: 'user@EXAMPLE.COM',
    password: 'kerb-password',
  };

  it('returns a kerberosTicket string (stub when kerberos not installed)', async () => {
    const result = await applyKerberosAuth(config, secrets);
    expect(result).toHaveProperty('kerberosTicket');
    expect(typeof result.kerberosTicket).toBe('string');
    expect(result.kerberosTicket.length).toBeGreaterThan(0);
  });

  it('stub ticket contains principal and service info', async () => {
    const result = await applyKerberosAuth(config, secrets);

    // The stub is a base64-encoded JSON
    const decoded = JSON.parse(Buffer.from(result.kerberosTicket, 'base64').toString('utf-8'));
    expect(decoded.type).toBe('kerberos-stub');
    expect(decoded.principal).toBe('user@EXAMPLE.COM');
    expect(decoded.servicePrincipal).toBe('HTTP/api.example.com');
    expect(decoded.realm).toBe('EXAMPLE.COM');
    expect(decoded.kdc).toBe('kdc.example.com');
  });

  it('works with keytab instead of password', async () => {
    const keytabSecrets = {
      principal: 'svc@EXAMPLE.COM',
      keytab: '/etc/krb5.keytab',
    };
    const result = await applyKerberosAuth(config, keytabSecrets);
    expect(result.kerberosTicket.length).toBeGreaterThan(0);
  });
});
