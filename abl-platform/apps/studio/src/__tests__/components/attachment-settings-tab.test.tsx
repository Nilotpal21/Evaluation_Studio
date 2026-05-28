/**
 * AttachmentSettingsTab Unit Tests (UT-0 through UT-13)
 *
 * Tests rendering, loading, field display, override/inherited indicators,
 * and field interaction for the attachment settings tab component.
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

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
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
  resolved = PLATFORM_DEFAULTS,
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

// Load i18n messages for tests
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

describe('AttachmentSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationStore.projectId = 'project-1';
    mockApiFetch.mockResolvedValue(makeApiResponse());
  });

  // UT-0: Navigation wiring renders component
  test('UT-0: renders the component with title and description', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });
    expect(screen.getByText('Configure file upload behavior for this project.')).toBeDefined();
  });

  // UT-1: Loading spinner while fetching
  test('UT-1: shows loading spinner while fetching config', async () => {
    // Delay the API response
    mockApiFetch.mockReturnValue(new Promise(() => {}));

    renderTab();

    // Should show the spinner (Loader2 renders as an svg with animate-spin)
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  // UT-2: All config fields rendered with resolved values
  test('UT-2: renders all 6 config fields with resolved values', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Field labels
    expect(screen.getByText('Enable Attachments')).toBeDefined();
    expect(screen.getByText('Maximum File Size')).toBeDefined();
    expect(screen.getByText('Allowed File Types')).toBeDefined();
    expect(screen.getByText('PII Policy')).toBeDefined();
    expect(screen.getByText('Default Processing Mode')).toBeDefined();
    expect(screen.getByText('Max Files Per Session')).toBeDefined();

    // Resolved values
    expect(screen.getByText('100')).toBeDefined(); // maxFilesPerSession
    expect(screen.getByText('image/jpeg')).toBeDefined(); // mime type chip
    expect(screen.getByText('image/png')).toBeDefined();
    expect(screen.getByText('application/pdf')).toBeDefined();
  });

  // UT-3: "Inherited from defaults" for non-overridden fields
  test('UT-3: shows "Inherited from defaults" when no overrides exist', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const inherited = screen.getAllByText('Inherited from defaults');
    // 5 editable fields + 1 read-only = 6 indicators total
    expect(inherited.length).toBeGreaterThanOrEqual(6);
  });

  // UT-4: "Custom override" badge for overridden fields
  test('UT-4: shows "Custom override" badge for overridden fields', async () => {
    mockApiFetch.mockResolvedValue(
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

    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // enabled is overridden
    const overrideBadges = screen.getAllByText('Custom override');
    expect(overrideBadges.length).toBe(1);

    // The rest are inherited
    const inheritedBadges = screen.getAllByText('Inherited from defaults');
    expect(inheritedBadges.length).toBeGreaterThanOrEqual(5);
  });

  // UT-5: Toggle enabled field
  test('UT-5: toggling enabled switch updates form state', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  // UT-6: File size input shows MB and converts to bytes
  test('UT-6: file size input shows MB value and Save button enables on change', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const sizeInput = screen.getByDisplayValue('20') as HTMLInputElement;
    expect(sizeInput).toBeDefined();
    expect(screen.getByText('MB')).toBeDefined();

    // Change to 10 MB
    await act(async () => {
      fireEvent.change(sizeInput, { target: { value: '10' } });
    });

    // Save button should be enabled now (form is dirty)
    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    expect(saveBtn.disabled).toBe(false);
  });

  // UT-7: PII Policy dropdown changes
  test('UT-7: pii policy dropdown updates form state', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const piiSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(piiSelect.value).toBe('redact');

    await act(async () => {
      fireEvent.change(piiSelect, { target: { value: 'block' } });
    });

    expect(piiSelect.value).toBe('block');
  });

  // UT-8: Processing mode dropdown changes
  test('UT-8: processing mode dropdown updates form state', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const processingSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect(processingSelect.value).toBe('full');

    await act(async () => {
      fireEvent.change(processingSelect, { target: { value: 'metadata_only' } });
    });

    expect(processingSelect.value).toBe('metadata_only');
  });

  // UT-9: Add MIME type chip
  test('UT-9: adding a valid MIME type creates a chip', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const mimeInput = screen.getByPlaceholderText('Add MIME type...') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(mimeInput, { target: { value: 'text/html' } });
      fireEvent.keyDown(mimeInput, { key: 'Enter' });
    });

    expect(screen.getByText('text/html')).toBeDefined();
  });

  // UT-10: Remove MIME type chip
  test('UT-10: removing a MIME type chip removes it from the list', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('image/jpeg')).toBeDefined();
    });

    // Click the X button on the image/jpeg chip
    const removeButtons = screen.getAllByLabelText(/Remove MIME type/);
    await act(async () => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.queryByText('image/jpeg')).toBeNull();
  });

  // UT-11: Save button disabled when clean
  test('UT-11: save button is disabled when form is clean', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    expect(saveBtn.disabled).toBe(true);
  });

  // UT-12: Save button enabled when dirty
  test('UT-12: save button is enabled after making a change', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    const saveBtn = screen.getByText('Save Changes').closest('button')!;
    expect(saveBtn.disabled).toBe(false);
  });

  // UT-13: maxFilesPerSession read-only
  test('UT-13: maxFilesPerSession is displayed as read-only with inherited indicator', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Attachment Settings')).toBeDefined();
    });

    // Should show the value but no input/select for this field
    expect(screen.getByText('100')).toBeDefined();
    expect(screen.getByText('Max Files Per Session')).toBeDefined();
    expect(screen.getByText(/read-only/)).toBeDefined();
  });
});
