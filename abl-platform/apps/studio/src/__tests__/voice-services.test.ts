import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();

vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

vi.mock('../config/runtime', () => ({
  getRuntimeUrl: () => 'http://runtime.test',
}));

describe('voice-services', () => {
  let listVoiceServices: typeof import('../api/voice-services').listVoiceServices;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../api/voice-services');
    listVoiceServices = mod.listVoiceServices;
  });

  it('keeps known registry-backed S2S providers', async () => {
    const response = { ok: true };
    mockApiFetch.mockResolvedValueOnce(response);
    mockHandleResponse.mockResolvedValueOnce({
      success: true,
      instances: [
        {
          id: 'provider-openai',
          displayName: 'Primary OpenAI',
          serviceType: 's2s:openai',
          isDefault: true,
          isActive: true,
          createdAt: '2026-04-22T00:00:00.000Z',
        },
        {
          id: 'provider-deepgram',
          displayName: 'Deepgram Agent',
          serviceType: 's2s:deepgram',
          isDefault: false,
          isActive: true,
          createdAt: '2026-04-22T00:00:00.000Z',
        },
      ],
    });

    const result = await listVoiceServices('tenant-1');

    expect(result.map((provider) => provider.serviceType)).toEqual(['s2s:openai', 's2s:deepgram']);
    expect(mockApiFetch).toHaveBeenCalledWith(
      'http://runtime.test/api/tenants/tenant-1/service-instances',
      { headers: { 'Content-Type': 'application/json' } },
    );
    expect(mockHandleResponse).toHaveBeenCalledWith(response);
  });

  it('preserves unknown future s2s providers returned by runtime', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true });
    mockHandleResponse.mockResolvedValueOnce({
      success: true,
      instances: [
        {
          id: 'provider-future',
          displayName: 'Future Voice Agent',
          serviceType: 's2s:future-vendor',
          isDefault: false,
          isActive: true,
          createdAt: '2026-04-22T00:00:00.000Z',
        },
        {
          id: 'provider-google',
          displayName: 'Google Speech',
          serviceType: 'google',
          isDefault: false,
          isActive: true,
          createdAt: '2026-04-22T00:00:00.000Z',
        },
      ],
    });

    const result = await listVoiceServices('tenant-1');

    expect(result.map((provider) => provider.serviceType)).toEqual(['s2s:future-vendor']);
  });
});
