import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GuardrailPolicy } from '../../hooks/useGuardrails';
import { GuardrailsConfigPage } from '../../components/guardrails/GuardrailsConfigPage';

const mockUseGuardrailPolicies = vi.fn();

const mockNavigationStore = {
  projectId: 'project-1',
};

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: Object.assign(
    vi.fn((selector?: (state: typeof mockNavigationStore) => unknown) =>
      selector ? selector(mockNavigationStore) : mockNavigationStore,
    ),
    {
      getState: () => mockNavigationStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../hooks/useGuardrails', () => ({
  useGuardrailPolicies: (...args: unknown[]) => mockUseGuardrailPolicies(...args),
  useGuardrailProviders: () => ({
    providers: [],
    isLoading: false,
    error: null,
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    activateProvider: vi.fn(),
  }),
}));

vi.mock('../../components/guardrails/GuardrailPolicyForm', () => ({
  GuardrailPolicyForm: () => null,
}));

vi.mock('../../components/admin/GuardrailProviderForm', () => ({
  GuardrailProviderForm: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makePolicy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    _id: 'policy-1',
    name: 'guardrail-policy',
    description: 'Policy description',
    rules: [],
    isActive: true,
    scope: {
      type: 'project',
      projectId: 'project-1',
    },
    status: 'active',
    settings: {
      failMode: 'closed',
      timeouts: {
        local: 100,
        model: 200,
        llm: 300,
      },
      streaming: {
        enabled: false,
        defaultInterval: 'sentence',
        chunkSize: 256,
        maxLatencyMs: 500,
        earlyTermination: true,
      },
    },
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('GuardrailsConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseGuardrailPolicies.mockImplementation(
      (projectId: string | null, options?: { scope?: 'tenant' | 'project' }) => {
        if (options?.scope === 'tenant') {
          return {
            policies: [
              makePolicy({
                _id: 'tenant-policy-1',
                name: 'tenant-baseline',
                description: 'Tenant runtime baseline',
                scope: {
                  type: 'tenant',
                },
                isActive: true,
                status: 'active',
              }),
            ],
            isLoading: false,
            error: null,
            mutate: vi.fn(),
            createPolicy: vi.fn(),
            updatePolicy: vi.fn(),
            deletePolicy: vi.fn(),
            activatePolicy: vi.fn(),
          };
        }

        expect(projectId).toBe('project-1');
        return {
          policies: [
            makePolicy({
              _id: 'project-policy-1',
              name: 'project-policy',
            }),
          ],
          isLoading: false,
          error: null,
          mutate: vi.fn(),
          createPolicy: vi.fn(),
          updatePolicy: vi.fn(),
          deletePolicy: vi.fn(),
          activatePolicy: vi.fn(),
        };
      },
    );
  });

  test('shows active tenant baselines separately from editable project policies', () => {
    render(<GuardrailsConfigPage />);

    expect(screen.getByText('Tenant baselines affecting runtime')).toBeInTheDocument();
    expect(screen.getByText('tenant-baseline')).toBeInTheDocument();
    expect(screen.getByText('project-policy')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Edit policy')).toHaveLength(1);
    expect(mockUseGuardrailPolicies).toHaveBeenCalledWith('project-1');
    expect(mockUseGuardrailPolicies).toHaveBeenCalledWith(null, { scope: 'tenant' });
  });

  // ─── CT-7: Policy list shows status badges (FR-9.1..9.6) ───────────────

  describe('CT-7: Policy list renders status badges for policies (FR-9.1..9.6)', () => {
    test('active policy renders with active status badge', () => {
      mockUseGuardrailPolicies.mockImplementation(
        (_projectId: string | null, options?: { scope?: 'tenant' | 'project' }) => {
          if (options?.scope === 'tenant') {
            return {
              policies: [],
              isLoading: false,
              error: null,
              mutate: vi.fn(),
              createPolicy: vi.fn(),
              updatePolicy: vi.fn(),
              deletePolicy: vi.fn(),
              activatePolicy: vi.fn(),
            };
          }
          return {
            policies: [
              makePolicy({
                _id: 'active-policy',
                name: 'Active Policy',
                isActive: true,
                status: 'active',
              }),
            ],
            isLoading: false,
            error: null,
            mutate: vi.fn(),
            createPolicy: vi.fn(),
            updatePolicy: vi.fn(),
            deletePolicy: vi.fn(),
            activatePolicy: vi.fn(),
          };
        },
      );

      render(<GuardrailsConfigPage />);

      expect(screen.getByText('Active Policy')).toBeInTheDocument();
      // Status badge text — mock translation returns 'admin.guardrails.status_active'
      expect(screen.getByText('admin.guardrails.status_active')).toBeInTheDocument();
    });

    test('draft policy renders with draft status badge', () => {
      mockUseGuardrailPolicies.mockImplementation(
        (_projectId: string | null, options?: { scope?: 'tenant' | 'project' }) => {
          if (options?.scope === 'tenant') {
            return {
              policies: [],
              isLoading: false,
              error: null,
              mutate: vi.fn(),
              createPolicy: vi.fn(),
              updatePolicy: vi.fn(),
              deletePolicy: vi.fn(),
              activatePolicy: vi.fn(),
            };
          }
          return {
            policies: [
              makePolicy({
                _id: 'draft-policy',
                name: 'Draft Policy',
                isActive: false,
                status: 'draft',
              }),
            ],
            isLoading: false,
            error: null,
            mutate: vi.fn(),
            createPolicy: vi.fn(),
            updatePolicy: vi.fn(),
            deletePolicy: vi.fn(),
            activatePolicy: vi.fn(),
          };
        },
      );

      render(<GuardrailsConfigPage />);

      expect(screen.getByText('Draft Policy')).toBeInTheDocument();
      expect(screen.getByText('admin.guardrails.status_draft')).toBeInTheDocument();
    });

    test('archived policy renders with archived status badge', () => {
      mockUseGuardrailPolicies.mockImplementation(
        (_projectId: string | null, options?: { scope?: 'tenant' | 'project' }) => {
          if (options?.scope === 'tenant') {
            return {
              policies: [],
              isLoading: false,
              error: null,
              mutate: vi.fn(),
              createPolicy: vi.fn(),
              updatePolicy: vi.fn(),
              deletePolicy: vi.fn(),
              activatePolicy: vi.fn(),
            };
          }
          return {
            policies: [
              makePolicy({
                _id: 'archived-policy',
                name: 'Archived Policy',
                isActive: false,
                status: 'archived',
              }),
            ],
            isLoading: false,
            error: null,
            mutate: vi.fn(),
            createPolicy: vi.fn(),
            updatePolicy: vi.fn(),
            deletePolicy: vi.fn(),
            activatePolicy: vi.fn(),
          };
        },
      );

      render(<GuardrailsConfigPage />);

      expect(screen.getByText('Archived Policy')).toBeInTheDocument();
      expect(screen.getByText('admin.guardrails.status_archived')).toBeInTheDocument();
    });

    test('policy list shows activate/deactivate, edit, and delete action buttons', () => {
      render(<GuardrailsConfigPage />);

      // project-policy is active, so deactivate button should be present
      expect(screen.getByLabelText('Deactivate')).toBeInTheDocument();
      expect(screen.getByLabelText('Edit policy')).toBeInTheDocument();
      expect(screen.getByLabelText('Delete policy')).toBeInTheDocument();
    });

    test('policy description renders when present', () => {
      mockUseGuardrailPolicies.mockImplementation(
        (_projectId: string | null, options?: { scope?: 'tenant' | 'project' }) => {
          if (options?.scope === 'tenant') {
            return {
              policies: [],
              isLoading: false,
              error: null,
              mutate: vi.fn(),
              createPolicy: vi.fn(),
              updatePolicy: vi.fn(),
              deletePolicy: vi.fn(),
              activatePolicy: vi.fn(),
            };
          }
          return {
            policies: [
              makePolicy({
                _id: 'desc-policy',
                name: 'Described Policy',
                description: 'This policy has a description',
              }),
            ],
            isLoading: false,
            error: null,
            mutate: vi.fn(),
            createPolicy: vi.fn(),
            updatePolicy: vi.fn(),
            deletePolicy: vi.fn(),
            activatePolicy: vi.fn(),
          };
        },
      );

      render(<GuardrailsConfigPage />);

      expect(screen.getByText('Described Policy')).toBeInTheDocument();
      expect(screen.getByText('This policy has a description')).toBeInTheDocument();
    });
  });
});
