import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarRail } from '../../components/layout/SidebarRail';
import { TooltipProvider } from '../../components/ui/Tooltip';

const mockNavigate = vi.fn();
vi.mock('@/store/navigation-store', () => ({
  useNavigationStore: () => ({ navigate: mockNavigate }),
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('SidebarRail', () => {
  test('renders new chat, projects, and expand buttons', () => {
    renderWithProviders(<SidebarRail onExpand={() => {}} />);
    expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /projects/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  test('arch logo click navigates to home', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SidebarRail onExpand={() => {}} />);
    await user.click(screen.getByRole('button', { name: /new chat/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  test('expand button calls onExpand', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SidebarRail onExpand={onExpand} />);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    expect(onExpand).toHaveBeenCalled();
  });

  test('projects button calls onExpand by default', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SidebarRail onExpand={onExpand} />);
    await user.click(screen.getByRole('button', { name: /projects/i }));
    expect(onExpand).toHaveBeenCalled();
  });

  test('projects button calls onProjectsClick when provided', async () => {
    const onExpand = vi.fn();
    const onProjectsClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SidebarRail onExpand={onExpand} onProjectsClick={onProjectsClick} />);
    await user.click(screen.getByRole('button', { name: /projects/i }));
    expect(onProjectsClick).toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });
});
