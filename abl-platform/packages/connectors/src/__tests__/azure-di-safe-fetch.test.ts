/**
 * Unit tests for the Azure DI piece's inlined SSRF guard
 * (`piece-azure-document-intelligence/src/safe-fetch.ts`).
 *
 * Round 4 of pr-review caught two edge cases — the hex IPv6-mapped IPv4
 * bypass (`::ffff:7f00:1`) and the missing CGNAT range. This file pins
 * the fix in place.
 */

import { describe, expect, it } from 'vitest';
import { assertUrlSafeForSSRF, SSRFError } from '@abl/piece-azure-document-intelligence/safe-fetch';

async function expectBlocked(url: string): Promise<void> {
  await expect(assertUrlSafeForSSRF(url)).rejects.toBeInstanceOf(SSRFError);
}

async function expectAllowed(url: string): Promise<void> {
  await expect(assertUrlSafeForSSRF(url)).resolves.toBeUndefined();
}

describe('assertUrlSafeForSSRF', () => {
  it('rejects non-http(s) protocols', async () => {
    await expectBlocked('file:///etc/passwd');
    await expectBlocked('gopher://example.com');
    await expectBlocked('ftp://example.com');
  });

  it('rejects loopback IPv4 literal 127.0.0.1', async () => {
    await expectBlocked('http://127.0.0.1/probe');
    await expectBlocked('http://127.5.5.5/probe');
  });

  it('rejects RFC 1918 private IPv4 ranges', async () => {
    await expectBlocked('http://10.0.0.1/');
    await expectBlocked('http://192.168.1.1/');
    await expectBlocked('http://172.16.0.1/');
    await expectBlocked('http://172.31.255.255/');
  });

  it('rejects RFC 6598 CGNAT range 100.64.0.0/10', async () => {
    await expectBlocked('http://100.64.0.1/');
    await expectBlocked('http://100.100.100.100/');
    await expectBlocked('http://100.127.255.254/');
    // Boundary check — 100.63.x.x is public; 100.128.x.x is also public.
    // The lookup at runtime would still be DNS-resolved if it were a hostname;
    // here we only assert the literal is correctly classified.
  });

  it('rejects IPv4 link-local 169.254.0.0/16 (cloud metadata)', async () => {
    await expectBlocked('http://169.254.169.254/latest/meta-data/');
  });

  it('rejects IPv6 loopback ::1', async () => {
    await expectBlocked('http://[::1]/');
  });

  it('rejects IPv6 ULA fc/fd prefix', async () => {
    await expectBlocked('http://[fc00::1]/');
    await expectBlocked('http://[fd12:3456:789a::1]/');
  });

  it('rejects IPv6 link-local fe80::/10', async () => {
    await expectBlocked('http://[fe80::1]/');
  });

  it('rejects ::ffff: IPv4-mapped form (dotted-quad)', async () => {
    await expectBlocked('http://[::ffff:127.0.0.1]/');
    await expectBlocked('http://[::ffff:10.0.0.1]/');
  });

  it('rejects ::ffff: IPv4-mapped HEX form (Round 4 SSRF fix)', async () => {
    // 7f00:0001 == 127.0.0.1
    await expectBlocked('http://[::ffff:7f00:1]/');
    // c0a8:0001 == 192.168.0.1
    await expectBlocked('http://[::ffff:c0a8:1]/');
    // ac10:0001 == 172.16.0.1
    await expectBlocked('http://[::ffff:ac10:1]/');
  });

  it('rejects reserved hostnames', async () => {
    await expectBlocked('http://localhost/');
    await expectBlocked('http://metadata.google.internal/');
    await expectBlocked('http://something.internal/');
    await expectBlocked('http://kubernetes.local/');
  });

  it('allows public IPv4 addresses (literal)', async () => {
    await expectAllowed('https://8.8.8.8/');
  });

  it('honors AZURE_DI_SSRF_ALLOWED_HOSTS for fixture servers', async () => {
    const original = process.env.AZURE_DI_SSRF_ALLOWED_HOSTS;
    process.env.AZURE_DI_SSRF_ALLOWED_HOSTS = 'fixture-host.test,my-mock.local';
    try {
      await expectAllowed('http://fixture-host.test/probe');
      await expectAllowed('http://my-mock.local/probe');
    } finally {
      if (original === undefined) {
        delete process.env.AZURE_DI_SSRF_ALLOWED_HOSTS;
      } else {
        process.env.AZURE_DI_SSRF_ALLOWED_HOSTS = original;
      }
    }
  });
});
