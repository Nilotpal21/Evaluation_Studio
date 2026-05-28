import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Stable mock: config module is mocked once (hoisted), with a mutable ref
// that tests can change. This avoids vi.resetModules() which causes Mongoose
// OverwriteModelError when database models are transitively re-imported.
// =============================================================================

const mockTwilioConfig = {
  accountSid: '',
  authToken: '',
  apiKeySid: '',
  apiKeySecret: '',
  twimlAppSid: '',
  trunkSid: undefined as string | undefined,
};

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    voice: {
      twilio: mockTwilioConfig,
    },
  }),
}));

// Mock twilio SDK — mutable so individual tests can customise
const mockTwilioCreate = vi.fn();
const mockTwilioRemove = vi.fn();
const mockTwilioUpdate = vi.fn();
const mockTwilioList = vi.fn();
const mockAvailableLocal = vi.fn();
const mockAvailableTollFree = vi.fn();
const mockValidateRequest = vi.fn();

vi.mock('twilio', () => ({
  default: () => ({
    incomingPhoneNumbers: Object.assign(
      (_sid: string) => ({
        remove: mockTwilioRemove,
        update: mockTwilioUpdate,
      }),
      {
        create: mockTwilioCreate,
        list: mockTwilioList,
      },
    ),
    availablePhoneNumbers: (_country: string) => ({
      local: { list: mockAvailableLocal },
      tollFree: { list: mockAvailableTollFree },
    }),
  }),
  validateRequest: mockValidateRequest,
}));

// Import once — no dynamic re-imports needed
import { TwilioService } from '../services/voice/twilio-service.js';

function resetTwilioConfig(overrides: Partial<typeof mockTwilioConfig> = {}) {
  mockTwilioConfig.accountSid = overrides.accountSid ?? '';
  mockTwilioConfig.authToken = overrides.authToken ?? '';
  mockTwilioConfig.apiKeySid = overrides.apiKeySid ?? '';
  mockTwilioConfig.apiKeySecret = overrides.apiKeySecret ?? '';
  mockTwilioConfig.twimlAppSid = overrides.twimlAppSid ?? '';
  mockTwilioConfig.trunkSid = overrides.trunkSid;
}

beforeEach(() => {
  resetTwilioConfig();
  vi.clearAllMocks();
});

// =============================================================================
// Explicit config (constructor with TwilioConfig)
// =============================================================================

describe('TwilioService — explicit config (isConfigured + isBasicConfigured)', () => {
  it('isConfigured returns false when no explicit config given', () => {
    expect(new TwilioService().isConfigured()).toBe(false);
  });

  it('isConfigured returns true when all 4 credentials provided explicitly', () => {
    const svc = new TwilioService({
      accountSid: 'ACxxx',
      authToken: 'token',
      apiKey: 'SKxxx',
      apiSecret: 'secret',
      twimlAppSid: 'APxxx',
    });
    expect(svc.isConfigured()).toBe(true);
    expect(svc.isBasicConfigured()).toBe(true);
  });

  it('fromCredentials creates a fully configured service', () => {
    const svc = TwilioService.fromCredentials('SKxxx', {
      accountSid: 'ACxxx',
      authToken: 'token',
      apiKeySecret: 'secret',
      twimlAppSid: 'APxxx',
    });
    expect(svc.isConfigured()).toBe(true);
    expect(svc.isBasicConfigured()).toBe(true);
  });
});

// =============================================================================
// Env config path (loadConfig via getConfig mock)
// =============================================================================

