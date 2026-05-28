import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '../../components/layout/Sidebar';
import { TooltipProvider } from '../../components/ui/Tooltip';

vi.mock('@/store/navigation-store', () => ({
  useNavigationStore: () => ({ navigate: vi.fn() }),
}));
vi.mock('@/store/project-store', () => ({
  useProjectStore: () => ({ projects: [], currentProjectId: null }),
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('Sidebar', () => {
  test('renders collapsed by default (icon rail visible)', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  test('expands on toggle click showing project list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sidebar />);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });

  test('collapses back to icon rail', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sidebar />);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('Projects')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /collapse/i }));
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });
});
