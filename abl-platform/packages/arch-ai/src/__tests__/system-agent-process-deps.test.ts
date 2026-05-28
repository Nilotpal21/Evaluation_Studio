import { describe, expect, it } from 'vitest';

import {
  buildManagedBehaviorProfileConfigVariables,
  getStaleManagedBehaviorProfileConfigKeys,
} from '../system-agent-process-deps.js';
import type { TopologyOutput } from '../types/blueprint.js';

describe('system-agent process deps', () => {
  it('materializes managed behavior profile config variables for shared-voice handoffs', () => {
    const topology: TopologyOutput = {
      agents: [
        {
          name: 'TriageAgent',
          role: 'Triage',
          executionMode: 'reasoning',
          description: 'Routes support requests',
        },
        {
          name: 'OrdersAgent',
          role: 'Orders',
          executionMode: 'reasoning',
          description: 'Resolves order requests',
        },
      ],
      edges: [
        {
          from: 'TriageAgent',
          to: 'OrdersAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          condition: 'orders',
          expectReturn: true,
        },
      ],
      entryPoint: 'TriageAgent',
    };

    const variables = buildManagedBehaviorProfileConfigVariables(topology);

    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({
      key: 'profile:shared_voice_handoff',
    });
    expect(variables[0]?.value).toContain('BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(variables[0]?.value).toContain('Do not introduce yourself as a new person');
  });

  it('does not materialize managed profile config variables without shared voice', () => {
    const topology: TopologyOutput = {
      agents: [
        {
          name: 'TriageAgent',
          role: 'Triage',
          executionMode: 'reasoning',
          description: 'Routes support requests',
        },
        {
          name: 'HumanEscalation',
          role: 'Human escalation',
          executionMode: 'reasoning',
          description: 'Escalates to a human',
        },
      ],
      edges: [
        {
          from: 'TriageAgent',
          to: 'HumanEscalation',
          type: 'escalate',
          experienceMode: 'human_escalation',
          condition: 'human help',
          expectReturn: false,
        },
      ],
      entryPoint: 'TriageAgent',
    };

    expect(buildManagedBehaviorProfileConfigVariables(topology)).toEqual([]);
    expect(getStaleManagedBehaviorProfileConfigKeys(topology)).toEqual([
      'profile:shared_voice_handoff',
    ]);
  });

  it('does not delete the managed shared-voice profile while a topology still uses it', () => {
    const topology: TopologyOutput = {
      agents: [
        {
          name: 'TriageAgent',
          role: 'Triage',
          executionMode: 'reasoning',
          description: 'Routes support requests',
        },
        {
          name: 'OrdersAgent',
          role: 'Orders',
          executionMode: 'reasoning',
          description: 'Resolves order requests',
        },
      ],
      edges: [
        {
          from: 'TriageAgent',
          to: 'OrdersAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          condition: 'orders',
          expectReturn: true,
        },
      ],
      entryPoint: 'TriageAgent',
    };

    expect(getStaleManagedBehaviorProfileConfigKeys(topology)).toEqual([]);
  });
});
