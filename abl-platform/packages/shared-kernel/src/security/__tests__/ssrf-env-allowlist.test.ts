/**
 * Operator-controlled SSRF allowlist regression coverage.
 *
 * SSRF protection is a hard deny-list — but operators occasionally need to
 * allow specific dev/internal hostnames whose DNS records resolve to
 * RFC1918 addresses (e.g. cluster-internal services in agents-dev). The
 * SSRF_ALLOWED_HOSTNAMES env var carries that allowlist into safeFetch so
 * the per-IP private-range check is skipped for those hostnames only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateUrlForSafeFetch, getEnvSSRFAllowedHosts } from '../safe-fetch.js';
import type { SafeFetchDnsLookup } from '../safe-fetch.js';

const originalEnv = process.env.SSRF_ALLOWED_HOSTNAMES;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.SSRF_ALLOWED_HOSTNAMES;
  } else {
    process.env.SSRF_ALLOWED_HOSTNAMES = originalEnv;
  }
});

const fakeLookupTo: (address: string, family?: 4 | 6) => SafeFetchDnsLookup =
  (address, family = 4) =>
  async () => [{ address, family }];

describe('getEnvSSRFAllowedHosts', () => {
  it('parses comma-separated hostnames and lowercases them', () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'Dev.Internal,Other.Local , trailing-space ';
    expect(getEnvSSRFAllowedHosts()).toEqual(['dev.internal', 'other.local', 'trailing-space']);
  });

  it('returns an empty list when the env var is not set', () => {
    delete process.env.SSRF_ALLOWED_HOSTNAMES;
    expect(getEnvSSRFAllowedHosts()).toEqual([]);
  });
});

describe('validateUrlForSafeFetch with operator allowlist', () => {
  beforeEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTNAMES;
  });

  it('blocks a hostname that resolves to a private IP by default', async () => {
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('10.0.0.5'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('allows a hostname listed in SSRF_ALLOWED_HOSTNAMES even if it resolves privately', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    const result = await validateUrlForSafeFetch('http://internal.dev.svc/', {
      dnsLookup: fakeLookupTo('10.0.0.5'),
    });
    expect(result.address).toBe('10.0.0.5');
    expect(result.hostname).toBe('internal.dev.svc');
  });

  it('still blocks a hostname not on the allowlist when others are listed', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'permitted.dev';
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('10.0.0.5'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('still blocks loopback when the allowlist does not cover it', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'permitted.dev';
    await expect(
      validateUrlForSafeFetch('http://localhost.local/', {
        dnsLookup: fakeLookupTo('127.0.0.1'),
      }),
    ).rejects.toThrow();
  });

  // ── Defence: an allowlisted hostname must NOT bypass metadata / loopback ──
  // The allowlist is a private-range relaxation only — it must never let an
  // attacker-controlled (or hijacked) DNS record point at cloud metadata or
  // 127.x and have the request go through.

  it('blocks an allowlisted hostname that resolves to AWS/GCP IMDS (169.254.169.254)', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('169.254.169.254'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('blocks an allowlisted hostname that resolves to Azure IMDS (169.254.169.253)', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('169.254.169.253'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('blocks an allowlisted hostname that resolves to loopback', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('127.0.0.1'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('blocks an allowlisted hostname that resolves to Alibaba metadata (100.100.100.200)', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    await expect(
      validateUrlForSafeFetch('http://internal.dev.svc/', {
        dnsLookup: fakeLookupTo('100.100.100.200'),
      }),
    ).rejects.toThrow(/private or metadata/i);
  });

  it('still permits a 172.16.x RFC1918 address for an allowlisted hostname', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    const result = await validateUrlForSafeFetch('http://internal.dev.svc/', {
      dnsLookup: fakeLookupTo('172.16.5.10'),
    });
    expect(result.address).toBe('172.16.5.10');
  });

  it('still permits a 192.168.x RFC1918 address for an allowlisted hostname', async () => {
    process.env.SSRF_ALLOWED_HOSTNAMES = 'internal.dev.svc';
    const result = await validateUrlForSafeFetch('http://internal.dev.svc/', {
      dnsLookup: fakeLookupTo('192.168.10.20'),
    });
    expect(result.address).toBe('192.168.10.20');
  });
});
