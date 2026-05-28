import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { validateMemorySemantics } from '../../diagnostics/memory-validators.js';
import type { ValidatorContext } from '../../diagnostics/types.js';

describe('memory-validators', () => {
  function createContext(agents: Record<string, Partial<AgentIR>>): ValidatorContext {
    return {
      agents: agents as Record<string, AgentIR>,
      topology: {},
      projectConfig: {},
    };
  }

  describe('M-01: Session variable declared but never referenced', () => {
    it('emits M-01 when session variable is unused', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'unused_var', type: 'string' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-01',
          severity: 'info',
          agentName: 'test_agent',
          message: expect.stringContaining('unused_var'),
        }),
      );
    });

    it('does not emit M-01 when session variable is used in constraint', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'user_name', type: 'string' }],
          },
          constraints: {
            constraints: [{ condition: 'user_name IS SET' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is used in handoff WHEN', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'escalate_flag', type: 'boolean' }],
          },
          coordination: {
            handoffs: [{ target: 'other_agent', when: 'escalate_flag === true' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is in handoff PASS field', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'context_data', type: 'string' }],
          },
          coordination: {
            handoffs: [{ target: 'other_agent', context: { pass: ['context_data'] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is in completion condition', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'done_flag', type: 'boolean' }],
          },
          completion: {
            conditions: [{ when: 'done_flag === true' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is in flow RESPOND template', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'user_name', type: 'string' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello {{user_name}}' },
            },
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is in flow SET', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'counter', type: 'number' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { set: [{ variable: 'counter', expression: '1' }] },
            },
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('does not emit M-01 when session variable is in REMEMBER trigger', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'session_id', type: 'string' }],
            remember: [
              {
                when: 'session_id IS SET',
                store: { target: 'memory_path', value: '{{session_id}}' },
              },
            ],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });
  });

  describe('M-02: Persistent memory path has no scope', () => {
    it('emits M-02 when persistent memory has no scope', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'history', access: 'read' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-02',
          severity: 'info',
          message: expect.stringContaining('history'),
          message: expect.stringContaining('no scope'),
        }),
      );
    });

    it('does not emit M-02 when persistent memory has scope', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'history', access: 'read', scope: 'user' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-02')).toHaveLength(0);
    });

    it('does not emit M-02 when persistent memory has tenant scope', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'shared_data', access: 'readwrite', scope: 'tenant' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-02')).toHaveLength(0);
    });
  });

  describe('M-03: REMEMBER trigger references undefined variable', () => {
    it('emits M-03 when REMEMBER stores undefined session variable', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'defined_var', type: 'string' }],
            remember: [{ store: { target: 'memory_path', value: '{{undefined_var}}' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-03',
          severity: 'warning',
          message: expect.stringContaining('undefined_var'),
        }),
      );
    });

    it('does not emit M-03 when REMEMBER references declared session variable', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'user_input', type: 'string' }],
            remember: [{ store: { target: 'memory_path', value: '{{user_input}}' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-03')).toHaveLength(0);
    });

    it('does not emit M-03 when REMEMBER references persistent memory path', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'stored_value', access: 'read', scope: 'user' }],
            remember: [{ store: { target: 'memory_path', value: '{{stored_value}}' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-03')).toHaveLength(0);
    });

    it('handles REMEMBER with multiple variable references', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [
              { name: 'var1', type: 'string' },
              { name: 'var2', type: 'string' },
            ],
            remember: [
              { store: { target: 'memory_path', value: '{{var1}} and {{var2}} and {{var3}}' } },
            ],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      const m03Findings = findings.filter((f) => f.code === 'M-03');
      expect(m03Findings.length).toBeGreaterThanOrEqual(1);
      expect(m03Findings[0].message).toContain('var3');
    });
  });

  describe('M-04: RECALL references non-existent memory path', () => {
    it('emits M-04 when RECALL injects undefined persistent path', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'defined_path', access: 'read', scope: 'user' }],
            recall: [{ action: { type: 'inject_context', paths: ['undefined_path'] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-04',
          severity: 'error',
          message: expect.stringContaining('undefined_path'),
        }),
      );
    });

    it('does not emit M-04 when RECALL references declared persistent path', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'conversation_history', access: 'read', scope: 'user' }],
            recall: [{ action: { type: 'inject_context', paths: ['conversation_history'] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-04')).toHaveLength(0);
    });

    it('does not emit M-04 when RECALL references session variable', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'session_data', type: 'string' }],
            recall: [{ action: { type: 'inject_context', paths: ['session_data'] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-04')).toHaveLength(0);
    });

    it('handles RECALL with multiple paths', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'path1', access: 'read', scope: 'user' }],
            recall: [{ action: { type: 'inject_context', paths: ['path1', 'path2', 'path3'] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      const m04Findings = findings.filter((f) => f.code === 'M-04');
      expect(m04Findings.length).toBe(2);
    });

    it('does not emit M-04 when RECALL has no paths', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            recall: [{ action: { type: 'inject_context' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-04')).toHaveLength(0);
    });

    it('does not emit M-04 when RECALL action is not inject_context', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            recall: [{ action: { type: 'other_type' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-04')).toHaveLength(0);
    });
  });

  describe('M-05: Persistent memory with write access but no REMEMBER writes to it', () => {
    it('emits M-05 when persistent memory has write access but no REMEMBER', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'writable_path', access: 'write', scope: 'user' }],
            remember: [],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-05',
          severity: 'info',
          message: expect.stringContaining('writable_path'),
          message: expect.stringContaining('no REMEMBER'),
        }),
      );
    });

    it('emits M-05 when persistent memory has readwrite access but no REMEMBER', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'rw_path', access: 'readwrite', scope: 'user' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'M-05',
          message: expect.stringContaining('rw_path'),
        }),
      );
    });

    it('does not emit M-05 when persistent memory has write access and REMEMBER writes to it', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'writable_path', access: 'write', scope: 'user' }],
            remember: [{ store: { target: 'writable_path', value: 'data' } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-05')).toHaveLength(0);
    });

    it('does not emit M-05 when persistent memory has read-only access', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'readonly_path', access: 'read', scope: 'user' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-05')).toHaveLength(0);
    });

    it('does not emit M-05 when persistent memory has no access specified', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            persistent: [{ path: 'default_path', scope: 'user' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-05')).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('handles agent with no memory config', () => {
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

      const findings = validateMemorySemantics(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles empty agents object', () => {
      const ctx = createContext({});
      const findings = validateMemorySemantics(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles memory with empty arrays', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [],
            persistent: [],
            remember: [],
            recall: [],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles template references correctly', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'user_name', type: 'string' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello {{user_name}}!' },
            },
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      const m01Findings = findings.filter((f) => f.code === 'M-01');
      // user_name is referenced in the template
      expect(m01Findings).toHaveLength(0);
    });

    it('handles variable references in expression with operators', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [
              { name: 'count', type: 'number' },
              { name: 'threshold', type: 'number' },
            ],
          },
          constraints: {
            constraints: [{ condition: 'count > threshold AND count < 100' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('handles handoff PASS with object notation', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'data', type: 'string' }],
          },
          coordination: {
            handoffs: [{ target: 'other', context: { pass: [{ name: 'data', as: 'renamed' }] } }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('handles flow CALL_AS assignment', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'result', type: 'string' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'api_tool', call_as: 'result' },
            },
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('handles flow complete_when condition', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'done', type: 'boolean' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Working...', complete_when: 'done === true' },
            },
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('filters out reserved keywords from variable refs', () => {
      const ctx = createContext({
        test_agent: {
          memory: {
            session: [{ name: 'flag', type: 'boolean' }],
          },
          constraints: {
            constraints: [{ condition: 'flag IS SET AND true OR false' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.filter((f) => f.code === 'M-01')).toHaveLength(0);
    });

    it('handles multiple agents with different memory configs', () => {
      const ctx = createContext({
        agent1: {
          memory: {
            session: [{ name: 'unused', type: 'string' }],
          },
        },
        agent2: {
          memory: {
            persistent: [{ path: 'data', access: 'write', scope: 'user' }],
          },
        },
      });

      const findings = validateMemorySemantics(ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.agentName === 'agent1')).toBe(true);
      expect(findings.some((f) => f.agentName === 'agent2')).toBe(true);
    });
  });
});
