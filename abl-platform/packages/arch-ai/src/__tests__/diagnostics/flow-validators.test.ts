import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { validateFlowSemantics } from '../../diagnostics/flow-validators.js';
import type { ValidatorContext } from '../../diagnostics/types.js';

describe('flow-validators', () => {
  function createContext(agents: Record<string, Partial<AgentIR>>): ValidatorContext {
    return {
      agents: agents as Record<string, AgentIR>,
      topology: {},
      projectConfig: {},
    };
  }

  describe('F-03: No entry point', () => {
    it('emits F-03 when steps array is empty', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: [],
            definitions: {},
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-03',
          severity: 'error',
          agentName: 'test_agent',
          message: expect.stringContaining('empty steps array'),
        }),
      );
    });

    it('emits F-03 when first step has no definition', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {},
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-03',
          severity: 'error',
          agentName: 'test_agent',
          message: expect.stringContaining('entry point "start" has no definition'),
        }),
      );
    });

    it('does not emit F-03 when entry point is defined', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-03')).toHaveLength(0);
    });
  });

  describe('F-01: THEN references non-existent step', () => {
    it('emits F-01 when THEN references undefined step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                respond: 'Hello',
                then: 'missing_step',
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-01',
          severity: 'error',
          message: expect.stringContaining('THEN references non-existent step "missing_step"'),
        }),
      );
    });

    it('does not emit F-01 when THEN is COMPLETE', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                respond: 'Hello',
                then: 'COMPLETE',
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-01')).toHaveLength(0);
    });

    it('emits F-01 when ON_INPUT branch targets non-existent step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                gather: 'name',
                on_input: [{ when: 'yes', then: 'missing' }],
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-01',
          message: expect.stringContaining('ON_INPUT branch targets non-existent step "missing"'),
        }),
      );
    });

    it('emits F-01 when ON_RESULT branch targets non-existent step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                call: 'api_tool',
                on_result: [{ when: 'success', then: 'missing' }],
              },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-01',
          message: expect.stringContaining('ON_RESULT branch targets non-existent step "missing"'),
        }),
      );
    });

    it('emits F-01 when ON_SUCCESS targets non-existent step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                call: 'api_tool',
                on_success: { then: 'missing' },
              },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-01',
          message: expect.stringContaining('ON_SUCCESS targets non-existent step "missing"'),
        }),
      );
    });

    it('emits F-01 when ON_FAILURE targets non-existent step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                call: 'api_tool',
                on_failure: { then: 'missing' },
              },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-01',
          message: expect.stringContaining('ON_FAILURE targets non-existent step "missing"'),
        }),
      );
    });

    it('does not emit F-01 when all branches target existing steps', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'next'],
            definitions: {
              start: {
                gather: 'name',
                then: 'next',
                on_input: [{ when: 'yes', then: 'next' }],
              },
              next: { respond: 'Done', then: 'COMPLETE' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-01')).toHaveLength(0);
    });
  });

  describe('F-04: Step has no action', () => {
    it('emits F-04 when step has no action fields', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { then: 'COMPLETE' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-04',
          severity: 'warning',
          message: expect.stringContaining('has no action'),
        }),
      );
    });

    it('does not emit F-04 when step has respond', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });

    it('does not emit F-04 when step has gather', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { gather: 'name' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });

    it('does not emit F-04 when step has call', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'tool_name' },
            },
          },
          tools: [{ name: 'tool_name', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });

    it('does not emit F-04 when step has reasoning_zone', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { reasoning_zone: { available_tools: ['tool'] } },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });

    it('does not emit F-04 when step has set', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { set: { variable: 'value' } },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });

    it('does not emit F-04 when step has on_input', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { on_input: [{ when: 'condition', then: 'COMPLETE' }] },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-04')).toHaveLength(0);
    });
  });

  describe('F-06: CALL references non-existent tool', () => {
    it('emits F-06 when CALL references undefined tool', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'missing_tool' },
            },
          },
          tools: [],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-06',
          severity: 'error',
          message: expect.stringContaining('CALL references tool "missing_tool"'),
        }),
      );
    });

    it('does not emit F-06 when tool is defined', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'api_tool' },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-06')).toHaveLength(0);
    });

    it('handles CALL with parameters syntax', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'api_tool({"arg": "value"})' },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-06')).toHaveLength(0);
    });
  });

  describe('F-12: max_attempts is invalid', () => {
    it('emits F-12 when max_turns is 0', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {
                  available_tools: ['tool'],
                  max_turns: 0,
                },
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-12',
          severity: 'warning',
          message: expect.stringContaining('max_turns=0'),
        }),
      );
    });

    it('emits F-12 when max_turns is negative', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {
                  available_tools: ['tool'],
                  max_turns: -1,
                },
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-12',
          message: expect.stringContaining('max_turns=-1'),
        }),
      );
    });

    it('does not emit F-12 when max_turns is positive', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {
                  available_tools: ['tool'],
                  max_turns: 5,
                },
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-12')).toHaveLength(0);
    });
  });

  describe('F-14: REASONING_ZONE has no available_tools', () => {
    it('emits F-14 when available_tools is missing', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {},
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-14',
          severity: 'warning',
          message: expect.stringContaining('no available_tools'),
        }),
      );
    });

    it('emits F-14 when available_tools is empty', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {
                  available_tools: [],
                },
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-14',
          message: expect.stringContaining('no available_tools'),
        }),
      );
    });

    it('does not emit F-14 when available_tools is populated', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: {
                reasoning_zone: {
                  available_tools: ['tool1', 'tool2'],
                },
              },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-14')).toHaveLength(0);
    });
  });

  describe('F-02: Unreachable steps', () => {
    it('emits F-02 when a step is unreachable', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'orphan'],
            definitions: {
              start: { respond: 'Hello', then: 'COMPLETE' },
              orphan: { respond: 'Never reached' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-02',
          severity: 'warning',
          message: expect.stringContaining('step "orphan" is unreachable'),
        }),
      );
    });

    it('does not emit F-02 when all steps are reachable via THEN', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'next', 'end'],
            definitions: {
              start: { respond: 'Hello', then: 'next' },
              next: { respond: 'Middle', then: 'end' },
              end: { respond: 'Done', then: 'COMPLETE' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });

    it('does not emit F-02 when steps are reachable via ON_INPUT', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'branch'],
            definitions: {
              start: {
                gather: 'name',
                on_input: [{ when: 'condition', then: 'branch' }],
                then: 'COMPLETE',
              },
              branch: { respond: 'Branched', then: 'COMPLETE' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });

    it('does not emit F-02 when steps are reachable via ON_RESULT', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'success_branch'],
            definitions: {
              start: {
                call: 'api_tool',
                on_result: [{ when: 'success', then: 'success_branch' }],
                then: 'COMPLETE',
              },
              success_branch: { respond: 'Success', then: 'COMPLETE' },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });

    it('does not emit F-02 when steps are reachable via digressions', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'digression'],
            definitions: {
              start: {
                respond: 'Hello',
                digressions: [{ when: 'help', goto: 'digression' }],
                then: 'COMPLETE',
              },
              digression: { respond: 'Help text', then: 'COMPLETE' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });

    it('does not emit F-02 when steps are reachable via ON_SUCCESS', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'success'],
            definitions: {
              start: {
                call: 'api_tool',
                on_success: { then: 'success' },
                then: 'COMPLETE',
              },
              success: { respond: 'Success', then: 'COMPLETE' },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });

    it('does not emit F-02 when steps are reachable via ON_FAILURE', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'failure'],
            definitions: {
              start: {
                call: 'api_tool',
                on_failure: { then: 'failure' },
                then: 'COMPLETE',
              },
              failure: { respond: 'Failed', then: 'COMPLETE' },
            },
          },
          tools: [{ name: 'api_tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-02')).toHaveLength(0);
    });
  });

  describe('F-09: Cycle without exit condition', () => {
    it('emits F-09 when there is a cycle with no exit', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['a', 'b'],
            definitions: {
              a: { respond: 'A', then: 'b' },
              b: { respond: 'B', then: 'a' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-09',
          severity: 'error',
          message: expect.stringContaining('cycle'),
        }),
      );
    });

    it('does not emit F-09 when cycle has THEN: COMPLETE exit', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['a', 'b'],
            definitions: {
              a: { respond: 'A', then: 'b' },
              b: { respond: 'B', on_input: [{ when: 'exit', then: 'COMPLETE' }], then: 'a' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-09')).toHaveLength(0);
    });

    it('does not emit F-09 when cycle has complete_when condition', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['a', 'b'],
            definitions: {
              a: { respond: 'A', then: 'b' },
              b: { respond: 'B', complete_when: 'condition', then: 'a' },
            },
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-09')).toHaveLength(0);
    });

    it('does not emit F-09 when cycle has ON_SUCCESS exit', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['a', 'b'],
            definitions: {
              a: { call: 'tool', on_success: { then: 'COMPLETE' }, then: 'b' },
              b: { respond: 'B', then: 'a' },
            },
          },
          tools: [{ name: 'tool', description: 'test' }],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.filter((f) => f.code === 'F-09')).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('handles agent with no flow', () => {
      const ctx = createContext({
        test_agent: {
          tools: [],
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles empty agents object', () => {
      const ctx = createContext({});
      const findings = validateFlowSemantics(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles flow with no definitions', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'F-03',
          severity: 'error',
        }),
      );
    });

    it('handles multiple agents with different issues', () => {
      const ctx = createContext({
        agent1: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello', then: 'missing' },
            },
          },
        },
        agent2: {
          flow: {
            steps: [],
            definitions: {},
          },
        },
      });

      const findings = validateFlowSemantics(ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.agentName === 'agent1')).toBe(true);
      expect(findings.some((f) => f.agentName === 'agent2')).toBe(true);
    });
  });
});
