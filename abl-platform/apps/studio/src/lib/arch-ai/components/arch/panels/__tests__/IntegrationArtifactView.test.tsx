import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationArtifactView } from '../IntegrationArtifactView';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { IntegrationDraftSummary } from '@/lib/arch-ai/integration-draft-service';

function makeDraft(overrides: Partial<IntegrationDraftSummary> = {}): IntegrationDraftSummary {
  return {
    id: 'draft-1',
    title: 'Slack integration',
    status: 'draft',
    source: 'in_project',
    providerKey: 'slack',
    toolIds: [],
    authProfileIds: [],
    envVarKeys: [],
    configVarKeys: [],
    variableNamespaceIds: [],
    targetAgentNames: [],
    pendingSteps: [],
    lastIntentSummary: null,
    connectionIds: [],
    lastTestStatus: null,
    lastTestAt: null,
    lastTestError: null,
    testHistory: [],
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    ...overrides,
  } as IntegrationDraftSummary;
}

function mockFetchOnce(payload: { drafts: IntegrationDraftSummary[] }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as typeof fetch;
}

describe('IntegrationArtifactView', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when no drafts', async () => {
    mockFetchOnce({ drafts: [] });
    render(<IntegrationArtifactView sessionId={null} projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText(/No integrations yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Add integration/i })).toBeInTheDocument();
  });

  it('renders one card per draft with provider name and status', async () => {
    mockFetchOnce({
      drafts: [
        makeDraft({ id: 'draft-1', providerKey: 'slack', status: 'draft' }),
        makeDraft({ id: 'draft-2', providerKey: 'github', status: 'complete' }),
      ],
    });

    render(<IntegrationArtifactView sessionId={null} projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText('slack')).toBeInTheDocument());
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Resume in chat/i })).toHaveLength(2);
  });

  it('clicking "Resume in chat" sets resume_integration prefill metadata with draftId', async () => {
    mockFetchOnce({
      drafts: [makeDraft({ id: 'draft-xyz', providerKey: 'slack' })],
    });

    render(<IntegrationArtifactView sessionId={null} projectId="proj-1" />);

    const resumeBtn = await screen.findByRole('button', { name: /Resume in chat/i });
    fireEvent.click(resumeBtn);

    expect(useArchAIStore.getState().prefillMetadata).toEqual({
      kind: 'resume_integration',
      draftId: 'draft-xyz',
      intent: 'resume',
    });
  });

  it('clicking "+ Add integration" sets start_integration prefill metadata', async () => {
    mockFetchOnce({ drafts: [] });

    render(<IntegrationArtifactView sessionId={null} projectId="proj-1" />);

    const addBtn = await screen.findByRole('button', { name: /Add integration/i });
    fireEvent.click(addBtn);

    expect(useArchAIStore.getState().prefillMetadata).toEqual({
      kind: 'start_integration',
    });
  });
});
