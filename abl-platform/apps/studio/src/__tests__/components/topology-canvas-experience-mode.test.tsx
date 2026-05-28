/**
 * @vitest-environment happy-dom
 */

import React, { type PropsWithChildren } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TopologyData } from '../../types/arch';

vi.mock('framer-motion', () => ({
  motion: {
    g: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <g {...props}>{children}</g>
    ),
  },
}));

import { TopologyCanvas } from '../../components/topology/TopologyCanvas';

const topology: TopologyData = {
  nodes: [
    {
      id: 'reception',
      name: 'Reception',
      type: 'supervisor',
      isEntry: true,
      executionMode: 'reasoning',
      tools: [],
      gatherFields: [],
      flowStepCount: 1,
      constraintCount: 0,
      healthStatus: 'healthy',
    },
    {
      id: 'orders',
      name: 'Orders',
      type: 'agent',
      isEntry: false,
      executionMode: 'hybrid',
      tools: ['get_order'],
      gatherFields: [],
      flowStepCount: 2,
      constraintCount: 1,
      healthStatus: 'healthy',
    },
    {
      id: 'human',
      name: 'Human Escalation',
      type: 'agent',
      isEntry: false,
      executionMode: 'scripted',
      tools: [],
      gatherFields: [],
      flowStepCount: 1,
      constraintCount: 0,
      healthStatus: 'warning',
    },
    {
      id: 'policy',
      name: 'Policy Advisor',
      type: 'agent',
      isEntry: false,
      executionMode: 'reasoning',
      tools: ['search_policy'],
      gatherFields: [],
      flowStepCount: 1,
      constraintCount: 0,
      healthStatus: 'healthy',
    },
  ],
  edges: [
    {
      from: 'reception',
      to: 'orders',
      type: 'handoff',
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'reception',
      to: 'human',
      type: 'handoff',
      experienceMode: 'visible_handoff',
    },
    {
      from: 'reception',
      to: 'policy',
      type: 'delegate',
      experienceMode: 'silent_delegate',
    },
  ],
};

describe('TopologyCanvas experience mode rendering', () => {
  it('labels persisted topology edges by customer experience mode', () => {
    render(<TopologyCanvas topology={topology} />);

    expect(screen.getByText('Shared voice')).toBeInTheDocument();
    expect(screen.getByText('Visible handoff')).toBeInTheDocument();
    expect(screen.getByText('Silent delegate')).toBeInTheDocument();
    expect(screen.getByTestId('topology-edge-experience-reception-orders')).toBeInTheDocument();
    expect(screen.getByTestId('topology-edge-experience-reception-human')).toBeInTheDocument();
    expect(screen.getByTestId('topology-edge-experience-reception-policy')).toBeInTheDocument();
  });

  it('keeps compact topology mode visually dense by omitting edge labels', () => {
    render(<TopologyCanvas topology={topology} compact />);

    expect(screen.queryByText('Shared voice')).not.toBeInTheDocument();
    expect(screen.queryByText('Visible handoff')).not.toBeInTheDocument();
    expect(screen.queryByText('Silent delegate')).not.toBeInTheDocument();
  });
});
