/**
 * ModelResolutionAnalyzer Tests
 *
 * Verifies the 5-level model resolution chain analyzer produces the correct
 * DiagnosticFindings for happy paths, error paths, tenant isolation, and edge cases.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../services/diagnostics/types.js';

// =============================================================================
// MOCKS — must be declared before importing the analyzer
// =============================================================================

const mockTenantModelFindOne = vi.fn();
const mockLLMCredentialFindOne = vi.fn();
const mockFindAgentModelConfig = vi.fn();
const mockFindAnyModelConfig = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: (...args: unknown[]) => mockTenantModelFindOne(...args),
  },
  LLMCredential: {
    findOne: (...args: unknown[]) => mockLLMCredentialFindOne(...args),
  },
}));

vi.mock('../repos/llm-resolution-repo.js', () => ({
  findAgentModelConfig: (...args: unknown[]) => mockFindAgentModelConfig(...args),
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

import { ModelResolutionAnalyzer } from '../services/diagnostics/analyzers/model-resolution.js';

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

// =============================================================================
// TESTS
// =============================================================================

describe('ModelResolutionAnalyzer', () => {
  let analyzer: ModelResolutionAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new ModelResolutionAnalyzer();

    // Default: everything returns null
    mockFindAgentModelConfig.mockResolvedValue(null);
    mockFindAnyModelConfig.mockResolvedValue(null);
    mockLean(mockTenantModelFindOne, null);
    mockLean(mockLLMCredentialFindOne, null);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    test('tenant model exists with credential → MODEL_RESOLVED info finding', async () => {
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4o', provider: 'openai' });
      mockLean(mockLLMCredentialFindOne, {
        provider: 'openai',
        credentialScope: 'tenant',
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('MODEL_RESOLVED');
      expect(findings[0].severity).toBe('info');
      expect(findings[0].title).toBe('Model resolution successful');
      expect(findings[0].detail).toContain('Tenant Model');
    });

    test('agent model config exists → resolves at level 2', async () => {
      mockFindAgentModelConfig.mockResolvedValue({
        defaultModel: 'claude-3',
        provider: 'anthropic',
      });
      mockLean(mockLLMCredentialFindOne, {
        provider: 'anthropic',
        credentialScope: 'tenant',
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('MODEL_RESOLVED');
      expect(findings[0].severity).toBe('info');
      expect(findings[0].detail).toContain('Agent DB');
    });
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  describe('error paths', () => {
    test('no model at any level → NO_MODEL_RESOLVED error finding', async () => {
      // All mocks already return null by default; credential also null
      const findings = await analyzer.analyze(makeContext());

      const noModel = findings.find((f) => f.code === 'NO_MODEL_RESOLVED');
      expect(noModel).toBeDefined();
      expect(noModel!.severity).toBe('error');
      expect(noModel!.evidence.length).toBeGreaterThan(0);
    });

    test('model found but no credential → NO_CREDENTIAL error finding', async () => {
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4', provider: 'openai' });
      // credential remains null

      const findings = await analyzer.analyze(makeContext());

      const noCred = findings.find((f) => f.code === 'NO_CREDENTIAL');
      expect(noCred).toBeDefined();
      expect(noCred!.severity).toBe('error');
      expect(noCred!.detail).toContain('No active LLM credential');
    });

    test('no model AND no credential → both error findings emitted', async () => {
      const findings = await analyzer.analyze(makeContext());

      const codes = findings.map((f) => f.code);
      expect(codes).toContain('NO_MODEL_RESOLVED');
      expect(codes).toContain('NO_CREDENTIAL');
      expect(findings).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    test('agent model config lookup passes tenantId through the tenant-safe repository helper', async () => {
      mockLean(mockLLMCredentialFindOne, { provider: 'openai' });
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4' });

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockFindAgentModelConfig).toHaveBeenCalledWith(
        'project-456',
        'test-agent',
        'iso-tenant',
      );
    });

    test('project model config lookup passes tenantId through the tenant-safe repository helper', async () => {
      mockLean(mockLLMCredentialFindOne, { provider: 'openai' });
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4' });

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockFindAnyModelConfig).toHaveBeenCalledWith('project-456', 'iso-tenant');
    });

    test('TenantModel.findOne includes tenantId in query', async () => {
      mockLean(mockLLMCredentialFindOne, { provider: 'openai' });
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4' });

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockTenantModelFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });

    test('LLMCredential.findOne includes tenantId in query', async () => {
      mockLean(mockLLMCredentialFindOne, { provider: 'openai' });
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4' });

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockLLMCredentialFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('database query throws → warning finding, continues to next level', async () => {
      mockFindAgentModelConfig.mockRejectedValue(new Error('Connection timeout'));
      // Other levels succeed
      mockLean(mockTenantModelFindOne, { modelId: 'gpt-4' });
      mockLean(mockLLMCredentialFindOne, { provider: 'openai' });

      const findings = await analyzer.analyze(makeContext());

      // Should still resolve overall because tenant model + credential exist
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('MODEL_RESOLVED');
      // The chain evidence should include the failed level 2 step
      const level2Evidence = findings[0].evidence.find(
        (e) => e.label === 'Level 2: Agent DB (AgentModelConfig)',
      );
      expect(level2Evidence).toBeDefined();
      expect((level2Evidence!.data as Record<string, unknown>).checked).toBe(false);
      expect((level2Evidence!.data as Record<string, unknown>).reason).toContain(
        'Connection timeout',
      );
    });

    test('agentName is undefined → skips all checks, returns NO_AGENT_NAME info', async () => {
      const findings = await analyzer.analyze(makeContext({ agentName: undefined }));

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('NO_AGENT_NAME');
      expect(findings[0].severity).toBe('info');

      // No database calls should have been made
      expect(mockFindAgentModelConfig).not.toHaveBeenCalled();
      expect(mockFindAnyModelConfig).not.toHaveBeenCalled();
      expect(mockTenantModelFindOne).not.toHaveBeenCalled();
      expect(mockLLMCredentialFindOne).not.toHaveBeenCalled();
    });
  });
});
