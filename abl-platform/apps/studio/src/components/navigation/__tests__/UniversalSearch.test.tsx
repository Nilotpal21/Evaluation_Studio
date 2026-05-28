/**
 * UniversalSearch Component Tests
 *
 * Tests context-aware search functionality, keyboard navigation,
 * and proper routing for both project-level and agent-level contexts.
 */

import { describe, test, expect, vi, beforeEach, it, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UniversalSearch } from '../UniversalSearch';
import { useNavigationStore } from '../../../store/navigation-store';
import { useAgentEditorStore } from '../../agent-editor/hooks/useAgentEditorStore';
import { fetchTools } from '../../../api/tools';
import { listWorkflows } from '../../../api/workflows';
import { fetchKnowledgeBases } from '../../../api/search-ai';
import { getAllNavItems } from '../../../config/navigation';

const mockFeatureState = vi.hoisted(() => ({
  hasGovernance: true,
}));

// Mock next-intl
const mockUseTranslations = vi.fn();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (key: string) => {
    if (namespace === 'agent_editor.menu') {
      const labels: Record<string, string> = {
        'group.identity': 'Identity',
        'group.capabilities': 'Capabilities',
        'item.goal_persona': 'Goal & Persona',
        'item.execution': 'Execution',
        'item.tools': 'Tools',
        'item.gather_fields': 'Gather Fields',
      };
      return labels[key] ?? key;
    }
    return key;
  },
}));

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock lucide-react icons
vi.mock('lucide-react', async () => {
  const actual = await vi.importActual<typeof import('lucide-react')>('lucide-react');
  return {
    ...actual,
    UserCog: vi.fn(() => null),
  };
});

// Mock stores
const mockNavigate = vi.fn();
const mockSetActiveSection = vi.fn();

vi.mock('../../../store/navigation-store', () => ({
  useNavigationStore: vi.fn(),
}));

vi.mock('../../agent-editor/hooks/useAgentEditorStore', () => ({
  useAgentEditorStore: vi.fn(),
}));

// Mock API calls
vi.mock('../../../api/tools', () => ({
  fetchTools: vi.fn(),
}));

vi.mock('../../../api/workflows', () => ({
  listWorkflows: vi.fn(),
  getExecution: vi.fn(),
  cancelExecution: vi.fn(),
}));

