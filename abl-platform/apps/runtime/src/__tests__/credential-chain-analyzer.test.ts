/**
 * CredentialChainAnalyzer Tests
 *
 * Verifies the credential chain analyzer produces the correct
 * DiagnosticFindings for healthy credentials, missing credentials,
 * provider allowlist violations, and stale credential warnings.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../services/diagnostics/types.js';

// =============================================================================
// MOCKS — must be declared before importing the analyzer
// =============================================================================

const mockLLMCredentialFind = vi.fn();
const mockTenantLLMPolicyFindOne = vi.fn();
const mockTenantModelFindOne = vi.fn();
const mockFindAnyModelConfig = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  LLMCredential: {
    find: (...args: unknown[]) => mockLLMCredentialFind(...args),
  },
  TenantLLMPolicy: {
    findOne: (...args: unknown[]) => mockTenantLLMPolicyFindOne(...args),
  },
  TenantModel: {
    findOne: (...args: unknown[]) => mockTenantModelFindOne(...args),
  },
}));

vi.mock('../repos/llm-resolution-repo.js', () => ({
  findAnyModelConfig: (...args: unknown[]) => mockFindAnyModelConfig(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { CredentialChainAnalyzer } from '../services/diagnostics/analyzers/credential-chain.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    tenantId: 'tenant-123',
    projectId: 'project-456',
    agentName: 'test-agent',
    depth: 'standard',
    ...overrides,
  };
}

/** Shorthand: findOne returns { lean() } */
function mockLean(mock: ReturnType<typeof vi.fn>, value: unknown) {
  mock.mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  });
}

function mockCredentials(value: Array<Record<string, unknown>>) {
  mockLLMCredentialFind.mockResolvedValue(value);
}

// =============================================================================
// TESTS
// =============================================================================

