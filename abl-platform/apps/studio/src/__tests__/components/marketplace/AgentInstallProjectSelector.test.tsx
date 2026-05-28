/**
 * AgentInstallProjectSelector Component Tests
 *
 * Tests the project selector dialog for agent template installation.
 * Uses store.setState() to control the marketplace store's user projects.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentInstallProjectSelector } from '../../../components/marketplace/AgentInstallProjectSelector';
import { useMarketplaceStore } from '../../../store/marketplace-store';

// Mock apiFetch — external API boundary
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

// Mock the template-install API — external API boundary
vi.mock('@/api/template-install', () => ({
  installProjectTemplate: vi.fn(),
  previewAgentInstall: vi.fn(),
  applyAgentInstall: vi.fn(),
}));

describe('AgentInstallProjectSelector', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      userProjects: [],
      userProjectsLoading: false,
      // Override fetchUserProjects to a no-op so the useEffect doesn't
      // trigger the real store action (which calls apiFetch)
      fetchUserProjects: vi.fn(),
    });
  });

  it('renders project list when projects are available', () => {
    useMarketplaceStore.setState({
      userProjects: [
        { id: 'p1', name: 'Project Alpha', slug: 'project-alpha', agentCount: 3 },
        { id: 'p2', name: 'Project Beta', slug: 'project-beta', agentCount: 1 },
      ],
      userProjectsLoading: false,
    });

    render(
      <AgentInstallProjectSelector open={true} onClose={vi.fn()} onProjectSelected={vi.fn()} />,
    );

    expect(screen.getByText('Project Alpha')).toBeTruthy();
    expect(screen.getByText('3 agents')).toBeTruthy();
    expect(screen.getByText('Project Beta')).toBeTruthy();
    expect(screen.getByText('1 agent')).toBeTruthy();
  });

  it('calls onProjectSelected when a project is clicked', () => {
    const onProjectSelected = vi.fn();

    useMarketplaceStore.setState({
      userProjects: [{ id: 'p1', name: 'Project Alpha', slug: 'project-alpha', agentCount: 2 }],
      userProjectsLoading: false,
    });

    render(
      <AgentInstallProjectSelector
        open={true}
        onClose={vi.fn()}
        onProjectSelected={onProjectSelected}
      />,
    );

    fireEvent.click(screen.getByText('Project Alpha'));
    expect(onProjectSelected).toHaveBeenCalledWith('p1', 'Project Alpha');
  });

  it('shows empty state when no projects', () => {
    useMarketplaceStore.setState({
      userProjects: [],
      userProjectsLoading: false,
    });

    render(
      <AgentInstallProjectSelector open={true} onClose={vi.fn()} onProjectSelected={vi.fn()} />,
    );

    expect(screen.getByText('No projects found. Create a project first.')).toBeTruthy();
  });

  it('shows loading state while fetching projects', () => {
    useMarketplaceStore.setState({
      userProjects: [],
      userProjectsLoading: true,
    });

    render(
      <AgentInstallProjectSelector open={true} onClose={vi.fn()} onProjectSelected={vi.fn()} />,
    );

    expect(screen.getByText('Loading projects...')).toBeTruthy();
  });

  it('calls onClose when cancel button is clicked', () => {
    const onClose = vi.fn();

    useMarketplaceStore.setState({
      userProjects: [],
      userProjectsLoading: false,
    });

    render(
      <AgentInstallProjectSelector open={true} onClose={onClose} onProjectSelected={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
