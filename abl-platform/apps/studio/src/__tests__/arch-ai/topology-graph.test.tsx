import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopologyGraph } from '@/lib/arch-ai/components/arch/panels/TopologyGraph';

describe('TopologyGraph', () => {
  it('keeps hook order stable when topology data arrives after an empty render', () => {
    const { rerender } = render(<TopologyGraph agents={[]} edges={[]} entryPoint="" />);

    expect(screen.getByText('No topology yet')).toBeInTheDocument();

    expect(() =>
      rerender(
        <TopologyGraph
          agents={[
            {
              name: 'SupportRouter',
              role: 'Routes support requests',
              executionMode: 'reasoning',
            },
            {
              name: 'BillingAgent',
              role: 'Handles billing questions',
              executionMode: 'reasoning',
            },
          ]}
          edges={[
            {
              from: 'SupportRouter',
              to: 'BillingAgent',
              type: 'handoff',
              condition: 'billing request',
            },
          ]}
          entryPoint="SupportRouter"
        />,
      ),
    ).not.toThrow();

    expect(screen.getByText('SupportRouter')).toBeInTheDocument();
    expect(screen.getByText('BillingAgent')).toBeInTheDocument();
  });
});
