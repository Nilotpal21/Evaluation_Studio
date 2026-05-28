import { describe, expect, it } from 'vitest';

import { validateTopologyRuntimeHints } from '@/lib/arch-ai/topology-runtime-validation';

const baseAgents = [
  {
    name: 'SupportRouter',
    role: 'Routes customer support requests',
    description: 'Classifies the customer request and routes to the right specialist.',
    tools: [],
  },
  {
    name: 'OrdersAgent',
    role: 'Handles order status',
    description: 'Looks up order status and resolves delivery issues.',
    tools: ['get_order'],
  },
];

describe('topology runtime validation', () => {
  it('requires customer handoff experience on every edge', () => {
    const result = validateTopologyRuntimeHints({
      agents: baseAgents,
      edges: [
        {
          from: 'SupportRouter',
          to: 'OrdersAgent',
          type: 'delegate',
        },
      ],
      entryPoint: 'SupportRouter',
    });

    expect(result).toContain('omit customer handoff experience mode');
    expect(result).toContain('SupportRouter -> OrdersAgent');
  });

  it('rejects incompatible edge type and experience mode pairs', () => {
    const result = validateTopologyRuntimeHints({
      agents: baseAgents,
      edges: [
        {
          from: 'SupportRouter',
          to: 'OrdersAgent',
          type: 'delegate',
          experienceMode: 'human_escalation',
        },
      ],
      entryPoint: 'SupportRouter',
    });

    expect(result).toContain('incompatible experienceMode');
    expect(result).toContain('human_escalation only on escalate edges');
  });

  it('requires tool hints when a non-entry specialist implies external work', () => {
    const result = validateTopologyRuntimeHints({
      agents: [
        baseAgents[0]!,
        {
          name: 'OrdersAgent',
          role: 'Handles order lookup',
          description: 'Looks up order status and retrieves delivery details.',
          tools: [],
        },
      ],
      edges: [
        {
          from: 'SupportRouter',
          to: 'OrdersAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
        },
      ],
      entryPoint: 'SupportRouter',
    });

    expect(result).toContain('imply external lookup/action/calculation work');
    expect(result).toContain('OrdersAgent');
  });

  it('accepts a complete shared-voice support handoff', () => {
    const result = validateTopologyRuntimeHints({
      agents: baseAgents,
      edges: [
        {
          from: 'SupportRouter',
          to: 'OrdersAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
        },
      ],
      entryPoint: 'SupportRouter',
    });

    expect(result).toBeNull();
  });
});
