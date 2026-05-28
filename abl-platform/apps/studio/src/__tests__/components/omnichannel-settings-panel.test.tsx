/**
 * OmnichannelSettingsPanel Unit Tests (UT-1 through UT-7)
 *
 * Tests loading state, settings rendering, API integration (PATCH save),
 * success/error toasts, and graceful fallback to defaults.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

const { mockApiFetch, mockNavigationStore, mockToast } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockNavigationStore: { projectId: 'project-1' },
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (s: typeof mockNavigationStore) => unknown) =>
    selector(mockNavigationStore),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// =============================================================================
// HELPERS
// =============================================================================

const CUSTOM_API_DATA = {
  recall: {
    enabled: true,
    maxMessages: 50,
    maxAgeDays: 14,
    allowedChannels: ['web', 'voice', 'sms'],
  },
  identity: {
    requireVerification: false,
    minTier: 1,
  },
  consent: {
    requireExplicitConsent: false,
  },
  liveSync: {
    enabled: true,
    joinMode: 'auto' as const,
    transcriptMode: 'final_only' as const,
  },
};

function makeGetResponse(data: Record<string, unknown> | null = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  };
}

function makePatchResponse(data: Record<string, unknown> | null = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  };
}

function makeErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code: 'INTERNAL_ERROR', message: 'Server error' } }),
  };
}

async function renderPanel() {
  const { OmnichannelSettingsPanel } =
    await import('../../components/projects/OmnichannelSettingsPanel');
  return render(<OmnichannelSettingsPanel />);
}

// =============================================================================
// TESTS
// =============================================================================

describe('OmnichannelSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationStore.projectId = 'project-1';
    mockApiFetch.mockResolvedValue(makeGetResponse(null));
  });

  // UT-1: renders loading state
  test('UT-1: shows loading spinner while fetching settings', async () => {
    // Never resolve the API call to keep loading state visible
    mockApiFetch.mockReturnValue(new Promise(() => {}));

    await renderPanel();

    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  // UT-2: renders settings form on successful load with defaults
  test('UT-2: renders all sections with defaults when API returns null data', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    // Wait for loading to finish — title should appear
    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Description
    expect(screen.getByText('Configure cross-channel session continuity')).toBeDefined();

    // Section headers
    expect(screen.getByText('Conversation Recall')).toBeDefined();
    expect(screen.getByText('Identity Requirements')).toBeDefined();
    expect(screen.getByText('Consent')).toBeDefined();
    expect(screen.getByText('Live Transcript Sync')).toBeDefined();

    // Field labels
    expect(screen.getByText('Enable cross-channel recall')).toBeDefined();
    expect(screen.getByText('Maximum messages to recall')).toBeDefined();
    expect(screen.getByText('Maximum age (days)')).toBeDefined();
    expect(screen.getByText('Allowed channels')).toBeDefined();
    expect(screen.getByText('Require identity verification')).toBeDefined();
    expect(screen.getByText('Minimum identity tier')).toBeDefined();
    expect(screen.getByText('Require explicit consent')).toBeDefined();
    expect(screen.getByText('Enable live sync')).toBeDefined();
    expect(screen.getByText('Join mode')).toBeDefined();
    expect(screen.getByText('Transcript mode')).toBeDefined();

    // Default numeric values in inputs
    const maxMsgsInput = screen.getByDisplayValue('20') as HTMLInputElement;
    expect(maxMsgsInput).toBeDefined();
    const maxAgeInput = screen.getByDisplayValue('30') as HTMLInputElement;
    expect(maxAgeInput).toBeDefined();

    // Save button should be disabled (clean state)
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    expect(saveBtn.disabled).toBe(true);
  });

  // UT-3: renders settings from API response with custom values
  test('UT-3: renders custom values from API response', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(CUSTOM_API_DATA));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Custom numeric values
    const maxMsgsInput = screen.getByDisplayValue('50') as HTMLInputElement;
    expect(maxMsgsInput).toBeDefined();
    const maxAgeInput = screen.getByDisplayValue('14') as HTMLInputElement;
    expect(maxAgeInput).toBeDefined();

    // recall.enabled = true → the first switch should be checked
    const switches = screen.getAllByRole('switch');
    // Switch order: recall.enabled, identity.requireVerification, consent.requireExplicitConsent, liveSync.enabled
    expect(switches[0].getAttribute('aria-checked')).toBe('true'); // recall enabled
    expect(switches[1].getAttribute('aria-checked')).toBe('false'); // identity requireVerification = false
    expect(switches[2].getAttribute('aria-checked')).toBe('false'); // consent requireExplicit = false
    expect(switches[3].getAttribute('aria-checked')).toBe('true'); // liveSync enabled

    // Channel chips should be pressed for web, voice, sms
    const webBtn = screen.getByLabelText('web channel');
    expect(webBtn.getAttribute('aria-pressed')).toBe('true');
    const voiceBtn = screen.getByLabelText('voice channel');
    expect(voiceBtn.getAttribute('aria-pressed')).toBe('true');
    const smsBtn = screen.getByLabelText('sms channel');
    expect(smsBtn.getAttribute('aria-pressed')).toBe('true');

    // whatsapp should NOT be pressed
    const whatsappBtn = screen.getByLabelText('whatsapp channel');
    expect(whatsappBtn.getAttribute('aria-pressed')).toBe('false');

    // Identity tier select should show "1"
    const tierSelect = screen.getByLabelText('Minimum identity tier') as HTMLSelectElement;
    expect(tierSelect.value).toBe('1');

    // Join mode select should show "auto"
    const joinModeSelect = screen.getByLabelText('Join mode') as HTMLSelectElement;
    expect(joinModeSelect.value).toBe('auto');
  });

  // UT-4: save sends PATCH with changed fields
  test('UT-4: toggling a setting and saving sends PATCH with full form state', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Toggle recall enabled (default is false → true)
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]); // recall.enabled toggle
    });

    // Verify switch toggled
    expect(switches[0].getAttribute('aria-checked')).toBe('true');

    // Mock the PATCH response
    const patchResponseData = {
      recall: {
        enabled: true,
        maxMessages: 20,
        maxAgeDays: 30,
        allowedChannels: [],
      },
      identity: {
        requireVerification: true,
        minTier: 2,
      },
      consent: {
        requireExplicitConsent: true,
      },
      liveSync: {
        enabled: false,
        joinMode: 'prompt',
        transcriptMode: 'final_only',
      },
    };
    mockApiFetch.mockResolvedValueOnce(makePatchResponse(patchResponseData));

    // Click save
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify PATCH was called with the correct path and method
    const patchCall = mockApiFetch.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' && (call[1] as Record<string, unknown>).method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(patchCall![0]).toBe('/api/projects/project-1/omnichannel');

    const body = JSON.parse((patchCall![1] as Record<string, string>).body);
    // The component sends the full formState
    expect(body.recall.enabled).toBe(true);
    expect(body.recall.maxMessages).toBe(20);
    expect(body.identity.requireVerification).toBe(true);
    expect(body.consent.requireExplicitConsent).toBe(true);
    expect(body.liveSync.enabled).toBe(false);
  });

  // UT-5: shows success toast on save
  test('UT-5: shows success toast after successful PATCH', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Make a change to enable save
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    // Mock successful PATCH
    mockApiFetch.mockResolvedValueOnce(makePatchResponse(null));

    // Click save
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Settings saved');
    });
  });

  // UT-6: shows error toast on save failure
  test('UT-6: shows error toast when PATCH returns error', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Make a change
    const switches = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    // Mock PATCH failure
    mockApiFetch.mockResolvedValueOnce(makeErrorResponse(500));

    // Click save
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to save settings');
    });

    // Form should retain dirty state (save button still enabled)
    expect(saveBtn.disabled).toBe(false);
  });

  // UT-7: handles runtime unreachable gracefully (GET returns null data)
  test('UT-7: uses defaults when GET returns null data and form is functional', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // All toggles should be at default positions
    const switches = screen.getAllByRole('switch');
    // recall.enabled = false
    expect(switches[0].getAttribute('aria-checked')).toBe('false');
    // identity.requireVerification = true
    expect(switches[1].getAttribute('aria-checked')).toBe('true');
    // consent.requireExplicitConsent = true
    expect(switches[2].getAttribute('aria-checked')).toBe('true');
    // liveSync.enabled = false
    expect(switches[3].getAttribute('aria-checked')).toBe('false');

    // Default numeric values
    expect((screen.getByDisplayValue('20') as HTMLInputElement).value).toBe('20');
    expect((screen.getByDisplayValue('30') as HTMLInputElement).value).toBe('30');

    // Default selects
    const tierSelect = screen.getByLabelText('Minimum identity tier') as HTMLSelectElement;
    expect(tierSelect.value).toBe('2');
    const joinModeSelect = screen.getByLabelText('Join mode') as HTMLSelectElement;
    expect(joinModeSelect.value).toBe('prompt');
    const transcriptSelect = screen.getByLabelText('Transcript mode') as HTMLSelectElement;
    expect(transcriptSelect.value).toBe('final_only');
    expect(transcriptSelect.disabled).toBe(true);

    // No channels selected by default
    const channelButtons = ['web', 'voice', 'sms', 'whatsapp', 'email', 'slack', 'teams'];
    for (const channel of channelButtons) {
      const btn = screen.getByLabelText(`${channel} channel`);
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    }

    // Can still interact — toggle and channel chips work
    await act(async () => {
      fireEvent.click(switches[0]); // toggle recall
    });
    expect(switches[0].getAttribute('aria-checked')).toBe('true');

    // Click a channel chip
    const webBtn = screen.getByLabelText('web channel');
    await act(async () => {
      fireEvent.click(webBtn);
    });
    expect(webBtn.getAttribute('aria-pressed')).toBe('true');

    // Save button should now be enabled
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    expect(saveBtn.disabled).toBe(false);
  });

  // UT-8: shows error toast when GET request fails
  test('UT-8: shows error toast when initial GET fails', async () => {
    mockApiFetch.mockResolvedValue(makeErrorResponse(500));

    await renderPanel();

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to save settings');
    });
  });

  // UT-9: channel toggle adds and removes channels
  test('UT-9: channel chip toggles add and remove channels correctly', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    const webBtn = screen.getByLabelText('web channel');
    expect(webBtn.getAttribute('aria-pressed')).toBe('false');

    // Click to add
    await act(async () => {
      fireEvent.click(webBtn);
    });
    expect(webBtn.getAttribute('aria-pressed')).toBe('true');

    // Click again to remove
    await act(async () => {
      fireEvent.click(webBtn);
    });
    expect(webBtn.getAttribute('aria-pressed')).toBe('false');
  });

  // UT-10: select dropdowns update correctly
  test('UT-10: identity tier and join mode selects update form state', async () => {
    mockApiFetch.mockResolvedValue(makeGetResponse(null));

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Omnichannel')).toBeDefined();
    });

    // Change identity tier
    const tierSelect = screen.getByLabelText('Minimum identity tier') as HTMLSelectElement;
    expect(tierSelect.value).toBe('2');
    await act(async () => {
      fireEvent.change(tierSelect, { target: { value: '0' } });
    });
    expect(tierSelect.value).toBe('0');

    // Change join mode
    const joinModeSelect = screen.getByLabelText('Join mode') as HTMLSelectElement;
    expect(joinModeSelect.value).toBe('prompt');
    await act(async () => {
      fireEvent.change(joinModeSelect, { target: { value: 'auto' } });
    });
    expect(joinModeSelect.value).toBe('auto');

    // Save button should be enabled
    const saveBtn = screen.getByText('Save Settings').closest('button')!;
    expect(saveBtn.disabled).toBe(false);
  });
});
