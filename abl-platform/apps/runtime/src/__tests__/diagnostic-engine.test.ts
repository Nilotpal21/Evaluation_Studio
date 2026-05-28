import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticEngine } from '../services/diagnostics/engine.js';
import type {
  Analyzer,
  DiagnosticContext,
  DiagnosticFinding,
} from '../services/diagnostics/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentName: 'test-agent',
    depth: 'deep',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<DiagnosticFinding> = {}): DiagnosticFinding {
  return {
    analyzer: 'mock',
    severity: 'info',
    code: 'TEST',
    title: 'test finding',
    detail: '',
    suggestion: '',
    evidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Analyzers
// ---------------------------------------------------------------------------

const mockInfraAnalyzer: Analyzer = {
  name: 'mock-infra',
  category: 'infra',
  analyze: async () => [
    makeFinding({
      analyzer: 'mock-infra',
      severity: 'error',
      code: 'INFRA_ERR',
      title: 'infra error',
    }),
  ],
};

const mockExecutionAnalyzer: Analyzer = {
  name: 'mock-execution',
  category: 'execution',
  analyze: async () => [
    makeFinding({
      analyzer: 'mock-execution',
      severity: 'warning',
      code: 'EXEC_WARN',
      title: 'execution warning',
    }),
  ],
};

const mockBehavioralAnalyzer: Analyzer = {
  name: 'mock-behavioral',
  category: 'behavioral',
  analyze: async () => [
    makeFinding({
      analyzer: 'mock-behavioral',
      severity: 'info',
      code: 'BEHAV_INFO',
      title: 'behavioral info',
    }),
  ],
};

const mockModelResolutionAnalyzer: Analyzer = {
  name: 'model-resolution',
  category: 'infra',
  analyze: async () => [
    makeFinding({
      analyzer: 'model-resolution',
      severity: 'error',
      code: 'NO_CREDENTIAL',
      title: 'no credential',
      detail: 'No active LLM credential exists for this tenant.',
    }),
  ],
};

const throwingAnalyzer: Analyzer = {
  name: 'mock-throwing',
  category: 'infra',
  analyze: async () => {
    throw new Error('analyzer exploded');
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiagnosticEngine', () => {
  let engine: DiagnosticEngine;

  beforeEach(() => {
    engine = new DiagnosticEngine();
  });

  // -----------------------------------------------------------------------
  // Core engine behavior
  // -----------------------------------------------------------------------
  describe('core engine behavior', () => {
    it('empty engine returns healthy report with empty findings', async () => {
      const report = await engine.diagnose(makeContext());

      expect(report.status).toBe('healthy');
      expect(report.findings).toEqual([]);
      expect(report.summary.errors).toBe(0);
      expect(report.summary.warnings).toBe(0);
      expect(report.summary.infos).toBe(0);
      expect(report.summary.analyzersRun).toEqual([]);
    });

    it('engine with one analyzer that returns findings reflects them in report', async () => {
      engine.register(mockInfraAnalyzer);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].code).toBe('INFRA_ERR');
      expect(report.summary.analyzersRun).toEqual(['mock-infra']);
    });

    it('engine with analyzer that throws catches error and adds ANALYZER_FAILED finding', async () => {
      engine.register(throwingAnalyzer);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0];
      expect(finding.code).toBe('ANALYZER_FAILED');
      expect(finding.severity).toBe('warning');
      expect(finding.analyzer).toBe('mock-throwing');
      expect(finding.title).toContain('mock-throwing');
      expect(finding.detail).toBe('analyzer exploded');
      expect(finding.suggestion).toContain('Other results are still valid');
      expect(report.summary.analyzersRun).toEqual(['mock-throwing']);
    });

    it('annotates configuration findings with canonical taxonomy metadata', async () => {
      engine.register(mockModelResolutionAnalyzer);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].code).toBe('NO_CREDENTIAL');
      expect(report.findings[0].canonical).toEqual({
        domain: 'configuration',
        category: 'llm',
        code: 'LLM_CREDENTIAL_MISSING',
      });
    });

    it('continues running remaining analyzers after one throws', async () => {
      engine.register(throwingAnalyzer);
      engine.register(mockInfraAnalyzer);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(2);
      expect(report.summary.analyzersRun).toEqual(['mock-throwing', 'mock-infra']);
    });
  });

  // -----------------------------------------------------------------------
  // Depth filtering
  // -----------------------------------------------------------------------
  describe('depth filtering', () => {
    beforeEach(() => {
      engine.register(mockInfraAnalyzer);
      engine.register(mockExecutionAnalyzer);
      engine.register(mockBehavioralAnalyzer);
    });

    it('quick depth only runs infra analyzers', async () => {
      const report = await engine.diagnose(makeContext({ depth: 'quick' }));

      expect(report.summary.analyzersRun).toEqual(['mock-infra']);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].analyzer).toBe('mock-infra');
    });

    it('standard depth runs infra + execution analyzers but not behavioral', async () => {
      const report = await engine.diagnose(makeContext({ depth: 'standard' }));

      expect(report.summary.analyzersRun).toEqual(['mock-infra', 'mock-execution']);
      expect(report.findings).toHaveLength(2);
      expect(report.findings.map((f) => f.analyzer)).not.toContain('mock-behavioral');
    });

    it('deep depth runs all analyzers', async () => {
      const report = await engine.diagnose(makeContext({ depth: 'deep' }));

      expect(report.summary.analyzersRun).toEqual([
        'mock-infra',
        'mock-execution',
        'mock-behavioral',
      ]);
      expect(report.findings).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Report shape
  // -----------------------------------------------------------------------
  describe('report shape', () => {
    it('status is broken when errors exist', async () => {
      engine.register(mockInfraAnalyzer); // produces an error finding
      const report = await engine.diagnose(makeContext());
      expect(report.status).toBe('broken');
    });

    it('status is degraded when only warnings exist (no errors)', async () => {
      engine.register(mockExecutionAnalyzer); // produces a warning finding
      const report = await engine.diagnose(makeContext());
      expect(report.status).toBe('degraded');
    });

    it('status is healthy when only infos exist', async () => {
      engine.register(mockBehavioralAnalyzer); // produces an info finding
      const report = await engine.diagnose(makeContext());
      expect(report.status).toBe('healthy');
    });

    it('status is healthy when no findings', async () => {
      const report = await engine.diagnose(makeContext());
      expect(report.status).toBe('healthy');
    });

    it('status is broken even when warnings and infos also exist alongside errors', async () => {
      engine.register(mockInfraAnalyzer);
      engine.register(mockExecutionAnalyzer);
      engine.register(mockBehavioralAnalyzer);
      const report = await engine.diagnose(makeContext());
      expect(report.status).toBe('broken');
    });

    it('findings are sorted by severity: errors first, then warnings, then infos', async () => {
      // Register in reverse severity order to test sorting
      engine.register(mockBehavioralAnalyzer); // info
      engine.register(mockExecutionAnalyzer); // warning
      engine.register(mockInfraAnalyzer); // error

      const report = await engine.diagnose(makeContext());

      expect(report.findings[0].severity).toBe('error');
      expect(report.findings[1].severity).toBe('warning');
      expect(report.findings[2].severity).toBe('info');
    });

    it('summary counts are correct', async () => {
      engine.register(mockInfraAnalyzer); // 1 error
      engine.register(mockExecutionAnalyzer); // 1 warning
      engine.register(mockBehavioralAnalyzer); // 1 info

      const report = await engine.diagnose(makeContext());

      expect(report.summary.errors).toBe(1);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.infos).toBe(1);
      expect(report.summary.analyzersRun).toHaveLength(3);
    });

    it('target type is session when sessionId is provided', async () => {
      const report = await engine.diagnose(makeContext({ sessionId: 'sess-42' }));
      expect(report.target.type).toBe('session');
      expect(report.target.id).toBe('sess-42');
      expect(report.target.agentName).toBe('test-agent');
    });

    it('target type is agent when no sessionId is provided', async () => {
      const report = await engine.diagnose(makeContext({ agentName: 'my-agent' }));
      expect(report.target.type).toBe('agent');
      expect(report.target.id).toBe('my-agent');
      expect(report.target.agentName).toBe('my-agent');
    });

    it('target defaults to unknown when neither agentName nor sessionId is provided', async () => {
      const report = await engine.diagnose(
        makeContext({ agentName: undefined, sessionId: undefined }),
      );
      expect(report.target.type).toBe('agent');
      expect(report.target.id).toBe('unknown');
      expect(report.target.agentName).toBe('unknown');
    });

    it('timestamp is a valid ISO string', async () => {
      const report = await engine.diagnose(makeContext());
      expect(() => new Date(report.timestamp)).not.toThrow();
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });

    it('config is an empty object', async () => {
      const report = await engine.diagnose(makeContext());
      expect(report.config).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Multiple findings from a single analyzer
  // -----------------------------------------------------------------------
  describe('multiple findings from single analyzer', () => {
    it('collects all findings from an analyzer that returns multiple', async () => {
      const multiAnalyzer: Analyzer = {
        name: 'multi',
        category: 'infra',
        analyze: async () => [
          makeFinding({ analyzer: 'multi', severity: 'error', code: 'A' }),
          makeFinding({ analyzer: 'multi', severity: 'warning', code: 'B' }),
          makeFinding({ analyzer: 'multi', severity: 'info', code: 'C' }),
        ],
      };

      engine.register(multiAnalyzer);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(3);
      expect(report.summary.errors).toBe(1);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.infos).toBe(1);
      // Sorted by severity
      expect(report.findings[0].code).toBe('A');
      expect(report.findings[1].code).toBe('B');
      expect(report.findings[2].code).toBe('C');
    });
  });

  // -----------------------------------------------------------------------
  // Non-Error throw handling
  // -----------------------------------------------------------------------
  describe('non-Error throw handling', () => {
    it('handles analyzer that throws a non-Error value', async () => {
      const stringThrower: Analyzer = {
        name: 'string-thrower',
        category: 'infra',
        analyze: async () => {
          throw 'string error'; // eslint-disable-line no-throw-literal
        },
      };

      engine.register(stringThrower);
      const report = await engine.diagnose(makeContext());

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].detail).toBe('string error');
      expect(report.findings[0].code).toBe('ANALYZER_FAILED');
    });
  });
});
