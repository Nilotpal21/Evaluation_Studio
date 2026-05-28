import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractTrustedClientIp,
  isInternalNetworkAddress,
  isInternalNetworkRequest,
  normalizeHostHeader,
} from '../internal-network.js';

describe('internal-network helpers', () => {
  it('extracts the original client IP from a forwarded chain', () => {
    expect(extractTrustedClientIp('1.1.1.1, 10.1.2.3')).toBe('1.1.1.1');
    expect(extractTrustedClientIp('203.0.113.9')).toBe('203.0.113.9');
  });

  it('normalizes localhost host headers with ports', () => {
    expect(normalizeHostHeader('localhost:3000')).toBe('localhost');
    expect(normalizeHostHeader('[::1]:3000')).toBe('::1');
  });

  it('detects internal network addresses', () => {
    expect(isInternalNetworkAddress('10.0.0.5')).toBe(true);
    expect(isInternalNetworkAddress('8.8.8.8')).toBe(false);
  });

  it('allows internal requests only when the direct peer and forwarded chain are internal', () => {
    expect(
      isInternalNetworkRequest({
        forwardedFor: '10.0.0.5, 10.0.0.6',
        remoteAddress: '10.0.0.7',
        host: 'runtime.internal',
      }),
    ).toBe(true);
    expect(
      isInternalNetworkRequest({
        forwardedFor: '1.1.1.1, 10.0.0.5',
        remoteAddress: '10.0.0.7',
        host: 'studio.example.com',
      }),
    ).toBe(false);
    expect(
      isInternalNetworkRequest({
        forwardedFor: '10.0.0.8',
        remoteAddress: '8.8.8.8',
        host: 'studio.example.com',
      }),
    ).toBe(false);
  });

  it('fails closed when only spoofable proxy headers are present', () => {
    expect(
      isInternalNetworkRequest({
        forwardedFor: '10.0.0.8',
        host: 'studio.example.com',
      }),
    ).toBe(false);
    expect(
      isInternalNetworkRequest({
        host: 'localhost:3000',
      }),
    ).toBe(false);
    expect(
      isInternalNetworkRequest(
        {
          host: 'localhost:3000',
        },
        { allowLocalhostHostFallback: true },
      ),
    ).toBe(true);
  });
});

describe('extraInternalCidrs option', () => {
  it('treats addresses inside an extra CIDR as internal for both peer and forwarded chain', () => {
    expect(
      isInternalNetworkRequest(
        {
          remoteAddress: '160.83.1.5',
          forwardedFor: '160.83.2.7, 10.0.0.5',
        },
        { extraInternalCidrs: ['160.83.0.0/16'] },
      ),
    ).toBe(true);
  });

  it('still rejects when a forwarded hop falls outside both private ranges and extra CIDRs', () => {
    expect(
      isInternalNetworkRequest(
        {
          remoteAddress: '160.83.1.5',
          forwardedFor: '8.8.8.8, 10.0.0.5',
        },
        { extraInternalCidrs: ['160.83.0.0/16'] },
      ),
    ).toBe(false);
  });

  it('still rejects realIp outside the allowlist even if peer is inside it', () => {
    expect(
      isInternalNetworkRequest(
        {
          remoteAddress: '160.83.1.5',
          realIp: '1.0.0.1',
        },
        { extraInternalCidrs: ['160.83.0.0/16'] },
      ),
    ).toBe(false);
  });

  it('reflects the extra cidrs in isInternalNetworkAddress', () => {
    expect(isInternalNetworkAddress('160.83.1.5')).toBe(false);
    expect(isInternalNetworkAddress('160.83.1.5', ['160.83.0.0/16'])).toBe(true);
    expect(isInternalNetworkAddress('8.8.4.4', ['160.83.0.0/16'])).toBe(false);
  });
});

describe('INTERNAL_NETWORK_EXTRA_CIDRS env var', () => {
  const original = process.env.INTERNAL_NETWORK_EXTRA_CIDRS;

  beforeEach(() => {
    delete process.env.INTERNAL_NETWORK_EXTRA_CIDRS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INTERNAL_NETWORK_EXTRA_CIDRS;
    } else {
      process.env.INTERNAL_NETWORK_EXTRA_CIDRS = original;
    }
  });

  it('default behaviour without the env still rejects public peers', () => {
    expect(
      isInternalNetworkRequest({
        remoteAddress: '160.83.1.5',
      }),
    ).toBe(false);
  });

  it('parses comma-separated CIDRs from the env and accepts matching peers', () => {
    process.env.INTERNAL_NETWORK_EXTRA_CIDRS = '160.83.0.0/16, 8.8.8.8';
    expect(
      isInternalNetworkRequest({
        remoteAddress: '160.83.10.20',
        forwardedFor: '160.83.4.4, 10.0.0.5',
      }),
    ).toBe(true);
    expect(
      isInternalNetworkRequest({
        remoteAddress: '8.8.8.8',
      }),
    ).toBe(true);
    expect(
      isInternalNetworkRequest({
        remoteAddress: '9.9.9.9',
      }),
    ).toBe(false);
  });

  it('explicit options override the env', () => {
    process.env.INTERNAL_NETWORK_EXTRA_CIDRS = '160.83.0.0/16';
    expect(
      isInternalNetworkRequest(
        {
          remoteAddress: '160.83.1.5',
        },
        { extraInternalCidrs: [] },
      ),
    ).toBe(false);
  });

  it('picks up env mutations across calls', () => {
    expect(
      isInternalNetworkRequest({
        remoteAddress: '160.83.1.5',
      }),
    ).toBe(false);

    process.env.INTERNAL_NETWORK_EXTRA_CIDRS = '160.83.0.0/16';

    expect(
      isInternalNetworkRequest({
        remoteAddress: '160.83.1.5',
      }),
    ).toBe(true);
  });
});
