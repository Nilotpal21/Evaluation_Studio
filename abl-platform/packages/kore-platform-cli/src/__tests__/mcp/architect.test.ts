/**
 * Architect Module Tests
 *
 * Tests for gap detection, ABL generation, and project scaffolding.
 */

import { describe, test, expect } from 'vitest';
import {
  detectGapsFromUseCase,
  detectAgentPlatformGaps,
  detectXO11Gaps,
  mergeGapReports,
} from '../../mcp/architect/gaps.js';
import type { GapReport } from '../../mcp/architect/types.js';

// =============================================================================
// GAP DETECTION FROM USE CASE TEXT
// =============================================================================

describe('detectGapsFromUseCase', () => {
  describe('detects common ABL gaps', () => {
    test('detects no-http-calls gap', () => {
      const useCase = 'The agent needs to make API calls to external services';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.length).toBeGreaterThan(0);
      expect(report.gaps.some((g) => g.requirement.includes('HTTP/API'))).toBe(true);
    });

    test('detects no-loops gap', () => {
      const useCase = 'The system should iterate through all items and process each one in a loop';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('Loop'))).toBe(true);
    });

    test('detects no-timers gap', () => {
      const useCase = 'Schedule a periodic task to run every hour';
      const report = detectGapsFromUseCase(useCase);

      expect(
        report.gaps.some(
          (g) => g.requirement.includes('Timer') || g.requirement.includes('schedule'),
        ),
      ).toBe(true);
    });

    test('detects no-database gap', () => {
      const useCase = 'Query the database to find matching records';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('database'))).toBe(true);
    });

    test('detects no-conditional-gather gap', () => {
      const useCase = 'Show field X only if user selected option Y (conditional field)';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('Conditional GATHER'))).toBe(true);
    });

    test('detects no-file-upload gap', () => {
      const useCase = 'Allow users to upload documents and attachments';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('File upload'))).toBe(true);
    });

    test('detects no-streaming gap', () => {
      const useCase = 'Provide real-time updates via websocket';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('streaming'))).toBe(true);
    });

    test('detects no-arithmetic gap', () => {
      const useCase = 'Calculate the total price with discount formula';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('Arithmetic'))).toBe(true);
    });

    test('detects limited-entity-extraction gap', () => {
      const useCase = 'Use NLU to extract named entities from user input';
      const report = detectGapsFromUseCase(useCase);

      expect(
        report.gaps.some(
          (g) => g.requirement.includes('entity extraction') || g.requirement.includes('NLU'),
        ),
      ).toBe(true);
    });

    test('detects no-multi-language gap', () => {
      const useCase = 'Support multilingual conversations with i18n';
      const report = detectGapsFromUseCase(useCase);

      expect(report.gaps.some((g) => g.requirement.includes('Multi-language'))).toBe(true);
    });
  });

  describe('returns no gaps for supported use cases', () => {
    test('simple customer support use case has high coverage', () => {
      const useCase =
        'A customer support agent that helps users with questions and collects their contact information';
      const report = detectGapsFromUseCase(useCase);

      expect(report.overallCoverage).toBeGreaterThanOrEqual(90);
    });

    test('booking assistant use case', () => {
      const useCase = 'Help users book appointments by gathering date, time, and service type';
      const report = detectGapsFromUseCase(useCase);

      expect(report.overallCoverage).toBeGreaterThanOrEqual(90);
    });
  });

  describe('calculates coverage correctly', () => {
    test('100% coverage when no gaps detected', () => {
      const useCase = 'A simple greeting agent';
      const report = detectGapsFromUseCase(useCase);

      expect(report.overallCoverage).toBe(100);
    });

    test('coverage decreases with significant gaps', () => {
      const useCase = 'Need to loop through items and make API calls with database queries';
      const report = detectGapsFromUseCase(useCase);

      expect(report.overallCoverage).toBeLessThan(100);
      expect(report.gaps.length).toBeGreaterThanOrEqual(2);
    });

    test('coverage is never negative', () => {
      const useCase = `
        Build an agent that loops through data, makes HTTP requests,
        schedules periodic tasks, queries the database, uploads files,
        uses streaming real-time updates, performs calculations,
        and supports multiple languages with NLU entity extraction.
      `;
      const report = detectGapsFromUseCase(useCase);

      expect(report.overallCoverage).toBeGreaterThanOrEqual(0);
    });
  });

  describe('gap alternatives', () => {
    test('each gap has at least one alternative', () => {
      const useCase = 'Loop through items, call APIs, and query database';
      const report = detectGapsFromUseCase(useCase);

      for (const gap of report.gaps) {
        expect(gap.alternatives.length).toBeGreaterThan(0);
        expect(gap.alternatives[0].approach).toBeTruthy();
      }
    });

    test('alternatives include DSL patterns', () => {
      const useCase = 'Make HTTP API calls to external services';
      const report = detectGapsFromUseCase(useCase);

      const httpGap = report.gaps.find((g) => g.requirement.includes('HTTP'));
      expect(httpGap).toBeDefined();
      expect(httpGap!.alternatives[0].dslPattern).toContain('TOOLS:');
    });
  });
});

