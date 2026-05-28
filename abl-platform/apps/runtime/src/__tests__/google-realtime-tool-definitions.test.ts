import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTools, getActiveThread } = vi.hoisted(() => ({
  buildTools: vi.fn(),
  getActiveThread: vi.fn(
    (session: { threads: unknown[]; activeThreadIndex: number }) =>
      session.threads[session.activeThreadIndex],
  ),
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  buildTools,
}));

vi.mock('../services/execution/types.js', () => ({
  getActiveThread,
}));

import {
  buildGoogleRealtimeToolDefinitions,
  toRealtimeToolDefinitions,
} from '../services/voice/korevg/realtime-tool-definitions.js';

describe('buildGoogleRealtimeToolDefinitions', () => {
  beforeEach(() => {
    buildTools.mockReset();
    getActiveThread.mockClear();
  });

  it('includes child-only tools so Gemini can keep calling tools after handoff', () => {
    buildTools.mockImplementation((session: { agentName: string }) => {
      if (session.agentName === 'SupervisorAgent') {
        return [
          {
            name: 'lookup_parent',
            description: 'Lookup supervisor data',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
          {
            name: 'handoff_to_AppointmentAgent',
            description: 'Transfer to appointment specialist',
            input_schema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
        ];
      }

      return [
        {
          name: 'lookup_child',
          description: 'Lookup appointment data',
          input_schema: {
            type: 'object',
            properties: { account_number: { type: 'string' } },
            required: ['account_number'],
          },
        },
      ];
    });

    const session = {
      agentName: 'SupervisorAgent',
      agentIR: { metadata: { name: 'SupervisorAgent' } },
      compilationOutput: {
        agents: {
          SupervisorAgent: { metadata: { name: 'SupervisorAgent' } },
          AppointmentAgent: { metadata: { name: 'AppointmentAgent' } },
        },
      },
      threads: [
        {
          agentName: 'SupervisorAgent',
          agentIR: { metadata: { name: 'SupervisorAgent' } },
          conversationHistory: [],
          state: {},
          data: { values: {}, gatheredKeys: new Set<string>() },
          startedAt: 1,
          returnExpected: false,
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
      conversationHistory: [],
      data: { values: {}, gatheredKeys: new Set<string>() },
      state: {},
    };

    const definitions = buildGoogleRealtimeToolDefinitions(session as any);
    const toolNames = definitions.map((definition) => definition.name);

    expect(toolNames).toEqual(['lookup_parent', 'handoff_to_AppointmentAgent', 'lookup_child']);
    expect(buildTools).toHaveBeenCalledTimes(2);
  });

  it('keeps return-to-parent tools on realtime child agents', () => {
    const definitions = toRealtimeToolDefinitions([
      {
        name: '__return_to_parent__',
        description: 'Return control to the supervisor',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['reason', 'message'],
        },
      },
    ]);

    expect(definitions).toEqual([
      {
        type: 'function',
        name: '__return_to_parent__',
        description: 'Return control to the supervisor',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['reason', 'message'],
        },
      },
    ]);
  });
});
