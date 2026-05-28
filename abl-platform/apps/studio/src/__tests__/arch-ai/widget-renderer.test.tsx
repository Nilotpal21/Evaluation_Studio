import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WidgetRenderer } from '@/lib/arch-ai/components/arch/widgets/WidgetRenderer';

describe('WidgetRenderer', () => {
  it('lets blueprint widgets own their own compact heading without repeating the question or summary', () => {
    render(
      <WidgetRenderer
        toolCallId="blueprint-confirm-1"
        toolName="ask_user"
        input={{
          widgetType: 'BlueprintConfirm',
          question:
            'Would you like to turn this concept into a draft topology or refine the approach first?',
          title: 'Blueprint direction',
          description: '## Proposed blueprint\n- Entry agent routes the conversation',
          options: [
            { label: 'Generate draft topology', value: 'generate_draft_topology' },
            { label: 'Refine concept first', value: 'refine_concept' },
          ],
          allowCustom: false,
        }}
        requestId="req-1"
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Blueprint direction')).toBeInTheDocument();
    expect(screen.getByText('Generate draft blueprint')).toBeInTheDocument();
    expect(screen.queryByText(/turn this concept into a draft blueprint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/entry agent routes the conversation/i)).not.toBeInTheDocument();
  });

  it('renders answered topology approvals inline as a readonly summary', () => {
    render(
      <WidgetRenderer
        toolCallId="topology-approval-1"
        toolName="ask_user"
        input={{
          widgetType: 'TopologyApproval',
          question: 'Review this draft topology.',
          title: 'Draft topology ready',
          agentCount: 3,
          edgeCount: 2,
          entryPoint: 'SupportRouter',
          agents: ['SupportRouter', 'ReturnsAgent', 'EscalationAgent'],
          topology: {},
        }}
        requestId="req-2"
        answeredResult={{
          action: 'request_changes',
          notes: 'Split returns and refunds into separate specialists.',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Review this draft blueprint.')).toBeInTheDocument();
    expect(
      screen.getByText(/request_changes — Split returns and refunds into separate specialists\./i),
    ).toBeInTheDocument();
  });

  it('normalizes pending legacy topology approval copy to blueprint copy', () => {
    render(
      <WidgetRenderer
        toolCallId="topology-approval-2"
        toolName="ask_user"
        input={{
          widgetType: 'TopologyApproval',
          question: 'Review this draft topology.',
          title: 'Draft topology ready',
          agentCount: 2,
          edgeCount: 1,
          entryPoint: 'SupportRouter',
          agents: ['SupportRouter', 'ShippingAgent'],
          topology: {},
        }}
        requestId="req-3"
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Draft blueprint ready')).toBeInTheDocument();
    expect(screen.getByText('Accept blueprint')).toBeInTheDocument();
    expect(screen.queryByText('Draft topology ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Accept topology')).not.toBeInTheDocument();
  });
});
