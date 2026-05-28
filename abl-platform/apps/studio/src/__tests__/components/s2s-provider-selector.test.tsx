import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { S2SProviderSelector } from '../../components/deployments/channels/S2SProviderSelector';

const { mockListVoiceServices } = vi.hoisted(() => ({
  mockListVoiceServices: vi.fn(),
}));

vi.mock('../../api/voice-services', () => ({
  listVoiceServices: (...args: Parameters<typeof mockListVoiceServices>) =>
    mockListVoiceServices(...args),
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: (selector: (state: { tenantId: string }) => unknown) =>
    selector({ tenantId: 'tenant-1' }),
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

describe('S2SProviderSelector', () => {
  test('shows only active runtime-wired S2S providers and auto-selects the first', async () => {
    const onChange = vi.fn();
    mockListVoiceServices.mockResolvedValue([
      {
        id: 'svc-stt',
        serviceType: 'deepgram',
        displayName: 'Deepgram STT',
        isActive: true,
      },
      {
        id: 'svc-unsupported',
        serviceType: 's2s:deepgram',
        displayName: 'Deepgram Voice Agent',
        isActive: true,
      },
      {
        id: 'svc-openai',
        serviceType: 's2s:openai',
        displayName: 'OpenAI Realtime',
        isActive: true,
      },
      {
        id: 'svc-microsoft',
        serviceType: 's2s:microsoft',
        displayName: 'Azure OpenAI Realtime',
        isActive: true,
      },
      {
        id: 'svc-grok-inactive',
        serviceType: 's2s:grok',
        displayName: 'Inactive Grok',
        isActive: false,
      },
    ]);

    render(<S2SProviderSelector value={undefined} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getAllByText('OpenAI Realtime')).toHaveLength(2);
    });

    expect(screen.getAllByText('Azure OpenAI Realtime')).toHaveLength(2);
    expect(screen.queryByText('Deepgram STT')).not.toBeInTheDocument();
    expect(screen.queryByText('Deepgram Voice Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Inactive Grok')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith('s2s:openai');
  });
});
