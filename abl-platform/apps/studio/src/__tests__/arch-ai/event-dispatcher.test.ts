import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchEnvelope } from '@/lib/arch-ai/ui/event-dispatcher';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useProjectStore } from '@/store/project-store';
import type { ArchSSEEvent } from '@/lib/arch-ai/ui/types';
import type { TurnEvent } from '@agent-platform/arch-ai/types';

const { swrMutateMock } = vi.hoisted(() => ({
  swrMutateMock: vi.fn(),
}));

vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr');
  return {
    ...actual,
    mutate: swrMutateMock,
  };
});

function makeSession() {
  return {
    id: 'sess-build-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: 'BookingHub',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      messages: [],
      topologyApproved: true,
      topology: {
        agents: [{ name: 'BookingTriageAgent' }, { name: 'SchedulingAgent' }],
        edges: [],
        entryPoint: 'BookingTriageAgent',
      },
      lockedTopology: {
        agents: [{ name: 'BookingTriageAgent' }, { name: 'SchedulingAgent' }],
        edges: [],
        entryPoint: 'BookingTriageAgent',
      },
      files: {},
    },
    createdAt: '2026-04-19T12:00:00.000Z',
    updatedAt: '2026-04-19T12:00:00.000Z',
  };
}

function dispatch(event: ArchSSEEvent) {
  dispatchEnvelope(event, useArchUIStore.getState());
}

function makeTurnEvent(
  event: Omit<
    TurnEvent,
    'eventId' | 'schemaVersion' | 'sessionId' | 'turnId' | 'seq' | 'timestamp'
  > &
    Partial<Pick<TurnEvent, 'eventId' | 'turnId' | 'seq'>>,
): TurnEvent {
  return {
    eventId: 'evt-1',
    schemaVersion: 2,
    sessionId: 'sess-build-1',
    turnId: 'turn-1',
    seq: 1,
    timestamp: Date.now(),
    ...event,
  } as TurnEvent;
}

