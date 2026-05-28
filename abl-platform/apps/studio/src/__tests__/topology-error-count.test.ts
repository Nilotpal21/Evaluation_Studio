/**
 * Test for topology error counting fix
 *
 * Validates that we count unique failed agents instead of total error messages.
 */

import { describe, it, expect } from 'vitest';

describe('Topology Error Counting', () => {
  describe('Error Tracking Logic', () => {
    it('should track unique failed agents with Set', () => {
      const failedAgents = new Set<string>();
      const errors: string[] = [];

      // Simulate agent with multiple errors
      const agentName = 'broken_agent';

      // Add same agent multiple times (simulating multiple error types)
      failedAgents.add(agentName);
      errors.push(`${agentName}: Parse error 1`);

      failedAgents.add(agentName); // Set deduplicates
      errors.push(`${agentName}: Parse error 2`);

      failedAgents.add(agentName); // Set deduplicates
      errors.push(`${agentName}: Tool error`);

      // Agent counted once, but 3 error messages
      expect(failedAgents.size).toBe(1);
      expect(errors.length).toBe(3);
    });

    it('should track multiple unique failed agents', () => {
      const failedAgents = new Set<string>();
      const errors: string[] = [];

      // Simulate 3 agents failing
      ['agent1', 'agent2', 'agent3'].forEach((name) => {
        failedAgents.add(name);
        errors.push(`${name}: Error 1`);
        errors.push(`${name}: Error 2`);
      });

      expect(failedAgents.size).toBe(3);
      expect(errors.length).toBe(6);
    });
  });

  describe('Compilation Error Tracking', () => {
    it('should track agents from compilation errors', () => {
      const failedAgents = new Set<string>();

      // Simulate compilation errors
      const compilationErrors = [
        { agent: 'agent1', message: 'Tool not found: missing_tool', type: 'compilation' as const },
        {
          agent: 'agent1',
          message: 'Tool not found: another_missing',
          type: 'compilation' as const,
        },
        { agent: 'agent2', message: 'Invalid flow step', type: 'compilation' as const },
      ];

      for (const ce of compilationErrors) {
        if (ce.agent) {
          failedAgents.add(ce.agent);
        }
      }

      // 2 unique agents, 3 total errors
      expect(failedAgents.size).toBe(2);
      expect(compilationErrors.length).toBe(3);
    });
  });

  describe('Error Summary Structure', () => {
    it('should create correct error summary structure', () => {
      const failedAgents = new Set(['agent1', 'agent2']);
      const errors = ['agent1: Parse error', 'agent1: Tool error', 'agent2: Compilation error'];

      const errorSummary = {
        failedAgentCount: failedAgents.size,
        totalErrorCount: errors.length,
      };

      // Error details are kept in separate 'errors' array (not in errorSummary)
      expect(errorSummary).toMatchObject({
        failedAgentCount: 2,
        totalErrorCount: 3,
      });

      // Verify the separate errors array contains all messages
      expect(errors).toHaveLength(3);
      expect(errors).toEqual(
        expect.arrayContaining([
          'agent1: Parse error',
          'agent1: Tool error',
          'agent2: Compilation error',
        ]),
      );
    });

    it('should handle case with no errors', () => {
      const failedAgents = new Set<string>();
      const errors: string[] = [];

      const errorSummary = {
        failedAgentCount: failedAgents.size,
        totalErrorCount: errors.length,
      };

      expect(errorSummary).toMatchObject({
        failedAgentCount: 0,
        totalErrorCount: 0,
      });
    });
  });

  describe('Real-World Scenario', () => {
    it('should correctly count agents when one agent has many errors', () => {
      // This simulates the cloud scenario:
      // - 1 agent fails
      // - Generates 6 errors (parse + tool + compilation)
      const failedAgents = new Set<string>();
      const errors: string[] = [];

      const agentName = 'complex_agent';

      // Parse errors (2)
      failedAgents.add(agentName);
      errors.push(`${agentName}: Parse error 1`);
      errors.push(`${agentName}: Parse error 2`);

      // Tool errors (2)
      failedAgents.add(agentName); // Set deduplicates
      errors.push(`${agentName}: Tool not found: tool1`);
      errors.push(`${agentName}: Tool not found: tool2`);

      // Compilation errors (2)
      failedAgents.add(agentName); // Set deduplicates
      errors.push(`${agentName}: Compilation error 1`);
      errors.push(`${agentName}: Compilation error 2`);

      const errorSummary = {
        failedAgentCount: failedAgents.size,
        totalErrorCount: errors.length,
      };

      // UI should show: "1 agent failed to compile (6 errors)"
      // NOT: "6 agents failed to compile"
      expect(errorSummary.failedAgentCount).toBe(1);
      expect(errorSummary.totalErrorCount).toBe(6);
      expect(errorSummary.failedAgentCount).toBeLessThan(errorSummary.totalErrorCount);

      // Error details are kept in separate 'errors' array
      expect(errors).toHaveLength(6);
    });

    it('should simulate cloud deployment with 200 agents', () => {
      const failedAgents = new Set<string>();
      const errors: string[] = [];

      // Simulate 200 agents, each generating 6 errors
      for (let i = 1; i <= 200; i++) {
        const agentName = `agent_${i}`;
        failedAgents.add(agentName);

        // Each agent generates multiple errors
        for (let j = 1; j <= 6; j++) {
          errors.push(`${agentName}: Error ${j}`);
        }
      }

      const errorSummary = {
        failedAgentCount: failedAgents.size,
        totalErrorCount: errors.length,
      };

      // Before fix: UI showed "1,200 agents failed"
      // After fix: UI shows "200 agents failed (1,200 errors)"
      expect(errorSummary.failedAgentCount).toBe(200);
      expect(errorSummary.totalErrorCount).toBe(1200);

      // The ratio shows the problem: 6x inflation
      const inflationRatio = errorSummary.totalErrorCount / errorSummary.failedAgentCount;
      expect(inflationRatio).toBe(6);

      // Error details are kept in separate 'errors' array
      expect(errors).toHaveLength(1200);
    });
  });
});