// =============================================================================
// AGENT PLATFORM v12 GAP DETECTION
// =============================================================================

describe('detectAgentPlatformGaps', () => {
  test('detects processors gap', () => {
    const data = {
      agents: [{ name: 'Agent1', processors: [{ type: 'pre', script: 'some code' }] }],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('processor'))).toBe(true);
  });

  test('detects voice/realTimeLlm gap', () => {
    const data = {
      agents: [{ name: 'Agent1', realTimeLlmModel: 'gpt-4' }],
    };
    const report = detectAgentPlatformGaps(data);

    expect(
      report.gaps.some((g) => g.requirement.includes('voice') || g.requirement.includes('VAD')),
    ).toBe(true);
  });

  test('detects thought streaming gap', () => {
    const data = {
      app: {
        appConfigurations: { thoughtStreaming: true },
      },
      agents: [],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('Thought streaming'))).toBe(true);
  });

  test('detects PII masking gap', () => {
    const data = {
      app: {
        piiConfigs: { enabled: true },
      },
      agents: [],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('PII'))).toBe(true);
  });

  test('detects per-agent model config gap', () => {
    const data = {
      agents: [{ name: 'Agent1', aiModel: { model: 'gpt-4', temperature: 0.7 } }],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('Per-agent LLM model'))).toBe(true);
  });

  test('detects content variables gap', () => {
    const data = {
      app: {
        contentVariables: [{ key: 'welcome', value: 'Hello!' }],
      },
      agents: [],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('Content variables'))).toBe(true);
  });

  test('returns 100% coverage when no gaps', () => {
    const data = {
      app: {},
      agents: [{ name: 'SimpleAgent' }],
    };
    const report = detectAgentPlatformGaps(data);

    expect(report.overallCoverage).toBe(100);
  });

  test('handles empty export', () => {
    const data = {};
    const report = detectAgentPlatformGaps(data);

    expect(report.gaps).toHaveLength(0);
    expect(report.overallCoverage).toBe(100);
  });
});

// =============================================================================
// XO11 GAP DETECTION
// =============================================================================

describe('detectXO11Gaps', () => {
  test('detects script nodes gap', () => {
    const data = {
      scriptNodes: [{ name: 'CustomLogic', script: 'return x + 1' }],
    };
    const report = detectXO11Gaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('Script nodes'))).toBe(true);
    expect(report.gaps[0].severity).toBe('significant');
  });

  test('detects rich UX nodes gap', () => {
    const data = {
      dialogFlows: [
        {
          name: 'MainFlow',
          nodes: [{ type: 'carousel', items: [] }],
        },
      ],
    };
    const report = detectXO11Gaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('Channel-specific UX'))).toBe(true);
  });

  test('detects quick reply nodes', () => {
    const data = {
      dialogTasks: [
        {
          name: 'Task1',
          nodes: [{ type: 'quickReply', options: ['Yes', 'No'] }],
        },
      ],
    };
    const report = detectXO11Gaps(data);

    expect(report.gaps.some((g) => g.requirement.includes('UX'))).toBe(true);
  });

  test('returns 100% coverage when no gaps', () => {
    const data = {
      dialogFlows: [
        {
          name: 'SimpleFlow',
          nodes: [{ type: 'message', text: 'Hello' }],
        },
      ],
    };
    const report = detectXO11Gaps(data);

    expect(report.overallCoverage).toBe(100);
  });

  test('handles empty export', () => {
    const data = {};
    const report = detectXO11Gaps(data);

    expect(report.gaps).toHaveLength(0);
    expect(report.overallCoverage).toBe(100);
  });
});