describe('TwilioService — env config path (loadConfig)', () => {
  it('isConfigured false + isBasicConfigured false when no env creds', () => {
    const svc = new TwilioService(); // uses loadConfig() → reads mock config
    expect(svc.isConfigured()).toBe(false);
    expect(svc.isBasicConfigured()).toBe(false);
  });

  it('isConfigured true + isBasicConfigured true when all 4 creds in env', () => {
    resetTwilioConfig({
      accountSid: 'ACxxx',
      authToken: 'token',
      apiKeySid: 'SKxxx',
      apiKeySecret: 'secret',
    });
    const svc = new TwilioService();
    expect(svc.isConfigured()).toBe(true);
    expect(svc.isBasicConfigured()).toBe(true);
  });

  it('isConfigured false + isBasicConfigured true when only accountSid + authToken in env', () => {
    resetTwilioConfig({ accountSid: 'ACxxx', authToken: 'token' });
    const svc = new TwilioService();
    expect(svc.isConfigured()).toBe(false);
    expect(svc.isBasicConfigured()).toBe(true);
  });

  it('isBasicConfigured false when accountSid present but authToken missing', () => {
    resetTwilioConfig({ accountSid: 'ACxxx' });
    const svc = new TwilioService();
    expect(svc.isBasicConfigured()).toBe(false);
  });

  it('isBasicConfigured false when authToken present but accountSid missing', () => {
    resetTwilioConfig({ authToken: 'token' });
    const svc = new TwilioService();
    expect(svc.isBasicConfigured()).toBe(false);
  });
});

// =============================================================================
// purchasePhoneNumber
// =============================================================================

describe('TwilioService — purchasePhoneNumber', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SKxxx',
    apiSecret: 'secret',
    twimlAppSid: 'APxxx',
  };

  it('passes trunkSid in create params when configured', async () => {
    mockTwilioCreate.mockResolvedValue({
      sid: 'PNabc',
      phoneNumber: '+14155551234',
      friendlyName: 'Test Number',
    });
    const svc = new TwilioService({ ...BASE_CONFIG, trunkSid: 'TKtrunk123' });

    const result = await svc.purchasePhoneNumber('+14155551234');

    expect(mockTwilioCreate).toHaveBeenCalledWith({
      phoneNumber: '+14155551234',
      trunkSid: 'TKtrunk123',
    });
    expect(result).toEqual({
      sid: 'PNabc',
      phoneNumber: '+14155551234',
      friendlyName: 'Test Number',
    });
  });

  it('omits trunkSid from create params when not configured', async () => {
    mockTwilioCreate.mockResolvedValue({
      sid: 'PNabc',
      phoneNumber: '+14155551234',
      friendlyName: 'Test Number',
    });
    const svc = new TwilioService(BASE_CONFIG);

    await svc.purchasePhoneNumber('+14155551234');

    expect(mockTwilioCreate).toHaveBeenCalledWith({ phoneNumber: '+14155551234' });
    expect(mockTwilioCreate.mock.calls[0][0]).not.toHaveProperty('trunkSid');
  });

  it('reads trunkSid from env config', () => {
    resetTwilioConfig({
      accountSid: 'ACxxx',
      authToken: 'token',
      apiKeySid: 'SKxxx',
      apiKeySecret: 'secret',
      trunkSid: 'TKenv123',
    });
    const svc = new TwilioService();
    expect((svc as any).config?.trunkSid).toBe('TKenv123');
  });
});

// =============================================================================
// releasePhoneNumber
// =============================================================================

describe('TwilioService — releasePhoneNumber', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SK',
    apiSecret: 'sec',
    twimlAppSid: '',
  };

  it('calls incomingPhoneNumbers(sid).remove()', async () => {
    mockTwilioRemove.mockResolvedValue(undefined);
    const svc = new TwilioService(BASE_CONFIG);

    await svc.releasePhoneNumber('PNabc123');
    expect(mockTwilioRemove).toHaveBeenCalledOnce();
  });

  it('swallows 404 (number already gone)', async () => {
    mockTwilioRemove.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const svc = new TwilioService(BASE_CONFIG);

    await expect(svc.releasePhoneNumber('PNgone')).resolves.toBeUndefined();
  });

  it('propagates non-404 errors', async () => {
    mockTwilioRemove.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));
    const svc = new TwilioService(BASE_CONFIG);

    await expect(svc.releasePhoneNumber('PNbad')).rejects.toThrow('Server error');
  });
});

// =============================================================================
// assignNumberToTrunk
// =============================================================================

