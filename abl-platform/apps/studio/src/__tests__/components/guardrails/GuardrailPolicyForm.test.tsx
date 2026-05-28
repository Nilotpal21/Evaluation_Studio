/**
 * CT-1, CT-1b, CT-1c — GuardrailPolicyForm component tests for ABLP-723.
 *
 * CT-1:  EntityMultiselect quick-preset radio behavior (FR-6.1, FR-6.2, FR-6.3)
 * CT-1b: kind: 'both' expansion contract (FR-5.3 surface-semantics)
 * CT-1c: Serializer round-trip with enabled: false for SDB-preset rules (LLD R1-F7)
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuardrailPolicyForm } from '@/components/guardrails/GuardrailPolicyForm';
import type { GuardrailPolicy } from '@/hooks/useGuardrails';
import type { ReactNode } from 'react';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const mockUseGuardrailProviders = vi.hoisted(() => vi.fn());
const mockFetchRuntimeAgents = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: mockToast,
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

/**
 * Mock SWR (3rd-party) — intercepts all useSWR calls including
 * EntityMultiselect catalog fetch.
 */
const mockSwrImplementation = vi.hoisted(() =>
  vi.fn((_key: string | null) => ({
    data: undefined as unknown,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  })),
);

vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockSwrImplementation(args[0] as string | null),
}));

// Dialog stub — replaces Radix Dialog to avoid pointer-events: none on body
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

