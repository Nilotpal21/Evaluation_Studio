import { afterEach, describe, it, expect } from 'vitest';
import {
  validateUrlForSSRF,
  validateHostnameForSSRF,
  assertUrlSafeForSSRF,
  getDevSSRFOptions,
  isPrivateIP,
  isMetadataEndpoint,
  isLocalhost,
  decimalToIp,
  decodeOctalIp,
  decodeHexIp,
  decodeIpv4AddressLiteral,
} from '../ssrf-validator.js';

// ─── decimalToIp ───────────────────────────────────────────────────────────

describe('decimalToIp', () => {
  it('converts 2130706433 to 127.0.0.1', () => {
    expect(decimalToIp(2130706433)).toBe('127.0.0.1');
  });

  it('converts 167772160 to 10.0.0.0', () => {
    expect(decimalToIp(167772160)).toBe('10.0.0.0');
  });

  it('converts 0 to 0.0.0.0', () => {
    expect(decimalToIp(0)).toBe('0.0.0.0');
  });

  it('returns null for negative numbers', () => {
    expect(decimalToIp(-1)).toBeNull();
  });

  it('returns null for numbers exceeding IPv4 range', () => {
    expect(decimalToIp(0x100000000)).toBeNull();
  });

  it('converts max IPv4 (255.255.255.255)', () => {
    expect(decimalToIp(0xffffffff)).toBe('255.255.255.255');
  });

  it('returns null for NaN', () => {
    expect(decimalToIp(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(decimalToIp(Infinity)).toBeNull();
  });
});

// ─── decodeOctalIp ─────────────────────────────────────────────────────────

describe('decodeOctalIp', () => {
  it('decodes 0177.0.0.01 to 127.0.0.1', () => {
    expect(decodeOctalIp('0177.0.0.01')).toBe('127.0.0.1');
  });

  it('decodes 012.0.0.01 to 10.0.0.1', () => {
    expect(decodeOctalIp('012.0.0.01')).toBe('10.0.0.1');
  });

  it('returns null for non-octal addresses', () => {
    expect(decodeOctalIp('192.168.1.1')).toBeNull();
  });

  it('returns null for non-IP strings', () => {
    expect(decodeOctalIp('example.com')).toBeNull();
  });

  it('returns null for partial IPs', () => {
    expect(decodeOctalIp('0177.0.0')).toBeNull();
  });

  it('returns null if octal decode produces invalid octets', () => {
    expect(decodeOctalIp('0777.0.0.01')).toBeNull(); // 0777 = 511 > 255
  });

  it('returns null if an octet contains non-digit characters', () => {
    expect(decodeOctalIp('0177.0.0.0a')).toBeNull();
  });
});

// ─── encoded IPv4 literals ─────────────────────────────────────────────────

describe('encoded IPv4 literals', () => {
  it('decodes hex 0x7f000001 to 127.0.0.1', () => {
    expect(decodeHexIp('0x7f000001')).toBe('127.0.0.1');
  });

  it('decodes mixed hex/octal/decimal notation', () => {
    expect(decodeIpv4AddressLiteral('0x7f.0.0.01')).toBe('127.0.0.1');
  });

  it('decodes short inet_aton notation', () => {
    expect(decodeIpv4AddressLiteral('127.1')).toBe('127.0.0.1');
  });
});

// ─── isPrivateIP ───────────────────────────────────────────────────────────

describe('isPrivateIP', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('returns true for private IP: %s', (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1'])(
    'returns false for public IP: %s',
    (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    },
  );

  it.each(['192.0.0.8', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1'])(
    'returns true for reserved/test IP: %s',
    (ip) => {
      expect(isPrivateIP(ip)).toBe(true);
    },
  );

  it('detects CGN range 100.64.x.x', () => {
    expect(isPrivateIP('100.64.0.1')).toBe(true);
    expect(isPrivateIP('100.127.255.255')).toBe(true);
  });

  it('allows 100.128+ (not CGN)', () => {
    expect(isPrivateIP('100.128.0.1')).toBe(false);
  });

  it('detects IPv6 unique local (fc00:)', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
  });

  it('detects IPv6 unique local (fd00:)', () => {
    expect(isPrivateIP('fd00::1')).toBe(true);
  });

  it('detects IPv6 link-local (fe80:)', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('handles IPv6 unspecified (::)', () => {
    expect(isPrivateIP('::')).toBe(true);
  });

  it('handles IP with port suffix (127.0.0.1:8080)', () => {
    expect(isPrivateIP('127.0.0.1:8080')).toBe(true);
  });

  it('handles bracketed IPv6 ([::1])', () => {
    expect(isPrivateIP('[::1]')).toBe(true);
  });

  it('returns false for IPv4 with octet > 255', () => {
    expect(isPrivateIP('256.0.0.1')).toBe(false);
  });

  it('returns false for IPv4 with multiple octets > 255', () => {
    expect(isPrivateIP('999.999.999.999')).toBe(false);
  });

  it('returns false for public IPv6 address (non-IPv4 path)', () => {
    expect(isPrivateIP('2001:db8::1')).toBe(false);
  });
});

// ─── isMetadataEndpoint ────────────────────────────────────────────────────

describe('isMetadataEndpoint', () => {
  it('blocks 169.254.169.254', () => {
    expect(isMetadataEndpoint('169.254.169.254')).toBe(true);
  });

  it('blocks metadata.google.internal', () => {
    expect(isMetadataEndpoint('metadata.google.internal')).toBe(true);
  });

  it('blocks metadata.azure.com', () => {
    expect(isMetadataEndpoint('metadata.azure.com')).toBe(true);
  });

  it('allows regular hostnames', () => {
    expect(isMetadataEndpoint('api.example.com')).toBe(false);
  });

  it('blocks subdomain of metadata.google.internal', () => {
    expect(isMetadataEndpoint('foo.metadata.google.internal')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMetadataEndpoint('METADATA.GOOGLE.INTERNAL')).toBe(true);
  });

  it('blocks AWS IMDSv2 alternate (169.254.169.253)', () => {
    expect(isMetadataEndpoint('169.254.169.253')).toBe(true);
  });

  it('blocks Alibaba metadata endpoint', () => {
    expect(isMetadataEndpoint('100.100.100.200')).toBe(true);
  });

  it('blocks AWS IPv6 metadata endpoint', () => {
    expect(isMetadataEndpoint('fd00:ec2::254')).toBe(true);
  });
});

// ─── isLocalhost ───────────────────────────────────────────────────────────

describe('isLocalhost', () => {
  it.each(['localhost', '127.0.0.1', '::1', 'localhost.localdomain'])(
    'returns true for %s',
    (host) => {
      expect(isLocalhost(host)).toBe(true);
    },
  );

  it('returns false for external hosts', () => {
    expect(isLocalhost('example.com')).toBe(false);
  });
});

// ─── validateUrlForSSRF ────────────────────────────────────────────────────

describe('validateUrlForSSRF', () => {
  describe('safe URLs', () => {
    it.each([
      'https://api.example.com/data',
      'http://webhook.site/callback',
      'https://8.8.8.8/dns',
    ])('allows %s', (url) => {
      expect(validateUrlForSSRF(url)).toEqual({ safe: true });
    });
  });

  describe('private IPs', () => {
    it.each([
      'http://127.0.0.1/',
      'http://10.0.0.1/admin',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
    ])('blocks %s', (url) => {
      const result = validateUrlForSSRF(url);
      expect(result.safe).toBe(false);
    });
  });

  describe('decimal IP encoding', () => {
    it('blocks http://2130706433/ (= 127.0.0.1)', () => {
      // Node URL parser auto-decodes decimal IPs → hostname is already 127.0.0.1
      // Our decimal decoder is defense-in-depth for non-standard URL parsers
      const result = validateUrlForSSRF('http://2130706433/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('127.0.0.1');
    });

    it('blocks http://167772161/ (= 10.0.0.1)', () => {
      const result = validateUrlForSSRF('http://167772161/');
      expect(result.safe).toBe(false);
    });
  });

  describe('octal IP encoding', () => {
    it('blocks http://0177.0.0.01/ (= 127.0.0.1)', () => {
      // Node URL parser auto-decodes octal IPs → hostname is already 127.0.0.1
      // Our octal decoder is defense-in-depth for non-standard URL parsers
      const result = validateUrlForSSRF('http://0177.0.0.01/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('127.0.0.1');
    });

    it('blocks http://012.0.0.01/ (= 10.0.0.1)', () => {
      const result = validateUrlForSSRF('http://012.0.0.01/');
      expect(result.safe).toBe(false);
    });
  });

  describe('hex and mixed IP encoding', () => {
    it('blocks http://0x7f000001/ (= 127.0.0.1)', () => {
      const result = validateUrlForSSRF('http://0x7f000001/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('127.0.0.1');
    });

    it('blocks mixed notation for metadata IPs', () => {
      const result = validateHostnameForSSRF('0xa9.0376.0251.0376');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('169.254.169.254');
    });
  });

  describe('userinfo bypass', () => {
    it('blocks http://evil.com@169.254.169.254/', () => {
      const result = validateUrlForSSRF('http://evil.com@169.254.169.254/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('userinfo');
    });
  });

  describe('metadata endpoints', () => {
    it('blocks http://169.254.169.254/latest/meta-data/', () => {
      const result = validateUrlForSSRF('http://169.254.169.254/latest/meta-data/');
      expect(result.safe).toBe(false);
    });

    it('blocks http://metadata.google.internal/', () => {
      const result = validateUrlForSSRF('http://metadata.google.internal/');
      expect(result.safe).toBe(false);
    });
  });

  describe('protocol validation', () => {
    it('blocks file:// URLs', () => {
      const result = validateUrlForSSRF('file:///etc/passwd');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('scheme');
    });

    it('blocks ftp:// URLs', () => {
      const result = validateUrlForSSRF('ftp://evil.com/file');
      expect(result.safe).toBe(false);
    });
  });

  describe('invalid URLs', () => {
    it('blocks malformed URLs', () => {
      const result = validateUrlForSSRF('not-a-url');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Invalid URL');
    });
  });

  describe('options', () => {
    it('allowLocalhost permits 127.0.0.1', () => {
      const result = validateUrlForSSRF('http://127.0.0.1/', { allowLocalhost: true });
      expect(result.safe).toBe(true);
    });

    it('allowLocalhost still blocks metadata endpoints', () => {
      const result = validateUrlForSSRF('http://169.254.169.254/', { allowLocalhost: true });
      expect(result.safe).toBe(false);
    });

    it('allowPrivateRanges permits 10.x IPs', () => {
      const result = validateUrlForSSRF('http://10.0.0.1/', { allowPrivateRanges: true });
      expect(result.safe).toBe(true);
    });

    it('additionalBlockedHosts blocks custom hostnames', () => {
      const result = validateUrlForSSRF('http://internal.corp/', {
        additionalBlockedHosts: ['internal.corp'],
      });
      expect(result.safe).toBe(false);
    });

    it('additionalAllowedHosts overrides blocking', () => {
      const result = validateUrlForSSRF('http://localhost/', {
        additionalAllowedHosts: ['localhost'],
      });
      expect(result.safe).toBe(true);
    });

    it('allowPrivateRanges still blocks metadata endpoints', () => {
      const result = validateUrlForSSRF('http://169.254.169.254/latest/', {
        allowPrivateRanges: true,
      });
      expect(result.safe).toBe(false);
    });

    it('allowLocalhost permits localhost hostname', () => {
      const result = validateUrlForSSRF('http://localhost:3000/api', { allowLocalhost: true });
      expect(result.safe).toBe(true);
    });
  });

  describe('real-world edge cases', () => {
    it('blocks empty string', () => {
      const result = validateUrlForSSRF('');
      expect(result.safe).toBe(false);
    });

    it('allows URLs with query params and fragments', () => {
      const result = validateUrlForSSRF('https://api.example.com/data?key=value#section');
      expect(result.safe).toBe(true);
    });

    it('allows URLs with ports', () => {
      const result = validateUrlForSSRF('https://api.example.com:8443/path');
      expect(result.safe).toBe(true);
    });

    it('blocks private IP in URL with port', () => {
      const result = validateUrlForSSRF('http://10.0.0.1:8080/api');
      expect(result.safe).toBe(false);
    });

    it('blocks javascript: scheme', () => {
      const result = validateUrlForSSRF('javascript:alert(1)');
      expect(result.safe).toBe(false);
    });

    it('blocks data: scheme', () => {
      const result = validateUrlForSSRF('data:text/html,<h1>hi</h1>');
      expect(result.safe).toBe(false);
    });

    it('blocks decimal encoding of 10.0.0.1', () => {
      const result = validateUrlForSSRF('http://167772161/'); // 10.0.0.1
      expect(result.safe).toBe(false);
    });

    it('blocks octal encoding of 10.0.0.1', () => {
      const result = validateUrlForSSRF('http://012.0.0.01/');
      expect(result.safe).toBe(false);
    });

    it('blocks CGN range via URL', () => {
      const result = validateUrlForSSRF('http://100.100.100.100/');
      expect(result.safe).toBe(false);
    });

    it('allows 100.128.x (outside CGN range)', () => {
      const result = validateUrlForSSRF('http://100.128.0.1/');
      expect(result.safe).toBe(true);
    });

    it('handles URL with basic auth in allowed domain', () => {
      // Even if the target hostname is safe, userinfo bypass is always blocked
      const result = validateUrlForSSRF('http://user:pass@api.example.com/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('userinfo');
    });

    it('blocks IPv6 loopback in URL', () => {
      const result = validateUrlForSSRF('http://[::1]/');
      expect(result.safe).toBe(false);
    });

    it('blocks IPv6-mapped IPv4 in URL after WHATWG normalization', () => {
      const result = validateUrlForSSRF('http://[::ffff:127.0.0.1]/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Blocked private/reserved IP');
    });

    it('blocks 0.0.0.0 (this-network)', () => {
      const result = validateUrlForSSRF('http://0.0.0.0/');
      expect(result.safe).toBe(false);
    });
  });
});

// ─── validateHostnameForSSRF ────────────────────────────────────────────────

describe('validateHostnameForSSRF', () => {
  describe('decimal IP decode (defense-in-depth)', () => {
    it('blocks decimal 2130706433 as 127.0.0.1', () => {
      // Bypasses Node URL parser to exercise the decimal decode branch directly
      const result = validateHostnameForSSRF('2130706433');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('127.0.0.1');
      expect(result.reason).toContain('decoded from decimal');
    });

    it('blocks decimal 167772161 as 10.0.0.1', () => {
      const result = validateHostnameForSSRF('167772161');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('10.0.0.1');
      expect(result.reason).toContain('decoded from decimal');
    });

    it('blocks decimal for metadata IP 169.254.169.254', () => {
      // 169.254.169.254 = 2852039166
      const result = validateHostnameForSSRF('2852039166');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('169.254.169.254');
      expect(result.reason).toContain('decoded from decimal');
    });

    it('allows decimal for safe public IP', () => {
      // 8.8.8.8 = 134744072
      const result = validateHostnameForSSRF('134744072');
      expect(result.safe).toBe(true);
    });

    it('treats out-of-range decimal as regular hostname (not an IP)', () => {
      // Number exceeding IPv4 range — decimalToIp returns null, treated as non-IP hostname
      const result = validateHostnameForSSRF('99999999999999');
      expect(result.safe).toBe(true);
    });
  });

  describe('octal IP decode (defense-in-depth)', () => {
    it('blocks octal 0177.0.0.01 as 127.0.0.1', () => {
      const result = validateHostnameForSSRF('0177.0.0.01');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('127.0.0.1');
      expect(result.reason).toContain('decoded from octal');
    });

    it('blocks octal 012.0.0.01 as 10.0.0.1', () => {
      const result = validateHostnameForSSRF('012.0.0.01');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('10.0.0.1');
      expect(result.reason).toContain('decoded from octal');
    });
  });

  describe('allowLocalhost with 127.x bypass in private IP check', () => {
    it('allows 127.0.0.1 when allowLocalhost is true', () => {
      const result = validateHostnameForSSRF('127.0.0.1', { allowLocalhost: true });
      expect(result.safe).toBe(true);
    });

    it('still blocks non-localhost private IPs when allowLocalhost is true', () => {
      const result = validateHostnameForSSRF('10.0.0.1', { allowLocalhost: true });
      expect(result.safe).toBe(false);
    });

    it('skips 127.x in private IP patterns when allowLocalhost is true (continue branch)', () => {
      // This exercises the `allowLocalhost && /^127\./.test(hostname)` continue branch
      // by passing a hostname that isLocalhost catches — but we need one that gets past isLocalhost.
      // Actually isLocalhost catches all 127.x, so this continue branch is truly a safety net.
      // We test it indirectly: 127.0.0.1 with allowLocalhost returns safe from isLocalhost check.
      const result = validateHostnameForSSRF('127.0.0.1', { allowLocalhost: true });
      expect(result.safe).toBe(true);
    });
  });

  describe('options passthrough', () => {
    it('additionalAllowedHosts overrides blocking', () => {
      const result = validateHostnameForSSRF('127.0.0.1', {
        additionalAllowedHosts: ['127.0.0.1'],
      });
      expect(result.safe).toBe(true);
    });

    it('additionalBlockedHosts blocks custom hostnames', () => {
      const result = validateHostnameForSSRF('evil.corp', {
        additionalBlockedHosts: ['evil.corp'],
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Blocked hostname');
    });

    it('allowPrivateRanges permits private IPs', () => {
      const result = validateHostnameForSSRF('10.0.0.1', { allowPrivateRanges: true });
      expect(result.safe).toBe(true);
    });

    it('strips IPv6 brackets', () => {
      const result = validateHostnameForSSRF('[::1]');
      expect(result.safe).toBe(false);
    });
  });
});

// ─── assertUrlSafeForSSRF ──────────────────────────────────────────────────

describe('assertUrlSafeForSSRF', () => {
  it('does not throw for safe URLs', () => {
    expect(() => assertUrlSafeForSSRF('https://api.example.com/')).not.toThrow();
  });

  it('throws for blocked URLs', () => {
    expect(() => assertUrlSafeForSSRF('http://127.0.0.1/')).toThrow('Blocked');
  });

  it('supports allowLocalhost option', () => {
    expect(() => assertUrlSafeForSSRF('http://localhost/', { allowLocalhost: true })).not.toThrow();
  });
});

// ─── getDevSSRFOptions ────────────────────────────────────────────────────

describe('getDevSSRFOptions', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowFlag = process.env.ALLOW_SSRF_PRIVATE_RANGES;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowFlag === undefined) {
      delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    } else {
      process.env.ALLOW_SSRF_PRIVATE_RANGES = originalAllowFlag;
    }
  });

  it('allows private ranges in development mode', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).toBe(true);
    expect(opts.allowLocalhost).toBe(true);
  });

  it('allows private ranges in test mode', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).toBe(true);
  });

  it('does NOT allow private ranges in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).not.toBe(true);
    expect(opts.allowLocalhost).toBeUndefined();
  });

  it('returns empty options in production (restrictive mode)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    const opts = getDevSSRFOptions();
    expect(opts).toEqual({});
  });

  it('does NOT allow private ranges in staging (NODE_ENV=staging)', () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.ALLOW_SSRF_PRIVATE_RANGES;
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).not.toBe(true);
  });

  it('allows private ranges when ALLOW_SSRF_PRIVATE_RANGES=true regardless of NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_SSRF_PRIVATE_RANGES = 'true';
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).toBe(true);
    expect(opts.allowLocalhost).toBe(true);
  });

  it('does not allow private ranges when ALLOW_SSRF_PRIVATE_RANGES is any value other than true', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_SSRF_PRIVATE_RANGES = 'false';
    const opts = getDevSSRFOptions();
    expect(opts.allowPrivateRanges).not.toBe(true);
  });
});
