import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockValidateUrlForSSRF = vi.fn();
const mockEnvironmentVariableFindOne = vi.fn();
const mockProjectConfigVariableFindOne = vi.fn();
const mockVariableNamespaceFindOne = vi.fn();
const mockVariableNamespaceMembershipFindOne = vi.fn();
const mockDecryptForTenantAuto = vi.fn();

function selectLeanResult(value: unknown) {
  return {
    select: () => ({
      lean: () => Promise.resolve(value),
    }),
  };
}

function leanResult(value: unknown) {
  return {
    lean: () => Promise.resolve(value),
  };
}

vi.mock('@agent-platform/shared', () => ({
  validateUrlForSSRF: (...args: unknown[]) => mockValidateUrlForSSRF(...args),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: () => ({ allowLocalhost: true, allowPrivateRanges: true }),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: unknown[]) => mockDecryptForTenantAuto(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    findOne: (...args: unknown[]) => mockEnvironmentVariableFindOne(...args),
  },
  ProjectConfigVariable: {
    findOne: (...args: unknown[]) => mockProjectConfigVariableFindOne(...args),
  },
  VariableNamespace: {
    findOne: (...args: unknown[]) => mockVariableNamespaceFindOne(...args),
  },
  VariableNamespaceMembership: {
    findOne: (...args: unknown[]) => mockVariableNamespaceMembershipFindOne(...args),
  },
}));

describe('validateUrlWithPlaceholders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateUrlForSSRF.mockReturnValue({ safe: true });
    mockEnvironmentVariableFindOne.mockReturnValue(selectLeanResult(null));
    mockVariableNamespaceFindOne.mockReturnValue(selectLeanResult({ _id: 'ns-default' }));
    mockProjectConfigVariableFindOne.mockReturnValue(
      selectLeanResult({ _id: 'cfg-api-base', value: 'https://api.example.com' }),
    );
    mockVariableNamespaceMembershipFindOne.mockReturnValue(
      selectLeanResult({ _id: 'membership-1' }),
    );
  });

  it('resolves config placeholders through linked variable namespaces before SSRF validation', async () => {
    const { validateUrlWithPlaceholders } = await import('@/lib/resolve-and-validate-url');

    const result = await validateUrlWithPlaceholders(
      '{{config.API_BASE}}/events',
      'tenant-1',
      'project-1',
      'dev',
      { variableNamespaceIds: ['ns-tools'], useDefaultNamespaceFallback: false },
    );

    expect(result).toEqual({ safe: true });
    expect(mockProjectConfigVariableFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      key: 'API_BASE',
    });
    expect(mockVariableNamespaceMembershipFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      variableId: 'cfg-api-base',
      variableType: 'config',
      namespaceId: { $in: ['ns-tools'] },
    });
    expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('https://api.example.com/events', {
      allowLocalhost: true,
      allowPrivateRanges: true,
    });
  });

  it('fails closed when a config placeholder is not linked to the tool namespace', async () => {
    const { validateUrlWithPlaceholders } = await import('@/lib/resolve-and-validate-url');
    mockVariableNamespaceMembershipFindOne.mockReturnValue(selectLeanResult(null));

    const result = await validateUrlWithPlaceholders(
      '{{config.API_BASE}}/events',
      'tenant-1',
      'project-1',
      'dev',
      { variableNamespaceIds: ['ns-tools'], useDefaultNamespaceFallback: false },
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toContain('config.API_BASE');
    expect(mockValidateUrlForSSRF).not.toHaveBeenCalled();
  });

  it('allows unresolved env placeholders when runtime URL placeholders are explicitly allowed', async () => {
    const { validateUrlWithPlaceholders } = await import('@/lib/resolve-and-validate-url');

    const result = await validateUrlWithPlaceholders(
      '{{env.API_BASE_URL}}/events',
      'tenant-1',
      'project-1',
      'dev',
      { allowUnresolvedEnvPlaceholders: true },
    );

    expect(result).toEqual({ safe: true });
    expect(mockValidateUrlForSSRF).not.toHaveBeenCalled();
  });

  it('still blocks literal unsafe URL prefixes when unresolved env placeholders are allowed', async () => {
    const { validateUrlWithPlaceholders } = await import('@/lib/resolve-and-validate-url');
    mockValidateUrlForSSRF.mockReturnValueOnce({
      safe: false,
      reason: 'Blocked cloud metadata endpoint',
    });

    const result = await validateUrlWithPlaceholders(
      'http://169.254.169.254/{{env.METADATA_PATH}}',
      'tenant-1',
      'project-1',
      'dev',
      { allowUnresolvedEnvPlaceholders: true },
    );

    expect(result).toEqual({ safe: false, reason: 'Blocked cloud metadata endpoint' });
    expect(mockValidateUrlForSSRF).toHaveBeenCalledWith('http://169.254.169.254/placeholder', {
      allowLocalhost: true,
      allowPrivateRanges: true,
    });
  });
});