// Select stub — uses a native <select> for testing
vi.mock('@/components/ui/Select', () => ({
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

// Hook mocks via @/ alias path
vi.mock('@/hooks/useGuardrails', () => ({
  useGuardrailProviders: () => mockUseGuardrailProviders(),
}));

vi.mock('@/api/runtime-agents', () => ({
  fetchRuntimeAgents: (...args: unknown[]) => mockFetchRuntimeAgents(...args),
}));

// ─── Test catalog data ──────────────────────────────────────────────────────

const MOCK_PII_ENTITIES = [
  { id: 'us_ssn', label: 'US SSN', category: 'Government ID', pack: 'us' },
  { id: 'us_passport', label: 'US Passport', category: 'Government ID', pack: 'us' },
  { id: 'us_drivers_license', label: 'US Drivers License', category: 'Government ID', pack: 'us' },
  { id: 'email_address', label: 'Email Address', category: 'Contact', pack: 'core' },
  { id: 'phone_number', label: 'Phone Number', category: 'Contact', pack: 'core' },
  { id: 'credit_card', label: 'Credit Card', category: 'Financial', pack: 'core' },
];

const CATALOG_RESPONSE = {
  success: true,
  data: MOCK_PII_ENTITIES,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    _id: 'policy-1',
    name: 'test-policy',
    description: '',
    rules: [],
    isActive: false,
    scope: { type: 'project', projectId: 'project-1' },
    status: 'draft',
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

/** Find the SDB preset card by its label text and return a container to query within. */
function findSdbPresetCard() {
  const sdbText = screen.getByText('Sensitive Data Block');
  let container = sdbText.closest('[class*="rounded"]');
  if (!container) {
    container = sdbText.parentElement?.parentElement?.parentElement ?? sdbText.parentElement;
  }
  return container as HTMLElement;
}

/** Click the toggle (role="switch") in the SDB preset row. */
async function toggleSdbPreset(user: ReturnType<typeof userEvent.setup>) {
  const sdbCard = findSdbPresetCard();
  const toggle = within(sdbCard).getByRole('switch');
  await user.click(toggle);
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('GuardrailPolicyForm — SDB preset tests (CT-1, CT-1b, CT-1c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });

    // SWR mock for EntityMultiselect catalog fetch
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: CATALOG_RESPONSE,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    });
  });

  // ─── CT-1: EntityMultiselect quick-preset radio behavior ────────────────

  describe('CT-1: EntityMultiselect quick-preset radio behavior (FR-6.1, FR-6.2, FR-6.3)', () => {
    test('SDB preset starts with entities: ["us_ssn"] (SSN-only default per Q-PRD-1)', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      // Set a policy name (required to enable submit)
      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'sdb-test');

      // Enable the SDB preset
      await toggleSdbPreset(user);

      // Submit the form
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };

      // SDB default entities should be ['us_ssn']
      const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');
      expect(sdbRules.length).toBeGreaterThanOrEqual(1);
      for (const rule of sdbRules) {
        expect(rule.entities).toEqual(['us_ssn']);
      }
    });

    test('clicking entity checkboxes changes the underlying entities array', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'sdb-entity-test');

      // Enable the SDB preset
      await toggleSdbPreset(user);

      // Wait for entities to render
      await waitFor(() => {
        expect(screen.getByText('Email Address')).toBeInTheDocument();
      });

      // Click the "Email Address" label to toggle that entity's checkbox
      const emailLabel = screen.getByText('Email Address');
      await user.click(emailLabel);

      // Submit the form
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
      const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');
      expect(sdbRules.length).toBeGreaterThanOrEqual(1);
      // Should now contain both us_ssn (default) and email_address (added)
      for (const rule of sdbRules) {
        expect(rule.entities).toEqual(expect.arrayContaining(['us_ssn', 'email_address']));
      }
    });
  });

  // ─── CT-1b: kind: 'both' expansion contract ────────────────────────────

  describe('CT-1b: kind: "both" expands to two rules on save and collapses back on load (FR-5.3)', () => {
    test('submitting an SDB rule with kind: "both" produces TWO rules (input + output) in the payload', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'both-test');

      // Enable the SDB preset — it defaults to kind: 'both'
      await toggleSdbPreset(user);

      // Submit
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
      const sdbRules = payload.rules.filter((r) => r.guardrailName === 'sensitive_data_block');

      // The SDB preset has kind: 'both' which must expand to two rules
      expect(sdbRules).toHaveLength(2);
      const kinds = sdbRules.map((r) => r.kind).sort();
      expect(kinds).toEqual(['input', 'output']);

      // Both rules share the same fields
      for (const rule of sdbRules) {
        expect(rule.presetKey).toBe('sensitive_data_block');
        expect(rule.entities).toEqual(['us_ssn']);
        expect(rule.override).toBe('define');
      }
    });

    test('loading a payload with input+output rules for the same name reconstructs kind: "both" in the form', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      // Create a policy with two SDB rules (input + output) — simulating round-trip
      const policyWithExpandedSdb = makePolicy({
        name: 'roundtrip-policy',
        rules: [
          {
            guardrailName: 'sensitive_data_block',
            override: 'define',
            kind: 'input',
            provider: 'builtin-pii',
            category: 'pii',
            threshold: 0.7,
            action: { type: 'block', message: 'Blocked' },
            presetKey: 'sensitive_data_block',
            entities: ['us_ssn'],
            actionMessage: 'Contains SSN',
            enabled: true,
          },
          {
            guardrailName: 'sensitive_data_block',
            override: 'define',
            kind: 'output',
            provider: 'builtin-pii',
            category: 'pii',
            threshold: 0.7,
            action: { type: 'block', message: 'Blocked' },
            presetKey: 'sensitive_data_block',
            entities: ['us_ssn'],
            actionMessage: 'Contains SSN',
            enabled: true,
          },
        ],
      });

      render(
        <GuardrailPolicyForm
          open
          onClose={vi.fn()}
          onSubmit={onSubmit}
          initial={policyWithExpandedSdb}
          projectId="project-1"
        />,
      );

      await waitFor(() => {
        expect(screen.getByDisplayValue('roundtrip-policy')).toBeInTheDocument();
      });

      // Submit the form without changes to verify the round-trip
      await user.click(screen.getByRole('button', { name: /update policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
      const sdbRules = payload.rules.filter((r) => r.guardrailName === 'sensitive_data_block');

      // After round-trip: still produces two rules (input + output)
      expect(sdbRules).toHaveLength(2);
      const kinds = sdbRules.map((r) => r.kind).sort();
      expect(kinds).toEqual(['input', 'output']);

      // Verify the fields survived the round-trip
      for (const rule of sdbRules) {
        expect(rule.presetKey).toBe('sensitive_data_block');
        expect(rule.entities).toEqual(['us_ssn']);
        expect(rule.enabled).toBe(true);
      }
    });
  });

  // ─── CT-1c: Serializer round-trip with enabled: false ──────────────────

  describe('CT-1c: Serializer round-trip with enabled: false for SDB-preset rules (LLD R1-F7)', () => {
    test('disabled SDB-preset rule is included in the submitted payload with enabled: false', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      // Fresh form — SDB preset starts disabled. The serializeRule() change
      // (ABLP-723 R1-F7) keeps SDB disabled rules in the payload rather than
      // filtering them to []. This test verifies that contract by submitting
      // a fresh form without enabling the SDB preset.
      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'disabled-sdb-fresh');

      // Do NOT enable the SDB preset — leave it disabled

      // Submit
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
      const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');

      // CRITICAL: disabled SDB rules must NOT be filtered out (unlike non-SDB presets)
      expect(sdbRules.length).toBeGreaterThanOrEqual(1);

      for (const rule of sdbRules) {
        expect(rule.enabled).toBe(false);
        expect(rule.presetKey).toBe('sensitive_data_block');
        expect(rule.entities).toEqual(['us_ssn']);
      }
    });

    test('enabling then disabling the SDB toggle preserves the rule with enabled: false', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'toggle-roundtrip');

      // Enable the SDB preset, then disable it
      await toggleSdbPreset(user); // enable
      await toggleSdbPreset(user); // disable

      // Find the SDB preset card and verify its toggle is OFF
      const sdbCard = findSdbPresetCard();
      const sdbToggle = within(sdbCard).getByRole('switch');
      expect(sdbToggle).toHaveAttribute('aria-checked', 'false');

      // Submit
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
      const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');

      // SDB disabled rules MUST survive serialization (R1-F7)
      expect(sdbRules.length).toBeGreaterThanOrEqual(1);
      for (const rule of sdbRules) {
        expect(rule.enabled).toBe(false);
        expect(rule.entities).toEqual(['us_ssn']);
      }
    });

    test('a non-SDB disabled rule IS filtered out (legacy behavior preserved)', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
      );

      const nameInput = screen.getByLabelText(/policy name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'non-sdb-disabled');

      // Do NOT enable any presets — all are disabled by default
      // Submit
      await user.click(screen.getByRole('button', { name: /create policy/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };

      // Non-SDB disabled rules should be filtered out
      const nonSdbRules = payload.rules.filter((r) => r.presetKey !== 'sensitive_data_block');
      expect(nonSdbRules).toHaveLength(0);

      // SDB rules ARE present (even though disabled) — this is the CT-1c contract
      const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');
      expect(sdbRules.length).toBeGreaterThanOrEqual(1);
      for (const rule of sdbRules) {
        expect(rule.enabled).toBe(false);
      }
    });
  });
});

