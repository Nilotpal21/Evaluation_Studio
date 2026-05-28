import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompileWorkerTimeoutError } from '@/lib/arch-ai/helpers/isolated-build-compiler';

const orchestratorMocks = vi.hoisted(() => ({
  validateGeneratedBuildSession: vi.fn(),
}));

vi.mock('@/lib/arch-ai/build-orchestrator', () => ({
  validateGeneratedBuildSession: orchestratorMocks.validateGeneratedBuildSession,
}));

vi.mock('@/lib/arch-ai/build-completion', () => ({
  classifyWarnings: (warnings: string[]) => ({
    info: warnings.filter((warning) => /^W8\d\d:/.test(warning)),
    actionable: warnings.filter((warning) => !/^W8\d\d:/.test(warning)),
  }),
}));

vi.mock('@agent-platform/arch-ai/constructs', () => ({
  renderMissingMemoryWarning: () => 'Missing MEMORY section — add at minimum one session variable',
  renderSupervisorCatchAllHandoffWarning: () => 'Missing catch-all HANDOFF rule',
}));

vi.mock('@agent-platform/arch-ai/guardrails', () => ({
  renderMissingGuardrailsWarning: () => 'Missing GUARDRAILS section',
}));

import { reconcileBuildResults } from '@/lib/arch-ai/build-result-reconciliation';

