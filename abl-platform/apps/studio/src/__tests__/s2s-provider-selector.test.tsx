import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockListVoiceServices = vi.fn();

vi.mock('../api/voice-services', () => ({
  listVoiceServices: (...args: unknown[]) => mockListVoiceServices(...args),
}));

vi.mock('../store/auth-store', () => ({
  useAuthStore: (selector?: (state: { tenantId: string }) => unknown) => {
    const state = { tenantId: 'tenant-1' };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../lib/sanitize-error', () => ({
  sanitizeError: (_error: unknown, fallback: string) => fallback,
}));

import { S2SProviderSelector } from '../components/deployments/channels/S2SProviderSelector';

describe('S2SProviderSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-selects the first active provider when no value is set', async () => {
    const onChange = vi.fn();
    mockListVoiceServices.mockResolvedValueOnce([
      {
        id: 'provider-openai',
        displayName: 'Primary OpenAI',
        serviceType: 's2s:openai',
        isDefault: true,
        isActive: true,
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    ]);

    render(<S2SProviderSelector value={undefined} onChange={onChange} />);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('s2s:openai');
    });
    expect(await screen.findByText('OpenAI Realtime')).toBeInTheDocument();
  });

  it('filters unsupported partial providers while showing selected-provider parity messaging', async () => {
    const onChange = vi.fn();
    mockListVoiceServices.mockResolvedValueOnce([
      {
        id: 'provider-deepgram',
        displayName: 'Deepgram Agent',
        serviceType: 's2s:deepgram',
        isDefault: true,
        isActive: true,
        createdAt: '2026-04-22T00:00:00.000Z',
      },
      {
        id: 'provider-grok',
        displayName: 'Grok Realtime',
        serviceType: 's2s:grok',
        isDefault: false,
        isActive: true,
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    ]);

    render(<S2SProviderSelector value="s2s:deepgram" onChange={onChange} />);

    expect(await screen.findByText('Grok Realtime (S2S)')).toBeInTheDocument();
    expect(screen.queryByText('Deepgram Voice Agent (S2S)')).not.toBeInTheDocument();
    expect(screen.queryByText('Partial telephony support')).not.toBeInTheDocument();
    expect(screen.getByText('Provider parity note')).toBeInTheDocument();
    expect(
      screen.getByText(/inline agent handoff and prompt-swap flows remain limited/i),
    ).toBeInTheDocument();
  });

  it('shows one selectable option per S2S provider type and prefers the default instance', async () => {
    const onChange = vi.fn();
    mockListVoiceServices.mockResolvedValueOnce([
      {
        id: 'provider-openai-backup',
        displayName: 'Backup OpenAI',
        serviceType: 's2s:openai',
        isDefault: false,
        isActive: true,
        createdAt: '2026-04-22T00:00:00.000Z',
      },
      {
        id: 'provider-openai-default',
        displayName: 'Default OpenAI',
        serviceType: 's2s:openai',
        isDefault: true,
        isActive: true,
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    ]);

    render(<S2SProviderSelector value="s2s:openai" onChange={onChange} />);

    expect(await screen.findByText('Default OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('Backup OpenAI')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });
});