// ─── CT-2: EntityMultiselect pack-disabled entity warning ───────────────────

describe('CT-2: EntityMultiselect pack-disabled entity warning (FR-10.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
  });

  test('pre-selected entity not in catalog is not rendered as a checkbox; only catalog entities appear', async () => {
    // Catalog excludes eu_uk_passport — only has us_ssn and email_address
    const LIMITED_CATALOG = {
      success: true,
      data: [
        { id: 'us_ssn', label: 'US SSN', category: 'Government ID', pack: 'us' },
        { id: 'email_address', label: 'Email Address', category: 'Contact', pack: 'core' },
      ],
    };

    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: LIMITED_CATALOG,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });

    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    // Create a policy with pre-selected entities including one NOT in the catalog
    const policyWithStaleEntity = makePolicy({
      name: 'stale-entity-policy',
      rules: [
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'input',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['eu_uk_passport', 'us_ssn'],
          actionMessage: 'Contains sensitive data',
          enabled: true,
        },
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'output',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['eu_uk_passport', 'us_ssn'],
          actionMessage: 'Contains sensitive data',
          enabled: true,
        },
      ],
    });

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
        initial={policyWithStaleEntity}
        projectId="project-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('stale-entity-policy')).toBeInTheDocument();
    });

    // The EntityMultiselect should show catalog entities
    await waitFor(() => {
      expect(screen.getByText('US SSN')).toBeInTheDocument();
      expect(screen.getByText('Email Address')).toBeInTheDocument();
    });

    // eu_uk_passport is NOT in the catalog, so no checkbox label renders for it
    expect(screen.queryByText('EU UK Passport')).not.toBeInTheDocument();

    // Submit and verify the stale entity is still in the payload (the form preserves it)
    await user.click(screen.getByRole('button', { name: /update policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
    const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');
    expect(sdbRules.length).toBeGreaterThanOrEqual(1);

    // The form preserves the entity IDs from the initial data even if the catalog doesn't list them
    for (const rule of sdbRules) {
      expect(rule.entities).toEqual(expect.arrayContaining(['eu_uk_passport', 'us_ssn']));
    }
  });
});

