import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { GuardrailProviderForm } from '../../components/admin/GuardrailProviderForm';
import type { GuardrailProvider } from '../../hooks/useGuardrails';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const mockAuthProfilePicker = vi.hoisted(() => vi.fn(() => null));
const mockAuthProfileToggle = vi.hoisted(() =>
  vi.fn(({ enabled, onToggle }: { enabled: boolean; onToggle: (enabled: boolean) => void }) => (
    <button type="button" onClick={() => onToggle(!enabled)}>
      auth-profile-toggle
    </button>
  )),
);
const mockProjectStoreState = vi.hoisted(() => ({
  currentProjectId: null as string | null,
  projects: [] as Array<{ id: string }>,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    label,
    options,
    value,
    onChange,
  }: {
    label?: string;
    options: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value)}
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

vi.mock('../../components/auth-profiles/AuthProfileToggle', () => ({
  AuthProfileToggle: mockAuthProfileToggle,
}));

vi.mock('../../components/auth-profiles/AuthProfilePicker', () => ({
  AuthProfilePicker: mockAuthProfilePicker,
}));

vi.mock('../../components/guardrails/GuardrailYamlEditor', () => ({
  GuardrailYamlEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (nextValue: string) => void;
  }) => (
    <textarea
      aria-label="guardrail-provider-yaml"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  toYaml: (value: unknown) => JSON.stringify(value, null, 2),
  fromYaml: (value: string) => JSON.parse(value),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: (
    selector: (state: { currentProjectId: string | null; projects: unknown[] }) => unknown,
  ) => selector(mockProjectStoreState),
}));

