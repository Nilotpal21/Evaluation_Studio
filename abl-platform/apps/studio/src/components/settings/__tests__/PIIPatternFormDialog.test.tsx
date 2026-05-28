/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIIPatternFormDialog, type IPIIPattern } from '../PIIPatternFormDialog';

const mockApiFetch = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (key === 'configure_builtin_title' && values?.name) {
      return `${namespace}.${key}:${String(values.name)}`;
    }
    if (key === 'detections_count' && values?.count !== undefined) {
      return `${String(values.count)} detections`;
    }
    return `${namespace}.${key}`;
  },
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
        aria-label={label}
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

const builtinDraftPattern: IPIIPattern = {
  _id: '',
  name: 'Email Address',
  piiType: 'email',
  redaction: {
    type: 'predefined',
    label: '[REDACTED_EMAIL]',
  },
  consumerAccess: [],
  defaultRenderMode: 'redacted',
  enabled: true,
  builtinOverride: true,
};

const customPattern: IPIIPattern = {
  _id: 'pattern-42',
  name: 'Employee ID',
  description: 'Protect employee identifiers',
  piiType: 'custom',
  regex: 'EMP-\\d{4}',
  validate: '^EMP-\\d{4}$',
  redaction: {
    type: 'predefined',
    label: '[EMPLOYEE_ID]',
  },
  consumerAccess: [],
  defaultRenderMode: 'redacted',
  enabled: true,
  builtinOverride: false,
};

const persistedBuiltinPattern: IPIIPattern = {
  ...builtinDraftPattern,
  _id: 'override-1',
  regex: '[^\\s]+@example\\.com',
  validate: '^.+@example\\.com$',
};

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

function renderDialog(overrides: Partial<React.ComponentProps<typeof PIIPatternFormDialog>> = {}) {
  const props: React.ComponentProps<typeof PIIPatternFormDialog> = {
    open: true,
    onClose: vi.fn(),
    onSave: vi.fn(),
    projectId: 'project-1',
    ...overrides,
  };

  return render(<PIIPatternFormDialog {...props} />);
}

