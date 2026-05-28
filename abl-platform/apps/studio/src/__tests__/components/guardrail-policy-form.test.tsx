import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { GuardrailPolicyForm } from '../../components/guardrails/GuardrailPolicyForm';
import type { GuardrailPolicy } from '../../hooks/useGuardrails';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const mockUseGuardrailProviders = vi.hoisted(() => vi.fn());
const mockFetchRuntimeAgents = vi.hoisted(() => vi.fn());

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

vi.mock('../../hooks/useGuardrails', () => ({
  useGuardrailProviders: () => mockUseGuardrailProviders(),
}));

vi.mock('../../api/runtime-agents', () => ({
  fetchRuntimeAgents: (...args: unknown[]) => mockFetchRuntimeAgents(...args),
}));

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string | undefined) => void;
  }) => (
    <textarea
      data-testid="mock-monaco-editor"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const defaultSettings: NonNullable<GuardrailPolicy['settings']> = {
  failMode: 'closed',
  timeouts: {
    local: 123,
    model: 456,
    llm: 789,
  },
  streaming: {
    enabled: true,
    defaultInterval: 'token',
    chunkSize: 64,
    maxLatencyMs: 321,
    earlyTermination: false,
  },
};

function makePolicy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    _id: 'policy-1',
    name: 'existing-policy',
    description: 'Existing description',
    rules: [
      {
        guardrailName: 'content_safety',
        override: 'define',
        kind: 'input',
        provider: 'provider-a',
        category: 'hate',
        threshold: 0.9,
        action: { type: 'block', message: 'Blocked by provider' },
      },
      {
        guardrailName: 'custom_rule',
        override: 'define',
        kind: 'output',
        check: 'true',
        threshold: 0.8,
        action: { type: 'warn', message: 'Warn from custom rule' },
      },
    ],
    isActive: true,
    scope: {
      type: 'agent',
      projectId: 'project-1',
      agentDefId: 'agent-42',
    },
    status: 'active',
    settings: defaultSettings,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('GuardrailPolicyForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'provider-a', displayName: 'Provider A' }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
  });

  test('preserves existing rules and settings when editing a stored policy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={makePolicy()}
        projectId="project-1"
        agents={[{ value: 'agent-42', label: 'agent-42' }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('existing-policy')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'existing-policy',
        description: 'Existing description',
        scopeType: 'agent',
        agentDefId: 'agent-42',
        status: 'active',
        settings: expect.objectContaining({
          failMode: 'closed',
          timeouts: {
            local: 123,
            model: 456,
            llm: 789,
          },
          streaming: {
            enabled: true,
            defaultInterval: 'token',
            chunkSize: 64,
            maxLatencyMs: 321,
            earlyTermination: false,
          },
        }),
        rules: expect.arrayContaining([
          expect.objectContaining({
            guardrailName: 'content_safety',
            override: 'define',
            kind: 'input',
            provider: 'provider-a',
            category: 'hate',
            threshold: 0.9,
          }),
          expect.objectContaining({
            guardrailName: 'custom_rule',
            override: 'define',
            kind: 'output',
            check: 'true',
            threshold: 0.8,
          }),
        ]),
      }),
    );

    const submittedPayload = onSubmit.mock.calls[0][0] as {
      rules: Array<Record<string, unknown>>;
    };
    expect(submittedPayload.rules).toHaveLength(2);
  });

  test('preserves advanced policy fields when editing a stored policy in the form view', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const richPolicy = Object.assign(makePolicy(), {
      providerOverrides: [
        {
          providerName: 'provider-a',
          endpoint: 'https://moderation.example',
          defaultCategory: 'self_harm',
          defaultThreshold: 0.77,
          costPerEvalUsd: 0.04,
          isActive: true,
        },
      ],
      constitution: [
        {
          principle: 'Do not reveal secrets',
          weight: 0.9,
          examples: ['Never output credentials'],
        },
      ],
      caching: {
        enabled: true,
        exactMatch: true,
        semanticMatch: false,
        semanticThreshold: 0.95,
        defaultTtlSeconds: 900,
      },
      budget: {
        monthlyLimitUsd: 25,
        currentSpendUsd: 3.5,
        overspendAction: 'downgrade',
      },
    }) as GuardrailPolicy;

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={richPolicy}
        projectId="project-1"
        agents={[{ value: 'agent-42', label: 'agent-42' }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('existing-policy')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOverrides: [
          expect.objectContaining({
            providerName: 'provider-a',
            endpoint: 'https://moderation.example',
            defaultCategory: 'self_harm',
            defaultThreshold: 0.77,
            costPerEvalUsd: 0.04,
            isActive: true,
          }),
        ],
        constitution: [
          expect.objectContaining({
            principle: 'Do not reveal secrets',
            weight: 0.9,
            examples: ['Never output credentials'],
          }),
        ],
        caching: expect.objectContaining({
          enabled: true,
          exactMatch: true,
          semanticMatch: false,
          semanticThreshold: 0.95,
          defaultTtlSeconds: 900,
        }),
        budget: expect.objectContaining({
          monthlyLimitUsd: 25,
          currentSpendUsd: 3.5,
          overspendAction: 'downgrade',
        }),
      }),
    );
  });

  test('offers only runtime-available providers for provider-backed rules', async () => {
    mockUseGuardrailProviders.mockReturnValue({
      providers: [
        { name: 'provider-a', displayName: 'Provider A', isActive: true },
        { name: 'inactive-provider', displayName: 'Inactive Provider', isActive: false },
      ],
    });

    render(<GuardrailPolicyForm open onClose={vi.fn()} onSubmit={vi.fn()} projectId="project-1" />);

    await userEvent.click(screen.getByRole('button', { name: /content safety/i }));

    const providerSelect = screen.getByLabelText('Provider') as HTMLSelectElement;
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent);

    expect(optionLabels).toContain('Provider A');
    expect(optionLabels).toContain('Built-in PII');
    expect(optionLabels).not.toContain('Inactive Provider');
  });

  test('refreshes the form state when the edit target changes on a mounted dialog', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const firstPolicy = makePolicy({ _id: 'policy-a', name: 'policy-a', description: 'first' });
    const secondPolicy = makePolicy({
      _id: 'policy-b',
      name: 'policy-b',
      description: 'second',
      scope: { type: 'project', projectId: 'project-1' },
      status: 'draft',
      isActive: false,
      settings: {
        failMode: 'open',
        timeouts: { local: 11, model: 22, llm: 33 },
        streaming: {
          enabled: false,
          defaultInterval: 'sentence',
          chunkSize: 256,
          maxLatencyMs: 500,
          earlyTermination: true,
        },
      },
      rules: [],
    });

    const { rerender } = render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={firstPolicy}
        projectId="project-1"
      />,
    );

    expect(screen.getByDisplayValue('policy-a')).toBeInTheDocument();

    rerender(
      <GuardrailPolicyForm
        open={false}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={firstPolicy}
        projectId="project-1"
      />,
    );

    rerender(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={secondPolicy}
        projectId="project-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('policy-b')).toBeInTheDocument();
      expect(screen.getByDisplayValue('second')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'policy-b',
        description: 'second',
        scopeType: 'project',
        status: 'draft',
      }),
    );
  });

  test('preserves archived status when editing an archived policy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={makePolicy({
          status: 'archived',
          isActive: false,
          scope: { type: 'project', projectId: 'project-1' },
          rules: [],
        })}
        projectId="project-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('existing-policy')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'archived',
      }),
    );
  });

  test('preserves YAML-authored rules when switching back to the form before submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^yaml$/i }));

    const yamlEditor = await screen.findByTestId('mock-monaco-editor');

    fireEvent.change(yamlEditor, {
      target: {
        value: `name: yaml-policy
description: Authored in YAML
scopeType: project
status: draft
rules:
  - guardrailName: yaml_rule
    override: define
    kind: input
    check: "true"
    threshold: 0.7
    action:
      type: warn
      message: YAML warning
settings:
  failMode: open
  timeouts:
    local: 101
    model: 202
    llm: 303
  streaming:
    enabled: false
    defaultInterval: sentence
    chunkSize: 256
    maxLatencyMs: 500
    earlyTermination: true
`,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /^form$/i }));
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'yaml-policy',
        description: 'Authored in YAML',
        rules: [
          expect.objectContaining({
            guardrailName: 'yaml_rule',
            override: 'define',
            kind: 'input',
            check: 'true',
            threshold: 0.7,
          }),
        ],
      }),
    );
  });

  test('allows creating a valid YAML policy without stale form name state', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^yaml$/i }));
    const yamlEditor = await screen.findByTestId('mock-monaco-editor');
    fireEvent.change(yamlEditor, {
      target: {
        value: `name: yaml-only-policy
scopeType: project
status: draft
rules:
  - guardrailName: yaml_only_rule
    override: define
    kind: input
    check: "true"
    threshold: 0.7
    action:
      type: warn
settings:
  failMode: open
  timeouts:
    local: 101
    model: 202
    llm: 303
`,
      },
    });

    const submit = screen.getByRole('button', { name: /create policy/i });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'yaml-only-policy',
        scopeType: 'project',
        rules: [
          expect.objectContaining({
            guardrailName: 'yaml_only_rule',
            check: 'true',
          }),
        ],
      }),
    );
  });

  test('preserves unsupported override and non-chat execution rules when editing in the form view', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const policyWithUnsupportedRules = makePolicy({
      rules: [
        {
          guardrailName: 'disabled_rule',
          override: 'disable',
        },
        {
          guardrailName: 'tool_guardrail',
          override: 'define',
          kind: 'tool_input',
          check: 'true',
          threshold: 0.6,
          action: { type: 'block', message: 'Tool input blocked' },
        },
        {
          guardrailName: 'severity_override_rule',
          override: 'severity_actions',
          severityActions: {
            high: { type: 'block', message: 'High severity blocked' },
            medium: { type: 'warn', message: 'Medium severity warned' },
          },
        },
      ],
    });

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={policyWithUnsupportedRules}
        projectId="project-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('existing-policy')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({
            guardrailName: 'disabled_rule',
            override: 'disable',
          }),
          expect.objectContaining({
            guardrailName: 'tool_guardrail',
            override: 'define',
            kind: 'tool_input',
            check: 'true',
            threshold: 0.6,
          }),
          expect.objectContaining({
            guardrailName: 'severity_override_rule',
            override: 'severity_actions',
            severityActions: expect.objectContaining({
              high: expect.objectContaining({ type: 'block' }),
              medium: expect.objectContaining({ type: 'warn' }),
            }),
          }),
        ]),
      }),
    );
  });

  test('preserves tenant scope when switching YAML back to the form before submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^yaml$/i }));

    const yamlEditor = await screen.findByTestId('mock-monaco-editor');

    fireEvent.change(yamlEditor, {
      target: {
        value: `name: tenant-policy
description: Tenant baseline
scope:
  type: tenant
status: active
rules:
  - guardrailName: tenant_rule
    override: define
    kind: input
    check: "true"
    threshold: 0.7
    action:
      type: warn
      message: Tenant warning
settings:
  failMode: open
  timeouts:
    local: 100
    model: 200
    llm: 300
  streaming:
    enabled: false
    defaultInterval: sentence
    chunkSize: 256
    maxLatencyMs: 500
    earlyTermination: true
`,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /^form$/i }));
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tenant-policy',
        scopeType: 'tenant',
        status: 'active',
      }),
    );
  });

  test('omits incomplete custom rules from form submissions', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    fireEvent.change(screen.getByLabelText(/policy name/i), {
      target: { value: 'policy-with-incomplete-rule' },
    });
    await user.click(screen.getByRole('button', { name: /add custom rule/i }));
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'policy-with-incomplete-rule',
        rules: [],
      }),
    );
  });

  test('loads project agents and submits agent-scoped policies with the selected agent name', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    mockFetchRuntimeAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          name: 'booking_agent',
          agentPath: '/agents/booking',
          description: null,
          dslContent: null,
          activeVersions: {},
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
    });

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    await waitFor(() => {
      expect(mockFetchRuntimeAgents).toHaveBeenCalledWith('project-1');
    });

    fireEvent.change(screen.getByLabelText(/policy name/i), {
      target: { value: 'agent-policy' },
    });

    await user.click(screen.getByText(/agent \(specific\)/i));
    await user.selectOptions(screen.getByLabelText(/select agent/i), 'booking_agent');
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent-policy',
        scopeType: 'agent',
        agentDefId: 'booking_agent',
      }),
    );
  });
});