vi.mock('../../../api/search-ai', () => ({
  fetchKnowledgeBases: vi.fn(),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// Mock navigation config
vi.mock('../../../config/navigation', () => ({
  getAllNavItems: vi.fn(),
}));

vi.mock('../../../hooks/use-features', () => ({
  useFeatures: () => ({
    hasModules: true,
    hasCodeTools: true,
    hasGovernance: mockFeatureState.hasGovernance,
    isLoading: false,
  }),
}));

// Mock agent editor menu
vi.mock('../../agent-editor/AgentEditorMenu', () => ({
  menuGroups: [
    {
      id: 'identity',
      label: 'identity',
      items: [
        { section: 'identity', label: 'goal_persona', Icon: vi.fn() },
        { section: 'execution', label: 'execution', Icon: vi.fn() },
      ],
    },
    {
      id: 'capabilities',
      label: 'capabilities',
      items: [
        { section: 'tools', label: 'tools', Icon: vi.fn() },
        { section: 'gather', label: 'gather_fields', Icon: vi.fn() },
      ],
    },
  ],
}));

describe('UniversalSearch', () => {
  const mockNavigate = vi.fn();
  const mockSetActiveSection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFeatureState.hasGovernance = true;

    // Default navigation store mock (project level)
    (useNavigationStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
      selector({
        projectId: 'project-123',
        page: 'overview',
        subPage: null,
        tab: null,
        navigate: mockNavigate,
      }),
    );

    // Default agent editor store mock
    (useAgentEditorStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
      selector({
        visibleSections: ['identity', 'execution', 'tools', 'gather'],
        setActiveSection: mockSetActiveSection,
      }),
    );

    // Mock getState for agent editor store
    (useAgentEditorStore as any).getState = vi.fn(() => ({
      setActiveSection: mockSetActiveSection,
    }));

    // Mock navigation config
    (getAllNavItems as Mock).mockReturnValue([
      { id: 'overview', Icon: vi.fn(), key: 'overview', group: 'build' },
      { id: 'agents', Icon: vi.fn(), key: 'agents', group: 'build' },
      { id: 'workflows', Icon: vi.fn(), key: 'workflows', group: 'build' },
      { id: 'tools', Icon: vi.fn(), key: 'tools', group: 'resources' },
      { id: 'governance', Icon: vi.fn(), key: 'governance_label', group: 'govern' },
    ]);

    // Mock API calls
    (fetchTools as Mock).mockResolvedValue({
      data: [
        { id: 'tool-1', name: 'Email Tool' },
        { id: 'tool-2', name: 'Calendar Tool' },
      ],
    });

    (listWorkflows as Mock).mockResolvedValue([
      { id: 'wf-1', name: 'Onboarding Workflow' },
      { id: 'wf-2', name: 'Support Workflow' },
    ]);

    (fetchKnowledgeBases as Mock).mockResolvedValue({
      knowledgeBases: [
        { _id: 'kb-1', name: 'Product Documentation' },
        { _id: 'kb-2', name: 'FAQ Database' },
      ],
    });
  });

  describe('Rendering', () => {
    it('should render search button', () => {
      render(<UniversalSearch />);
      const searchButton = screen.getByTitle(/placeholder/);
      expect(searchButton).toBeInTheDocument();
    });

    it('should not show dropdown initially', () => {
      render(<UniversalSearch />);
      expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
    });

    it('should open dropdown when clicking search button', async () => {
      render(<UniversalSearch />);
      const searchButton = screen.getByTitle(/placeholder/);

      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/placeholder/i)).toBeInTheDocument();
      });
    });

    it('should close dropdown when clicking search button again', async () => {
      render(<UniversalSearch />);
      const searchButton = screen.getByTitle(/placeholder/);

      fireEvent.click(searchButton);
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/placeholder/i)).toBeInTheDocument();
      });

      fireEvent.click(searchButton);
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('should not open search with Cmd+K because CommandPalette owns the shortcut', async () => {
      render(<UniversalSearch />);

      fireEvent.keyDown(document, { key: 'k', metaKey: true });

      expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
    });

    it('should not open search with Ctrl+K because CommandPalette owns the shortcut', async () => {
      render(<UniversalSearch />);

      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

      expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
    });

    it('should close search with Escape', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/placeholder/i)).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Project-Level Context', () => {
    it('should show project navigation items', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
        expect(screen.getByText('agents')).toBeInTheDocument();
        expect(screen.getByText('workflows')).toBeInTheDocument();
      });
    });

    it('should hide governance navigation when the governance feature is disabled', async () => {
      mockFeatureState.hasGovernance = false;
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });
      expect(screen.queryByText('governance_label')).not.toBeInTheDocument();
    });

    it('should load dynamic items (tools, workflows, knowledge bases)', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(fetchTools).toHaveBeenCalledWith('project-123', { limit: 100 });
        expect(listWorkflows).toHaveBeenCalledWith('project-123');
        expect(fetchKnowledgeBases).toHaveBeenCalledWith('project-123');
      });

      await waitFor(() => {
        expect(screen.getByText('Email Tool')).toBeInTheDocument();
        expect(screen.getByText('Calendar Tool')).toBeInTheDocument();
        expect(screen.getByText('Onboarding Workflow')).toBeInTheDocument();
        expect(screen.getByText('Support Workflow')).toBeInTheDocument();
        expect(screen.getByText('Product Documentation')).toBeInTheDocument();
        expect(screen.getByText('FAQ Database')).toBeInTheDocument();
      });
    });

    it('should navigate to project page when selecting item', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      const overviewButton = screen.getByText('overview').closest('button');
      fireEvent.click(overviewButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/projects/project-123/overview');
    });
  });

  describe('Agent-Level Context', () => {
    beforeEach(() => {
      // Mock agent context
      (useNavigationStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
        selector({
          projectId: 'project-123',
          page: 'agents',
          subPage: 'agent-456',
          tab: null,
          navigate: mockNavigate,
        }),
      );
    });

    it('should show agent sections instead of project navigation', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
        expect(screen.getByText('Execution')).toBeInTheDocument();
        expect(screen.getByText('Tools')).toBeInTheDocument();
        expect(screen.getByText('Gather Fields')).toBeInTheDocument();
      });

      // Should NOT show project navigation
      expect(screen.queryByText('overview')).not.toBeInTheDocument();
    });

    it('should NOT load dynamic items when inside agent', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      });

      expect(fetchTools).not.toHaveBeenCalled();
      expect(listWorkflows).not.toHaveBeenCalled();
      expect(fetchKnowledgeBases).not.toHaveBeenCalled();
    });

    it('should filter sections by visibleSections', async () => {
      // Mock with limited visible sections
      (useAgentEditorStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
        selector({
          visibleSections: ['identity', 'execution'], // Only these two visible
          setActiveSection: mockSetActiveSection,
        }),
      );

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
        expect(screen.getByText('Execution')).toBeInTheDocument();
      });

      // Should NOT show hidden sections
      expect(screen.queryByText('Tools')).not.toBeInTheDocument();
      expect(screen.queryByText('Gather Fields')).not.toBeInTheDocument();
    });

    it('should call setActiveSection when selecting agent section', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      });

      const identityButton = screen.getByText('Goal & Persona').closest('button');
      fireEvent.click(identityButton!);

      expect(mockSetActiveSection).toHaveBeenCalledWith('identity');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should NOT show agent sections when in chat tab', async () => {
      // Mock agent context but in chat tab
      (useNavigationStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
        selector({
          projectId: 'project-123',
          page: 'agents',
          subPage: 'agent-456',
          tab: 'chat',
          navigate: mockNavigate,
        }),
      );

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      // Should show project navigation, not agent sections
      expect(screen.queryByText('Goal & Persona')).not.toBeInTheDocument();
    });
  });

  describe('Search Filtering', () => {
    it('should filter items based on query', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
        expect(screen.getByText('agents')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/placeholder/i);
      await userEvent.type(searchInput, 'age');

      await waitFor(() => {
        expect(screen.getByText('agents')).toBeInTheDocument();
        expect(screen.queryByText('overview')).not.toBeInTheDocument();
      });
    });

    it('should show no results message when no matches', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/placeholder/i);
      await userEvent.type(searchInput, 'xyz123nonexistent');

      await waitFor(() => {
        expect(screen.getByText(/no_results/i)).toBeInTheDocument();
      });
    });

    it('should clear search query with X button', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      const searchInput = screen.getByPlaceholderText(/placeholder/i);
      await userEvent.type(searchInput, 'test');

      const clearButton = screen
        .getByRole('button', { name: '' })
        .querySelector('svg')
        ?.closest('button');
      if (clearButton) {
        fireEvent.click(clearButton);
      }

      expect((searchInput as HTMLInputElement).value).toBe('');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should navigate down with ArrowDown', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: 'ArrowDown' });

      // First item should be selected (index 0 -> 1)
      const buttons = screen.getAllByRole('button');
      const navButtons = buttons.filter(
        (btn) => btn.textContent?.includes('overview') || btn.textContent?.includes('agents'),
      );
      expect(navButtons.length).toBeGreaterThan(1);
    });

    it('should navigate up with ArrowUp', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowUp' });

      // Should be back to first item
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should select item with Enter', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: 'Enter' });

      expect(mockNavigate).toHaveBeenCalled();
    });
  });

  describe('Click Outside', () => {
    it('should close dropdown when clicking outside', async () => {
      render(
        <div>
          <UniversalSearch />
          <div data-testid="outside">Outside</div>
        </div>,
      );

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/placeholder/i)).toBeInTheDocument();
      });

      const outside = screen.getByTestId('outside');
      fireEvent.mouseDown(outside);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/placeholder/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Group Labels', () => {
    it('should display correct group labels for project navigation', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        const buildLabels = screen.getAllByText('section_build');
        expect(buildLabels.length).toBeGreaterThan(0);
        const resourcesLabels = screen.getAllByText('section_resources');
        expect(resourcesLabels.length).toBeGreaterThan(0);
      });
    });

    it('should display correct group labels for agent sections', async () => {
      // Mock agent context
      (useNavigationStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
        selector({
          projectId: 'project-123',
          page: 'agents',
          subPage: 'agent-456',
          tab: null,
          navigate: mockNavigate,
        }),
      );

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        const identityLabels = screen.getAllByText('Identity');
        expect(identityLabels.length).toBeGreaterThan(0);
        const capabilitiesLabels = screen.getAllByText('Capabilities');
        expect(capabilitiesLabels.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Loading States', () => {
    it('should show static items immediately while dynamic items load', async () => {
      // Mock slow API
      (fetchTools as Mock).mockReturnValue(new Promise(() => {})); // Never resolves

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      // Static items should show immediately
      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
        expect(screen.getByText('agents')).toBeInTheDocument();
      });

      // Dynamic items should not be present yet
      expect(screen.queryByText('Email Tool')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null projectId gracefully', async () => {
      (useNavigationStore as unknown as Mock).mockImplementation((selector: (state: any) => any) =>
        selector({
          projectId: null,
          page: 'overview',
          subPage: null,
          tab: null,
          navigate: mockNavigate,
        }),
      );

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/placeholder/i)).toBeInTheDocument();
      });

      // Should not crash and should not call APIs
      expect(fetchTools).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      (fetchTools as Mock).mockRejectedValue(new Error('Network error'));
      (listWorkflows as Mock).mockRejectedValue(new Error('Network error'));
      (fetchKnowledgeBases as Mock).mockRejectedValue(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      await waitFor(() => {
        expect(screen.getByText('overview')).toBeInTheDocument();
      });

      // Should still show static items
      expect(screen.getByText('agents')).toBeInTheDocument();

      consoleSpy.mockRestore();
    });

    it('should reset query and selected index when closing', async () => {
      render(<UniversalSearch />);

      const searchButton = screen.getByTitle(/placeholder/);
      fireEvent.click(searchButton);

      const searchInput = screen.getByPlaceholderText(/placeholder/i);
      await userEvent.type(searchInput, 'test');

      fireEvent.keyDown(document, { key: 'ArrowDown' });

      fireEvent.click(searchButton);

      fireEvent.click(searchButton);

      await waitFor(() => {
        const input = screen.getByPlaceholderText(/placeholder/i) as HTMLInputElement;
        expect(input.value).toBe('');
      });
    });
  });
});
