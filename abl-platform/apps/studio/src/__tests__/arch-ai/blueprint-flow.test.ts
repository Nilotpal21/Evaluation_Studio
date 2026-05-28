import { describe, expect, it } from 'vitest';
import type { ArchSession } from '@agent-platform/arch-ai/types';
import {
  asBlueprintTopology,
  buildBlueprintConfirmWidget,
  buildTopologyApprovalWidget,
  buildTopologyRevisionPrompt,
  getBlueprintStage,
  getDraftTopology,
  getLockedTopology,
  hasPendingBlueprintWidget,
  normalizeBlueprintConfirmAnswer,
  normalizeTopologyApprovalAnswer,
  normalizeTopologyRevisionAnswer,
} from '@/lib/arch-ai/blueprint-flow';

function makeSession(metadataOverrides: Partial<ArchSession['metadata']> = {}): ArchSession {
  return {
    id: 'sess-blueprint',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'BLUEPRINT',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: 'EcomSupport',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      messages: [
        {
          id: 'msg-assistant',
          role: 'assistant',
          content:
            'I recommend a supervisor-led topology with domain specialists for orders, returns, and shipping.',
          timestamp: '2026-04-19T15:04:00.000Z',
          phase: 'BLUEPRINT',
        },
      ],
      blueprintStage: 'draft_ready',
      topologyApproved: false,
      topology: {
        agents: [
          {
            name: 'Supervisor',
            role: 'Routes incoming support requests',
            executionMode: 'reasoning',
            description: 'Entry point and router',
          },
          {
            name: 'ReturnsAgent',
            role: 'Handles returns and refunds',
            executionMode: 'reasoning',
            description: 'Returns specialist',
          },
          {
            name: 'ShippingAgent',
            role: 'Tracks shipments and delivery issues',
            executionMode: 'reasoning',
            description: 'Shipping specialist',
          },
        ],
        edges: [{ from: 'Supervisor', to: 'ReturnsAgent', type: 'delegate', condition: 'return' }],
        entryPoint: 'Supervisor',
      },
      draftTopology: {
        agents: [
          {
            name: 'Supervisor',
            role: 'Routes incoming support requests',
            executionMode: 'reasoning',
            description: 'Entry point and router',
          },
          {
            name: 'ReturnsAgent',
            role: 'Handles returns and refunds',
            executionMode: 'reasoning',
            description: 'Returns specialist',
          },
          {
            name: 'ShippingAgent',
            role: 'Tracks shipments and delivery issues',
            executionMode: 'reasoning',
            description: 'Shipping specialist',
          },
        ],
        edges: [{ from: 'Supervisor', to: 'ReturnsAgent', type: 'delegate', condition: 'return' }],
        entryPoint: 'Supervisor',
      },
      files: {},
      ...metadataOverrides,
    },
    createdAt: '2026-04-19T15:00:00.000Z',
    updatedAt: '2026-04-19T15:05:00.000Z',
  };
}

describe('blueprint-flow helpers', () => {
  it('normalizes valid topology payloads and derives draft vs locked state', () => {
    const topology = asBlueprintTopology(makeSession().metadata.topology);
    expect(topology).not.toBeNull();
    expect(getBlueprintStage(makeSession())).toBe('draft_ready');
    expect(getDraftTopology(makeSession())?.agents).toHaveLength(3);

    const lockedSession = makeSession({
      blueprintStage: 'topology_locked',
      topologyApproved: true,
      lockedTopology: makeSession().metadata.topology,
    });
    expect(getBlueprintStage(lockedSession)).toBe('topology_locked');
    expect(getLockedTopology(lockedSession)?.entryPoint).toBe('Supervisor');
  });

  it('preserves runtime topology hints used by build generation', () => {
    const topology = asBlueprintTopology({
      agents: [
        {
          name: 'BookingAgent',
          role: 'Books travel',
          executionMode: 'hybrid',
          description: 'Collects trip details and books itinerary services.',
          tools: ['search_flights', 'create_booking'],
          gatherFields: ['origin_city', 'destination_city'],
          flowStepSeeds: ['collect_trip_details', 'search_options', 'confirm_booking'],
          suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
        },
        {
          name: 'SupportSpecialist',
          role: 'Specialist support',
          executionMode: 'reasoning',
          description: 'Continues specialist support cases.',
        },
      ],
      edges: [
        {
          from: 'BookingAgent',
          to: 'SupportSpecialist',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          condition: 'needs specialist',
        },
      ],
      entryPoint: 'BookingAgent',
    });

    expect(topology?.agents[0]).toMatchObject({
      tools: ['search_flights', 'create_booking'],
      gatherFields: ['origin_city', 'destination_city'],
      flowStepSeeds: ['collect_trip_details', 'search_options', 'confirm_booking'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    });
    expect(topology?.edges[0]).toMatchObject({
      experienceMode: 'shared_voice_handoff',
    });
  });

  it('builds blueprint widgets with the expected payload shape', () => {
    const confirm = buildBlueprintConfirmWidget('Draft the graph when ready.');
    expect(confirm).toMatchObject({
      widgetType: 'BlueprintConfirm',
      options: [{ value: 'generate_draft_topology' }, { value: 'refine_concept' }],
    });
    expect(confirm.question).toContain('draft blueprint');

    const approval = buildTopologyApprovalWidget(getDraftTopology(makeSession())!, 'Review draft.');
    expect(approval).toMatchObject({
      widgetType: 'TopologyApproval',
      title: 'Draft blueprint ready',
      agentCount: 3,
      edgeCount: 1,
      entryPoint: 'Supervisor',
      agents: ['Supervisor', 'ReturnsAgent', 'ShippingAgent'],
    });
  });

  it('detects pending blueprint widgets and normalizes answers', () => {
    const session = makeSession({
      pendingInteraction: {
        kind: 'widget',
        id: 'widget-topology',
        payload: {
          widgetType: 'TopologyApproval',
          question: 'Review the draft topology.',
        },
        createdAt: '2026-04-19T15:05:00.000Z',
      },
    });

    expect(hasPendingBlueprintWidget(session, 'TopologyApproval')).toBe(true);
    expect(hasPendingBlueprintWidget(session, 'BlueprintConfirm')).toBe(false);
    expect(normalizeBlueprintConfirmAnswer('generate_draft_topology')).toBe(
      'generate_draft_topology',
    );
    expect(
      normalizeTopologyApprovalAnswer({ action: 'request_changes', notes: 'Split billing.' }),
    ).toEqual({
      action: 'request_changes',
      notes: 'Split billing.',
    });
    expect(
      normalizeTopologyRevisionAnswer({
        targets: ['agents', 'handoffs'],
        notes: 'Reduce routing hops',
      }),
    ).toEqual({
      targets: ['agents', 'handoffs'],
      notes: 'Reduce routing hops',
    });
  });

  it('builds revision prompts that preserve the requested change targets', () => {
    const prompt = buildTopologyRevisionPrompt({
      targets: ['agents', 'responsibilities'],
      notes: 'Split returns from shipping',
    });
    expect(prompt).toContain('"agents"');
    expect(prompt).toContain('"responsibilities"');
    expect(prompt).toContain('Split returns from shipping');
  });
});
