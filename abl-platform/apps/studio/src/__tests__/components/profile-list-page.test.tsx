import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileListPage } from '@/components/profiles/ProfileListPage';
import { useProfileStore } from '@/store/profile-store';
import { PageHeaderProvider, usePageHeaderState } from '@/contexts/PageHeaderContext';

const mockNavigate = vi.fn();
const mockListBehaviorProfiles = vi.fn();

vi.mock('@/store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      projectId: 'proj-1',
      navigate: mockNavigate,
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('@/api/behavior-profiles', () => ({
  listBehaviorProfiles: (...args: unknown[]) => mockListBehaviorProfiles(...args),
}));

function HeaderActionsProbe() {
  const { actions } = usePageHeaderState();
  return <div data-testid="header-actions">{actions}</div>;
}

function renderPage() {
  return render(
    <PageHeaderProvider>
      <HeaderActionsProbe />
      <ProfileListPage />
    </PageHeaderProvider>,
  );
}

describe('ProfileListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProfileStore.setState({
      profiles: [],
      loading: false,
      error: null,
      selectedProfile: null,
    });

    mockListBehaviorProfiles.mockResolvedValue([
      {
        name: 'voice/vip',
        priority: 5,
        whenExpression: 'channel == "voice"',
        dslContent: 'BEHAVIOR_PROFILE: voice/vip',
        overrideCategories: ['conversation'],
        usedByAgents: ['Concierge'],
        updatedAt: '2026-04-23T10:00:00.000Z',
      },
    ]);
  });

  it('encodes profile names when opening a card', async () => {
    renderPage();

    await waitFor(() => {
      expect(mockListBehaviorProfiles).toHaveBeenCalledWith('proj-1');
    });

    fireEvent.click(await screen.findByText('voice/vip'));

    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/profiles/voice%2Fvip');
  });

  it('uses a reserved create route segment for new profiles', async () => {
    renderPage();

    fireEvent.click((await screen.findByText('New Profile')).closest('button')!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/profiles/__new__');
  });
});
