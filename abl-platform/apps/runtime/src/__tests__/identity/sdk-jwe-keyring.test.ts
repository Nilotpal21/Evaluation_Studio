import { describe, expect, it } from 'vitest';
import {
  createDisabledSdkJweKeyProvider,
  createStaticSdkJweKeyProvider,
} from '../../services/identity/sdk-jwe-keyring.js';

function keyBytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

describe('sdk-jwe-keyring', () => {
  it('reports provider-disabled capability without returning keys', () => {
    const provider = createDisabledSdkJweKeyProvider();

    expect(provider.getCapability()).toEqual({
      supported: false,
      canIssueBootstrap: false,
      canIssueSession: false,
      canVerify: false,
      blockedReason: 'provider_disabled',
    });
    expect(provider.getActiveKey('sdk_session')).toBeNull();
    expect(provider.resolveKey('kid-1', 'sdk_session')).toBeNull();
    expect(provider.listSafeMetadata()).toEqual([]);
  });

  it('returns opaque active and previous key handles with safe metadata only', () => {
    const provider = createStaticSdkJweKeyProvider({
      keys: [
        {
          kid: 'active-key',
          purposes: ['sdk_bootstrap', 'sdk_session'],
          status: 'active',
          keyBytes: keyBytes(1),
        },
        {
          kid: 'previous-key',
          purposes: ['sdk_session'],
          status: 'previous',
          keyBytes: keyBytes(2),
        },
        {
          kid: 'disabled-key',
          purposes: ['sdk_session'],
          status: 'disabled',
          keyBytes: keyBytes(3),
        },
      ],
    });

    expect(provider.getCapability()).toEqual({
      supported: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      canVerify: true,
    });
    expect(provider.getActiveKey('sdk_session')).toMatchObject({
      kid: 'active-key',
      purpose: 'sdk_session',
      alg: 'dir',
    });
    expect(provider.resolveKey('previous-key', 'sdk_session')).toMatchObject({
      kid: 'previous-key',
      purpose: 'sdk_session',
    });
    expect(provider.resolveKey('disabled-key', 'sdk_session')).toBeNull();
    expect(JSON.stringify(provider.listSafeMetadata())).not.toContain('1,1,1');
    const metadata = provider.listSafeMetadata();
    expect(metadata).toEqual([
      {
        kid: 'active-key',
        purposes: ['sdk_bootstrap', 'sdk_session'],
        status: 'active',
        alg: 'dir',
      },
      {
        kid: 'previous-key',
        purposes: ['sdk_session'],
        status: 'previous',
        alg: 'dir',
      },
      {
        kid: 'disabled-key',
        purposes: ['sdk_session'],
        status: 'disabled',
        alg: 'dir',
      },
    ]);

    metadata[0]?.purposes.splice(0);
    expect(provider.getActiveKey('sdk_session')).toMatchObject({
      kid: 'active-key',
      purpose: 'sdk_session',
    });
  });

  it('can verify previous keys without using them for issuance', () => {
    const provider = createStaticSdkJweKeyProvider({
      keys: [
        {
          kid: 'previous-bootstrap',
          purposes: ['sdk_bootstrap'],
          status: 'previous',
          keyBytes: keyBytes(4),
        },
      ],
    });

    expect(provider.getCapability()).toEqual({
      supported: true,
      canIssueBootstrap: false,
      canIssueSession: false,
      canVerify: true,
      blockedReason: 'key_provider_unavailable',
    });
    expect(provider.getActiveKey('sdk_bootstrap')).toBeNull();
    expect(provider.resolveKey('previous-bootstrap', 'sdk_bootstrap')).toMatchObject({
      kid: 'previous-bootstrap',
    });
  });

  it.each([
    {
      safetyGates: { redactionVerified: false },
      blockedReason: 'redaction_unverified',
    },
    {
      safetyGates: { diagnosticsReady: false },
      blockedReason: 'diagnostics_unready',
    },
    {
      safetyGates: { sessionTransportBudgetVerified: false },
      blockedReason: 'transport_budget_unverified',
    },
  ] as const)(
    'blocks capability when prerequisite is not ready: $blockedReason',
    ({ safetyGates, blockedReason }) => {
      const provider = createStaticSdkJweKeyProvider({
        keys: [
          {
            kid: 'active-key',
            purposes: ['sdk_bootstrap', 'sdk_session'],
            status: 'active',
            keyBytes: keyBytes(5),
          },
        ],
        safetyGates,
      });

      expect(provider.getCapability()).toEqual({
        supported: false,
        canIssueBootstrap: false,
        canIssueSession: false,
        canVerify: false,
        blockedReason,
      });
    },
  );

  it('rejects duplicate kid and purpose pairs to avoid ambiguous key resolution', () => {
    expect(() =>
      createStaticSdkJweKeyProvider({
        keys: [
          {
            kid: 'duplicate',
            purposes: ['sdk_session'],
            status: 'active',
            keyBytes: keyBytes(6),
          },
          {
            kid: 'duplicate',
            purposes: ['sdk_session'],
            status: 'previous',
            keyBytes: keyBytes(7),
          },
        ],
      }),
    ).toThrow(/Duplicate SDK JWE key/);
  });
});