describe('CredentialChainAnalyzer', () => {
  let analyzer: CredentialChainAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new CredentialChainAnalyzer();

    // Default: everything returns null
    mockCredentials([]);
    mockLean(mockTenantLLMPolicyFindOne, null);
    mockLean(mockTenantModelFindOne, null);
    mockFindAnyModelConfig.mockResolvedValue(null);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    test('active credential with recent validation → CREDENTIAL_CHAIN_OK info', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('CREDENTIAL_CHAIN_OK');
      expect(findings[0].severity).toBe('info');
      expect(findings[0].title).toBe('Credential chain is healthy');
    });

    test('credential matches resolved model provider → info', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockLean(mockTenantModelFindOne, { provider: 'openai', modelId: 'gpt-4o' });
      mockLean(mockTenantLLMPolicyFindOne, { allowedProviders: ['openai'] });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('CREDENTIAL_CHAIN_OK');
    });

    test('google and gemini providers are equivalent for diagnostics allowlist and credentials', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'gemini',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockLean(mockTenantModelFindOne, { provider: 'google', modelId: 'gemini-2.5-pro' });
      mockLean(mockTenantLLMPolicyFindOne, { allowedProviders: ['gemini'] });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('CREDENTIAL_CHAIN_OK');
      expect(findings.find((f) => f.code === 'PROVIDER_CREDENTIAL_MISSING')).toBeUndefined();
      expect(findings.find((f) => f.code === 'PROVIDER_NOT_ALLOWED')).toBeUndefined();
    });

    test('uses provider-matching credential when multiple active credentials exist', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
        {
          provider: 'anthropic',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockFindAnyModelConfig.mockResolvedValue({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'CREDENTIAL_CHAIN_OK',
        severity: 'info',
      });
      expect(findings[0].detail).toContain('anthropic');
    });

    test('project model provider takes precedence over tenant default for credential matching', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
        {
          provider: 'anthropic',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockFindAnyModelConfig.mockResolvedValue({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      });
      mockLean(mockTenantModelFindOne, { provider: 'openai', modelId: 'gpt-5.2' });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('CREDENTIAL_CHAIN_OK');
      expect(findings[0].detail).toContain('anthropic');
    });
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  describe('error paths', () => {
    test('no active credential → NO_ACTIVE_CREDENTIAL error', async () => {
      // mockLLMCredentialFind already returns an empty array by default

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('NO_ACTIVE_CREDENTIAL');
      expect(findings[0].severity).toBe('error');
      expect(findings[0].detail).toContain('No active LLM credential');
    });

    test('provider not in tenant allowlist → PROVIDER_NOT_ALLOWED error', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'anthropic',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockLean(mockTenantLLMPolicyFindOne, {
        allowedProviders: ['openai', 'azure'],
      });

      const findings = await analyzer.analyze(makeContext());

      const providerNotAllowed = findings.find((f) => f.code === 'PROVIDER_NOT_ALLOWED');
      expect(providerNotAllowed).toBeDefined();
      expect(providerNotAllowed!.severity).toBe('error');
      expect(providerNotAllowed!.detail).toContain('anthropic');
      expect(providerNotAllowed!.detail).toContain('openai');
    });

    test('resolved model provider without matching credential → PROVIDER_CREDENTIAL_MISSING error', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockLean(mockTenantModelFindOne, { provider: 'anthropic', modelId: 'claude-3' });

      const findings = await analyzer.analyze(makeContext());

      const mismatch = findings.find((f) => f.code === 'PROVIDER_CREDENTIAL_MISSING');
      expect(mismatch).toBeDefined();
      expect(mismatch!.severity).toBe('error');
      expect(mismatch!.detail).toContain('anthropic');
      expect(mismatch!.detail).toContain('openai');
    });
  });

  // ---------------------------------------------------------------------------
  // Stale credential warning
  // ---------------------------------------------------------------------------

  describe('stale credential warning', () => {
    test('lastValidatedAt is null → CREDENTIAL_STALE warning', async () => {
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: null,
        },
      ]);

      const findings = await analyzer.analyze(makeContext());

      const stale = findings.find((f) => f.code === 'CREDENTIAL_STALE');
      expect(stale).toBeDefined();
      expect(stale!.severity).toBe('warning');
      expect(stale!.detail).toContain('never been validated');
    });

    test('lastValidatedAt > 30 days ago → CREDENTIAL_STALE warning', async () => {
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days ago
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: oldDate,
        },
      ]);

      const findings = await analyzer.analyze(makeContext());

      const stale = findings.find((f) => f.code === 'CREDENTIAL_STALE');
      expect(stale).toBeDefined();
      expect(stale!.severity).toBe('warning');
      expect(stale!.detail).toContain('over 30 days ago');
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    test('LLMCredential.find includes tenantId in query', async () => {
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: new Date(),
        },
      ]);

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockLLMCredentialFind).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });

    test('TenantLLMPolicy.findOne includes tenantId in query', async () => {
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: new Date(),
        },
      ]);

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockTenantLLMPolicyFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });

    test('project model provider lookup passes tenantId through the tenant-safe repository helper', async () => {
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: new Date(),
        },
      ]);

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockFindAnyModelConfig).toHaveBeenCalledWith('project-456', 'iso-tenant');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('empty allowedProviders array does not trigger PROVIDER_NOT_ALLOWED', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockCredentials([
        {
          provider: 'openai',
          credentialScope: 'tenant',
          lastValidatedAt: recentDate,
        },
      ]);
      mockLean(mockTenantLLMPolicyFindOne, {
        allowedProviders: [],
      });

      const findings = await analyzer.analyze(makeContext());

      const providerNotAllowed = findings.find((f) => f.code === 'PROVIDER_NOT_ALLOWED');
      expect(providerNotAllowed).toBeUndefined();
    });

    test('no credential returns early without checking policy or staleness', async () => {
      // Default mocks: credential is null

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('NO_ACTIVE_CREDENTIAL');
      // TenantLLMPolicy should not have been queried
      expect(mockTenantLLMPolicyFindOne).not.toHaveBeenCalled();
    });
  });
});
