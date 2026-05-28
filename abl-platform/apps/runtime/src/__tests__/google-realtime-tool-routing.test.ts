import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import { findGoogleRealtimeDeclaringThreadIndex } from '../services/voice/korevg/google-realtime-tool-routing.js';

function createGoogleSession(): RuntimeSession {
  return {
    id: 's1',
    agentName: 'ChildAgent',
    agentIR: {
      metadata: { name: 'ChildAgent' },
      tools: [],
    } as unknown as AgentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {
        session: {
          s2sProvider: 's2s:google',
        },
      },
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [
      {
        agentName: 'SupervisorAgent',
        agentIR: {
          metadata: { name: 'SupervisorAgent' },
          tools: [{ name: 'list_appointments' }],
        } as unknown as AgentIR,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: {
          values: {
            session: {
              s2sProvider: 's2s:google',
            },
          },
          gatheredKeys: new Set<string>(),
        },
        startedAt: 1,
        returnExpected: false,
        status: 'completed',
      },
      {
        agentName: 'ChildAgent',
        agentIR: {
          metadata: { name: 'ChildAgent' },
          tools: [],
        } as unknown as AgentIR,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: {
          values: {
            session: {
              s2sProvider: 's2s:google',
            },
          },
          gatheredKeys: new Set<string>(),
        },
        startedAt: 2,
        parentThreadIndex: 0,
        returnExpected: false,
        status: 'active',
      },
      {
        agentName: 'SiblingAgent',
        agentIR: {
          metadata: { name: 'SiblingAgent' },
          tools: [{ name: 'lookup_weather' }],
        } as unknown as AgentIR,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        data: {
          values: {
            session: {
              s2sProvider: 's2s:google',
            },
          },
          gatheredKeys: new Set<string>(),
        },
        startedAt: 3,
        returnExpected: false,
        status: 'waiting',
      },
    ],
    activeThreadIndex: 1,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  } as RuntimeSession;
}

describe('findGoogleRealtimeDeclaringThreadIndex', () => {
  it('walks parentThreadIndex for permanent Google handoffs', () => {
    const session = createGoogleSession();

    expect(findGoogleRealtimeDeclaringThreadIndex(session, 'list_appointments')).toBe(0);
  });

  it('does not reroute through unrelated sibling threads', () => {
    const session = createGoogleSession();

    expect(findGoogleRealtimeDeclaringThreadIndex(session, 'lookup_weather')).toBeNull();
  });
});
