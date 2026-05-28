/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIIProtectionTab } from '../PIIProtectionTab';
import type { IPIIPattern } from '../PIIPatternFormDialog';

const mockApiFetch = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (key === 'configure_builtin_title' && values?.name) {
      return `${namespace}.${key}:${String(values.name)}`;
    }
    if (key === 'delete_confirm_title' && values?.name) {
      return `${namespace}.${key}:${String(values.name)}`;
    }
    if (key === 'deleted' && values?.name) {
      return `${namespace}.${key}:${String(values.name)}`;
    }
    if (key === 'detections_count' && values?.count !== undefined) {
      return `${String(values.count)} detections`;
    }
    return `${namespace}.${key}`;
  },
}));

vi.mock('../../../store/navigation-store', () => ({
  useNavigationStore: () => ({ projectId: 'project-1' }),
}));

vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../../lib/sanitize-error', () => ({
  sanitizeError: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../ui/Dialog', () => ({
  Dialog: ({
    children,
    open,
    title,
  }: {
    children: React.ReactNode;
    open: boolean;
    title?: string;
  }) =>
    open ? (
      <div aria-label={title} role="dialog">
        {children}
      </div>
    ) : null,
}));

vi.mock('../../ui/Button', () => ({
  Button: ({
    children,
    disabled,
    loading,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled || loading} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock('../../ui/Select', () => ({
  Select: ({
    disabled,
    label,
    onChange,
    options,
    value,
  }: {
    disabled?: boolean;
    label?: string;
    onChange?: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value?: string;
  }) => (
    <label>
      {label}
      <select
        aria-label={label ?? 'select'}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
        value={value ?? ''}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock('../../ui/RadioGroup', () => ({
  RadioGroup: ({
    onChange,
    options,
    value,
  }: {
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value: string;
  }) => (
    <div>
      {options.map((option) => (
        <label key={option.value}>
          <input
            checked={value === option.value}
            name="redaction-type"
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </div>
  ),
}));

vi.mock('../../ui/Toggle', () => ({
  Toggle: ({
    checked,
    label,
    onChange,
  }: {
    checked: boolean;
    label?: string;
    onChange: (checked: boolean) => void;
  }) => (
    <label>
      {label}
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  ),
}));

vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    confirmLabel,
    description,
    loading,
    onClose,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel?: string;
    description: string;
    loading?: boolean;
    onClose: () => void;
    onConfirm: () => void;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div aria-label={title} role="alertdialog">
        <p>{description}</p>
        <button onClick={onClose} type="button">
          close
        </button>
        <button disabled={loading} onClick={onConfirm} type="button">
          {confirmLabel ?? 'confirm'}
        </button>
      </div>
    ) : null,
}));

vi.mock('../../ui/EmptyState', () => ({
  EmptyState: ({
    action,
    description,
    title,
  }: {
    action?: React.ReactNode;
    description?: string;
    title: string;
  }) => (
    <div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  ),
}));

function makeJsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

function makePattern(overrides: Partial<IPIIPattern> = {}): IPIIPattern {
  return {
    _id: 'custom-1',
    name: 'Customer Email',
    description: 'Mask customer email addresses',
    piiType: 'custom',
    regex: '[^\\s]+@example\\.com',
    validate: '^.+@example\\.com$',
    redaction: {
      type: 'predefined',
      label: '[REDACTED_EMAIL]',
    },
    consumerAccess: [],
    defaultRenderMode: 'redacted',
    enabled: true,
    builtinOverride: false,
    ...overrides,
  };
}

function getConfigureButtons(): HTMLButtonElement[] {
  return screen
    .getAllByRole('button')
    .filter(
      (button): button is HTMLButtonElement =>
        button instanceof HTMLButtonElement &&
        button.textContent?.includes('settings.pii_protection.configure') === true,
    );
}

describe('PIIProtectionTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows baseline scrubbing and configurable built-in pattern guidance', async () => {
    mockApiFetch.mockResolvedValue(makeJsonResponse({ success: true, data: [] }));

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(
        screen.getByText('settings.pii_protection.baseline_secret_scrubbing_notice'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('settings.pii_protection.builtin_info')).toBeInTheDocument();
    expect(screen.getByText('settings.pii_protection.empty_description')).toBeInTheDocument();
  });

  it('loads and persists global PII runtime settings', async () => {
    const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, url, body });

      if (url === '/api/projects/project-1/pii-patterns' && method === 'GET') {
        return makeJsonResponse({ success: true, data: [] });
      }

      if (url === '/api/projects/project-1/runtime-config' && method === 'GET') {
        return makeJsonResponse({
          success: true,
          data: {
            pii_redaction: {
              enabled: true,
              redact_input: true,
              redact_output: false,
            },
          },
        });
      }

      if (url === '/api/projects/project-1/runtime-config' && method === 'PUT') {
        return makeJsonResponse({
          success: true,
          data: {
            pii_redaction: body?.pii_redaction,
          },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(
        screen.getByText('settings.pii_protection.baseline_secret_scrubbing_notice'),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[];
      expect(toggles[0].checked).toBe(true);
      expect(toggles[1].checked).toBe(false);
    });

    fireEvent.click((screen.getAllByRole('checkbox') as HTMLInputElement[])[1]);

    await waitFor(() => {
      expect(requests).toContainEqual({
        method: 'PUT',
        url: '/api/projects/project-1/runtime-config',
        body: {
          pii_redaction: {
            enabled: true,
            redact_input: true,
            redact_output: true,
          },
        },
      });
    });
  });

  it('creates and then updates a built-in override through the settings tab flow', async () => {
    let storedPatterns: IPIIPattern[] = [];
    const previewRequests: Array<Record<string, unknown>> = [];
    const saveRequests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (url === '/api/projects/project-1/pii-patterns' && method === 'GET') {
        return makeJsonResponse({ success: true, data: storedPatterns });
      }

      if (url === '/api/projects/project-1/pii-patterns/test' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        previewRequests.push(body);
        return makeJsonResponse({
          success: true,
          data: {
            detections: [{ match: 'alice@example.com', index: 6, length: 17 }],
            consumerPreviews: { default: 'Email a***@example.com' },
          },
        });
      }

      if (url === '/api/projects/project-1/pii-patterns' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        saveRequests.push({ method, url, body });
        storedPatterns = [{ ...(body as IPIIPattern), _id: 'override-1' }];
        return makeJsonResponse(
          {
            success: true,
            data: storedPatterns[0],
          },
          { status: 201 },
        );
      }

      if (url === '/api/projects/project-1/pii-patterns/override-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        saveRequests.push({ method, url, body });
        storedPatterns = [{ ...storedPatterns[0], ...(body as Partial<IPIIPattern>) }];
        return makeJsonResponse({
          success: true,
          data: storedPatterns[0],
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<PIIProtectionTab />);

    const configureButtons = await waitFor(() => {
      const buttons = getConfigureButtons();
      expect(buttons.length).toBeGreaterThan(0);
      return buttons;
    });

    fireEvent.click(configureButtons[0]);

    expect(
      screen.getByRole('dialog', {
        name: 'settings.pii_protection.form.configure_builtin_title:settings.pii_protection.builtin_email_name',
      }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('settings.pii_protection.builtin_email_name')).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.sample_text_placeholder'),
      {
        target: { value: 'Email alice@example.com' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.test_button' }),
    );

    await waitFor(() => {
      expect(previewRequests).toHaveLength(1);
    });

    expect(previewRequests[0]).toMatchObject({
      piiType: 'email',
      text: 'Email alice@example.com',
    });
    expect(previewRequests[0]).not.toHaveProperty('regex');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Email a***@example.com')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.save_changes' }),
    );

    await waitFor(() => {
      expect(saveRequests).toHaveLength(1);
    });

    expect(saveRequests[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/project-1/pii-patterns',
      body: expect.objectContaining({
        builtinOverride: true,
        name: 'settings.pii_protection.builtin_email_name',
        piiType: 'email',
      }),
    });
    await waitFor(() => {
      expect(screen.getByText('settings.pii_protection.customized')).toBeInTheDocument();
    });

    fireEvent.click(
      (
        await waitFor(() => {
          const buttons = getConfigureButtons();
          expect(buttons.length).toBeGreaterThan(0);
          return buttons;
        })
      )[0],
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.save_changes' }),
    );

    await waitFor(() => {
      expect(saveRequests).toHaveLength(2);
    });

    expect(saveRequests[1]).toMatchObject({
      method: 'PUT',
      url: '/api/projects/project-1/pii-patterns/override-1',
    });
  });

  it('rolls back optimistic toggle updates when saving the enabled flag fails', async () => {
    const storedPatterns = [makePattern()];

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (url === '/api/projects/project-1/pii-patterns' && method === 'GET') {
        return makeJsonResponse({ success: true, data: storedPatterns });
      }

      if (url === '/api/projects/project-1/pii-patterns/custom-1' && method === 'PUT') {
        return makeJsonResponse(
          { success: false, error: { message: 'Update failed' } },
          { ok: false, status: 500 },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(screen.getByText('Customer Email')).toBeInTheDocument();
    });

    const getCustomToggle = () => screen.getAllByRole('checkbox')[2] as HTMLInputElement;
    expect(getCustomToggle().checked).toBe(true);

    fireEvent.click(getCustomToggle());
    expect(getCustomToggle().checked).toBe(false);

    await waitFor(() => {
      expect(getCustomToggle().checked).toBe(true);
    });
    expect(mockToastError).toHaveBeenCalledWith('settings.pii_protection.update_failed');
  });

  it('deletes a custom pattern after confirmation and removes it from the list', async () => {
    let storedPatterns = [makePattern()];

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (url === '/api/projects/project-1/pii-patterns' && method === 'GET') {
        return makeJsonResponse({ success: true, data: storedPatterns });
      }

      if (url === '/api/projects/project-1/pii-patterns/custom-1' && method === 'DELETE') {
        storedPatterns = [];
        return makeJsonResponse({ success: true, data: { id: 'custom-1' } });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(screen.getByText('Customer Email')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('settings.pii_protection.delete'));

    const confirmDialog = screen.getByRole('alertdialog', {
      name: 'settings.pii_protection.delete_confirm_title:Customer Email',
    });
    fireEvent.click(
      within(confirmDialog).getByRole('button', { name: 'settings.pii_protection.delete' }),
    );

    await waitFor(() => {
      expect(screen.queryByText('Customer Email')).not.toBeInTheDocument();
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('settings.pii_protection.deleted:Customer Email');
  });

  it('keeps the pattern visible and shows an error when delete fails', async () => {
    const storedPatterns = [makePattern()];

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (url === '/api/projects/project-1/pii-patterns' && method === 'GET') {
        return makeJsonResponse({ success: true, data: storedPatterns });
      }

      if (url === '/api/projects/project-1/pii-patterns/custom-1' && method === 'DELETE') {
        throw new Error('delete failed');
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(screen.getByText('Customer Email')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('settings.pii_protection.delete'));

    const confirmDialog = screen.getByRole('alertdialog', {
      name: 'settings.pii_protection.delete_confirm_title:Customer Email',
    });
    fireEvent.click(
      within(confirmDialog).getByRole('button', { name: 'settings.pii_protection.delete' }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('settings.pii_protection.delete_failed');
    });
    expect(screen.getByText('Customer Email')).toBeInTheDocument();
  });

  it('shows a toast when the initial pattern load fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('network down'));

    render(<PIIProtectionTab />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('settings.pii_protection.load_failed');
    });
  });
});