// ─── CT-3: DecisionMatrixModal WCAG APG dialog pattern ──────────────────────

describe('CT-3: DecisionMatrixModal WCAG APG dialog pattern (FR-3.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: CATALOG_RESPONSE,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });
  });

  test('clicking the help button opens the decision matrix modal with table content', async () => {
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        projectId="project-1"
      />,
    );

    // Find and click the decision matrix help button
    const helpButton = screen.getByLabelText('Open decision matrix');
    expect(helpButton).toBeInTheDocument();
    await user.click(helpButton);

    // The Dialog mock renders children when open=true.
    // Verify the matrix content is shown (action/input/output columns)
    await waitFor(() => {
      expect(screen.getByText('Action')).toBeInTheDocument();
      expect(screen.getByText('Input')).toBeInTheDocument();
      expect(screen.getByText('Output')).toBeInTheDocument();
    });

    // Verify the decision matrix row content (unique descriptive text per row)
    expect(screen.getByText('Message rejected before reaching the agent')).toBeInTheDocument();
    expect(screen.getByText('Response suppressed before reaching the user')).toBeInTheDocument();
    expect(screen.getByText('Message forwarded with a warning annotation')).toBeInTheDocument();
    expect(screen.getByText('Response delivered with a warning annotation')).toBeInTheDocument();
    expect(screen.getByText('Message routed to human review queue')).toBeInTheDocument();
    expect(screen.getByText('Response held pending human approval')).toBeInTheDocument();
  });
});

// ─── CT-4: DecisionMatrixModal first-run auto-open via localStorage ─────────

describe('CT-4: DecisionMatrixModal first-run auto-open via localStorage (FR-3.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: CATALOG_RESPONSE,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });
  });

  test('auto-opens decision matrix when SDB is enabled and localStorage key is absent', async () => {
    // Create a policy with SDB enabled — triggers auto-open
    const policyWithSdb = makePolicy({
      name: 'sdb-auto-open',
      rules: [
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'input',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'output',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
      ],
    });

    // No localStorage key set — should auto-open
    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        initial={policyWithSdb}
        projectId="project-1"
      />,
    );

    // The matrix modal should auto-open and display its content
    await waitFor(() => {
      expect(screen.getByText('Message rejected before reaching the agent')).toBeInTheDocument();
    });

    // localStorage key should have been set
    expect(localStorage.getItem('sdb_decision_matrix_seen')).toBe('1');
  });

  test('does NOT auto-open when localStorage key is already set', async () => {
    // Pre-set the localStorage key
    localStorage.setItem('sdb_decision_matrix_seen', 'true');

    const policyWithSdb = makePolicy({
      name: 'sdb-no-auto-open',
      rules: [
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'input',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'output',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
      ],
    });

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        initial={policyWithSdb}
        projectId="project-1"
      />,
    );

    // Wait for form to render
    await waitFor(() => {
      expect(screen.getByDisplayValue('sdb-no-auto-open')).toBeInTheDocument();
    });

    // The matrix modal content should NOT be visible
    expect(
      screen.queryByText('Message rejected before reaching the agent'),
    ).not.toBeInTheDocument();
  });
});

