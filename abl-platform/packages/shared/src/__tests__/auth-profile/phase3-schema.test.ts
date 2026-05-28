import { describe, it, expect } from 'vitest';
import {
  DigestConfigSchema,
  DigestSecretsSchema,
  KerberosConfigSchema,
  KerberosSecretsSchema,
  SamlConfigSchema,
  SamlSecretsSchema,
  HawkConfigSchema,
  HawkSecretsSchema,
  WsSecurityConfigSchema,
  WsSecuritySecretsSchema,
} from '../../validation/auth-profile-phase3.schema.js';
import { CreateAuthProfileSchema } from '../../validation/auth-profile.schema.js';

// ── Helper for building a valid CreateAuthProfile payload ───────────────
const baseFields = {
  name: 'test-profile',
  scope: 'tenant' as const,
  projectId: null,
  visibility: 'shared' as const,
};

// ── digest ────────────────────────────────────────────────────────────

describe('DigestConfigSchema', () => {
  it('accepts valid input with realm', () => {
    expect(DigestConfigSchema.safeParse({ realm: 'example.com' }).success).toBe(true);
  });

  it('rejects missing realm', () => {
    expect(DigestConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty realm', () => {
    expect(DigestConfigSchema.safeParse({ realm: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(DigestConfigSchema.safeParse({ realm: 'r', extra: true }).success).toBe(false);
  });
});

describe('DigestSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(DigestSecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(DigestSecretsSchema.safeParse({}).success).toBe(false);
    expect(DigestSecretsSchema.safeParse({ username: 'u' }).success).toBe(false);
    expect(DigestSecretsSchema.safeParse({ password: 'p' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      DigestSecretsSchema.safeParse({ username: 'u', password: 'p', extra: true }).success,
    ).toBe(false);
  });
});

// ── kerberos ──────────────────────────────────────────────────────────

describe('KerberosConfigSchema', () => {
  it('accepts valid input', () => {
    expect(
      KerberosConfigSchema.safeParse({
        realm: 'EXAMPLE.COM',
        kdc: 'kdc.example.com',
        servicePrincipal: 'HTTP/api.example.com',
      }).success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(KerberosConfigSchema.safeParse({}).success).toBe(false);
    expect(KerberosConfigSchema.safeParse({ realm: 'R' }).success).toBe(false);
    expect(KerberosConfigSchema.safeParse({ realm: 'R', kdc: 'kdc' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      KerberosConfigSchema.safeParse({
        realm: 'R',
        kdc: 'kdc',
        servicePrincipal: 'sp',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('KerberosSecretsSchema', () => {
  it('accepts with password', () => {
    expect(
      KerberosSecretsSchema.safeParse({ principal: 'user@EXAMPLE.COM', password: 'pass' }).success,
    ).toBe(true);
  });

  it('accepts with keytab', () => {
    expect(
      KerberosSecretsSchema.safeParse({ principal: 'user@EXAMPLE.COM', keytab: '/path/to/keytab' })
        .success,
    ).toBe(true);
  });

  it('accepts with both password and keytab', () => {
    expect(
      KerberosSecretsSchema.safeParse({
        principal: 'user@EXAMPLE.COM',
        password: 'pass',
        keytab: '/path',
      }).success,
    ).toBe(true);
  });

  it('rejects with neither password nor keytab', () => {
    expect(KerberosSecretsSchema.safeParse({ principal: 'user@EXAMPLE.COM' }).success).toBe(false);
  });

  it('rejects missing principal', () => {
    expect(KerberosSecretsSchema.safeParse({ password: 'pass' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      KerberosSecretsSchema.safeParse({
        principal: 'u',
        password: 'p',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ── saml ──────────────────────────────────────────────────────────────

describe('SamlConfigSchema', () => {
  it('accepts valid input', () => {
    expect(
      SamlConfigSchema.safeParse({
        idpMetadataUrl: 'https://idp.example.com/metadata',
        entityId: 'urn:example:sp',
        assertionConsumerServiceUrl: 'https://sp.example.com/acs',
      }).success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(SamlConfigSchema.safeParse({}).success).toBe(false);
    expect(
      SamlConfigSchema.safeParse({ idpMetadataUrl: 'https://idp.example.com/metadata' }).success,
    ).toBe(false);
  });

  it('rejects invalid URL for idpMetadataUrl', () => {
    expect(
      SamlConfigSchema.safeParse({
        idpMetadataUrl: 'not-a-url',
        entityId: 'eid',
        assertionConsumerServiceUrl: 'https://sp.example.com/acs',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid URL for assertionConsumerServiceUrl', () => {
    expect(
      SamlConfigSchema.safeParse({
        idpMetadataUrl: 'https://idp.example.com/metadata',
        entityId: 'eid',
        assertionConsumerServiceUrl: 'not-a-url',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      SamlConfigSchema.safeParse({
        idpMetadataUrl: 'https://idp.example.com/metadata',
        entityId: 'eid',
        assertionConsumerServiceUrl: 'https://sp.example.com/acs',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('SamlSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(SamlSecretsSchema.safeParse({ privateKey: 'pk', certificate: 'cert' }).success).toBe(
      true,
    );
  });

  it('rejects missing required fields', () => {
    expect(SamlSecretsSchema.safeParse({}).success).toBe(false);
    expect(SamlSecretsSchema.safeParse({ privateKey: 'pk' }).success).toBe(false);
    expect(SamlSecretsSchema.safeParse({ certificate: 'cert' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      SamlSecretsSchema.safeParse({ privateKey: 'pk', certificate: 'cert', extra: true }).success,
    ).toBe(false);
  });
});

// ── hawk ──────────────────────────────────────────────────────────────

describe('HawkConfigSchema', () => {
  it('accepts sha256', () => {
    expect(HawkConfigSchema.safeParse({ algorithm: 'sha256' }).success).toBe(true);
  });

  it('accepts sha1', () => {
    expect(HawkConfigSchema.safeParse({ algorithm: 'sha1' }).success).toBe(true);
  });

  it('rejects invalid algorithm', () => {
    expect(HawkConfigSchema.safeParse({ algorithm: 'md5' }).success).toBe(false);
  });

  it('rejects missing algorithm', () => {
    expect(HawkConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(HawkConfigSchema.safeParse({ algorithm: 'sha256', extra: true }).success).toBe(false);
  });
});

describe('HawkSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(HawkSecretsSchema.safeParse({ id: 'hawk-id', key: 'hawk-key' }).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(HawkSecretsSchema.safeParse({}).success).toBe(false);
    expect(HawkSecretsSchema.safeParse({ id: 'id' }).success).toBe(false);
    expect(HawkSecretsSchema.safeParse({ key: 'key' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(HawkSecretsSchema.safeParse({ id: 'id', key: 'key', extra: true }).success).toBe(false);
  });
});

// ── ws_security ───────────────────────────────────────────────────────

describe('WsSecurityConfigSchema', () => {
  it('accepts mustUnderstand true', () => {
    expect(WsSecurityConfigSchema.safeParse({ mustUnderstand: true }).success).toBe(true);
  });

  it('accepts mustUnderstand false', () => {
    expect(WsSecurityConfigSchema.safeParse({ mustUnderstand: false }).success).toBe(true);
  });

  it('rejects missing mustUnderstand', () => {
    expect(WsSecurityConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-boolean mustUnderstand', () => {
    expect(WsSecurityConfigSchema.safeParse({ mustUnderstand: 'yes' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(WsSecurityConfigSchema.safeParse({ mustUnderstand: true, extra: true }).success).toBe(
      false,
    );
  });
});

describe('WsSecuritySecretsSchema', () => {
  it('accepts valid input without certificate', () => {
    expect(WsSecuritySecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });

  it('accepts valid input with certificate', () => {
    expect(
      WsSecuritySecretsSchema.safeParse({ username: 'u', password: 'p', certificate: 'cert' })
        .success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(WsSecuritySecretsSchema.safeParse({}).success).toBe(false);
    expect(WsSecuritySecretsSchema.safeParse({ username: 'u' }).success).toBe(false);
    expect(WsSecuritySecretsSchema.safeParse({ password: 'p' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      WsSecuritySecretsSchema.safeParse({ username: 'u', password: 'p', extra: true }).success,
    ).toBe(false);
  });
});

// ── CreateAuthProfileSchema — Phase 3 discriminated union branches ────

describe('CreateAuthProfileSchema — Phase 3 types', () => {
  describe('digest', () => {
    it('accepts valid digest profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'digest',
        config: { realm: 'example.com' },
        secrets: { username: 'user', password: 'pass' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects digest profile with missing realm', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'digest',
        config: {},
        secrets: { username: 'user', password: 'pass' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('kerberos', () => {
    it('accepts valid kerberos profile with password', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'kerberos',
        config: { realm: 'EXAMPLE.COM', kdc: 'kdc.example.com', servicePrincipal: 'HTTP/api' },
        secrets: { principal: 'user@EXAMPLE.COM', password: 'pass' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid kerberos profile with keytab', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'kerberos',
        config: { realm: 'EXAMPLE.COM', kdc: 'kdc.example.com', servicePrincipal: 'HTTP/api' },
        secrets: { principal: 'user@EXAMPLE.COM', keytab: '/path/to/keytab' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects kerberos profile without password or keytab', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'kerberos',
        config: { realm: 'EXAMPLE.COM', kdc: 'kdc.example.com', servicePrincipal: 'HTTP/api' },
        secrets: { principal: 'user@EXAMPLE.COM' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('saml', () => {
    it('accepts valid saml profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'saml',
        config: {
          idpMetadataUrl: 'https://idp.example.com/metadata',
          entityId: 'urn:example:sp',
          assertionConsumerServiceUrl: 'https://sp.example.com/acs',
        },
        secrets: { privateKey: 'pk', certificate: 'cert' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects saml profile with invalid IDP URL', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'saml',
        config: {
          idpMetadataUrl: 'not-a-url',
          entityId: 'eid',
          assertionConsumerServiceUrl: 'https://sp.example.com/acs',
        },
        secrets: { privateKey: 'pk', certificate: 'cert' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('hawk', () => {
    it('accepts valid hawk profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'hawk',
        config: { algorithm: 'sha256' },
        secrets: { id: 'hid', key: 'hkey' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects hawk profile with invalid algorithm', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'hawk',
        config: { algorithm: 'md5' },
        secrets: { id: 'hid', key: 'hkey' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ws_security', () => {
    it('accepts valid ws_security profile without certificate', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'ws_security',
        config: { mustUnderstand: true },
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid ws_security profile with certificate', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'ws_security',
        config: { mustUnderstand: false },
        secrets: { username: 'u', password: 'p', certificate: 'cert-data' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects ws_security profile with missing mustUnderstand', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'ws_security',
        config: {},
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('cross-field refinements still work', () => {
    it('rejects tenant-scoped profile with non-null projectId', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        projectId: 'some-project',
        authType: 'digest',
        config: { realm: 'r' },
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects project-scoped profile with null projectId', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        scope: 'project',
        projectId: null,
        authType: 'hawk',
        config: { algorithm: 'sha256' },
        secrets: { id: 'hid', key: 'hkey' },
      });
      expect(result.success).toBe(false);
    });
  });
});
