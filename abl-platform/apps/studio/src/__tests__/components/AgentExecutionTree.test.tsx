import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentExecutionTree } from '../../components/session/AgentExecutionTree';
import type { TreeNode } from '../../hooks/useSessionDetail';

const mockSelectSpan = vi.fn();
const mockSetDebugPanelTab = vi.fn();

vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      selectSpan: mockSelectSpan,
      setDebugPanelTab: mockSetDebugPanelTab,
    };
    return selector ? selector(state) : state;
  },
}));

function makeTreeNode(
  overrides: Partial<TreeNode> & Pick<TreeNode, 'id' | 'type' | 'label'>,
): TreeNode {
  return {
    children: [],
    ...overrides,
  };
}

describe('AgentExecutionTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets transcript separators be selected from the left rail', () => {
    const onSelectNode = vi.fn();

    render(
      <AgentExecutionTree
        tree={[
          makeTreeNode({
            id: 'user-msg',
            type: 'user_input',
            label: '"I need a hotel in Paris"',
          }),
          makeTreeNode({
            id: 'agent-msg',
            type: 'agent_response',
            label: 'Agent: "I can help with that."',
          }),
        ]}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />,
    );

    fireEvent.click(screen.getByText('"I need a hotel in Paris"'));
    fireEvent.click(screen.getByText('Agent: "I can help with that."'));

    expect(onSelectNode).toHaveBeenNthCalledWith(1, 'user-msg');
    expect(onSelectNode).toHaveBeenNthCalledWith(2, 'agent-msg');
  });

  it('renders attachment lifecycle nodes in the execution tree', () => {
    render(
      <AgentExecutionTree
        tree={[
          makeTreeNode({
            id: 'agent-span',
            type: 'agent',
            label: 'SlackTestAgent',
            children: [
              makeTreeNode({
                id: 'attachment-download',
                type: 'attachment_process',
                label: 'Attachment Fetch: receipt.png',
              }),
              makeTreeNode({
                id: 'attachment-upload',
                type: 'attachment_upload',
                label: 'Attachment Ingest: receipt.png',
              }),
            ],
          }),
        ]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('SlackTestAgent'));

    expect(screen.getByText('Attachment Fetch: receipt.png')).toBeInTheDocument();
    expect(screen.getByText('Attachment Ingest: receipt.png')).toBeInTheDocument();
  });
});
