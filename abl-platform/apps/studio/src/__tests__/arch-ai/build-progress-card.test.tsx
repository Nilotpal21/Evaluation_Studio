import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BuildProgressCard } from '@/lib/arch-ai/components/arch/chat/BuildProgressCard';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

describe('BuildProgressCard', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  it('shows BUILD-ready sessions as queued instead of generating', () => {
    const store = useArchAIStore.getState();
    store.setBuildPhase('ready');
    store.addFile('ReservationRouter', '');
    store.addFile('MedicalBookingSpecialist', '');

    render(
      <BuildProgressCard topologyAgents={['ReservationRouter', 'MedicalBookingSpecialist']} />,
    );

    expect(screen.getByText('Ready to build 2 agents')).toBeInTheDocument();
    expect(screen.getByText('0/2 compiled')).toBeInTheDocument();
    expect(screen.getAllByText('Queued')).toHaveLength(2);
  });

  it('keeps topology agents as canonical and surfaces unexpected extras separately', () => {
    const store = useArchAIStore.getState();
    store.setBuildPhase('complete');
    store.setBuildAgentStatus('Supervisor', 'compiled');
    store.setBuildAgentStatus('OrderAgent', 'compiled');
    store.addFile('LegacySupportAgent', '', { fileType: 'agent' });

    render(<BuildProgressCard topologyAgents={['Supervisor', 'OrderAgent']} />);

    expect(screen.getByText('Built 2 agents')).toBeInTheDocument();
    expect(screen.getByText('2/2 compiled')).toBeInTheDocument();
    expect(
      screen.getByText(/Unexpected generated agents outside the approved topology/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/LegacySupportAgent/i)).toBeInTheDocument();
  });
});
