import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';
import { OnboardingArtifactPanel } from '@/lib/arch-ai/components/arch/panels/OnboardingArtifactPanel';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

describe('OnboardingArtifactPanel blueprint document', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  it('renders a rich blueprint artifact without promoting pending boilerplate as final detail', () => {
    const artifact = buildBlueprintDocumentArtifact({
      metadata: {
        specification: {
          projectName: 'SupportFlow',
          description: 'Route support requests across FAQ, ticket, incident, and escalation flows.',
          channels: ['Web Chat', 'Slack'],
          language: 'English',
          conversationNotes: ['Reduce duplicate asks', 'Escalate critical incidents'],
        },
        sourceArchitectureContract: {
          sourceFiles: ['support-sop.md'],
          entryAgent: 'HelpdeskRouter',
          channels: ['Web Chat', 'Slack'],
          requiredMcpServers: ['Support MCP'],
          sharedMemoryVariables: ['customer_id'],
          universalRules: ['Preserve case context across routed agents.'],
          guardrails: ['Content safety'],
          optionalExternalAgents: [],
          confidence: 0.95,
          declaredAgents: [
            {
              name: 'HelpdeskRouter',
              role: 'Entry triage',
              tools: [],
              memoryVariables: ['customer_id'],
              limitations: [],
              provenance: { fileName: 'support-sop.md', section: 'Agents' },
            },
            {
              name: 'IssueIntakeSpecialist',
              role: 'Incident intake',
              tools: ['extract_incident_signals'],
              memoryVariables: ['customer_id'],
              limitations: [],
              provenance: { fileName: 'support-sop.md', section: 'Agents' },
            },
          ],
          tools: [
            {
              name: 'extract_incident_signals',
              description: 'Extract incident signals.',
              provenance: { fileName: 'support-sop.md', section: 'Tools' },
            },
          ],
        },
      },
      topology: {
        pattern: 'hub_spoke',
        entryPoint: 'HelpdeskRouter',
        agents: [
          {
            name: 'HelpdeskRouter',
            role: 'Entry triage',
            executionMode: 'hybrid',
            description: 'Routes user requests to the right specialist.',
          },
          {
            name: 'IssueIntakeSpecialist',
            role: 'Incident intake',
            executionMode: 'hybrid',
            description: 'Collects diagnostic context and recommends next steps.',
          },
        ],
        edges: [
          {
            from: 'HelpdeskRouter',
            to: 'IssueIntakeSpecialist',
            type: 'handoff',
            condition: 'known_issue == true',
          },
        ],
      },
    });

    useArchAIStore.getState().addTab({
      type: 'blueprint-document',
      label: 'Blueprint',
      data: artifact,
      toolCallId: 'blueprint-doc-test',
    });

    render(
      <OnboardingArtifactPanel
        session={{ id: 'session-1', metadata: {} }}
        onSpecUpdate={vi.fn()}
        phase="BLUEPRINT"
      />,
    );

    expect(screen.getByText('Blueprint artifact')).toBeInTheDocument();
    expect(screen.getByText('Source coverage')).toBeInTheDocument();
    expect(screen.getByText('2/2 agents captured')).toBeInTheDocument();
    expect(screen.getByText('Architecture map')).toBeInTheDocument();
    expect(screen.queryByText('Session journey')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /markdown/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /json/i })).toBeInTheDocument();
    expect(screen.getAllByText('HelpdeskRouter').length).toBeGreaterThan(0);
    expect(screen.getAllByText('IssueIntakeSpecialist').length).toBeGreaterThan(0);

    expect(screen.getByText('Open items')).toBeInTheDocument();
    expect(screen.getByText(/Confirm required tools/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Executive Summary' })).toBeInTheDocument();

    expect(
      screen.queryByText('No project tools have been captured in the blueprint draft yet.'),
    ).not.toBeInTheDocument();
  });
});
