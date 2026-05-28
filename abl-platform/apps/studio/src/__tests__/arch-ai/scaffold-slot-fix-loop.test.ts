import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentArchitecturePlan } from '@agent-platform/arch-ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { DomainContextInput, ScaffoldResult } from '@/lib/arch-ai/scaffold/types';

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import { scaffoldAblAgent } from '@/lib/arch-ai/scaffold/scaffold-generator';
import { fillSlots } from '@/lib/arch-ai/scaffold/slot-fix-loop';

const baseDomain: DomainContextInput = {
  domain: 'Mortgage Origination',
  channels: ['web'],
  compliance: ['Fair lending'],
  integrations: [],
  tone: 'professional',
};

const forbiddenFallbackLanguage =
  /\b(routing|classif(?:y|ies|ying)|rout(?:e|es|ed)|routers?|escalat(?:e|es|ed|ing|ion)|specialists?|tools?|workflows?|steps?|contexts?|retr(?:y|ies|ied|ying))\b|details needed to continue/i;

function expectFallbackValuesToAvoidInternalLanguage(values: Iterable<string>): void {
  for (const value of values) {
    expect(value).not.toMatch(forbiddenFallbackLanguage);
  }
}

function buildSupervisorPlan(): AgentArchitecturePlan {
  return {
    agentName: 'OriginationRouter',
    archetype: 'supervisor',
    keyword: 'SUPERVISOR',
    isEntry: true,
    gather: {
      required: false,
      reason: 'Supervisors route, not gather',
      suggestedFields: [],
    },
    complete: {
      required: false,
      reason: 'Supervisors route indefinitely',
    },
    flow: {
      recommended: false,
      reason: 'Reasoning supervisor',
      executionMode: 'reasoning',
    },
    complexity: {
      selectedExecutionMode: 'reasoning',
      level: 'structured',
      reason: 'Supervisor routes by intent',
      signals: ['supervisor_routing'],
    },
    handoffs: {
      targets: [
        {
          to: 'ApplicantIntake',
          edgeType: 'delegate',
          returnExpected: true,
          condition: undefined,
        },
        {
          to: 'CreditAuthorization',
          edgeType: 'delegate',
          returnExpected: true,
          condition: undefined,
        },
      ],
      needsCatchAll: true,
      catchAllTarget: 'ApplicantIntake',
    },
    allowedPassFields: [],
    blocked: [],
    localTopology: {
      agents: [
        { name: 'OriginationRouter', role: 'Mortgage router', executionMode: 'reasoning' },
        { name: 'ApplicantIntake', role: 'Applicant intake', executionMode: 'reasoning' },
        {
          name: 'CreditAuthorization',
          role: 'Credit authorization',
          executionMode: 'reasoning',
        },
      ],
      edges: [
        {
          from: 'OriginationRouter',
          to: 'ApplicantIntake',
          type: 'delegate',
          expectReturn: true,
        },
        {
          from: 'OriginationRouter',
          to: 'CreditAuthorization',
          type: 'delegate',
          expectReturn: true,
        },
      ],
    },
  };
}