describe('TwilioService — assignNumberToTrunk', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SKxxx',
    apiSecret: 'secret',
    twimlAppSid: 'APxxx',
  };

  it('returns null and logs warn when trunkSid is not configured', async () => {
    const svc = new TwilioService(BASE_CONFIG); // no trunkSid

    const result = await svc.assignNumberToTrunk('+14155551234');
    expect(result).toBeNull();
  });

  it('calls list then update and returns { sid } on success', async () => {
    mockTwilioList.mockResolvedValue([{ sid: 'PNabc', phoneNumber: '+14155551234' }]);
    mockTwilioUpdate.mockResolvedValue({});
    const svc = new TwilioService({ ...BASE_CONFIG, trunkSid: 'TKtrunk123' });

    const result = await svc.assignNumberToTrunk('+14155551234');

    expect(mockTwilioList).toHaveBeenCalledWith({ phoneNumber: '+14155551234', limit: 1 });
    expect(mockTwilioUpdate).toHaveBeenCalledWith({ trunkSid: 'TKtrunk123' });
    expect(result).toEqual({ sid: 'PNabc' });
  });

  it('throws when phone number not found in Twilio account', async () => {
    mockTwilioList.mockResolvedValue([]); // empty list
    const svc = new TwilioService({ ...BASE_CONFIG, trunkSid: 'TKtrunk123' });

    await expect(svc.assignNumberToTrunk('+10000000000')).rejects.toThrow(
      'not found in Twilio account',
    );
  });
});

// =============================================================================
// unassignNumberFromTrunk
// =============================================================================

describe('TwilioService — unassignNumberFromTrunk', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SK',
    apiSecret: 'sec',
    twimlAppSid: '',
  };

  it('calls incomingPhoneNumbers(sid).update({ trunkSid: "" })', async () => {
    mockTwilioUpdate.mockResolvedValue({});
    const svc = new TwilioService(BASE_CONFIG);

    await svc.unassignNumberFromTrunk('PNabc123');
    expect(mockTwilioUpdate).toHaveBeenCalledWith({ trunkSid: '' });
  });

  it('does not throw on 404 (already gone)', async () => {
    mockTwilioUpdate.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const svc = new TwilioService(BASE_CONFIG);

    await expect(svc.unassignNumberFromTrunk('PNgone')).resolves.toBeUndefined();
  });

  it('re-throws non-404 errors', async () => {
    mockTwilioUpdate.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));
    const svc = new TwilioService(BASE_CONFIG);

    await expect(svc.unassignNumberFromTrunk('PNbad')).rejects.toThrow('Server error');
  });
});

// =============================================================================
// searchAvailableNumbers
// =============================================================================

describe('TwilioService — searchAvailableNumbers', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SK',
    apiSecret: 'sec',
    twimlAppSid: '',
  };

  it('calls availablePhoneNumbers(countryCode).local.list() for local type', async () => {
    mockAvailableLocal.mockResolvedValue([
      { phoneNumber: '+14155551234', friendlyName: 'SF Number', region: 'CA', isoCountry: 'US' },
    ]);
    const svc = new TwilioService(BASE_CONFIG);

    const results = await svc.searchAvailableNumbers({
      countryCode: 'US',
      numberType: 'local',
      areaCode: '415',
    });

    expect(mockAvailableLocal).toHaveBeenCalledWith({ limit: 20, areaCode: '415' });
    expect(results).toEqual([
      { phoneNumber: '+14155551234', friendlyName: 'SF Number', region: 'CA', isoCountry: 'US' },
    ]);
  });

  it('calls availablePhoneNumbers(countryCode).tollFree.list() for tollFree type', async () => {
    mockAvailableTollFree.mockResolvedValue([
      { phoneNumber: '+18005551234', friendlyName: 'TF Number', region: '', isoCountry: 'US' },
    ]);
    const svc = new TwilioService(BASE_CONFIG);

    const results = await svc.searchAvailableNumbers({
      countryCode: 'US',
      numberType: 'tollFree',
    });

    expect(mockAvailableTollFree).toHaveBeenCalledWith({ limit: 20 });
    expect(results).toEqual([
      { phoneNumber: '+18005551234', friendlyName: 'TF Number', region: '', isoCountry: 'US' },
    ]);
  });
});