describe('PIIPatternFormDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates first-time built-in overrides with POST instead of PUT', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { _id: 'pattern-1' } }),
    });

    const onSave = vi.fn();

    render(
      <PIIPatternFormDialog
        open={true}
        onClose={vi.fn()}
        onSave={onSave}
        pattern={builtinDraftPattern}
        projectId="project-1"
        builtinOverride={true}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.save_changes' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      builtinOverride: true,
      name: 'Email Address',
      piiType: 'email',
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('tests built-in overrides without requiring a stored regex', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          detections: [{ match: 'alice@example.com', index: 6, length: 17 }],
          consumerPreviews: { default: 'Email a***@example.com' },
        },
      }),
    });

    render(
      <PIIPatternFormDialog
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        pattern={builtinDraftPattern}
        projectId="project-1"
        builtinOverride={true}
      />,
    );

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
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns/test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      piiType: 'email',
      text: 'Email alice@example.com',
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('regex');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Email a***@example.com')).toBeInTheDocument();
  });

  it('creates custom patterns with POST and the entered detection fields', async () => {
    const onSave = vi.fn();
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({ success: true, data: { _id: 'pattern-42' } }, { status: 201 }),
    );

    renderDialog({ onSave });

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Employee ID' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: 'EMP-\\d{4}' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.validator_placeholder'),
      {
        target: { value: '^EMP-\\d{4}$' },
      },
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'Employee ID',
      piiType: 'custom',
      regex: 'EMP-\\d{4}',
      validate: '^EMP-\\d{4}$',
      builtinOverride: false,
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('updates existing custom patterns with PUT', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({ success: true, data: { _id: customPattern._id } }),
    );

    renderDialog({ pattern: customPattern });

    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.description_placeholder'),
      {
        target: { value: 'Updated employee identifier handling' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.save_changes' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns/pattern-42');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'Employee ID',
      description: 'Updated employee identifier handling',
      piiType: 'custom',
      regex: 'EMP-\\d{4}',
      validate: '^EMP-\\d{4}$',
      builtinOverride: false,
    });
  });

  it('updates persisted built-in overrides with PUT and preserves stored detection fields', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({ success: true, data: { _id: persistedBuiltinPattern._id } }),
    );

    renderDialog({
      pattern: persistedBuiltinPattern,
      builtinOverride: true,
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.save_changes' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns/override-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({
      builtinOverride: true,
      piiType: 'email',
      regex: '[^\\s]+@example\\.com',
      validate: '^.+@example\\.com$',
    });
  });

  it('blocks custom saves when the regex is missing', async () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Employee ID' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(
      screen.getByText('settings.pii_protection.form.error_regex_required'),
    ).toBeInTheDocument();
  });

  it('blocks custom saves when the regex is invalid', async () => {
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Employee ID' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: '[unterminated' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(
      screen.getByText('settings.pii_protection.form.error_invalid_regex'),
    ).toBeInTheDocument();
  });

  it('tests custom patterns with regex and validator payloads', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({
        success: true,
        data: {
          detections: [{ match: 'EMP-1234', index: 9, length: 8 }],
          consumerPreviews: { default: 'Employee [EMPLOYEE_ID]' },
        },
      }),
    );

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Employee ID' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: 'EMP-\\d{4}' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.validator_placeholder'),
      {
        target: { value: '^EMP-\\d{4}$' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.sample_text_placeholder'),
      {
        target: { value: 'Employee EMP-1234' },
      },
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.test_button' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/pii-patterns/test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      regex: 'EMP-\\d{4}',
      validate: '^EMP-\\d{4}$',
      piiType: 'custom',
      text: 'Employee EMP-1234',
    });
    expect(screen.getByText('EMP-1234')).toBeInTheDocument();
    expect(screen.getByText('Employee [EMPLOYEE_ID]')).toBeInTheDocument();
  });

  it('saves random redaction config and per-consumer overrides', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({ success: true, data: { _id: 'pattern-random' } }, { status: 201 }),
    );

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Session Token' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: 'tok_[A-Z0-9]+' },
      },
    );
    fireEvent.click(screen.getByLabelText('settings.pii_protection.form.redaction_random'));
    fireEvent.change(screen.getByLabelText('settings.pii_protection.form.charset'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g., ABC123!@#'), {
      target: { value: 'XYZ123' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.length_placeholder'),
      {
        target: { value: '8' },
      },
    );
    fireEvent.change(screen.getByLabelText('settings.pii_protection.form.default_render_mode'), {
      target: { value: 'tokenized' },
    });
    fireEvent.click(
      screen.getByText('settings.pii_protection.form.add_consumer').closest('button')!,
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.consumer_name_placeholder'),
      {
        target: { value: 'auditor' },
      },
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[selects.length - 1], { target: { value: 'masked' } });

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'Session Token',
      regex: 'tok_[A-Z0-9]+',
      defaultRenderMode: 'tokenized',
      redaction: {
        type: 'random',
        randomConfig: {
          charset: 'custom',
          customChars: 'XYZ123',
          length: 8,
        },
      },
      consumerAccess: [{ consumer: 'auditor', renderMode: 'masked' }],
    });
  });

  it('normalizes LLM original consumer access to tokenized before saving', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse({ success: true, data: { _id: 'pattern-safe-llm' } }, { status: 201 }),
    );

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Session Token' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: 'tok_[A-Z0-9]+' },
      },
    );

    expect(
      screen.getByText('settings.pii_protection.form.llm_original_notice'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByText('settings.pii_protection.form.add_consumer').closest('button')!,
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.consumer_name_placeholder'),
      {
        target: { value: ' LLM ' },
      },
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[selects.length - 1], { target: { value: 'original' } });

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      consumerAccess: [{ consumer: 'llm', renderMode: 'tokenized' }],
    });
  });

  it('adds an explicit LLM tokenized override when the default render mode is original', async () => {
    mockApiFetch.mockResolvedValue(
      makeJsonResponse(
        { success: true, data: { _id: 'pattern-default-original' } },
        { status: 201 },
      ),
    );

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText('settings.pii_protection.form.name_placeholder'), {
      target: { value: 'Account Number' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('settings.pii_protection.form.regex_placeholder'),
      {
        target: { value: 'acct_[0-9]+' },
      },
    );
    fireEvent.change(screen.getByLabelText('settings.pii_protection.form.default_render_mode'), {
      target: { value: 'original' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.pii_protection.form.create_pattern' }),
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      defaultRenderMode: 'original',
      consumerAccess: [{ consumer: 'llm', renderMode: 'tokenized' }],
    });
  });

  it('warns before disabling high-risk built-in patterns', () => {
    renderDialog({
      pattern: {
        ...builtinDraftPattern,
        name: 'Credit Card Number',
        piiType: 'credit_card',
        redaction: {
          type: 'predefined',
          label: '[REDACTED_CARD]',
        },
      },
      builtinOverride: true,
    });

    fireEvent.click(screen.getByLabelText('settings.pii_protection.form.enabled_label'));

    expect(
      screen.getByText('settings.pii_protection.form.high_risk_disable_warning'),
    ).toBeInTheDocument();
  });
});