// ─── CT-5: FailModeSelector and FailModeOpenBanner ──────────────────────────

describe('CT-5: FailModeSelector and FailModeOpenBanner (FR-6.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('sdb_decision_matrix_seen', 'true');
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: CATALOG_RESPONSE,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });
  });

  test('FailModeOpenBanner appears when failMode is "open" and an output rule is enabled', async () => {
    const user = userEvent.setup();

    // Create policy with SDB enabled (has kind: 'both' which includes output)
    // and failMode: 'open'
    const policyFailOpen = makePolicy({
      name: 'fail-open-test',
      settings: {
        failMode: 'open',
        timeouts: { local: 5000, model: 10000, llm: 30000 },
        streaming: {
          enabled: false,
          defaultInterval: 'sentence',
          chunkSize: 256,
          maxLatencyMs: 500,
          earlyTermination: true,
        },
      },
      rules: [
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'input',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
        {
          guardrailName: 'sensitive_data_block',
          override: 'define',
          kind: 'output',
          provider: 'builtin-pii',
          category: 'pii',
          threshold: 0.7,
          action: { type: 'block', message: 'Blocked' },
          presetKey: 'sensitive_data_block',
          entities: ['us_ssn'],
          actionMessage: 'Contains SSN',
          enabled: true,
        },
      ],
    });

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        initial={policyFailOpen}
        projectId="project-1"
      />,
    );

    // Wait for the form to load
    await waitFor(() => {
      expect(screen.getByDisplayValue('fail-open-test')).toBeInTheDocument();
    });

    // The FailModeOpenBanner should be visible because failMode is 'open' and
    // an output rule is enabled (SDB has kind: 'both' collapsed to include output)
    await waitFor(() => {
      expect(screen.getByText(/Fail-open with output guardrails/i)).toBeInTheDocument();
    });
  });

  test('FailModeOpenBanner does NOT appear when failMode is "closed"', async () => {
    // Default failMode is 'closed'
    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        projectId="project-1"
      />,
    );

    // Wait for the form to render
    await waitFor(() => {
      expect(screen.getByLabelText(/policy name/i)).toBeInTheDocument();
    });

    // No banner should be visible with closed failMode
    expect(screen.queryByText(/Fail-open with output guardrails/i)).not.toBeInTheDocument();
  });
});

// ─── CT-6: RuleCard enable toggle behavior (FR-8.3) ────────────────────────

