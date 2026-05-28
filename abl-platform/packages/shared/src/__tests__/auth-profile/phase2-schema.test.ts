import { describe, it, expect } from 'vitest';
import {
  BasicConfigSchema,
  BasicSecretsSchema,
  CustomHeaderConfigSchema,
  CustomHeaderSecretsSchema,
  CustomHeaderCrossFieldValidator,
  AwsIamConfigSchema,
  AwsIamSecretsSchema,
  AzureAdConfigSchema,
  AzureAdSecretsSchema,
  MtlsConfigSchema,
  MtlsSecretsSchema,
  SshKeyConfigSchema,
  SshKeySecretsSchema,
} from '../../validation/auth-profile-phase2.schema.js';
import { CreateAuthProfileSchema } from '../../validation/auth-profile.schema.js';

// ── Helper for building a valid CreateAuthProfile payload ───────────────
const baseFields = {
  name: 'test-profile',
  scope: 'tenant' as const,
  projectId: null,
  visibility: 'shared' as const,
};

// ── basic ──────────────────────────────────────────────────────────────

describe('BasicConfigSchema', () => {
  it('accepts empty object', () => {
    expect(BasicConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(BasicConfigSchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe('BasicSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(BasicSecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(BasicSecretsSchema.safeParse({}).success).toBe(false);
    expect(BasicSecretsSchema.safeParse({ username: 'u' }).success).toBe(false);
    expect(BasicSecretsSchema.safeParse({ password: 'p' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      BasicSecretsSchema.safeParse({ username: 'u', password: 'p', extra: true }).success,
    ).toBe(false);
  });
});

// ── custom_header ──────────────────────────────────────────────────────

describe('CustomHeaderConfigSchema', () => {
  it('accepts valid input with at least one header', () => {
    expect(
      CustomHeaderConfigSchema.safeParse({ headers: { 'X-Api-Key': 'key-name' } }).success,
    ).toBe(true);
  });

  it('rejects missing headers field', () => {
    expect(CustomHeaderConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty headers object', () => {
    expect(CustomHeaderConfigSchema.safeParse({ headers: {} }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(CustomHeaderConfigSchema.safeParse({ headers: { h: 'v' }, extra: true }).success).toBe(
      false,
    );
  });
});

describe('CustomHeaderSecretsSchema', () => {
  it('accepts valid input with at least one entry', () => {
    expect(
      CustomHeaderSecretsSchema.safeParse({ headerValues: { 'X-Api-Key': 'secret-value' } })
        .success,
    ).toBe(true);
  });

  it('rejects missing headerValues field', () => {
    expect(CustomHeaderSecretsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty headerValues object', () => {
    expect(CustomHeaderSecretsSchema.safeParse({ headerValues: {} }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      CustomHeaderSecretsSchema.safeParse({ headerValues: { h: 'v' }, extra: true }).success,
    ).toBe(false);
  });
});

describe('CustomHeaderCrossFieldValidator', () => {
  it('returns valid when keys match', () => {
    const result = CustomHeaderCrossFieldValidator(
      { headers: { 'X-Api-Key': 'key-name', Authorization: 'auth' } },
      { headerValues: { 'X-Api-Key': 'secret1', Authorization: 'secret2' } },
    );
    expect(result.valid).toBe(true);
  });

  it('returns missing when config has keys absent from secrets', () => {
    const result = CustomHeaderCrossFieldValidator(
      { headers: { 'X-Api-Key': 'key-name', 'X-Custom': 'custom' } },
      { headerValues: { 'X-Api-Key': 'secret1' } },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.missing).toContain('X-Custom');
    }
  });

  it('returns extra when secrets has keys absent from config', () => {
    const result = CustomHeaderCrossFieldValidator(
      { headers: { 'X-Api-Key': 'key-name' } },
      { headerValues: { 'X-Api-Key': 'secret1', 'X-Extra': 'extra' } },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.extra).toContain('X-Extra');
    }
  });
});

// ── aws_iam ────────────────────────────────────────────────────────────

describe('AwsIamConfigSchema', () => {
  it('accepts valid input with required region and service', () => {
    expect(
      AwsIamConfigSchema.safeParse({ region: 'us-east-1', service: 'execute-api' }).success,
    ).toBe(true);
  });

  it('rejects unknown role/external fields', () => {
    expect(
      AwsIamConfigSchema.safeParse({
        region: 'us-east-1',
        service: 's3',
        roleArn: 'arn:aws:iam::123456:role/my-role',
      }).success,
    ).toBe(false);
  });

  it('rejects missing required service even when region is provided', () => {
    expect(AwsIamConfigSchema.safeParse({ region: 'us-east-1' }).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(AwsIamConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AwsIamConfigSchema.safeParse({ region: 'us-east-1', service: 'execute-api', extra: true })
        .success,
    ).toBe(false);
  });
});

describe('AwsIamSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(
      AwsIamSecretsSchema.safeParse({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }).success,
    ).toBe(true);
  });

  it('accepts optional sessionToken', () => {
    expect(
      AwsIamSecretsSchema.safeParse({
        accessKeyId: 'AKIA...',
        secretAccessKey: 'wJal...',
        sessionToken: 'FwoG...',
      }).success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(AwsIamSecretsSchema.safeParse({}).success).toBe(false);
    expect(AwsIamSecretsSchema.safeParse({ accessKeyId: 'AKIA...' }).success).toBe(false);
    expect(AwsIamSecretsSchema.safeParse({ secretAccessKey: 'wJal...' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AwsIamSecretsSchema.safeParse({
        accessKeyId: 'AKIA...',
        secretAccessKey: 'wJal...',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ── azure_ad ───────────────────────────────────────────────────────────

describe('AzureAdConfigSchema', () => {
  it('accepts valid input with tenantId and resource', () => {
    expect(
      AzureAdConfigSchema.safeParse({
        tenantId: 'my-azure-tenant',
        resource: 'https://graph.microsoft.com',
      }).success,
    ).toBe(true);
  });

  it('defaults endpoint to login.microsoftonline.com', () => {
    const result = AzureAdConfigSchema.safeParse({
      tenantId: 'my-azure-tenant',
      resource: 'https://graph.microsoft.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoint).toBe('https://login.microsoftonline.com');
    }
  });

  it('rejects missing required fields', () => {
    expect(AzureAdConfigSchema.safeParse({}).success).toBe(false);
    expect(AzureAdConfigSchema.safeParse({ tenantId: 'tid' }).success).toBe(false);
    expect(AzureAdConfigSchema.safeParse({ resource: 'https://graph.microsoft.com' }).success).toBe(
      false,
    );
  });

  it('rejects invalid resource URL', () => {
    expect(AzureAdConfigSchema.safeParse({ tenantId: 'tid', resource: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AzureAdConfigSchema.safeParse({
        tenantId: 'tid',
        resource: 'https://graph.microsoft.com',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('AzureAdSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(
      AzureAdSecretsSchema.safeParse({ clientId: 'app-id', clientSecret: 'secret-value' }).success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(AzureAdSecretsSchema.safeParse({}).success).toBe(false);
    expect(AzureAdSecretsSchema.safeParse({ clientId: 'id' }).success).toBe(false);
    expect(AzureAdSecretsSchema.safeParse({ clientSecret: 'sec' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AzureAdSecretsSchema.safeParse({ clientId: 'id', clientSecret: 'sec', extra: true }).success,
    ).toBe(false);
  });
});

// ── mtls ───────────────────────────────────────────────────────────────

describe('MtlsConfigSchema', () => {
  it('accepts empty object', () => {
    expect(MtlsConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(MtlsConfigSchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe('MtlsSecretsSchema', () => {
  it('accepts valid input', () => {
    expect(
      MtlsSecretsSchema.safeParse({
        clientCert: '-----BEGIN CERTIFICATE-----\n...',
        clientKey: '-----BEGIN PRIVATE KEY-----\n...',
      }).success,
    ).toBe(true);
  });

  it('accepts optional caCert', () => {
    expect(
      MtlsSecretsSchema.safeParse({ clientCert: 'cert', clientKey: 'key', caCert: 'ca-cert' })
        .success,
    ).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(MtlsSecretsSchema.safeParse({}).success).toBe(false);
    expect(MtlsSecretsSchema.safeParse({ clientCert: 'cert' }).success).toBe(false);
    expect(MtlsSecretsSchema.safeParse({ clientKey: 'key' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      MtlsSecretsSchema.safeParse({ clientCert: 'cert', clientKey: 'key', extra: true }).success,
    ).toBe(false);
  });
});

// ── ssh_key ────────────────────────────────────────────────────────────

describe('SshKeyConfigSchema', () => {
  it('defaults keyType to rsa', () => {
    const result = SshKeyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyType).toBe('rsa');
    }
  });

  it('accepts ed25519', () => {
    expect(SshKeyConfigSchema.safeParse({ keyType: 'ed25519' }).success).toBe(true);
  });

  it('rejects invalid keyType', () => {
    expect(SshKeyConfigSchema.safeParse({ keyType: 'dsa' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(SshKeyConfigSchema.safeParse({ keyType: 'rsa', extra: true }).success).toBe(false);
  });
});

describe('SshKeySecretsSchema', () => {
  it('accepts valid input', () => {
    expect(
      SshKeySecretsSchema.safeParse({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...' })
        .success,
    ).toBe(true);
  });

  it('accepts optional passphrase', () => {
    expect(SshKeySecretsSchema.safeParse({ privateKey: 'key', passphrase: 'pass' }).success).toBe(
      true,
    );
  });

  it('rejects missing required fields', () => {
    expect(SshKeySecretsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(SshKeySecretsSchema.safeParse({ privateKey: 'key', extra: true }).success).toBe(false);
  });
});

// ── CreateAuthProfileSchema — Phase 2 discriminated union branches ────

describe('CreateAuthProfileSchema — Phase 2 types', () => {
  describe('basic', () => {
    it('accepts valid basic profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'basic',
        config: {},
        secrets: { username: 'user', password: 'pass' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects basic profile with missing secrets', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'basic',
        config: {},
        secrets: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe('custom_header', () => {
    it('accepts valid custom_header profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'custom_header',
        config: { headers: { 'X-Key': 'key-name' } },
        secrets: { headerValues: { 'X-Key': 'secret' } },
      });
      expect(result.success).toBe(true);
    });

    it('rejects custom_header profile with empty headers', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'custom_header',
        config: { headers: {} },
        secrets: { headerValues: { 'X-Key': 'secret' } },
      });
      expect(result.success).toBe(false);
    });

    it('rejects custom_header profile when config and secret header keys diverge', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'custom_header',
        config: { headers: { 'X-Key': 'key-name', Authorization: 'auth-header' } },
        secrets: { headerValues: { 'X-Key': 'secret' } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('aws_iam', () => {
    it('accepts valid aws_iam profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'aws_iam',
        config: { region: 'us-east-1', service: 'execute-api' },
        secrets: { accessKeyId: 'AKIA...', secretAccessKey: 'wJal...' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects aws_iam profile with missing region', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'aws_iam',
        config: {},
        secrets: { accessKeyId: 'AKIA...', secretAccessKey: 'wJal...' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('azure_ad', () => {
    it('accepts valid azure_ad profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'azure_ad',
        config: { tenantId: 'tid', resource: 'https://graph.microsoft.com' },
        secrets: { clientId: 'cid', clientSecret: 'csec' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects azure_ad profile with missing tenantId', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'azure_ad',
        config: { resource: 'https://graph.microsoft.com' },
        secrets: { clientId: 'cid', clientSecret: 'csec' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('mtls', () => {
    it('accepts valid mtls profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'mtls',
        config: {},
        secrets: { clientCert: 'cert', clientKey: 'key' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects mtls profile with missing clientKey', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'mtls',
        config: {},
        secrets: { clientCert: 'cert' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ssh_key', () => {
    it('accepts valid ssh_key profile', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'ssh_key',
        config: {},
        secrets: { privateKey: 'key' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects ssh_key profile with missing privateKey', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        authType: 'ssh_key',
        config: {},
        secrets: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe('cross-field refinements', () => {
    it('rejects tenant-scoped profile with non-null projectId', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        projectId: 'some-project',
        authType: 'basic',
        config: {},
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects project-scoped profile with null projectId', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        scope: 'project',
        projectId: null,
        authType: 'basic',
        config: {},
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects tenant-scoped profile with personal visibility', () => {
      const result = CreateAuthProfileSchema.safeParse({
        ...baseFields,
        visibility: 'personal',
        authType: 'basic',
        config: {},
        secrets: { username: 'u', password: 'p' },
      });
      expect(result.success).toBe(false);
    });
  });
});