describe('event-dispatcher raw SSE parity', () => {
  beforeEach(() => {
    swrMutateMock.mockReset();
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isLoading: false,
      error: null,
      moduleFilter: 'all',
    });
    useArchUIStore.setState({
      session: makeSession() as never,
      phase: 'BUILD',
    });
  });

  it('surfaces nested live error payloads from the Arch turn engine', () => {
    useArchUIStore.setState((s) => ({
      state: 'streaming',
      currentMsgId: 'assistant_msg_1',
      messages: [
        ...s.messages,
        {
          id: 'assistant_msg_1',
          role: 'assistant' as const,
          content: '',
          timestamp: new Date().toISOString(),
          isStreaming: true,
        },
      ],
    }));

    dispatch({
      type: 'error',
      error: {
        code: 'MODEL_BILLING',
        message:
          'Model provider billing or quota check failed. Review the connected account and billing settings.',
        retryable: false,
      },
    } as unknown as ArchSSEEvent);

    expect(useArchUIStore.getState().error).toMatchObject({
      message:
        'Model provider billing or quota check failed. Review the connected account and billing settings.',
      recoverable: false,
    });
    expect(useArchUIStore.getState().state).toBe('idle');
    expect(useArchUIStore.getState().currentMsgId).toBeNull();
    expect(useArchUIStore.getState().messages[0].isStreaming).toBe(false);
  });

  it('streams live BUILD events into build state, files, and topology tabs', () => {
    const artifactStore = useArchAIStore.getState();
    artifactStore.addTab({
      type: 'topology',
      label: 'Topology',
      data: {
        agents: [{ name: 'BookingTriageAgent' }, { name: 'SchedulingAgent' }],
        edges: [],
      },
      toolCallId: 'topology-1',
    });

    dispatch({
      type: 'build_agent_start',
      agent: 'BookingTriageAgent',
      mode: 'parallel',
      role: 'entry',
    });

    expect(useArchAIStore.getState().buildState.phase).toBe('generating');
    expect(useArchAIStore.getState().buildState.agents.BookingTriageAgent?.status).toBe(
      'generating',
    );
    expect(useArchAIStore.getState().filePanelVisible).toBe(true);
    expect(useArchAIStore.getState().filePanelFiles.BookingTriageAgent).toMatchObject({
      content: '',
      compileStatus: 'compiling',
    });
    expect(
      useArchAIStore
        .getState()
        .artifactTabs.some(
          (tab) => tab.type === 'agent_code' && tab.label === 'BookingTriageAgent',
        ),
    ).toBe(true);

    dispatch({
      type: 'file_content_delta',
      agentName: 'BookingTriageAgent',
      delta: 'AGENT BookingTriageAgent\n',
    });

    expect(useArchAIStore.getState().filePanelFiles.BookingTriageAgent?.streamingContent).toContain(
      'AGENT BookingTriageAgent',
    );

    dispatch({
      type: 'file_changed',
      path: 'agents/BookingTriageAgent.abl.yaml',
      action: 'create',
      content: 'GOAL: "Classify booking intent"\n',
    });

    expect(useArchAIStore.getState().filePanelFiles.BookingTriageAgent?.content).toContain(
      'Classify booking intent',
    );
    expect(
      useArchAIStore
        .getState()
        .artifactTabs.some(
          (tab) => tab.type === 'agent_code' && tab.label === 'BookingTriageAgent',
        ),
    ).toBe(true);

    dispatch({
      type: 'compile_result',
      agent: 'BookingTriageAgent',
      status: 'pass',
      warnings: [],
      errors: [],
    });

    expect(useArchAIStore.getState().filePanelFiles.BookingTriageAgent?.compileStatus).toBe(
      'success',
    );

    dispatch({
      type: 'build_reconciled',
      agents: {
        BookingTriageAgent: { status: 'compiled', errors: [], warnings: [] },
        SchedulingAgent: { status: 'compiled', errors: [], warnings: [] },
      },
      summary: {
        total: 2,
        compiled: 2,
        warnings: 0,
        errors: 0,
      },
    });

    expect(useArchAIStore.getState().buildState.phase).toBe('complete');
    expect(useArchAIStore.getState().buildState.summary).toMatchObject({
      total: 2,
      compiled: 2,
      errors: 0,
    });

    const topologyTab = useArchAIStore
      .getState()
      .artifactTabs.find((tab) => tab.type === 'topology' && tab.label === 'Topology');
    const topologyData = (topologyTab?.data ?? {}) as { buildStatus?: Record<string, string> };
    expect(topologyData.buildStatus).toMatchObject({
      BookingTriageAgent: 'compiled',
      SchedulingAgent: 'compiled',
    });
  });

  it('routes in-project Blueprint file payloads to the blueprint document tab', () => {
    const blueprintPayload = {
      markdown: '# CarrierCare Blueprint\n\nStatus: draft\n\n## 1. Executive Summary\n\nBilling.',
      sectionCount: 17,
      agentCount: 4,
      handoffCount: 3,
      status: 'draft',
      topology: {
        agents: [{ name: 'CarrierCareRouter' }],
        edges: [],
        entryPoint: 'CarrierCareRouter',
      },
    };

    dispatch({
      type: 'file_changed',
      path: 'src/agents/Blueprint.abl.yaml',
      action: 'create',
      content: JSON.stringify(blueprintPayload),
    });

    const store = useArchAIStore.getState();
    const blueprintTab = store.artifactTabs.find((tab) => tab.type === 'blueprint-document');

    expect(blueprintTab?.label).toBe('Blueprint');
    expect((blueprintTab?.data as { markdown?: string } | undefined)?.markdown).toContain(
      'CarrierCare Blueprint',
    );
    expect(
      store.artifactTabs.some((tab) => tab.type === 'agent_code' && tab.label === 'Blueprint'),
    ).toBe(false);
    expect(store.filePanelFiles.Blueprint).toBeUndefined();
    expect(store.activeTabId).toBe(blueprintTab?.id);
  });

  it('routes durable Blueprint file artifacts to the blueprint document tab', () => {
    const blueprintPayload = {
      markdown: '# CarrierCare Blueprint\n\nStatus: draft\n\n## 1. Executive Summary\n\nBilling.',
      sectionCount: 17,
      agentCount: 4,
      handoffCount: 3,
      status: 'draft',
      topology: {
        agents: [{ name: 'CarrierCareRouter' }],
        edges: [],
        entryPoint: 'CarrierCareRouter',
      },
    };

    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'file',
          agent: 'Blueprint',
          action: 'end',
          fileKind: 'agent',
          path: 'src/agents/Blueprint.abl.yaml',
          content: JSON.stringify(blueprintPayload),
        },
      }) as unknown as ArchSSEEvent,
    );

    const store = useArchAIStore.getState();
    const blueprintTab = store.artifactTabs.find((tab) => tab.type === 'blueprint-document');

    expect(blueprintTab?.label).toBe('Blueprint');
    expect((blueprintTab?.data as { markdown?: string } | undefined)?.markdown).toContain(
      'CarrierCare Blueprint',
    );
    expect(
      store.artifactTabs.some((tab) => tab.type === 'agent_code' && tab.label === 'Blueprint'),
    ).toBe(false);
    expect(store.filePanelFiles.Blueprint).toBeUndefined();
    expect(store.activeTabId).toBe(blueprintTab?.id);
  });

  it('turns raw ask_user tool calls into widget-pending state with restored pending interaction', () => {
    dispatch({
      type: 'tool_call',
      toolCallId: 'build-complete-1',
      toolName: 'ask_user',
      input: {
        widgetType: 'BuildComplete',
        question: 'What should we do next?',
        options: [{ label: 'Create project', value: 'create' }],
      },
    });

    const store = useArchUIStore.getState();
    expect(store.state).toBe('widget_pending');
    expect(store.messages.at(-1)?.toolCall?.toolName).toBe('ask_user');
    expect(store.session?.metadata.pendingInteraction).toMatchObject({
      kind: 'widget',
      id: 'build-complete-1',
    });
  });

  it('clears persisted pending interaction when a durable turn ends', () => {
    useArchUIStore.setState((state) => ({
      session: {
        ...state.session!,
        metadata: {
          ...state.session!.metadata,
          pendingInteraction: {
            kind: 'widget',
            id: 'build-complete-1',
            payload: {
              widgetType: 'BuildComplete',
              question: 'What should we do next?',
            },
            createdAt: '2026-04-19T12:00:10.000Z',
          },
        },
      } as never,
      state: 'streaming',
    }));

    dispatch(
      makeTurnEvent({
        type: 'turn_ended',
        reason: 'natural',
        suggestions: [],
      }),
    );

    expect(useArchUIStore.getState().session?.metadata.pendingInteraction).toBeNull();
  });

  it('wires successful create_project results into project landing state', () => {
    useArchUIStore.setState({
      currentMsgId: 'assistant-1',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Creating your project...',
          timestamp: '2026-04-19T12:00:00.000Z',
          isStreaming: true,
        },
      ] as never,
    });

    dispatch({
      type: 'tool_result',
      toolCallId: 'create_project',
      result: {
        success: true,
        projectId: 'proj-123',
        projectName: 'BookingHub',
        stats: { total: 2, saved: 2, failed: 0 },
      },
    });

    expect(useArchAIStore.getState().createdProjectId).toBe('proj-123');
    expect(useProjectStore.getState().projects[0]).toMatchObject({
      id: 'proj-123',
      name: 'BookingHub',
      agentCount: 2,
    });
    expect(useArchUIStore.getState().session?.metadata.projectId).toBe('proj-123');
    expect(useArchUIStore.getState().messages.at(-1)?.toolCall).toMatchObject({
      toolName: 'create_project',
    });
    expect(useArchUIStore.getState().currentMsgId).toBeNull();
  });

  it('opens and updates the diff artifact tab from durable diff events', () => {
    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'diff',
          diffId: 'proposal-lead-intake',
          status: 'pending',
          payload: {
            agentName: 'LeadIntake',
            reviewStatus: 'pending',
            changes: [
              {
                construct: 'FULL',
                before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
                after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
                rationale: 'Improve conversion speed.',
              },
            ],
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    const openedTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(openedTab?.label).toBe('Changes');
    expect(useArchAIStore.getState().overlayState).toBe('artifacts');
    expect(
      (openedTab?.data as { reviewStatus?: string; agentName?: string } | undefined)?.reviewStatus,
    ).toBe('pending');
    expect(
      (openedTab?.data as { reviewStatus?: string; agentName?: string } | undefined)?.agentName,
    ).toBe('LeadIntake');

    dispatch(
      makeTurnEvent({
        eventId: 'evt-diff-applied',
        seq: 2,
        type: 'artifact_updated',
        update: {
          artifact: 'diff',
          diffId: 'proposal-lead-intake',
          status: 'applied',
        },
      }) as unknown as ArchSSEEvent,
    );

    const updatedTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(updatedTab).toBeUndefined();
  });

  it('invalidates active project topology cache from durable topology artifacts', () => {
    useProjectStore.setState({ currentProjectId: 'project-1' });

    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'topology',
          payload: {
            agents: [{ name: 'LeadIntake' }],
            edges: [],
            agentCount: 1,
            edgeCount: 0,
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    expect(swrMutateMock).toHaveBeenCalledWith('/api/projects/project-1/topology', undefined, {
      revalidate: true,
    });
  });

  it('opens the blueprint document, not the graph, when a durable topology artifact arrives during BLUEPRINT', () => {
    useArchUIStore.setState((state) => ({
      phase: 'BLUEPRINT',
      session: {
        ...state.session!,
        metadata: {
          ...state.session!.metadata,
          phase: 'BLUEPRINT',
          topologyApproved: false,
          draftTopology: null,
          lockedTopology: null,
        },
      } as never,
    }));

    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'topology',
          payload: {
            agents: [
              {
                name: 'SupportRouter',
                role: 'Entry triage',
                executionMode: 'hybrid',
              },
              {
                name: 'ShippingDeliverySpecialist',
                role: 'Delivery support',
                executionMode: 'reasoning',
              },
            ],
            edges: [
              {
                from: 'SupportRouter',
                to: 'ShippingDeliverySpecialist',
                type: 'delegate',
                condition: 'issue_type == "shipping_delivery"',
              },
            ],
            entryPoint: 'SupportRouter',
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    const artifactStore = useArchAIStore.getState();
    const blueprintTab = artifactStore.artifactTabs.find(
      (tab) => tab.type === 'blueprint-document',
    );
    const topologyTab = artifactStore.artifactTabs.find((tab) => tab.type === 'topology');

    expect(topologyTab).toBeDefined();
    expect(blueprintTab).toBeDefined();
    expect(artifactStore.activeTabId).toBe(blueprintTab?.id);
    expect(blueprintTab?.label).toBe('Blueprint');
    expect((blueprintTab?.data as { markdown?: string } | undefined)?.markdown).toContain(
      '## 17. Configuration Checklist',
    );
  });

  it('opens the health tab from a durable health artifact', () => {
    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'health',
          payload: {
            overall: 'healthy',
            agents: [{ name: 'BookingTriageAgent', status: 'healthy' }],
            summary: { healthy: 1, warnings: 0, errors: 0 },
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    const healthTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'health');
    expect(healthTab?.label).toBe('Health');
    expect(useArchAIStore.getState().activeTabId).toBe(healthTab?.id ?? null);
    expect(useArchAIStore.getState().overlayState).toBe('artifacts');
  });

  it('renders durable model comparison widgets as synthetic tool result messages', () => {
    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'widget',
          variant: 'model_comparison',
          payload: {
            primary: { modelId: 'gpt-4.1', provider: 'openai' },
            recommendations: [{ modelId: 'gpt-4.1', provider: 'openai', score: 0.98 }],
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    const lastMessage = useArchUIStore.getState().messages.at(-1);
    expect(lastMessage?.toolCall).toMatchObject({
      toolName: 'recommend_model',
      result: {
        primary: { modelId: 'gpt-4.1', provider: 'openai' },
      },
    });
  });

  it('renders tool generation gate requests instead of falling back to the broken payload message', () => {
    dispatch({
      type: 'gate_request',
      gateType: 'tool_generation',
      data: {
        toolCount: 2,
        tools: ['lookupOrder', 'createReturn'],
      },
    });

    const lastMessage = useArchUIStore.getState().messages.at(-1);
    expect(useArchUIStore.getState().state).toBe('widget_pending');
    expect(lastMessage?.content).toBe('');
    expect(lastMessage?.toolCall).toMatchObject({
      toolName: 'gate_request',
      input: {
        widgetType: 'GateRequest',
        gateType: 'tool_generation',
        title: 'Tool Generation',
        details: ['2 tools proposed', 'Tools: lookupOrder, createReturn'],
      },
    });
  });

  it('attaches durable KB card artifacts to assistant messages', () => {
    dispatch(
      makeTurnEvent({
        type: 'artifact_updated',
        update: {
          artifact: 'widget',
          variant: 'kb_health_card',
          payload: {
            type: 'kb_health_card',
            kbId: 'kb-1',
            kbName: 'SupportDocs',
            overallStatus: 'healthy',
            sections: {
              sources: { total: 1, healthy: 1, syncing: 0 },
              documents: { total: 12, errored: 0, processing: 0 },
              pipeline: { status: 'ready' },
              llm: { configured: true },
            },
            actions: [],
          },
        },
      }) as unknown as ArchSSEEvent,
    );

    const lastMessage = useArchUIStore.getState().messages.at(-1);
    expect(lastMessage?.kbCards).toEqual([
      {
        type: 'kb_health_card',
        kbId: 'kb-1',
        kbName: 'SupportDocs',
        overallStatus: 'healthy',
        sections: {
          sources: { total: 1, healthy: 1, syncing: 0 },
          documents: { total: 12, errored: 0, processing: 0 },
          pipeline: { status: 'ready' },
          llm: { configured: true },
        },
        actions: [],
      },
    ]);
  });

  it('persists Search AI widget cards into a dedicated artifact tab', () => {
    dispatch({
      ...makeTurnEvent({
        seq: 1,
        type: 'artifact_updated',
        update: {
          artifact: 'widget',
          variant: 'search_results_card',
          payload: {
            type: 'search_results_card',
            kbId: 'kb-support',
            kbName: 'Support KB',
            query: 'refund policy',
            resultCount: 1,
            latencyMs: 42,
            results: [
              {
                title: 'Refund Policy',
                score: 0.93,
                content: 'Refunds are allowed within 30 days.',
                source: 'policy.md',
                sourceType: 'document',
              },
            ],
            actions: [],
          },
        },
      }),
      eventId: 'evt-search',
    } as unknown as ArchSSEEvent);

    dispatch({
      ...makeTurnEvent({
        seq: 2,
        type: 'artifact_updated',
        update: {
          artifact: 'widget',
          variant: 'upload_progress_card',
          payload: {
            type: 'upload_progress_card',
            kbId: 'kb-support',
            kbName: 'Support KB',
            files: [
              {
                name: 'support-guide.pdf',
                status: 'pending',
                stage: 'ingestion queued',
              },
            ],
            actions: [],
          },
        },
      }),
      eventId: 'evt-upload',
    } as unknown as ArchSSEEvent);

    dispatch({
      ...makeTurnEvent({
        seq: 3,
        type: 'artifact_updated',
        update: {
          artifact: 'widget',
          variant: 'kb_health_card',
          payload: {
            type: 'kb_health_card',
            kbId: 'kb-support',
            kbName: 'Support KB',
            overallStatus: 'healthy',
            sections: {
              sources: { total: 2, healthy: 2, syncing: 0 },
              documents: { total: 12, errored: 0, processing: 1 },
              pipeline: { status: 'running' },
              llm: { configured: true },
            },
            actions: [],
          },
        },
      }),
      eventId: 'evt-health',
    } as unknown as ArchSSEEvent);

    const searchTab = useArchAIStore
      .getState()
      .artifactTabs.find((tab) => tab.type === 'search-ai' && tab.label === 'Search AI');
    const searchData = searchTab?.data as {
      entries?: Array<{ card: { type: string; kbId: string } }>;
    };

    expect(searchTab).toBeDefined();
    expect(searchData.entries).toMatchObject([
      { card: { type: 'search_results_card', kbId: 'kb-support' } },
      { card: { type: 'upload_progress_card', kbId: 'kb-support' } },
      { card: { type: 'kb_health_card', kbId: 'kb-support' } },
    ]);

    const lastMessage = useArchUIStore.getState().messages.at(-1);
    expect(lastMessage?.kbCards).toHaveLength(3);
    expect(lastMessage?.kbCards?.[0]).toMatchObject({
      type: 'search_results_card',
      kbId: 'kb-support',
    });
    expect(lastMessage?.kbCards?.[1]).toMatchObject({
      type: 'upload_progress_card',
      kbId: 'kb-support',
    });
    expect(lastMessage?.kbCards?.[2]).toMatchObject({
      type: 'kb_health_card',
      kbId: 'kb-support',
    });
  });
});