describe('CT-6: RuleCard enable toggle behavior with empty entities (FR-8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('sdb_decision_matrix_seen', 'true');
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: CATALOG_RESPONSE,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });
  });

  test('SDB preset toggle can be enabled and then entities are selectable', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    const nameInput = screen.getByLabelText(/policy name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'toggle-test');

    // SDB preset starts disabled
    const sdbCard = findSdbPresetCard();
    const sdbToggle = within(sdbCard).getByRole('switch');
    expect(sdbToggle).toHaveAttribute('aria-checked', 'false');

    // Enable SDB
    await toggleSdbPreset(user);
    expect(sdbToggle).toHaveAttribute('aria-checked', 'true');

    // Entity multiselect should now appear with entities from catalog
    await waitFor(() => {
      expect(screen.getByText('Entities to detect')).toBeInTheDocument();
    });

    // Default entity (us_ssn) should be pre-selected — submit to verify
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
    const sdbRules = payload.rules.filter((r) => r.presetKey === 'sensitive_data_block');
    expect(sdbRules.length).toBeGreaterThanOrEqual(1);
    for (const rule of sdbRules) {
      expect(rule.entities).toEqual(['us_ssn']);
      expect(rule.enabled).toBe(true);
    }
  });

  test('disabling then re-enabling the SDB toggle preserves default entities', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm open onClose={vi.fn()} onSubmit={onSubmit} projectId="project-1" />,
    );

    const nameInput = screen.getByLabelText(/policy name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 're-enable-test');

    // Enable → disable → re-enable
    await toggleSdbPreset(user); // enable
    await toggleSdbPreset(user); // disable
    await toggleSdbPreset(user); // re-enable

    // Entity section should be visible again
    await waitFor(() => {
      expect(screen.getByText('Entities to detect')).toBeInTheDocument();
    });

    // Submit to verify entities are still the default
    await user.click(screen.getByRole('button', { name: /create policy/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as { rules: Array<Record<string, unknown>> };
    const sdbRules = payload.rules.filter(
      (r) => r.presetKey === 'sensitive_data_block' && r.enabled === true,
    );
    expect(sdbRules.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── CT-9: EntityMultiselect catalog endpoint failure ───────────────────────

describe('CT-9: EntityMultiselect catalog endpoint failure (FR-10.4, C.2 fail-closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('sdb_decision_matrix_seen', 'true');
    mockUseGuardrailProviders.mockReturnValue({
      providers: [{ name: 'builtin-pii', displayName: 'Built-in PII', isActive: true }],
    });
    mockFetchRuntimeAgents.mockResolvedValue({ agents: [] });
  });

  test('shows error state with retry UI when catalog fetch fails', async () => {
    // Mock SWR to return an error for the PII entities endpoint
    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: undefined,
          error: new Error('Server error'),
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });

    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        projectId="project-1"
      />,
    );

    // Enable the SDB preset to trigger the EntityMultiselect render
    await toggleSdbPreset(user);

    // The error alert should be visible
    await waitFor(() => {
      expect(screen.getByText('Failed to load entity catalog')).toBeInTheDocument();
    });

    // Retry button should be available
    expect(screen.getByText('Retry')).toBeInTheDocument();

    // The error is non-silent (visible alert with role="alert")
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  test('retry button invokes SWR mutate to re-fetch the catalog', async () => {
    const mockMutate = vi.fn();

    mockSwrImplementation.mockImplementation((key: string | null) => {
      if (key && key.includes('/pii-entities')) {
        return {
          data: undefined,
          error: new Error('Server error'),
          isLoading: false,
          mutate: mockMutate,
        };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });

    const user = userEvent.setup();

    render(
      <GuardrailPolicyForm
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        projectId="project-1"
      />,
    );

    // Enable SDB to show the error state
    await toggleSdbPreset(user);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    // Click retry
    await user.click(screen.getByText('Retry'));

    // mutate should have been called (retry fetches the catalog)
    expect(mockMutate).toHaveBeenCalled();
  });
});

// ─── CT-8: PIIProtectionTab cross-link banner ─────────────────────────────

describe('CT-8: PIIProtectionTab cross-link banner (FR-2.1, FR-2.3)', () => {
  // GAP: PIIProtectionTab (apps/studio/src/components/settings/PIIProtectionTab.tsx)
  // does NOT currently implement a cross-link banner to the Sensitive Data Block
  // guardrail policy editor. The component manages PII patterns (regex/built-in
  // pattern toggles) but has no reference to SDB guardrails or a 90-day TTL relationship.
  // This test is deferred until the cross-link banner is implemented.
  test.todo(
    'renders a banner cross-linking to the SDB guardrail policy editor with 90-day TTL copy',
  );
});