describe('scaffold slot fill loop', () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it('treats worker abort as terminal instead of falling back', async () => {
    const controller = new AbortController();
    controller.abort();
    const scaffold = scaffoldAblAgent(
      buildSupervisorPlan(),
      {
        agents: [
          { name: 'OriginationRouter', role: 'Mortgage router', executionMode: 'reasoning' },
          { name: 'ApplicantIntake', role: 'Applicant intake', executionMode: 'reasoning' },
          {
            name: 'CreditAuthorization',
            role: 'Credit authorization',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'OriginationRouter',
            to: 'ApplicantIntake',
            type: 'delegate',
            expectReturn: true,
          },
          {
            from: 'OriginationRouter',
            to: 'CreditAuthorization',
            type: 'delegate',
            expectReturn: true,
          },
        ],
        entryPoint: 'OriginationRouter',
      },
      {
        name: 'OriginationRouter',
        role: 'Mortgage router',
        executionMode: 'reasoning',
        isEntry: true,
      },
      baseDomain,
    );

    await expect(
      fillSlots(scaffold, {
        model: {} as LanguageModel,
        maxRetriesPerSlot: 0,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('Scaffold generation aborted before completion');
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('falls back to deterministic creative content when initial structured generation fails', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('model timeout'));

    const scaffold = scaffoldAblAgent(
      buildSupervisorPlan(),
      {
        agents: [
          { name: 'OriginationRouter', role: 'Mortgage router', executionMode: 'reasoning' },
          { name: 'ApplicantIntake', role: 'Applicant intake', executionMode: 'reasoning' },
          {
            name: 'CreditAuthorization',
            role: 'Credit authorization',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'OriginationRouter',
            to: 'ApplicantIntake',
            type: 'delegate',
            expectReturn: true,
          },
          {
            from: 'OriginationRouter',
            to: 'CreditAuthorization',
            type: 'delegate',
            expectReturn: true,
          },
        ],
        entryPoint: 'OriginationRouter',
      },
      {
        name: 'OriginationRouter',
        role: 'Mortgage router',
        executionMode: 'reasoning',
        isEntry: true,
      },
      baseDomain,
    );

    const result = await fillSlots(scaffold, {
      model: {} as LanguageModel,
      maxRetriesPerSlot: 0,
    });

    expect(result.creative['handoff.0.when']).toBe('intent.category == "applicant_intake"');
    expect(result.creative['handoff.1.when']).toBe('intent.category == "credit_authorization"');
    expect(result.creative['gather.routing_intent.ask']).toBe(
      'What intent should I use for this request?',
    );
    expectFallbackValuesToAvoidInternalLanguage(Object.values(result.creative));
    expect(result.fallbackSlots).toEqual(
      expect.arrayContaining(['goal', 'persona', 'handoff.0.when', 'handoff.1.when']),
    );
  });

  it('keeps forced fallback slot prompts and responses free of internal language', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('structured output unavailable'));

    const scaffold: ScaffoldResult = {
      skeleton: {
        agentName: 'FallbackProbe',
        keyword: 'AGENT',
        runtimePattern: 'reasoning',
        goalSlot: 'goal',
        personaSlot: 'persona',
        handoffs: [
          {
            to: 'RoutingToolStepSpecialist',
            returnExpected: true,
            whenSlot: 'handoff.0.when',
          },
        ],
        gatherFields: [
          {
            name: 'routing_context',
            type: 'string',
            source: 'user',
            askSlot: 'gather.routing_context.ask',
          },
          {
            name: 'customer_reference',
            type: 'string',
            source: 'user',
            askSlot: 'gather.customer_reference.ask',
          },
        ],
        completeSlots: [
          {
            whenSlot: 'complete.0.when',
            respondSlot: 'complete.0.respond',
          },
        ],
        memorySessionVars: ['routing_context', 'customer_reference'],
        tools: [],
        includeGuardrails: false,
      },
      creativeSchema: z.object({}).strict(),
      prompt: 'force deterministic fallback',
    };

    const result = await fillSlots(scaffold, {
      model: {} as LanguageModel,
      maxRetriesPerSlot: 0,
    });

    expect(result.creative['handoff.0.when']).toBe('intent.category == "general"');
    expect(result.creative['gather.routing_context.ask']).toBe(
      'What information should I use for this request?',
    );
    expect(result.creative['complete.0.when']).toBe('customer_reference != null');
    expect(result.creative['complete.0.respond']).toBe('Thanks, I have what I need now.');
    expectFallbackValuesToAvoidInternalLanguage(Object.values(result.creative));
    expect(result.fallbackSlots).toEqual(expect.arrayContaining(Object.keys(result.creative)));
  });
});
