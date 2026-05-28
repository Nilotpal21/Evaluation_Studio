import { describe, expect, it } from 'vitest';

import { ipMatchesAnyCidr, ipMatchesCidrEntry, ipv4ToNumber, parseIpv4Cidr } from '../cidr.js';

describe('ipv4ToNumber', () => {
  it('parses dotted-quad addresses', () => {
    expect(ipv4ToNumber('0.0.0.0')).toBe(0);
    expect(ipv4ToNumber('127.0.0.1')).toBe(0x7f000001);
    expect(ipv4ToNumber('255.255.255.255')).toBe(0xffffffff);
  });

  it('strips IPv6-mapped IPv4 prefix', () => {
    expect(ipv4ToNumber('::ffff:160.83.1.2')).toBe(ipv4ToNumber('160.83.1.2'));
  });

  it('rejects malformed input', () => {
    expect(ipv4ToNumber('1.2.3')).toBeNull();
    expect(ipv4ToNumber('1.2.3.256')).toBeNull();
    expect(ipv4ToNumber('not-an-ip')).toBeNull();
    expect(ipv4ToNumber('1.2.3.4.5')).toBeNull();
    expect(ipv4ToNumber('1.2.3.-1')).toBeNull();
  });
});

describe('parseIpv4Cidr', () => {
  it('parses standard CIDR notation', () => {
    const cidr = parseIpv4Cidr('10.0.0.0/8');
    expect(cidr).not.toBeNull();
    expect(cidr!.base).toBe(0x0a000000);
    expect(cidr!.mask).toBe(0xff000000);
  });

  it('handles /0 (match all)', () => {
    const cidr = parseIpv4Cidr('0.0.0.0/0');
    expect(cidr!.base).toBe(0);
    expect(cidr!.mask).toBe(0);
  });

  it('handles /32 (single host)', () => {
    const cidr = parseIpv4Cidr('203.0.113.5/32');
    expect(cidr!.base).toBe(ipv4ToNumber('203.0.113.5'));
    expect(cidr!.mask).toBe(0xffffffff);
  });

  it('rejects invalid prefix lengths', () => {
    expect(parseIpv4Cidr('10.0.0.0/33')).toBeNull();
    expect(parseIpv4Cidr('10.0.0.0/-1')).toBeNull();
    expect(parseIpv4Cidr('10.0.0.0/abc')).toBeNull();
  });

  it('rejects malformed inputs', () => {
    expect(parseIpv4Cidr('10.0.0.0')).toBeNull();
    expect(parseIpv4Cidr('10.0.0.0/24/8')).toBeNull();
    expect(parseIpv4Cidr('not-a-cidr')).toBeNull();
  });
});

describe('ipMatchesCidrEntry', () => {
  it('matches plain-IP entries exactly', () => {
    expect(ipMatchesCidrEntry('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(ipMatchesCidrEntry('10.0.0.2', '10.0.0.1')).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(ipMatchesCidrEntry('160.83.1.5', '160.83.0.0/16')).toBe(true);
    expect(ipMatchesCidrEntry('160.84.1.5', '160.83.0.0/16')).toBe(false);
    expect(ipMatchesCidrEntry('10.0.0.123', '10.0.0.0/24')).toBe(true);
    expect(ipMatchesCidrEntry('10.0.1.1', '10.0.0.0/24')).toBe(false);
  });

  it('handles IPv6-mapped IPv4 addresses', () => {
    expect(ipMatchesCidrEntry('::ffff:160.83.1.5', '160.83.0.0/16')).toBe(true);
    expect(ipMatchesCidrEntry('::ffff:10.0.0.1', '10.0.0.1')).toBe(true);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(ipMatchesCidrEntry('not-an-ip', '10.0.0.0/24')).toBe(false);
    expect(ipMatchesCidrEntry('10.0.0.1', 'not-a-cidr/24')).toBe(false);
  });
});

describe('ipMatchesAnyCidr', () => {
  it('returns false for an empty list', () => {
    expect(ipMatchesAnyCidr('10.0.0.1', [])).toBe(false);
  });

  it('returns true when any entry matches', () => {
    expect(ipMatchesAnyCidr('160.83.1.5', ['203.0.113.0/24', '160.83.0.0/16'])).toBe(true);
  });

  it('returns false when no entry matches', () => {
    expect(ipMatchesAnyCidr('192.0.2.1', ['203.0.113.0/24', '160.83.0.0/16'])).toBe(false);
  });
});