describe('build-result-reconciliation', () => {
  beforeEach(() => {
    orchestratorMocks.validateGeneratedBuildSession.mockReset();
  });

  it('keeps preliminary worker results when full-session validation times out', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockRejectedValueOnce(
      new CompileWorkerTimeoutError('compile', 30),
    );

    const result = await reconcileBuildResults({
      topologyAgents: [
        {
          name: 'Alpha',
          role: 'agent',
          executionMode: 'reasoning',
        },
      ],
      topologyEdges: [],
      rawResults: [
        {
          agentName: 'Alpha',
          status: 'compiled',
          warnings: [],
          errors: [],
        },
      ],
      agentFiles: {
        Alpha: {
          content: `AGENT: Alpha
GOAL: "Test agent"
`,
        },
      },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      agentName: 'Alpha',
      status: 'compiled',
      errors: [],
    });
    expect(result.agentStatuses).toEqual({ Alpha: 'compiled' });
    expect(result.recoveredCount).toBe(0);
  });

  it('keeps warnings non-blocking for project creation', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockResolvedValueOnce({
      results: [
        {
          agentName: 'Alpha',
          status: 'warning',
          warnings: ['Missing MEMORY section — add at minimum one session variable'],
          errors: [],
        },
      ],
    });

    const result = await reconcileBuildResults({
      topologyAgents: [{ name: 'Alpha', role: 'agent', executionMode: 'reasoning' }],
      topologyEdges: [],
      rawResults: [{ agentName: 'Alpha', status: 'compiled', warnings: [], errors: [] }],
      agentFiles: {
        Alpha: {
          content: `AGENT: Alpha
GOAL: "Answer alpha requests"
PERSONA: "Helpful alpha responder"
`,
        },
      },
    });

    expect(result.results[0]).toMatchObject({
      agentName: 'Alpha',
      status: 'warning',
      errors: [],
    });
    expect(result.agentStatuses).toEqual({ Alpha: 'warning' });
  });

  it('allows plain-English handoff conditions but still blocks generic gather placeholders', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockResolvedValueOnce({
      results: [
        {
          agentName: 'Alpha',
          status: 'compiled',
          warnings: [],
          errors: [],
        },
      ],
    });

    const result = await reconcileBuildResults({
      topologyAgents: [{ name: 'Alpha', role: 'agent', executionMode: 'reasoning' }],
      topologyEdges: [{ from: 'Alpha', to: 'Beta', type: 'delegate' }],
      rawResults: [{ agentName: 'Alpha', status: 'compiled', warnings: [], errors: [] }],
      agentFiles: {
        Alpha: {
          content: `AGENT: Alpha
GOAL: "Handle alpha requests"
PERSONA: "Helpful responder"
HANDOFF:
  - TO: Beta
    WHEN: "matching intent"
    RETURN: true
GATHER:
  gathered_detail:
    type: string
    required: true
    prompt: "{{question_to_collect_this_field}}"
`,
        },
      },
    });

    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('generic auto-fix gather field'),
        expect.stringContaining('placeholder gather prompt'),
      ]),
    );
    expect(result.agentStatuses).toEqual({ Alpha: 'error' });
  });

  it('blocks runtime readiness contract defects even when isolated validation passes', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockResolvedValueOnce({
      results: [
        {
          agentName: 'Alex',
          status: 'compiled',
          warnings: [],
          errors: [],
        },
        {
          agentName: 'PolicyAdvisor',
          status: 'compiled',
          warnings: [],
          errors: [],
        },
      ],
    });

    const result = await reconcileBuildResults({
      topologyAgents: [
        { name: 'Alex', role: 'support supervisor', executionMode: 'reasoning' },
        { name: 'PolicyAdvisor', role: 'policy advisor', executionMode: 'reasoning' },
      ],
      topologyEdges: [{ from: 'Alex', to: 'PolicyAdvisor', type: 'delegate' }],
      rawResults: [
        { agentName: 'Alex', status: 'compiled', warnings: [], errors: [] },
        { agentName: 'PolicyAdvisor', status: 'compiled', warnings: [], errors: [] },
      ],
      agentFiles: {
        Alex: {
          content: `SUPERVISOR: Alex
GOAL: "Route support requests"
PERSONA: "Helpful support router"
HANDOFF:
  - TO: PolicyAdvisor
    WHEN: routing_intent == "policy" AND (intent.category == "policy")
    RETURN: true
GATHER:
  routing_intent:
    type: string
    required: true
    prompt: "What do you need help with?"
`,
        },
        PolicyAdvisor: {
          content: `AGENT: PolicyAdvisor
GOAL: "Advise on policy"
PERSONA: "Helpful policy advisor"
COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
        },
      },
    });

    expect(result.results.find((entry) => entry.agentName === 'Alex')).toMatchObject({
      status: 'error',
      errors: expect.arrayContaining([
        expect.stringContaining('uses routing_intent as a classifier value'),
      ]),
    });
    expect(result.results.find((entry) => entry.agentName === 'PolicyAdvisor')).toMatchObject({
      status: 'error',
      errors: expect.arrayContaining([expect.stringContaining('unconditional silent COMPLETE')]),
    });
    expect(result.agentStatuses).toEqual({ Alex: 'error', PolicyAdvisor: 'error' });
  });

  it('does not add handoff condition blockers when full-session validation reports errors', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockResolvedValueOnce({
      results: [
        {
          agentName: 'Alpha',
          status: 'error',
          warnings: [],
          errors: ['Handoff target "Beta" does not exist.'],
        },
      ],
    });

    const result = await reconcileBuildResults({
      topologyAgents: [{ name: 'Alpha', role: 'agent', executionMode: 'reasoning' }],
      topologyEdges: [{ from: 'Alpha', to: 'Beta', type: 'delegate' }],
      rawResults: [{ agentName: 'Alpha', status: 'compiled', warnings: [], errors: [] }],
      agentFiles: {
        Alpha: {
          content: `AGENT: Alpha
GOAL: "Handle alpha requests"
PERSONA: "Helpful responder"
HANDOFF:
  - TO: Beta
    WHEN: matching intent
    RETURN: true
`,
        },
      },
    });

    expect(result.results[0]?.errors).toEqual(
      expect.arrayContaining(['Handoff target "Beta" does not exist.']),
    );
    expect(result.results[0]?.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('placeholder HANDOFF WHEN')]),
    );
  });

  it('passes topology experience modes into full-session validation', async () => {
    orchestratorMocks.validateGeneratedBuildSession.mockResolvedValueOnce({
      results: [
        {
          agentName: 'OrdersAgent',
          status: 'compiled',
          warnings: [],
          errors: [],
        },
      ],
    });

    await reconcileBuildResults({
      topologyAgents: [{ name: 'OrdersAgent', role: 'agent', executionMode: 'reasoning' }],
      topologyEdges: [
        {
          from: 'Triage',
          to: 'OrdersAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
        },
      ],
      rawResults: [{ agentName: 'OrdersAgent', status: 'compiled', warnings: [], errors: [] }],
      agentFiles: {
        OrdersAgent: {
          content: `AGENT: OrdersAgent
GOAL: "Handle orders"
PERSONA: "Helpful responder"
USE BEHAVIOR_PROFILE: shared_voice_handoff
`,
        },
      },
    });

    expect(orchestratorMocks.validateGeneratedBuildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        topology: expect.objectContaining({
          edges: [
            expect.objectContaining({
              from: 'Triage',
              to: 'OrdersAgent',
              type: 'transfer',
              experienceMode: 'shared_voice_handoff',
            }),
          ],
        }),
      }),
    );
  });
});
