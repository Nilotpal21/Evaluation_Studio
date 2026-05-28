import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarExpanded } from '../../components/layout/SidebarExpanded';
import { TooltipProvider } from '../../components/ui/Tooltip';

const mockNavigate = vi.fn();
vi.mock('@/store/navigation-store', () => ({
  useNavigationStore: () => ({ navigate: mockNavigate }),
}));

vi.mock('@/store/project-store', () => ({
  useProjectStore: () => ({
    projects: [
      {
        id: 'p1',
        name: 'Customer Service',
        agentCount: 4,
        slug: 'customer-service',
        createdAt: '',
        updatedAt: '',
        sessionCount: 0,
      },
      {
        id: 'p2',
        name: 'BankNexus',
        agentCount: 5,
        slug: 'banknexus',
        createdAt: '',
        updatedAt: '',
        sessionCount: 0,
      },
    ],
    currentProjectId: 'p1',
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('SidebarExpanded', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  test('renders project list with names', () => {
    renderWithProviders(<SidebarExpanded onCollapse={() => {}} />);
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText('BankNexus')).toBeInTheDocument();
  });

  test('active project has visual indicator', () => {
    renderWithProviders(<SidebarExpanded onCollapse={() => {}} />);
    const activeItem = screen.getByText('Customer Service').closest('button');
    expect(activeItem?.className).toMatch(/bg-/);
  });

  test('clicking project navigates', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SidebarExpanded onCollapse={() => {}} />);
    await user.click(screen.getByText('BankNexus'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p2');
  });

  test('collapse button calls onCollapse', async () => {
    const onCollapse = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SidebarExpanded onCollapse={onCollapse} />);
    await user.click(screen.getByRole('button', { name: /collapse/i }));
    expect(onCollapse).toHaveBeenCalled();
  });

  test('renders header with Projects label', () => {
    renderWithProviders(<SidebarExpanded onCollapse={() => {}} />);
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });
});
