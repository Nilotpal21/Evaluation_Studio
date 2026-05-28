import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecDocumentPanel } from '@/lib/arch-ai/components/arch/panels/SpecDocumentPanel';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';

function makeSpecDoc(overrides?: Record<string, unknown>) {
  return {
    version: 1,
    business: {
      projectName: '',
      objective: null,
      channels: [],
      language: 'English',
      compliance: [],
      constraints: [],
      personas: [],
      slas: [],
      edgeCases: [],
      notes: [],
    },
    architecture: {
      pattern: null,
      entryPoint: null,
      agentCount: 0,
      agents: [],
      edges: [],
      rationale: null,
    },
    implementation: {
      tools: [],
      guardrails: [],
      buildStatus: null,
    },
    decisions: [],
    ...overrides,
  };
}

describe('SpecDocumentPanel', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
    useArchUIStore.getState().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetches the spec document after a durable turn commit and hydrates the latest values', async () => {
    const blankDoc = makeSpecDoc();
    const filledDoc = makeSpecDoc({
      version: 9,
      business: {
        projectName: 'ReservationHub',
        objective:
          'Multi-vertical appointment booking system supporting medical, salon, restaurant, and fitness industries.',
        channels: ['Web Chat', 'Voice'],
        language: 'English',
        compliance: [],
        constraints: [],
        personas: [],
        slas: [],
        edgeCases: [],
        notes: [],
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: blankDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: filledDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: filledDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    render(<SpecDocumentPanel sessionId="sess-1" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(useArchAIStore.getState().specDocumentVersion).toBe(1);

    act(() => {
      useArchUIStore.setState({ lastCommittedSeq: 6 });
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('ReservationHub')).toBeInTheDocument();
    });

    expect(useArchAIStore.getState().specDocumentVersion).toBe(9);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows optimistic/fallback business values while the persisted spec document catches up', async () => {
    const blankDoc = makeSpecDoc();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: blankDoc }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    render(
      <SpecDocumentPanel
        sessionId="sess-2"
        specFallback={{
          projectName: 'CustomerCareHub',
          description: 'Support order status, returns, shipping, and escalations.',
          channels: ['Web Chat', 'Email'],
          language: 'English',
        }}
        specOverride={{
          projectName: 'CustomerCareHub',
          description: 'Support order status, returns, shipping, and escalations.',
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('CustomerCareHub')).toBeInTheDocument();
    });

    expect(
      screen.getByDisplayValue('Support order status, returns, shipping, and escalations.'),
    ).toBeInTheDocument();
  });

  it('uses v4 project-scoped spec endpoints for load, sync, and edit flows', async () => {
    const projectDoc = makeSpecDoc({
      version: 3,
      business: {
        projectName: 'OpsCopilot',
        objective: 'Help operators investigate runtime incidents quickly.',
        channels: ['Web Chat'],
        language: 'English',
        compliance: [],
        constraints: [],
        personas: [],
        slas: [],
        edgeCases: [],
        notes: [],
      },
    });

    const syncedDoc = makeSpecDoc({
      ...projectDoc,
      version: 4,
      business: {
        ...(projectDoc.business as Record<string, unknown>),
        objective: 'Help operators investigate runtime incidents and recover faster.',
      },
    });

    const updatedDoc = makeSpecDoc({
      ...syncedDoc,
      version: 5,
      business: {
        ...(syncedDoc.business as Record<string, unknown>),
        projectName: 'OpsCopilot Pro',
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: projectDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: syncedDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: updatedDoc }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    render(<SpecDocumentPanel sessionId="sess-project" projectId="proj-123" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/arch-ai/projects/proj-123/spec-document',
        expect.objectContaining({
          cache: 'no-store',
        }),
      );
    });

    fireEvent.click(screen.getByTitle('Sync from project'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/arch-ai/projects/proj-123/spec-document/sync',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    fetchMock.mockClear();

    fireEvent.change(screen.getByDisplayValue('OpsCopilot'), {
      target: { value: 'OpsCopilot Pro' },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/arch-ai/projects/proj-123/spec-document',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            updates: [{ path: 'business.projectName', value: 'OpsCopilot Pro' }],
          }),
        }),
      );
    });
  });
});
