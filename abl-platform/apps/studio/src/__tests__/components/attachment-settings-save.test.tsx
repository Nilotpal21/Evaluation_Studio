/**
 * AttachmentSettingsTab Save & Validation Tests (UT-14 through UT-22)
 *
 * Tests save behavior, reset-to-default, MIME validation, success/error toasts,
 * and form state retention on save failure.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AttachmentSettingsTab } from '../../components/settings/AttachmentSettingsTab';

// =============================================================================
// MOCKS
// =============================================================================

const mockApiFetch = vi.fn();
vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockNavigationStore = { projectId: 'project-1' };
vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => mockNavigationStore,
}));

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({
  toast: mockToast,
}));

// =============================================================================
// HELPERS
// =============================================================================

const PLATFORM_DEFAULTS = {
  enabled: true,
  maxFileSizeBytes: 20 * 1024 * 1024,
  maxFilesPerSession: 100,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  piiPolicy: 'redact' as const,
  defaultProcessingMode: 'full' as const,
};

function makeApiResponse(
  resolved: Omit<typeof PLATFORM_DEFAULTS, 'piiPolicy'> & { piiPolicy: string } = PLATFORM_DEFAULTS,
  projectOverrides: Record<string, unknown> | null = null,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { resolved, projectOverrides },
    }),
  };
}

const messages = {
  settings: {
    attachments: {
      title: 'Attachment Settings',
      description: 'Configure file upload behavior for this project.',
      save: 'Save Changes',
      saved: 'Attachment settings saved',
      save_failed: 'Failed to save attachment settings',
      load_failed: 'Failed to load attachment settings',
      field_enabled: 'Enable Attachments',
      field_enabled_description: 'Allow file uploads in chat sessions.',
      field_max_file_size: 'Maximum File Size',
      field_max_file_size_description: 'Maximum file size per upload.',
      field_max_file_size_unit: 'MB',
      field_allowed_mime_types: 'Allowed File Types',
      field_allowed_mime_types_description: 'MIME types allowed for upload.',
      field_allowed_mime_types_add: 'Add MIME type...',
      field_pii_policy: 'PII Policy',
      field_pii_policy_description: 'How to handle PII detected in attachments.',
      field_processing_mode: 'Default Processing Mode',
      field_processing_mode_description: 'How newly uploaded files are processed.',
      field_max_files_per_session: 'Max Files Per Session',
      field_max_files_per_session_description: 'Maximum number of files per session (read-only).',
      indicator_inherited: 'Inherited from defaults',
      indicator_override: 'Custom override',
      reset_to_default: 'Reset to default',
      validation_mime_format: 'Invalid MIME type format (e.g., image/png)',
      validation_mime_duplicate: 'Duplicate MIME type',
      validation_mime_cap: 'Maximum 50 MIME types allowed',
      pii_redact: 'Redact',
      pii_block: 'Block',
      pii_allow: 'Allow',
      processing_full: 'Full',
      processing_metadata_only: 'Metadata Only',
      processing_skip: 'Skip',
      aria_toggle_enabled: 'Toggle attachments enabled',
      aria_reset_field: 'Reset {field} to default',
      aria_remove_mime: 'Remove MIME type {type}',
      aria_add_mime: 'Add MIME type',
    },
  },
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AttachmentSettingsTab />
    </NextIntlClientProvider>,
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe('AttachmentSettingsTab — Save & Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationStore.projectId = 'project-1';
    mockApiFetch.mockResolvedValue(makeApiResponse());
  });

  // UT-14: Save sends PUT with only changed fields
  test('UT-14: save sends PUT with only changed fields', async () => {
    // Mock save response
    const saveResponse = makeApiResponse(
      { ...PLATFORM_DEFAULTS, enabled: false },
      {
        enabled: false,
        maxFileSizeBytes: null,
        allowedMimeTypes: null,
        piiPolicy: null,
        defaultProcessingMode: null,
      },
    );

    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Toggle enabled off
    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Mock the PUT call
    mockApiFetch.mockResolvedValueOnce(saveResponse);

    // Click save
    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify PUT was called with only the changed field
    const putCall = mockApiFetch.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' && (call[1] as Record<string, unknown>).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as Record<string, string>).body);
    expect(body).toEqual({ enabled: false });
    // Should NOT include unchanged fields
    expect(body.maxFileSizeBytes).toBeUndefined();
    expect(body.piiPolicy).toBeUndefined();
  });

  // UT-15: Reset sends null for field
  test('UT-15: reset-to-default sends null for the reset field', async () => {
    // Start with an overridden field
    mockApiFetch.mockResolvedValue(
      makeApiResponse(
        { ...PLATFORM_DEFAULTS, piiPolicy: 'block' },
        {
          enabled: null,
          maxFileSizeBytes: null,
          allowedMimeTypes: null,
          piiPolicy: 'block',
          defaultProcessingMode: null,
        },
      ),
    );

    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Custom override')).toBeDefined();
    });

    // Click the reset button for the overridden field
    const resetBtn = screen.getByTitle('Reset to default');
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    // Mock the PUT response
    mockApiFetch.mockResolvedValueOnce(makeApiResponse());

    // Click save
    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify null was sent for the reset field
    const putCall = mockApiFetch.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' && (call[1] as Record<string, unknown>).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as Record<string, string>).body);
    expect(body.piiPolicy).toBeNull();
  });

  // UT-16: MIME format validation rejects invalid
  test('UT-16: MIME validation rejects invalid format', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const mimeInput = screen.getByPlaceholderText('Add MIME type...');
    await act(async () => {
      fireEvent.change(mimeInput, { target: { value: 'not-a-mime' } });
      fireEvent.keyDown(mimeInput, { key: 'Enter' });
    });

    expect(screen.getByText('Invalid MIME type format (e.g., image/png)')).toBeDefined();
  });

  // UT-17: MIME format validation accepts valid
  test('UT-17: MIME validation accepts valid format', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const mimeInput = screen.getByPlaceholderText('Add MIME type...');
    await act(async () => {
      fireEvent.change(mimeInput, { target: { value: 'text/html' } });
      fireEvent.keyDown(mimeInput, { key: 'Enter' });
    });

    expect(screen.getByText('text/html')).toBeDefined();
    expect(screen.queryByText('Invalid MIME type format (e.g., image/png)')).toBeNull();
  });

  // UT-18: 50 MIME cap enforced
  test('UT-18: MIME cap is enforced at 50 entries', async () => {
    // Start with 50 mime types
    const mimeTypes = Array.from({ length: 50 }, (_, i) => `type/mime${i}`);
    mockApiFetch.mockResolvedValue(
      makeApiResponse({ ...PLATFORM_DEFAULTS, allowedMimeTypes: mimeTypes }),
    );

    renderTab();

    await waitFor(() => {
      expect(screen.getByText('50 / 50')).toBeDefined();
    });

    const mimeInput = screen.getByPlaceholderText('Add MIME type...');
    await act(async () => {
      fireEvent.change(mimeInput, { target: { value: 'text/extra' } });
      fireEvent.keyDown(mimeInput, { key: 'Enter' });
    });

    expect(screen.getByText('Maximum 50 MIME types allowed')).toBeDefined();
  });

  // UT-19: Success toast on save
  test('UT-19: shows success toast after successful save', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Make a change
    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Mock save response
    mockApiFetch.mockResolvedValueOnce(
      makeApiResponse(
        { ...PLATFORM_DEFAULTS, enabled: false },
        {
          enabled: false,
          maxFileSizeBytes: null,
          allowedMimeTypes: null,
          piiPolicy: null,
          defaultProcessingMode: null,
        },
      ),
    );

    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Attachment settings saved');
    });
  });

  // UT-20: Error toast on failure
  test('UT-20: shows error toast on save failure', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Make a change
    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Mock save failure
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Bad request' } }),
    });

    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to save attachment settings');
    });
  });

  // UT-21: Form retains state on save failure
  test('UT-21: form retains dirty state on save failure', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Make a change
    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Mock save failure
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Server error' } }),
    });

    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });

    // Save button should still be enabled (form is still dirty)
    expect(saveBtn.disabled).toBe(false);
    // Toggle should still be off (user's change preserved)
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  // UT-22: Duplicate MIME rejected
  test('UT-22: duplicate MIME type is rejected', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const mimeInput = screen.getByPlaceholderText('Add MIME type...');

    // Try to add image/jpeg which already exists
    await act(async () => {
      fireEvent.change(mimeInput, { target: { value: 'image/jpeg' } });
      fireEvent.keyDown(mimeInput, { key: 'Enter' });
    });

    expect(screen.getByText('Duplicate MIME type')).toBeDefined();
  });
});