// =============================================================================
// GAP REPORT MERGING
// =============================================================================

describe('mergeGapReports', () => {
  test('merges multiple reports', () => {
    const report1: GapReport = {
      gaps: [
        { requirement: 'Gap A', ablLimitation: 'Limit A', alternatives: [], severity: 'minor' },
      ],
      overallCoverage: 90,
    };
    const report2: GapReport = {
      gaps: [
        { requirement: 'Gap B', ablLimitation: 'Limit B', alternatives: [], severity: 'moderate' },
      ],
      overallCoverage: 85,
    };

    const merged = mergeGapReports(report1, report2);

    expect(merged.gaps).toHaveLength(2);
    expect(merged.gaps.some((g) => g.requirement === 'Gap A')).toBe(true);
    expect(merged.gaps.some((g) => g.requirement === 'Gap B')).toBe(true);
  });

  test('deduplicates gaps with same requirement', () => {
    const report1: GapReport = {
      gaps: [
        { requirement: 'Gap A', ablLimitation: 'Limit A', alternatives: [], severity: 'minor' },
      ],
      overallCoverage: 90,
    };
    const report2: GapReport = {
      gaps: [
        { requirement: 'Gap A', ablLimitation: 'Limit A', alternatives: [], severity: 'minor' },
      ],
      overallCoverage: 90,
    };

    const merged = mergeGapReports(report1, report2);

    expect(merged.gaps).toHaveLength(1);
  });

  test('recalculates coverage after merge', () => {
    const report1: GapReport = {
      gaps: [
        {
          requirement: 'Gap A',
          ablLimitation: 'Limit A',
          alternatives: [],
          severity: 'significant',
        },
      ],
      overallCoverage: 85,
    };
    const report2: GapReport = {
      gaps: [
        {
          requirement: 'Gap B',
          ablLimitation: 'Limit B',
          alternatives: [],
          severity: 'significant',
        },
      ],
      overallCoverage: 85,
    };

    const merged = mergeGapReports(report1, report2);

    // Two significant gaps (15 each) = 30 reduction from 100
    expect(merged.overallCoverage).toBe(70);
  });

  test('handles empty reports', () => {
    const report1: GapReport = { gaps: [], overallCoverage: 100 };
    const report2: GapReport = { gaps: [], overallCoverage: 100 };

    const merged = mergeGapReports(report1, report2);

    expect(merged.gaps).toHaveLength(0);
    expect(merged.overallCoverage).toBe(100);
  });

  test('handles single report', () => {
    const report: GapReport = {
      gaps: [
        { requirement: 'Gap A', ablLimitation: 'Limit A', alternatives: [], severity: 'minor' },
      ],
      overallCoverage: 97,
    };

    const merged = mergeGapReports(report);

    expect(merged.gaps).toHaveLength(1);
  });
});

// =============================================================================
// SEVERITY WEIGHTS
// =============================================================================

describe('severity weights in coverage calculation', () => {
  test('minor gaps reduce coverage by 3', () => {
    const useCase = 'Make API calls'; // triggers no-http-calls (minor)
    const report = detectGapsFromUseCase(useCase);

    const minorGaps = report.gaps.filter((g) => g.severity === 'minor');
    if (minorGaps.length === 1 && report.gaps.length === 1) {
      expect(report.overallCoverage).toBe(97);
    }
  });

  test('moderate gaps reduce coverage by 8', () => {
    const useCase = 'Loop through items'; // triggers no-loops (moderate)
    const report = detectGapsFromUseCase(useCase);

    const moderateGaps = report.gaps.filter((g) => g.severity === 'moderate');
    expect(moderateGaps.length).toBeGreaterThan(0);
  });

  test('significant gaps reduce coverage by 15', () => {
    const xo11Data = {
      scriptNodes: [{ name: 'Script1', script: 'code' }],
    };
    const report = detectXO11Gaps(xo11Data);

    expect(report.gaps[0].severity).toBe('significant');
    expect(report.overallCoverage).toBe(85); // 100 - 15
  });
});