function makeProvider(overrides: Partial<GuardrailProvider> = {}): GuardrailProvider {
  return {
    _id: 'provider-a-id',
    name: 'provider-a',
    displayName: 'Provider A',
    adapterType: 'custom_http',
    endpoint: 'https://a.example.com/evaluate',
    model: 'moderation-a',
    hosting: 'cloud_api',
    defaultCategory: 'toxicity',
    defaultThreshold: 0.7,
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    },
    retry: {
      maxRetries: 3,
      backoffBaseMs: 1000,
    },
    supportedCategories: ['toxicity'],
    customMapping: {
      requestTemplate: '{"text": "{{content}}"}',
      responseScorePath: 'result.score',
      responseLabelPath: 'result.label',
      responseExplanationPath: 'result.reason',
    },
    selfHostedConfig: {
      runtime: 'vllm',
      maxConcurrency: 8,
    },
    costPerEvalUsd: 0.002,
    isActive: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('GuardrailProviderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStoreState.currentProjectId = null;
    mockProjectStoreState.projects = [];
  });

  test('submits canonical runtime resilience shape from form fields', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('guardrails.provider_name_label'), 'tenant-provider');
    await user.type(screen.getByLabelText('guardrails.display_name_label'), 'Tenant Provider');
    await user.type(screen.getByLabelText('guardrails.endpoint_label'), 'https://eval.example.com');
    await user.type(screen.getByLabelText('guardrails.model_label'), 'moderation-v1');

    await user.click(screen.getByRole('button', { name: 'guardrails.add_provider' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tenant-provider',
        displayName: 'Tenant Provider',
        circuitBreaker: {
          failureThreshold: 5,
          resetTimeoutMs: 30_000,
        },
        retry: {
          maxRetries: 3,
          backoffBaseMs: 1000,
        },
      }),
    );
  });

  test('does not render or submit unsupported raw API key fields', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.queryByLabelText('guardrails.api_key_label')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('guardrails.provider_name_label'), 'tenant-provider');
    await user.type(screen.getByLabelText('guardrails.display_name_label'), 'Tenant Provider');
    await user.type(screen.getByLabelText('guardrails.endpoint_label'), 'https://eval.example.com');
    await user.type(screen.getByLabelText('guardrails.model_label'), 'moderation-v1');

    await user.click(screen.getByRole('button', { name: 'guardrails.add_provider' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  test('rehydrates state when editing a different provider and clears for create mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const first = makeProvider({
      _id: 'provider-a-id',
      name: 'provider-a',
      displayName: 'Provider A',
    });
    const second = makeProvider({
      _id: 'provider-b-id',
      name: 'provider-b',
      displayName: 'Provider B',
    });

    const { rerender } = render(
      <GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} initial={first} />,
    );

    expect(screen.getByDisplayValue('provider-a')).toBeInTheDocument();

    rerender(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} initial={second} />);

    expect(await screen.findByDisplayValue('provider-b')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('provider-a')).not.toBeInTheDocument();

    rerender(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.getByLabelText('guardrails.provider_name_label')).toHaveValue('');
    expect(screen.getByLabelText('guardrails.display_name_label')).toHaveValue('');
  });

  test('preserves advanced provider contract fields when editing through the form tab', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const initial = makeProvider({
      circuitBreaker: {
        failureThreshold: 9,
        resetTimeoutMs: 45_000,
        failMode: 'closed',
      },
    });

    render(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} initial={initial} />);

    await user.click(screen.getByRole('button', { name: 'guardrails.update_provider' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedCategories: ['toxicity'],
        customMapping: {
          requestTemplate: '{"text": "{{content}}"}',
          responseScorePath: 'result.score',
          responseLabelPath: 'result.label',
          responseExplanationPath: 'result.reason',
        },
        selfHostedConfig: {
          runtime: 'vllm',
          maxConcurrency: 8,
        },
        costPerEvalUsd: 0.002,
        circuitBreaker: {
          failureThreshold: 9,
          resetTimeoutMs: 45_000,
          failMode: 'closed',
        },
      }),
    );
  });

  test('filters auth profile picker to tenant-scoped shared profiles for tenant provider configs', () => {
    mockProjectStoreState.currentProjectId = 'project-1';

    render(
      <GuardrailProviderForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        initial={makeProvider({ adapterType: 'openai_moderation', authProfileId: 'profile-old' })}
      />,
    );

    expect(mockAuthProfilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        filterStatus: 'active',
        filterScope: 'tenant',
        filterVisibility: 'shared',
        filterAuthTypes: ['api_key', 'bearer'],
      }),
      undefined,
    );
  });

  test('submits null authProfileId when a user clears auth on an existing provider', async () => {
    mockProjectStoreState.currentProjectId = 'project-1';
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailProviderForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={makeProvider({ adapterType: 'openai_moderation', authProfileId: 'profile-old' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'auth-profile-toggle' }));
    await user.click(screen.getByRole('button', { name: 'guardrails.update_provider' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: null,
      }),
    );
  });

  test('submits advanced provider fields from YAML instead of whitelisting them away', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<GuardrailProviderForm open onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'YAML' }));
    fireEvent.change(screen.getByLabelText('guardrail-provider-yaml'), {
      target: {
        value: JSON.stringify({
          name: 'yaml-provider',
          displayName: 'YAML Provider',
          adapterType: 'custom_http',
          endpoint: 'https://guardrails.example.com/evaluate',
          model: 'content-safety',
          hosting: 'cloud_api',
          defaultCategory: 'toxicity',
          defaultThreshold: 0.7,
          supportedCategories: ['toxicity', 'self_harm'],
          customMapping: {
            requestTemplate: '{"content": "{{content}}", "category": "{{category}}"}',
            responseScorePath: 'moderation.score',
            responseLabelPath: 'moderation.label',
          },
          selfHostedConfig: { runtime: 'ollama', maxConcurrency: 4 },
          costPerEvalUsd: 0.004,
          circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000, failMode: 'closed' },
          retry: { maxRetries: 1, backoffBaseMs: 250 },
          isActive: true,
        }),
      },
    });

    await user.click(screen.getByRole('button', { name: 'guardrails.add_provider' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'yaml-provider',
        supportedCategories: ['toxicity', 'self_harm'],
        customMapping: {
          requestTemplate: '{"content": "{{content}}", "category": "{{category}}"}',
          responseScorePath: 'moderation.score',
          responseLabelPath: 'moderation.label',
        },
        selfHostedConfig: { runtime: 'ollama', maxConcurrency: 4 },
        costPerEvalUsd: 0.004,
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000, failMode: 'closed' },
      }),
    );
  });
});
