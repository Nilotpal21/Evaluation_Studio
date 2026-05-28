/**
 * ToolBindingAnalyzer Tests
 *
 * Verifies the tool binding analyzer correctly identifies bound and unbound
 * tools by checking ProjectAgent DSL content against ProjectTool records.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticContext } from '../../services/diagnostics/types.js';

// =============================================================================
// MOCKS — must be declared before importing the analyzer
// =============================================================================

const mockProjectAgentFindOne = vi.fn();
const mockProjectToolFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    findOne: (...args: unknown[]) => mockProjectAgentFindOne(...args),
  },
  ProjectTool: {
    findOne: (...args: unknown[]) => mockProjectToolFindOne(...args),
  },
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

import { ToolBindingAnalyzer } from '../../services/diagnostics/analyzers/tool-binding.js';

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

/** Mock ProjectAgent with DSL content containing a TOOLS section */
function mockAgentWithTools(toolNames: string[]) {
  const toolsList = toolNames.map((n) => `  - ${n}`).join('\n');
  const dslContent = `AGENT test-agent\nTOOLS:\n${toolsList}\nPROMPT:\n  Hello`;
  mockLean(mockProjectAgentFindOne, {
    name: 'test-agent',
    dslContent,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('ToolBindingAnalyzer', () => {
  let analyzer: ToolBindingAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new ToolBindingAnalyzer();

    // Default: no agent found
    mockLean(mockProjectAgentFindOne, null);
    mockLean(mockProjectToolFindOne, null);
  });

  // ---------------------------------------------------------------------------
  // No agent name
  // ---------------------------------------------------------------------------

  describe('no agent specified', () => {
    test('returns NO_AGENT_SPECIFIED info when agentName is undefined', async () => {
      const findings = await analyzer.analyze(makeContext({ agentName: undefined }));

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('NO_AGENT_SPECIFIED');
      expect(findings[0].severity).toBe('info');

      // No database calls
      expect(mockProjectAgentFindOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Agent not found
  // ---------------------------------------------------------------------------

  describe('agent not found', () => {
    test('returns AGENT_NOT_FOUND warning when no agent record exists', async () => {
      mockLean(mockProjectAgentFindOne, null);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('AGENT_NOT_FOUND');
      expect(findings[0].severity).toBe('warning');
    });
  });

  // ---------------------------------------------------------------------------
  // No DSL content
  // ---------------------------------------------------------------------------

  describe('no DSL content', () => {
    test('returns NO_DSL_CONTENT info when agent has null dslContent', async () => {
      mockLean(mockProjectAgentFindOne, { name: 'test-agent', dslContent: null });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('NO_DSL_CONTENT');
      expect(findings[0].severity).toBe('info');
    });
  });

  // ---------------------------------------------------------------------------
  // All tools bound
  // ---------------------------------------------------------------------------

  describe('happy path — all tools bound', () => {
    test('returns TOOLS_OK when all tools have matching ProjectTool records', async () => {
      mockAgentWithTools(['search_docs', 'send_email']);

      // Both tools exist in DB
      mockProjectToolFindOne.mockImplementation((...args: unknown[]) => {
        const query = args[0] as Record<string, unknown>;
        return {
          lean: vi.fn().mockResolvedValue({ name: query.name, toolType: 'http' }),
        };
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('TOOLS_OK');
      expect(findings[0].severity).toBe('info');
      expect(findings[0].detail).toContain('2 tool(s)');
    });
  });

  // ---------------------------------------------------------------------------
  // Unbound tools
  // ---------------------------------------------------------------------------

  describe('unbound tools', () => {
    test('returns UNBOUND_TOOL warning for tools without ProjectTool records', async () => {
      mockAgentWithTools(['search_docs', 'missing_tool']);

      // Only search_docs exists
      mockProjectToolFindOne.mockImplementation((...args: unknown[]) => {
        const query = args[0] as Record<string, unknown>;
        const exists = query.name === 'search_docs';
        return {
          lean: vi.fn().mockResolvedValue(exists ? { name: 'search_docs' } : null),
        };
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('UNBOUND_TOOL');
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].detail).toContain('missing_tool');
      expect(findings[0].evidence).toHaveLength(1);
      expect(findings[0].evidence[0].label).toContain('missing_tool');
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    test('ProjectAgent.findOne includes tenantId in query', async () => {
      mockLean(mockProjectAgentFindOne, null);

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockProjectAgentFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });

    test('ProjectTool.findOne includes tenantId in query', async () => {
      mockAgentWithTools(['my_tool']);
      mockLean(mockProjectToolFindOne, null);

      await analyzer.analyze(makeContext({ tenantId: 'iso-tenant' }));

      expect(mockProjectToolFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'iso-tenant' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Inline tools syntax
  // ---------------------------------------------------------------------------

  describe('inline tools syntax', () => {
    test('parses tools: [tool_a, tool_b] syntax', async () => {
      mockLean(mockProjectAgentFindOne, {
        name: 'test-agent',
        dslContent: 'AGENT test\ntools: [fetch_data, run_query]\nPROMPT: Hello',
      });

      mockProjectToolFindOne.mockImplementation((...args: unknown[]) => {
        const query = args[0] as Record<string, unknown>;
        return {
          lean: vi.fn().mockResolvedValue({ name: query.name }),
        };
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('TOOLS_OK');
      expect(findings[0].detail).toContain('2 tool(s)');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    test('database error in agent lookup → ANALYSIS_ERROR warning', async () => {
      mockProjectAgentFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('ANALYSIS_ERROR');
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].detail).toContain('Connection refused');
    });
  });
});