// =============================================================================
// validateWebhookSignature
// =============================================================================

describe('TwilioService — validateWebhookSignature', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'token',
    apiKey: 'SKxxx',
    apiSecret: 'secret',
    twimlAppSid: 'APxxx',
  };

  it('passes auth token, signature, URL, and params to twilio.validateRequest', async () => {
    mockValidateRequest.mockReturnValue(true);
    const svc = new TwilioService(BASE_CONFIG);

    const result = await svc.validateWebhookSignature(
      'twilio-signature',
      'wss://voice.example.com/voice/media?token=abc123',
      {},
    );

    expect(result).toBe(true);
    expect(mockValidateRequest).toHaveBeenCalledWith(
      'token',
      'twilio-signature',
      'wss://voice.example.com/voice/media?token=abc123',
      {},
    );
  });

  it('returns false when full Twilio config is unavailable', async () => {
    resetTwilioConfig({ accountSid: 'ACxxx', authToken: 'token' });
    const svc = new TwilioService();

    await expect(
      svc.validateWebhookSignature('twilio-signature', 'wss://voice.example.com/voice/media', {}),
    ).resolves.toBe(false);
    expect(mockValidateRequest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// generateMediaStreamToken / validateMediaStreamToken
// =============================================================================

describe('TwilioService — media stream connection tokens', () => {
  const BASE_CONFIG = {
    accountSid: 'ACxxx',
    authToken: 'test-auth-token-secret-value',
    apiKey: 'SKxxx',
    apiSecret: 'secret',
    twimlAppSid: 'APxxx',
  };

  it('generateMediaStreamToken returns a timestamp.hmac format', () => {
    const svc = new TwilioService(BASE_CONFIG);
    const token = svc.generateMediaStreamToken();

    expect(token).toMatch(/^\d+\.[a-f0-9]{64}$/);

    const [ts] = token.split('.');
    const timestamp = parseInt(ts, 10);
    // Timestamp should be within the last second
    expect(Date.now() - timestamp).toBeLessThan(2000);
  });

  it('validateMediaStreamToken accepts a freshly generated token', () => {
    const svc = new TwilioService(BASE_CONFIG);
    const token = svc.generateMediaStreamToken();

    expect(svc.validateMediaStreamToken(token)).toBe(true);
  });

  it('validateMediaStreamToken rejects a tampered token', () => {
    const svc = new TwilioService(BASE_CONFIG);
    const token = svc.generateMediaStreamToken();
    const [ts] = token.split('.');
    const tampered = `${ts}.${'a'.repeat(64)}`;

    expect(svc.validateMediaStreamToken(tampered)).toBe(false);
  });

  it('validateMediaStreamToken rejects an expired token', () => {
    const svc = new TwilioService(BASE_CONFIG);
    const token = svc.generateMediaStreamToken();

    // Use a very short TTL to simulate expiry
    expect(svc.validateMediaStreamToken(token, 0)).toBe(false);
  });

  it('validateMediaStreamToken rejects malformed tokens', () => {
    const svc = new TwilioService(BASE_CONFIG);

    expect(svc.validateMediaStreamToken('')).toBe(false);
    expect(svc.validateMediaStreamToken('no-dot-separator')).toBe(false);
    expect(svc.validateMediaStreamToken('notanumber.abcdef')).toBe(false);
    expect(svc.validateMediaStreamToken('.abcdef')).toBe(false);
  });

  it('validateMediaStreamToken rejects tokens from a different auth token', () => {
    const svc1 = new TwilioService(BASE_CONFIG);
    const svc2 = new TwilioService({ ...BASE_CONFIG, authToken: 'different-secret' });

    const token = svc1.generateMediaStreamToken();

    expect(svc1.validateMediaStreamToken(token)).toBe(true);
    expect(svc2.validateMediaStreamToken(token)).toBe(false);
  });

  it('validateMediaStreamToken returns false when service has no credentials', () => {
    const svc = new TwilioService(); // no config
    expect(svc.validateMediaStreamToken('12345.abc')).toBe(false);
  });
});
