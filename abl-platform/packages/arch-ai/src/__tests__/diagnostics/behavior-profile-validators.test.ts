import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { validateBehaviorProfiles } from '../../diagnostics/behavior-profile-validators.js';
import type { ValidatorContext } from '../../diagnostics/types.js';

describe('behavior-profile-validators', () => {
  function createContext(agents: Record<string, Partial<AgentIR>>): ValidatorContext {
    return {
      agents: agents as Record<string, AgentIR>,
      topology: {},
      projectConfig: {},
    };
  }

  describe('BP-02: Multiple profiles with same priority', () => {
    it('emits BP-02 when profiles have duplicate priority', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'profile_a', priority: 10 },
            { name: 'profile_b', priority: 10 },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-02',
          severity: 'warning',
          agentName: 'test_agent',
          message: expect.stringContaining('priority 10'),
          message: expect.stringContaining('profile_a'),
          message: expect.stringContaining('profile_b'),
        }),
      );
    });

    it('emits BP-02 when three profiles share priority', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'a', priority: 5 },
            { name: 'b', priority: 5 },
            { name: 'c', priority: 5 },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      const bp02 = findings.filter((f) => f.code === 'BP-02');
      expect(bp02).toHaveLength(1);
      expect(bp02[0].message).toContain('3 behavior profiles');
    });

    it('does not emit BP-02 when priorities are unique', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'profile_a', priority: 10 },
            { name: 'profile_b', priority: 20 },
            { name: 'profile_c', priority: 30 },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-02')).toHaveLength(0);
    });

    it('does not emit BP-02 for single profile', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [{ name: 'profile_a', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-02')).toHaveLength(0);
    });
  });

  describe('BP-03: Profile hides tool required by flow', () => {
    it('emits BP-03 when profile hides tool used in flow CALL', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'api_tool', description: 'API' }],
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'api_tool' },
            },
          },
          behavior_profiles: [{ name: 'restricted', priority: 10, tools_hide: ['api_tool'] }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-03',
          severity: 'error',
          agentName: 'test_agent',
          message: expect.stringContaining('hides tool "api_tool"'),
          message: expect.stringContaining('flow step "start" requires it'),
        }),
      );
    });

    it('handles CALL with parameters syntax', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'fetch', description: 'Fetch' }],
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'fetch({"url": "https://example.com"})' },
            },
          },
          behavior_profiles: [{ name: 'no_fetch', priority: 10, tools_hide: ['fetch'] }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-03',
          message: expect.stringContaining('hides tool "fetch"'),
        }),
      );
    });

    it('does not emit BP-03 when hidden tool is not used in flow', () => {
      const ctx = createContext({
        test_agent: {
          tools: [
            { name: 'tool_a', description: 'A' },
            { name: 'tool_b', description: 'B' },
          ],
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'tool_a' },
            },
          },
          behavior_profiles: [{ name: 'hide_b', priority: 10, tools_hide: ['tool_b'] }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-03')).toHaveLength(0);
    });

    it('does not emit BP-03 when profile has no tools_hide', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'api_tool', description: 'API' }],
          flow: {
            steps: ['start'],
            definitions: {
              start: { call: 'api_tool' },
            },
          },
          behavior_profiles: [{ name: 'default', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-03')).toHaveLength(0);
    });

    it('checks multiple flow steps', () => {
      const ctx = createContext({
        test_agent: {
          tools: [
            { name: 'tool_a', description: 'A' },
            { name: 'tool_b', description: 'B' },
          ],
          flow: {
            steps: ['step1', 'step2'],
            definitions: {
              step1: { call: 'tool_a' },
              step2: { call: 'tool_b' },
            },
          },
          behavior_profiles: [
            { name: 'hide_both', priority: 10, tools_hide: ['tool_a', 'tool_b'] },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      const bp03 = findings.filter((f) => f.code === 'BP-03');
      expect(bp03.length).toBe(2);
    });
  });

  describe('BP-04: Profile adds tool that collides with existing', () => {
    it('emits BP-04 when tools_add collides with agent tool', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'existing_tool', description: 'Existing' }],
          behavior_profiles: [
            {
              name: 'enhanced',
              priority: 10,
              tools_add: [{ name: 'existing_tool', description: 'Duplicate' }],
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-04',
          severity: 'warning',
          agentName: 'test_agent',
          message: expect.stringContaining('adds tool "existing_tool"'),
          message: expect.stringContaining('already exists'),
        }),
      );
    });

    it('does not emit BP-04 when tools_add has unique names', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'tool_a', description: 'A' }],
          behavior_profiles: [
            {
              name: 'enhanced',
              priority: 10,
              tools_add: [{ name: 'tool_b', description: 'B' }],
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-04')).toHaveLength(0);
    });

    it('does not emit BP-04 when profile has no tools_add', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'tool_a', description: 'A' }],
          behavior_profiles: [{ name: 'default', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-04')).toHaveLength(0);
    });

    it('checks multiple tools_add', () => {
      const ctx = createContext({
        test_agent: {
          tools: [
            { name: 'tool_a', description: 'A' },
            { name: 'tool_b', description: 'B' },
          ],
          behavior_profiles: [
            {
              name: 'add_many',
              priority: 10,
              tools_add: [
                { name: 'tool_a', description: 'Dup A' },
                { name: 'tool_c', description: 'New C' },
                { name: 'tool_b', description: 'Dup B' },
              ],
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      const bp04 = findings.filter((f) => f.code === 'BP-04');
      expect(bp04.length).toBe(2);
    });
  });

  describe('BP-05: gather_overrides targets non-existent field', () => {
    it('emits BP-05 when field_overrides targets non-existent field', () => {
      const ctx = createContext({
        test_agent: {
          gather: {
            fields: [{ name: 'email', type: 'string' }],
          },
          behavior_profiles: [
            {
              name: 'override_missing',
              priority: 10,
              gather_overrides: {
                field_overrides: {
                  phone: { required: true },
                },
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-05',
          severity: 'warning',
          agentName: 'test_agent',
          message: expect.stringContaining('overrides gather field "phone"'),
          message: expect.stringContaining('does not exist'),
        }),
      );
    });

    it('does not emit BP-05 when field_overrides targets existing field', () => {
      const ctx = createContext({
        test_agent: {
          gather: {
            fields: [{ name: 'email', type: 'string' }],
          },
          behavior_profiles: [
            {
              name: 'override_email',
              priority: 10,
              gather_overrides: {
                field_overrides: {
                  email: { required: true },
                },
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('does not emit BP-05 when profile has no gather_overrides', () => {
      const ctx = createContext({
        test_agent: {
          gather: {
            fields: [{ name: 'email', type: 'string' }],
          },
          behavior_profiles: [{ name: 'default', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('does not emit BP-05 when agent has no gather fields', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            {
              name: 'override',
              priority: 10,
              gather_overrides: {
                field_overrides: {
                  email: { required: true },
                },
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('checks multiple field_overrides', () => {
      const ctx = createContext({
        test_agent: {
          gather: {
            fields: [
              { name: 'email', type: 'string' },
              { name: 'name', type: 'string' },
            ],
          },
          behavior_profiles: [
            {
              name: 'override_many',
              priority: 10,
              gather_overrides: {
                field_overrides: {
                  email: { required: true },
                  phone: { required: false },
                  address: { required: false },
                },
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      const bp05 = findings.filter((f) => f.code === 'BP-05');
      expect(bp05.length).toBe(2);
      expect(bp05.some((f) => f.message.includes('phone'))).toBe(true);
      expect(bp05.some((f) => f.message.includes('address'))).toBe(true);
    });
  });

  describe('BP-05 extended: flow_modifications.skip targets non-existent step', () => {
    it('emits BP-05 when skip targets non-existent flow step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'end'],
            definitions: {
              start: { respond: 'Hello' },
              end: { respond: 'Bye' },
            },
          },
          behavior_profiles: [
            {
              name: 'skip_missing',
              priority: 10,
              flow_modifications: {
                skip: ['middle_step'],
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-05',
          severity: 'warning',
          message: expect.stringContaining('skips flow step "middle_step"'),
          message: expect.stringContaining('does not exist'),
        }),
      );
    });

    it('does not emit BP-05 when skip targets existing step', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'middle', 'end'],
            definitions: {
              start: { respond: 'Hello' },
              middle: { respond: 'Middle' },
              end: { respond: 'Bye' },
            },
          },
          behavior_profiles: [
            {
              name: 'skip_middle',
              priority: 10,
              flow_modifications: {
                skip: ['middle'],
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('does not emit BP-05 when profile has no flow_modifications', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello' },
            },
          },
          behavior_profiles: [{ name: 'default', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('does not emit BP-05 when agent has no flow', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            {
              name: 'skip',
              priority: 10,
              flow_modifications: {
                skip: ['some_step'],
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-05')).toHaveLength(0);
    });

    it('checks multiple skip targets', () => {
      const ctx = createContext({
        test_agent: {
          flow: {
            steps: ['start', 'end'],
            definitions: {
              start: { respond: 'Hello' },
              end: { respond: 'Bye' },
            },
          },
          behavior_profiles: [
            {
              name: 'skip_many',
              priority: 10,
              flow_modifications: {
                skip: ['start', 'middle', 'other'],
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      const bp05 = findings.filter((f) => f.code === 'BP-05');
      expect(bp05.length).toBe(2);
      expect(bp05.some((f) => f.message.includes('middle'))).toBe(true);
      expect(bp05.some((f) => f.message.includes('other'))).toBe(true);
    });
  });

  describe('BP-06: No default profile', () => {
    it('emits BP-06 when multiple profiles have no default', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'profile_a', priority: 10, when: 'condition_a' },
            { name: 'profile_b', priority: 20, when: 'condition_b' },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'BP-06',
          severity: 'info',
          agentName: 'test_agent',
          message: expect.stringContaining('no default profile'),
          message: expect.stringContaining('2 behavior profiles'),
        }),
      );
    });

    it('does not emit BP-06 when profile has when: "true"', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'conditional', priority: 10, when: 'user_type === "premium"' },
            { name: 'default', priority: 5, when: 'true' },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });

    it('does not emit BP-06 when profile has empty when', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'conditional', priority: 10, when: 'condition' },
            { name: 'default', priority: 5, when: '' },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });

    it('does not emit BP-06 when profile has no when field', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'conditional', priority: 10, when: 'condition' },
            { name: 'default', priority: 5 },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });

    it('does not emit BP-06 when profile has whitespace-only when', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [
            { name: 'conditional', priority: 10, when: 'condition' },
            { name: 'default', priority: 5, when: '   ' },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });

    it('does not emit BP-06 for single profile', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [{ name: 'only_profile', priority: 10, when: 'condition' }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });

    it('does not emit BP-06 when all profiles have conditions (single profile case)', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [{ name: 'single', priority: 10, when: 'some_condition' }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.filter((f) => f.code === 'BP-06')).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('handles agent with no behavior_profiles', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'tool', description: 'Test' }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles agent with empty behavior_profiles array', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles empty agents object', () => {
      const ctx = createContext({});
      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles multiple agents with different issues', () => {
      const ctx = createContext({
        agent1: {
          behavior_profiles: [
            { name: 'a', priority: 10 },
            { name: 'b', priority: 10 },
          ],
        },
        agent2: {
          behavior_profiles: [
            { name: 'x', priority: 5, when: 'cond' },
            { name: 'y', priority: 6, when: 'other' },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.agentName === 'agent1')).toBe(true);
      expect(findings.some((f) => f.agentName === 'agent2')).toBe(true);
    });

    it('handles profile with all optional fields empty', () => {
      const ctx = createContext({
        test_agent: {
          behavior_profiles: [{ name: 'minimal', priority: 10 }],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      expect(findings).toHaveLength(0);
    });

    it('handles complex profile with multiple modifications', () => {
      const ctx = createContext({
        test_agent: {
          tools: [{ name: 'tool_a', description: 'A' }],
          gather: {
            fields: [{ name: 'email', type: 'string' }],
          },
          flow: {
            steps: ['start'],
            definitions: {
              start: { respond: 'Hello' },
            },
          },
          behavior_profiles: [
            {
              name: 'complex',
              priority: 10,
              tools_hide: ['tool_b'],
              tools_add: [{ name: 'tool_c', description: 'C' }],
              gather_overrides: {
                field_overrides: {
                  email: { required: true },
                },
              },
              flow_modifications: {
                skip: ['start'],
              },
            },
          ],
        },
      });

      const findings = validateBehaviorProfiles(ctx);
      // No errors - all references are valid or absent
      expect(findings).toHaveLength(0);
    });
  });
});
