import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { classifyArchitecture, detectAntiPatterns } from '../../diagnostics/pattern-analyzer.js';
import type {
  ValidatorContext,
  ArchitecturePattern,
  AntiPattern,
} from '../../diagnostics/types.js';

describe('pattern-analyzer', () => {
  function createContext(
    agents: Record<string, Partial<AgentIR>>,
    options?: { entryAgent?: string; agentNames?: string[] },
  ): ValidatorContext {
    return {
      agents: agents as Record<string, AgentIR>,
      topology: {},
      projectConfig: {},
      entryAgent: options?.entryAgent,
      agentNames: options?.agentNames ?? Object.keys(agents),
    };
  }

  describe('classifyArchitecture', () => {
    it('returns "unknown" for empty project', () => {
      const ctx = createContext({});
      expect(classifyArchitecture(ctx)).toBe('unknown');
    });

    it('returns "single-agent" for one agent', () => {
      const ctx = createContext({
        main: { tools: [] },
      });
      expect(classifyArchitecture(ctx)).toBe('single-agent');
    });

    describe('hub-spoke pattern', () => {
      it('detects hub-spoke with router and multiple targets', () => {
        const ctx = createContext({
          router: {
            routing: {
              rules: [
                { to: 'worker1', when: 'intent === "a"' },
                { to: 'worker2', when: 'intent === "b"' },
              ],
            },
            coordination: {
              handoffs: [{ to: 'worker1' }, { to: 'worker2' }],
            },
          },
          worker1: { tools: [] },
          worker2: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('hub-spoke');
      });

      it('requires router to have multiple targets', () => {
        const ctx = createContext({
          router: {
            routing: { rules: [{ to: 'worker1', when: 'true' }] },
            coordination: { handoffs: [{ to: 'worker1' }] },
          },
          worker1: { tools: [] },
        });

        // Only one target, not hub-spoke
        expect(classifyArchitecture(ctx)).not.toBe('hub-spoke');
      });

      it('allows one non-router to have handoffs', () => {
        const ctx = createContext({
          router: {
            routing: {
              rules: [
                { to: 'worker1', when: 'true' },
                { to: 'worker2', when: 'true' },
              ],
            },
            coordination: { handoffs: [{ to: 'worker1' }, { to: 'worker2' }] },
          },
          worker1: { coordination: { handoffs: [{ to: 'router' }] } },
          worker2: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('hub-spoke');
      });
    });

    describe('triage pattern', () => {
      it('detects triage with entry routing agent', () => {
        const ctx = createContext(
          {
            triage: {
              routing: { rules: [{ to: 'specialist', when: 'true' }] },
              gather: { fields: [] },
              tools: [],
            },
            specialist: { tools: [{ name: 'tool1', description: 'Test' }] },
          },
          { entryAgent: 'triage' },
        );

        expect(classifyArchitecture(ctx)).toBe('triage');
      });

      it('requires no gather fields', () => {
        const ctx = createContext(
          {
            triage: {
              routing: { rules: [{ to: 'specialist', when: 'true' }] },
              gather: { fields: [{ name: 'field1', type: 'string' }] },
              tools: [],
            },
            specialist: { tools: [] },
          },
          { entryAgent: 'triage' },
        );

        expect(classifyArchitecture(ctx)).not.toBe('triage');
      });

      it('requires no tools', () => {
        const ctx = createContext(
          {
            triage: {
              routing: { rules: [{ to: 'specialist', when: 'true' }] },
              gather: { fields: [] },
              tools: [{ name: 'tool1', description: 'Test' }],
            },
            specialist: { tools: [] },
          },
          { entryAgent: 'triage' },
        );

        expect(classifyArchitecture(ctx)).not.toBe('triage');
      });

      it('requires routing rules', () => {
        const ctx = createContext(
          {
            triage: {
              routing: { rules: [] },
              gather: { fields: [] },
              tools: [],
            },
            specialist: { tools: [] },
          },
          { entryAgent: 'triage' },
        );

        expect(classifyArchitecture(ctx)).not.toBe('triage');
      });
    });

    describe('pipeline pattern', () => {
      it('detects linear chain A→B→C', () => {
        const ctx = createContext({
          a: { coordination: { handoffs: [{ to: 'b' }] } },
          b: { coordination: { handoffs: [{ to: 'c' }] } },
          c: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('pipeline');
      });

      it('allows for tail agent with no outbound', () => {
        const ctx = createContext({
          a: { coordination: { handoffs: [{ to: 'b' }] } },
          b: { coordination: { handoffs: [{ to: 'c' }] } },
          c: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('pipeline');
      });

      it('detects pipeline with 4 agents', () => {
        const ctx = createContext({
          a: { coordination: { handoffs: [{ to: 'b' }] } },
          b: { coordination: { handoffs: [{ to: 'c' }] } },
          c: { coordination: { handoffs: [{ to: 'd' }] } },
          d: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('pipeline');
      });
    });

    describe('hierarchical pattern', () => {
      it('detects hierarchical with multiple delegators', () => {
        const ctx = createContext({
          top: { coordination: { delegates: [{ agent: 'middle1' }, { agent: 'middle2' }] } },
          middle1: { coordination: { delegates: [{ agent: 'worker1' }] } },
          middle2: { tools: [] },
          worker1: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).toBe('hierarchical');
      });

      it('requires at least 2 delegators', () => {
        const ctx = createContext({
          top: { coordination: { delegates: [{ agent: 'worker1' }] } },
          worker1: { tools: [] },
        });

        expect(classifyArchitecture(ctx)).not.toBe('hierarchical');
      });
    });

    describe('mesh pattern', () => {
      it('detects bidirectional handoffs', () => {
        const ctx = createContext({
          a: { coordination: { handoffs: [{ to: 'b' }] } },
          b: { coordination: { handoffs: [{ to: 'a' }, { to: 'c' }] } },
          c: { coordination: { handoffs: [{ to: 'b' }] } },
        });

        // This topology matches pipeline pattern (a and c are chain agents with outbound=1, inbound≤1)
        expect(classifyArchitecture(ctx)).toBe('pipeline');
      });

      it('requires at least 2 bidirectional pairs', () => {
        const ctx = createContext({
          a: { coordination: { handoffs: [{ to: 'b' }] } },
          b: { coordination: { handoffs: [{ to: 'a' }] } },
          c: { tools: [] },
        });

        // a and b are both chain agents (outbound=1, inbound≤1), matching pipeline
        expect(classifyArchitecture(ctx)).toBe('pipeline');
      });
    });

    it('defaults to hub-spoke for unclear multi-agent structure', () => {
      const ctx = createContext({
        agent1: { tools: [] },
        agent2: { tools: [] },
      });

      expect(classifyArchitecture(ctx)).toBe('hub-spoke');
    });
  });

  describe('detectAntiPatterns', () => {
    describe('overloaded-agent', () => {
      it('detects agent with >10 tools, >10 fields, and handoffs', () => {
        const ctx = createContext({
          overloaded: {
            tools: Array.from({ length: 11 }, (_, i) => ({
              name: `tool${i}`,
              description: 'Test',
            })),
            gather: {
              fields: Array.from({ length: 11 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
            coordination: {
              handoffs: [{ to: 'other' }],
            },
          },
          other: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'overloaded-agent',
            agents: ['overloaded'],
            severity: 'warning',
          }),
        );
      });

      it('does not detect when tools ≤ 10', () => {
        const ctx = createContext({
          agent: {
            tools: Array.from({ length: 10 }, (_, i) => ({
              name: `tool${i}`,
              description: 'Test',
            })),
            gather: {
              fields: Array.from({ length: 11 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
            coordination: { handoffs: [{ to: 'other' }] },
          },
          other: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'overloaded-agent')).toHaveLength(0);
      });

      it('does not detect when fields ≤ 10', () => {
        const ctx = createContext({
          agent: {
            tools: Array.from({ length: 11 }, (_, i) => ({
              name: `tool${i}`,
              description: 'Test',
            })),
            gather: {
              fields: Array.from({ length: 10 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
            coordination: { handoffs: [{ to: 'other' }] },
          },
          other: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'overloaded-agent')).toHaveLength(0);
      });

      it('does not detect when no handoffs', () => {
        const ctx = createContext({
          agent: {
            tools: Array.from({ length: 11 }, (_, i) => ({
              name: `tool${i}`,
              description: 'Test',
            })),
            gather: {
              fields: Array.from({ length: 11 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'overloaded-agent')).toHaveLength(0);
      });

      it('includes fix suggestion', () => {
        const ctx = createContext({
          overloaded: {
            tools: Array.from({ length: 11 }, (_, i) => ({
              name: `tool${i}`,
              description: 'Test',
            })),
            gather: {
              fields: Array.from({ length: 11 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
            coordination: { handoffs: [{ to: 'other' }] },
          },
          other: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        const overloaded = patterns.find((p) => p.name === 'overloaded-agent');
        expect(overloaded?.fix).toBeDefined();
        expect(overloaded?.fix.effort).toBe('L');
      });
    });

    describe('supervisor-with-logic', () => {
      it('detects router with >3 gather fields', () => {
        const ctx = createContext({
          supervisor: {
            metadata: { type: 'supervisor' } as AgentIR['metadata'],
            routing: { rules: [{ to: 'worker', when: 'true' }] },
            gather: {
              fields: Array.from({ length: 4 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
          },
          worker: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'supervisor-with-logic',
            agents: ['supervisor'],
            severity: 'warning',
          }),
        );
      });

      it('detects router with >3 tools', () => {
        const ctx = createContext({
          supervisor: {
            metadata: { type: 'supervisor' } as AgentIR['metadata'],
            routing: { rules: [{ to: 'worker', when: 'true' }] },
            tools: Array.from({ length: 4 }, (_, i) => ({ name: `tool${i}`, description: 'Test' })),
          },
          worker: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'supervisor-with-logic',
            agents: ['supervisor'],
          }),
        );
      });

      it('does not detect when fields ≤ 3', () => {
        const ctx = createContext({
          supervisor: {
            metadata: { type: 'supervisor' } as AgentIR['metadata'],
            routing: { rules: [{ to: 'worker', when: 'true' }] },
            gather: {
              fields: Array.from({ length: 3 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
          },
          worker: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'supervisor-with-logic')).toHaveLength(0);
      });

      it('does not detect when tools ≤ 3', () => {
        const ctx = createContext({
          supervisor: {
            metadata: { type: 'supervisor' } as AgentIR['metadata'],
            routing: { rules: [{ to: 'worker', when: 'true' }] },
            tools: Array.from({ length: 3 }, (_, i) => ({ name: `tool${i}`, description: 'Test' })),
          },
          worker: { tools: [] },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'supervisor-with-logic')).toHaveLength(0);
      });

      it('does not detect when no routing', () => {
        const ctx = createContext({
          agent: {
            gather: {
              fields: Array.from({ length: 4 }, (_, i) => ({ name: `field${i}`, type: 'string' })),
            },
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'supervisor-with-logic')).toHaveLength(0);
      });
    });

    describe('under-constrained', () => {
      it('detects reasoning agent with tools but no guardrails', () => {
        const ctx = createContext({
          reasoner: {
            execution: { mode: 'reasoning' },
            tools: [{ name: 'tool1', description: 'Test' }],
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'under-constrained',
            agents: ['reasoner'],
            severity: 'warning',
          }),
        );
      });

      it('does not detect when guardrails present', () => {
        const ctx = createContext({
          reasoner: {
            execution: { mode: 'reasoning' },
            tools: [{ name: 'tool1', description: 'Test' }],
            constraints: {
              guardrails: [{ type: 'input', rule: 'safe' }],
            },
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'under-constrained')).toHaveLength(0);
      });

      it('does not detect when no tools', () => {
        const ctx = createContext({
          reasoner: {
            execution: { mode: 'reasoning' },
            tools: [],
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'under-constrained')).toHaveLength(0);
      });

      it('does not detect when not reasoning mode', () => {
        const ctx = createContext({
          agent: {
            execution: { mode: 'guided' },
            tools: [{ name: 'tool1', description: 'Test' }],
          },
        });

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'under-constrained')).toHaveLength(0);
      });
    });

    describe('orphaned-agents', () => {
      it('detects agents with no inbound handoffs', () => {
        const ctx = createContext(
          {
            entry: {
              coordination: { handoffs: [{ to: 'reachable' }] },
            },
            reachable: { tools: [] },
            orphan1: { tools: [] },
            orphan2: { tools: [] },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'reachable', 'orphan1', 'orphan2'] },
        );

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'orphaned-agents',
            agents: expect.arrayContaining(['orphan1', 'orphan2']),
            severity: 'warning',
          }),
        );
      });

      it('does not flag entry agent as orphaned', () => {
        const ctx = createContext(
          {
            entry: { tools: [] },
            other: { coordination: { handoffs: [{ to: 'entry' }] } },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'other'] },
        );

        const patterns = detectAntiPatterns(ctx);
        const orphaned = patterns.find((p) => p.name === 'orphaned-agents');
        expect(orphaned?.agents).not.toContain('entry');
      });

      it('detects agents not reached by delegates', () => {
        const ctx = createContext(
          {
            entry: {
              coordination: { delegates: [{ agent: 'reachable' }] },
            },
            reachable: { tools: [] },
            orphan: { tools: [] },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'reachable', 'orphan'] },
        );

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'orphaned-agents',
            agents: ['orphan'],
          }),
        );
      });

      it('detects agents not reached by routing rules', () => {
        const ctx = createContext(
          {
            entry: {
              routing: { rules: [{ to: 'reachable', when: 'true' }] },
            },
            reachable: { tools: [] },
            orphan: { tools: [] },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'reachable', 'orphan'] },
        );

        const patterns = detectAntiPatterns(ctx);
        expect(patterns).toContainEqual(
          expect.objectContaining({
            name: 'orphaned-agents',
            agents: ['orphan'],
          }),
        );
      });

      it('does not detect when all agents are reachable', () => {
        const ctx = createContext(
          {
            entry: {
              coordination: { handoffs: [{ to: 'a' }] },
            },
            a: {
              coordination: { handoffs: [{ to: 'b' }] },
            },
            b: { tools: [] },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'a', 'b'] },
        );

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.filter((p) => p.name === 'orphaned-agents')).toHaveLength(0);
      });
    });

    describe('multiple anti-patterns', () => {
      it('detects multiple anti-patterns in one project', () => {
        const ctx = createContext(
          {
            entry: {
              metadata: { type: 'supervisor' } as AgentIR['metadata'],
              routing: { rules: [{ to: 'overloaded', when: 'true' }] },
              gather: {
                fields: Array.from({ length: 4 }, (_, i) => ({
                  name: `field${i}`,
                  type: 'string',
                })),
              },
            },
            overloaded: {
              tools: Array.from({ length: 11 }, (_, i) => ({
                name: `tool${i}`,
                description: 'Test',
              })),
              gather: {
                fields: Array.from({ length: 11 }, (_, i) => ({
                  name: `field${i}`,
                  type: 'string',
                })),
              },
              coordination: { handoffs: [{ to: 'reasoner' }] },
            },
            reasoner: {
              execution: { mode: 'reasoning' },
              tools: [{ name: 'dangerous', description: 'Test' }],
            },
            orphan: { tools: [] },
          },
          { entryAgent: 'entry', agentNames: ['entry', 'overloaded', 'reasoner', 'orphan'] },
        );

        const patterns = detectAntiPatterns(ctx);
        expect(patterns.length).toBeGreaterThanOrEqual(3);
        expect(patterns.some((p) => p.name === 'supervisor-with-logic')).toBe(true);
        expect(patterns.some((p) => p.name === 'overloaded-agent')).toBe(true);
        expect(patterns.some((p) => p.name === 'under-constrained')).toBe(true);
        expect(patterns.some((p) => p.name === 'orphaned-agents')).toBe(true);
      });
    });

    it('returns empty array for clean architecture', () => {
      const ctx = createContext(
        {
          entry: {
            routing: { rules: [{ to: 'worker', when: 'true' }] },
          },
          worker: {
            tools: [{ name: 'tool1', description: 'Test' }],
            constraints: { guardrails: [{ type: 'input', rule: 'safe' }] },
          },
        },
        { entryAgent: 'entry', agentNames: ['entry', 'worker'] },
      );

      const patterns = detectAntiPatterns(ctx);
      expect(patterns).toHaveLength(0);
    });
  });
});
