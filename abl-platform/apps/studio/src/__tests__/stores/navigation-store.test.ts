/**
 * Navigation Store Tests
 *
 * Comprehensive tests for the navigation store: URL parsing, route matching,
 * breadcrumb generation, and navigation actions (navigate, goBack, setTab).
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

// Mock project-store so breadcrumb generation can resolve project names
vi.mock('../../store/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      projects: [
        {
          id: 'proj-1',
          name: 'My Project',
          slug: 'my-project',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
          agentCount: 3,
          sessionCount: 10,
        },
        {
          id: 'proj-2',
          name: 'Another Project',
          slug: 'another-project',
          createdAt: '2025-02-01',
          updatedAt: '2025-02-01',
          agentCount: 1,
          sessionCount: 5,
        },
      ],
    })),
  },
}));

// Spy on window.history methods
const pushStateSpy = vi.spyOn(window.history, 'pushState');
const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
const backSpy = vi.spyOn(window.history, 'back');

// Static import — vi.mock() calls above are hoisted, so mocks are applied before this loads.
import { useNavigationStore } from '../../store/navigation-store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

// =============================================================================
// TESTS
// =============================================================================

describe('Navigation Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushStateSpy.mockImplementation(() => {});
    replaceStateSpy.mockImplementation(() => {});
    backSpy.mockImplementation(() => {});

    // Reset to initial state (root URL)
    useNavigationStore.setState({
      area: 'projects',
      projectId: null,
      page: null,
      subPage: null,
      tab: null,
      subSection: null,
      breadcrumbs: [{ label: 'Projects', path: '/' }],
    });
    useArchAIStore.getState().reset();
  });

  // ===========================================================================
  // 1. INITIAL STATE
  // ===========================================================================

  describe('Initial state', () => {
    test('defaults to projects area with no project context', () => {
      const state = useNavigationStore.getState();

      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
      expect(state.page).toBeNull();
      expect(state.subPage).toBeNull();
      expect(state.tab).toBeNull();
    });

    test('has breadcrumbs array with at least the root crumb', () => {
      const state = useNavigationStore.getState();

      expect(state.breadcrumbs).toBeDefined();
      expect(Array.isArray(state.breadcrumbs)).toBe(true);
      expect(state.breadcrumbs.length).toBeGreaterThanOrEqual(1);
    });

    test('exposes navigate, goBack, and setTab actions', () => {
      const state = useNavigationStore.getState();

      expect(typeof state.navigate).toBe('function');
      expect(typeof state.goBack).toBe('function');
      expect(typeof state.setTab).toBe('function');
    });
  });

  // ===========================================================================
  // 2. navigate() — URL PARSING FOR ALL ROUTE PATTERNS
  // ===========================================================================

  describe('navigate() — route parsing', () => {
    // -------------------------------------------------------------------------
    // Root: / -> area: 'projects'
    // -------------------------------------------------------------------------
    describe('root route (/)', () => {
      test('parses / as area: projects', () => {
        useNavigationStore.getState().navigate('/');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('projects');
        expect(state.projectId).toBeNull();
        expect(state.page).toBeNull();
        expect(state.subPage).toBeNull();
        expect(state.tab).toBeNull();
      });

      test('calls history.pushState with the path', () => {
        useNavigationStore.getState().navigate('/');

        expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/');
      });
    });

    // -------------------------------------------------------------------------
    // Project agents list: /projects/:id/agents -> area: 'project', page: 'agents'
    // -------------------------------------------------------------------------
    describe('/projects/:id/agents', () => {
      test('parses project agents route correctly', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/agents');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('agents');
        expect(state.subPage).toBeNull();
        expect(state.tab).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // Specific agent: /projects/:id/agents/:agentName
    // -> area: 'project', page: 'agents', subPage: ':agentName'
    // -------------------------------------------------------------------------
    describe('/projects/:id/agents/:agentName', () => {
      test('parses agent detail route with subPage', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('agents');
        expect(state.subPage).toBe('booking-agent');
        expect(state.tab).toBeNull();
      });

      test('handles agent names with hyphens and numbers', () => {
        useNavigationStore.getState().navigate('/projects/proj-2/agents/agent-v2-test');

        const state = useNavigationStore.getState();
        expect(state.subPage).toBe('agent-v2-test');
      });

      test('ignores hash fragments when parsing agent detail routes', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent#tools');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('agents');
        expect(state.subPage).toBe('booking-agent');
        expect(state.tab).toBeNull();
        expect(pushStateSpy).toHaveBeenCalledWith(
          {},
          '',
          '/projects/proj-1/agents/booking-agent#tools',
        );
      });
    });

    // -------------------------------------------------------------------------
    // Sessions list: /projects/:id/sessions -> page: 'sessions'
    // -------------------------------------------------------------------------
    describe('/projects/:id/sessions', () => {
      test('parses sessions page correctly', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/sessions');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('sessions');
        expect(state.subPage).toBeNull();
      });
    });

    describe('/projects/:id/billing', () => {
      test('parses project billing page correctly', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/billing');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('billing');
        expect(state.subPage).toBeNull();
        expect(state.tab).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // Session detail: /projects/:id/sessions/:sessionId
    // -> page: 'sessions', subPage: ':sessionId'
    // -------------------------------------------------------------------------
    describe('/projects/:id/sessions/:sessionId', () => {
      test('parses session detail with subPage', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/sessions/sess-abc-123');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('sessions');
        expect(state.subPage).toBe('sess-abc-123');
      });

      test('handles UUID-style session IDs', () => {
        useNavigationStore
          .getState()
          .navigate('/projects/proj-1/sessions/f47ac10b-58cc-4372-a567-0e02b2c3d479');

        const state = useNavigationStore.getState();
        expect(state.subPage).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
      });
    });

    // -------------------------------------------------------------------------
    // Deployments: /projects/:id/deployments -> page: 'deployments'
    // -------------------------------------------------------------------------
    describe('/projects/:id/deployments', () => {
      test('parses deployments page correctly', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/deployments');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('deployments');
        expect(state.subPage).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // Settings: /projects/:id/settings -> page: 'settings'
    // -------------------------------------------------------------------------
    describe('/projects/:id/settings', () => {
      test('bare /settings defaults to settings-members page', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('settings-members');
        expect(state.subPage).toBeNull();
      });

      test('/settings/members parses as settings-members', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/members');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('settings-members');
        expect(state.subPage).toBeNull();
      });

      test('/settings/api-keys parses as settings-api-keys', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/api-keys');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-api-keys');
      });

      test('/settings/models parses as settings-models', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/models');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-models');
      });

      test('/settings/config-vars parses as settings-config-vars', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/config-vars');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-config-vars');
      });

      test('/settings/localization parses as settings-localization', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/localization');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-localization');
      });

      test('/settings/git parses as settings-git', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/git');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-git');
      });

      test('/settings/advanced parses as settings-advanced', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/advanced');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-advanced');
      });

      test('/settings/runtime-config parses as settings-runtime-config', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/runtime-config');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-runtime-config');
      });

      test('/settings/trace-dimensions parses as settings-trace-dimensions', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/trace-dimensions');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-trace-dimensions');
      });

      test('/settings/agent-transfer parses as settings-agent-transfer', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/agent-transfer');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-agent-transfer');
      });

      test('/settings/modules parses as settings-modules', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/modules');

        const state = useNavigationStore.getState();
        expect(state.page).toBe('settings-modules');
      });

      test('/settings/unknown-sub falls through as settings with subPage', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/settings/unknown-sub');

        const state = useNavigationStore.getState();
        // Unknown sub-page is not mapped, falls through to generic parsing
        expect(state.page).toBe('settings');
        expect(state.subPage).toBe('unknown-sub');
      });
    });

    // -------------------------------------------------------------------------
    // Project root (no page specified): defaults page to 'overview'
    // -------------------------------------------------------------------------
    describe('/projects/:id (no page)', () => {
      test('defaults page to overview when no page segment provided', () => {
        useNavigationStore.getState().navigate('/projects/proj-1');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('overview');
        expect(state.subPage).toBeNull();
      });

      test('closes the in-project Arch overlay when entering a project from /arch', () => {
        useNavigationStore.setState({
          area: 'arch',
          projectId: null,
          page: null,
          subPage: null,
          tab: null,
          subSection: null,
          breadcrumbs: [{ label: 'Arch', path: '/arch' }],
        });
        useArchAIStore.getState().setOverlayState('artifacts');
        useArchAIStore.getState().addTab({
          type: 'topology',
          label: 'Topology',
          data: { agents: [] },
          toolCallId: 'topology-1',
        });

        useNavigationStore.getState().navigate('/projects/proj-1');

        expect(useArchAIStore.getState().overlayState).toBe('closed');
        expect(useArchAIStore.getState().artifactTabs).toHaveLength(0);
      });
    });

    // -------------------------------------------------------------------------
    // Admin routes: /admin/members, /admin/models, /admin/security
    // -> area: 'admin'
    // -------------------------------------------------------------------------
    describe('admin routes', () => {
      test('/admin/members parses as admin area with members page', () => {
        useNavigationStore.getState().navigate('/admin/members');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('admin');
        expect(state.projectId).toBeNull();
        expect(state.page).toBe('members');
        expect(state.subPage).toBeNull();
      });

      test('/admin/models parses as admin area with models page', () => {
        useNavigationStore.getState().navigate('/admin/models');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('admin');
        expect(state.page).toBe('models');
      });

      test('/admin/security parses as admin area with security page', () => {
        useNavigationStore.getState().navigate('/admin/security');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('admin');
        expect(state.page).toBe('security');
      });

      test('/admin defaults page to members', () => {
        useNavigationStore.getState().navigate('/admin');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('admin');
        expect(state.page).toBe('members');
      });

      test('/admin/security/details parses subPage', () => {
        useNavigationStore.getState().navigate('/admin/security/details');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('admin');
        expect(state.page).toBe('security');
        expect(state.subPage).toBe('details');
      });
    });

    // -------------------------------------------------------------------------
    // Tab parsing: 5th path segment
    // -------------------------------------------------------------------------
    describe('tab segment parsing', () => {
      test('parses 5th segment as tab in project routes', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent/config');

        const state = useNavigationStore.getState();
        expect(state.area).toBe('project');
        expect(state.projectId).toBe('proj-1');
        expect(state.page).toBe('agents');
        expect(state.subPage).toBe('booking-agent');
        expect(state.tab).toBe('config');
      });
    });

    // -------------------------------------------------------------------------
    // history.pushState is called on every navigate
    // -------------------------------------------------------------------------
    describe('pushState integration', () => {
      test('calls pushState for project routes', () => {
        useNavigationStore.getState().navigate('/projects/proj-1/agents');

        expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/projects/proj-1/agents');
      });

      test('calls pushState for admin routes', () => {
        useNavigationStore.getState().navigate('/admin/models');

        expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/admin/models');
      });

      test('calls replaceState when replace navigation is requested', () => {
        useNavigationStore
          .getState()
          .navigate('/projects/proj-1/agents/booking-agent#tools', { replace: true });

        const state = useNavigationStore.getState();
        expect(state.subPage).toBe('booking-agent');
        expect(replaceStateSpy).toHaveBeenCalledWith(
          {},
          '',
          '/projects/proj-1/agents/booking-agent#tools',
        );
        expect(pushStateSpy).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // 3. setTab() ACTION
  // ===========================================================================

  describe('setTab()', () => {
    test('sets tab on current project route', () => {
      // First navigate to a project agent detail
      useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent');

      useNavigationStore.getState().setTab('config');

      const state = useNavigationStore.getState();
      expect(state.tab).toBe('config');
    });

    test('updates URL via history.pushState', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent');
      pushStateSpy.mockClear();

      useNavigationStore.getState().setTab('logs');

      expect(pushStateSpy).toHaveBeenCalled();
      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/projects/proj-1/agents/booking-agent/logs');
    });

    test('clears tab when set to null', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent');
      useNavigationStore.getState().setTab('config');

      expect(useNavigationStore.getState().tab).toBe('config');

      useNavigationStore.getState().setTab(null);

      expect(useNavigationStore.getState().tab).toBeNull();
    });

    test('builds correct path for admin routes when setTab is called', () => {
      useNavigationStore.getState().navigate('/admin/security');

      useNavigationStore.getState().setTab('advanced');

      // Admin buildPath: /admin/${page}${subPage ? /subPage : ''}
      // Tab is not included in admin path construction
      const state = useNavigationStore.getState();
      expect(state.tab).toBe('advanced');
      // pushState was called with the admin path
      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/admin/security');
    });

    test('builds correct path for project route with tab (no subPage)', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions');

      useNavigationStore.getState().setTab('active');

      // buildPath: /projects/proj-1 + /sessions + /active (tab appended)
      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/projects/proj-1/sessions/active');
    });

    test('pushState path includes both subPage and tab', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents/my-agent');

      useNavigationStore.getState().setTab('traces');

      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/projects/proj-1/agents/my-agent/traces');
    });
  });

  // ===========================================================================
  // 4. goBack() ACTION
  // ===========================================================================

  describe('goBack()', () => {
    test('calls window.history.back()', () => {
      useNavigationStore.getState().goBack();

      expect(backSpy).toHaveBeenCalledTimes(1);
    });

    test('does not modify store state directly (relies on popstate event)', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents');

      const stateBefore = useNavigationStore.getState();

      useNavigationStore.getState().goBack();

      // State should remain unchanged until popstate fires
      const stateAfter = useNavigationStore.getState();
      expect(stateAfter.area).toBe(stateBefore.area);
      expect(stateAfter.projectId).toBe(stateBefore.projectId);
      expect(stateAfter.page).toBe(stateBefore.page);
    });

    test('can be called multiple times', () => {
      useNavigationStore.getState().goBack();
      useNavigationStore.getState().goBack();
      useNavigationStore.getState().goBack();

      expect(backSpy).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // 5. BREADCRUMB GENERATION
  // ===========================================================================

  describe('Breadcrumb generation', () => {
    test('root route has single Projects breadcrumb', () => {
      useNavigationStore.getState().navigate('/');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toEqual([{ label: 'Projects', path: '/' }]);
    });

    test('project root includes Projects + Project name breadcrumbs', () => {
      useNavigationStore.getState().navigate('/projects/proj-1');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(2);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'My Project', path: '/projects/proj-1' });
    });

    test('project page with agents includes Agents crumb (overview is default)', () => {
      // overview is the default page and skipped in breadcrumbs; agents gets a crumb
      useNavigationStore.getState().navigate('/projects/proj-1/agents');

      const { breadcrumbs } = useNavigationStore.getState();
      // Projects -> My Project -> Agents
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'My Project', path: '/projects/proj-1' });
      expect(breadcrumbs[2]).toEqual({ label: 'Agents', path: '/projects/proj-1/agents' });
    });

    test('project sessions page includes capitalized page crumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'My Project', path: '/projects/proj-1' });
      expect(breadcrumbs[2]).toEqual({ label: 'Sessions', path: '/projects/proj-1/sessions' });
    });

    test('project billing page includes Billing crumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/billing');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[2]).toEqual({ label: 'Billing', path: '/projects/proj-1/billing' });
    });

    test('project deployments page includes Deployments crumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/deployments');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[2]).toEqual({
        label: 'Deployments',
        path: '/projects/proj-1/deployments',
      });
    });

    test('project settings page defaults to settings-members breadcrumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/settings');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[2]).toEqual({
        label: 'Settings Members',
        path: '/projects/proj-1/settings/members',
      });
    });

    test('localization settings page includes Localization crumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/settings/localization');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[2]).toEqual({
        label: 'Localization',
        path: '/projects/proj-1/settings/localization',
      });
    });

    test('subPage adds a fourth breadcrumb for non-agents pages', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions/sess-123');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(4);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'My Project', path: '/projects/proj-1' });
      expect(breadcrumbs[2]).toEqual({ label: 'Sessions', path: '/projects/proj-1/sessions' });
      expect(breadcrumbs[3]).toEqual({
        label: 'sess-123',
        path: '/projects/proj-1/sessions/sess-123',
      });
    });

    test('agent subPage adds crumb after Agents page crumb', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent');

      const { breadcrumbs } = useNavigationStore.getState();
      // Projects -> My Project -> Agents -> booking-agent
      expect(breadcrumbs).toHaveLength(4);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'My Project', path: '/projects/proj-1' });
      expect(breadcrumbs[2]).toEqual({ label: 'Agents', path: '/projects/proj-1/agents' });
      expect(breadcrumbs[3]).toEqual({
        label: 'booking-agent',
        path: '/projects/proj-1/agents/booking-agent',
      });
    });

    test('resolves project name from project store', () => {
      useNavigationStore.getState().navigate('/projects/proj-2/agents');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[1]).toEqual({ label: 'Another Project', path: '/projects/proj-2' });
    });

    test('falls back to "Project" label when project ID not found in store', () => {
      useNavigationStore.getState().navigate('/projects/unknown-id/agents');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[1]).toEqual({ label: 'Project', path: '/projects/unknown-id' });
    });

    test('admin route breadcrumbs include Projects -> Admin -> page', () => {
      useNavigationStore.getState().navigate('/admin/security');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[0]).toEqual({ label: 'Projects', path: '/' });
      expect(breadcrumbs[1]).toEqual({ label: 'Admin', path: '/admin' });
      expect(breadcrumbs[2]).toEqual({ label: 'Security', path: '/admin/security' });
    });

    test('admin route with members page has Members crumb', () => {
      useNavigationStore.getState().navigate('/admin/members');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[2]).toEqual({ label: 'Members', path: '/admin/members' });
    });

    test('admin route with models page has Models crumb', () => {
      useNavigationStore.getState().navigate('/admin/models');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({ label: 'Models', path: '/admin/models' });
    });

    test('setTab rebuilds breadcrumbs', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/search-ai/kb-123');
      useNavigationStore.getState().setTab('data');
      const { breadcrumbs } = useNavigationStore.getState();
      // Should have breadcrumbs reflecting the current state
      expect(breadcrumbs.length).toBeGreaterThanOrEqual(3);
    });

    test('setSubPageLabel updates breadcrumbs immediately', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/search-ai/kb-123');
      useNavigationStore.getState().setSubPageLabel('My Knowledge Base');
      const { breadcrumbs } = useNavigationStore.getState();
      const kbCrumb = breadcrumbs.find((c) => c.path.includes('kb-123'));
      expect(kbCrumb?.label).toBe('My Knowledge Base');
    });

    test('breadcrumbs are recomputed on every navigate call', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions');
      const crumbs1 = useNavigationStore.getState().breadcrumbs;
      expect(crumbs1).toHaveLength(3);

      useNavigationStore.getState().navigate('/admin/models');
      const crumbs2 = useNavigationStore.getState().breadcrumbs;
      expect(crumbs2).toHaveLength(3);
      expect(crumbs2[1]).toEqual({ label: 'Admin', path: '/admin' });

      useNavigationStore.getState().navigate('/');
      const crumbs3 = useNavigationStore.getState().breadcrumbs;
      expect(crumbs3).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 6. EDGE CASES
  // ===========================================================================

  describe('Edge cases', () => {
    test('empty string path falls back to projects root', () => {
      useNavigationStore.getState().navigate('');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
      expect(state.page).toBeNull();
    });

    test('double slashes are filtered correctly', () => {
      useNavigationStore.getState().navigate('//projects//proj-1//agents//');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.projectId).toBe('proj-1');
      expect(state.page).toBe('agents');
    });

    test('trailing slash is handled', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions/');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.projectId).toBe('proj-1');
      expect(state.page).toBe('sessions');
      expect(state.subPage).toBeNull();
    });

    test('unknown root path falls back to projects area', () => {
      useNavigationStore.getState().navigate('/unknown-path');

      const state = useNavigationStore.getState();
      // Not 'projects', 'admin', or a '/projects/:id' pattern
      // The parser falls through to the default return
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
      expect(state.page).toBeNull();
    });

    test('/projects without an ID falls back to projects root', () => {
      useNavigationStore.getState().navigate('/projects');

      const state = useNavigationStore.getState();
      // parts[0] === 'projects' but parts[1] is undefined, so falls to default
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
    });

    test('deeply nested path beyond tab is ignored (only 5 segments parsed)', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agents/my-agent/config/extra/stuff');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.projectId).toBe('proj-1');
      expect(state.page).toBe('agents');
      expect(state.subPage).toBe('my-agent');
      expect(state.tab).toBe('config');
      // 'extra' and 'stuff' are not captured — only first 5 segments matter
    });

    test('navigate updates state when transitioning between areas', () => {
      // Start in project
      useNavigationStore.getState().navigate('/projects/proj-1/agents');
      expect(useNavigationStore.getState().area).toBe('project');

      // Switch to admin
      useNavigationStore.getState().navigate('/admin/models');
      expect(useNavigationStore.getState().area).toBe('admin');
      expect(useNavigationStore.getState().projectId).toBeNull();

      // Switch back to root
      useNavigationStore.getState().navigate('/');
      expect(useNavigationStore.getState().area).toBe('projects');
    });

    test('navigate clears previous subPage and tab when moving to a route without them', () => {
      // Navigate to deeply nested route
      useNavigationStore.getState().navigate('/projects/proj-1/agents/booking-agent/config');
      expect(useNavigationStore.getState().subPage).toBe('booking-agent');
      expect(useNavigationStore.getState().tab).toBe('config');

      // Navigate to sessions list (no subPage or tab)
      useNavigationStore.getState().navigate('/projects/proj-1/sessions');
      expect(useNavigationStore.getState().subPage).toBeNull();
      expect(useNavigationStore.getState().tab).toBeNull();
    });

    test('special characters in project ID are preserved', () => {
      useNavigationStore.getState().navigate('/projects/proj_special-123/agents');

      const state = useNavigationStore.getState();
      expect(state.projectId).toBe('proj_special-123');
    });

    test('navigate is idempotent (same path produces same state)', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/sessions/sess-1');
      const state1 = { ...useNavigationStore.getState() };

      useNavigationStore.getState().navigate('/projects/proj-1/sessions/sess-1');
      const state2 = useNavigationStore.getState();

      expect(state2.area).toBe(state1.area);
      expect(state2.projectId).toBe(state1.projectId);
      expect(state2.page).toBe(state1.page);
      expect(state2.subPage).toBe(state1.subPage);
      expect(state2.tab).toBe(state1.tab);
    });

    test('path with only slashes falls back to projects root', () => {
      useNavigationStore.getState().navigate('///');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
    });
  });

  // ===========================================================================
  // POPSTATE EVENT HANDLING
  // ===========================================================================

  describe('popstate event handling', () => {
    test('popstate event updates store from window.location.pathname', () => {
      // Navigate to a project route
      useNavigationStore.getState().navigate('/projects/proj-1/agents');

      // Simulate the browser changing the URL (as if user pressed back)
      Object.defineProperty(window, 'location', {
        value: { ...window.location, pathname: '/admin/models' },
        writable: true,
        configurable: true,
      });

      // Fire popstate
      window.dispatchEvent(new PopStateEvent('popstate'));

      const state = useNavigationStore.getState();
      expect(state.area).toBe('admin');
      expect(state.page).toBe('models');
    });
  });

  // ===========================================================================
  // ADDITIONAL PROJECT PAGE ROUTES
  // ===========================================================================

  describe('additional project page routes', () => {
    test('/projects/:id/workflows parses correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/workflows');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('workflows');
    });

    test('/projects/:id/transfer-sessions parses correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/transfer-sessions');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('transfer-sessions');
    });

    test('/projects/:id/module-dependencies parses correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/module-dependencies');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('module-dependencies');
    });

    test('settings sub-page buildPath round-trips correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/settings/agent-transfer');

      const state = useNavigationStore.getState();
      expect(state.page).toBe('settings-agent-transfer');

      // setTab triggers buildPath — verify the URL stays in /settings/ format
      useNavigationStore.getState().setTab(null);
      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/projects/proj-1/settings/agent-transfer');
    });

    test('settings-modules buildPath round-trips correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/settings/modules');

      const state = useNavigationStore.getState();
      expect(state.page).toBe('settings-modules');

      useNavigationStore.getState().setTab(null);
      const pushCall = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1];
      expect(pushCall[2]).toBe('/projects/proj-1/settings/modules');
    });
  });

  // ===========================================================================
  // DEPRECATED PAGE REDIRECTS
  // ===========================================================================

  describe('deprecated page redirects', () => {
    test('/projects/:id/contacts redirects to overview', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/contacts');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('overview');
    });

    test('/projects/:id/observability redirects to overview', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/observability');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('overview');
    });

    test('/projects/:id/traces redirects to sessions with traces tab', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/traces');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('sessions');
      expect(state.tab).toBe('traces');
    });

    test('/projects/:id/analytics stays on the analytics page', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/analytics');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('analytics');
    });

    test('/projects/:id/inbox is a valid page (workflow approvals)', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/inbox');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('inbox');
    });

    test('/projects/:id/profiles is a valid page', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/profiles');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('project');
      expect(state.page).toBe('profiles');
    });

    test('/platform-admin redirects to projects root', () => {
      useNavigationStore.getState().navigate('/platform-admin');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
      expect(state.page).toBeNull();
    });

    test('/platform-admin/provisioned-models redirects to projects root', () => {
      useNavigationStore.getState().navigate('/platform-admin/provisioned-models');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('projects');
      expect(state.projectId).toBeNull();
      expect(state.page).toBeNull();
    });
  });

  // ===========================================================================
  // BREADCRUMB LABEL GENERATION FOR HYPHENATED PAGES
  // ===========================================================================

  describe('breadcrumb labels for hyphenated page names', () => {
    test('agent-performance produces "Agent Performance" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/agent-performance');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Agent Performance',
        path: '/projects/proj-1/agent-performance',
      });
    });

    test('quality-monitor produces "Quality Monitor" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/quality-monitor');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Quality Monitor',
        path: '/projects/proj-1/quality-monitor',
      });
    });

    test('customer-insights produces "Customer Insights" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/customer-insights');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Customer Insights',
        path: '/projects/proj-1/customer-insights',
      });
    });

    test('guardrails-config produces "Guardrails Config" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/guardrails-config');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Guardrails Config',
        path: '/projects/proj-1/guardrails-config',
      });
    });

    test('search-ai produces "Search AI" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/search-ai');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Search AI',
        path: '/projects/proj-1/search-ai',
      });
    });

    test('single-word pages still capitalize correctly', () => {
      useNavigationStore.getState().navigate('/projects/proj-1/governance');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Governance',
        path: '/projects/proj-1/governance',
      });
    });
  });

  // ===========================================================================
  // ADMIN EXTRA PAGES
  // ===========================================================================

  describe('additional admin page routes', () => {
    test('/admin/secrets parses correctly', () => {
      useNavigationStore.getState().navigate('/admin/secrets');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('admin');
      expect(state.page).toBe('secrets');
    });

    test('/admin/billing parses correctly', () => {
      useNavigationStore.getState().navigate('/admin/billing');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('admin');
      expect(state.page).toBe('billing');
    });

    test('/admin/audit-logs parses as the full-screen audit explorer', () => {
      useNavigationStore.getState().navigate('/admin/audit-logs');

      const state = useNavigationStore.getState();
      expect(state.area).toBe('admin');
      expect(state.page).toBe('audit-logs');
    });
  });

  // ===========================================================================
  // ADMIN BREADCRUMB LABELS FOR HYPHENATED PAGES
  // ===========================================================================

  describe('admin breadcrumb labels for hyphenated page names', () => {
    test('analytics-agents produces "Analytics Agents" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/admin/analytics-agents');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Analytics Agents',
        path: '/admin/analytics-agents',
      });
    });

    test('analytics-sessions produces "Analytics Sessions" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/admin/analytics-sessions');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Analytics Sessions',
        path: '/admin/analytics-sessions',
      });
    });

    test('env-vars produces "Env Vars" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/admin/env-vars');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Env Vars',
        path: '/admin/env-vars',
      });
    });

    test('audit-logs produces "Audit Logs" breadcrumb label', () => {
      useNavigationStore.getState().navigate('/admin/audit-logs');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Audit Logs',
        path: '/admin/audit-logs',
      });
    });

    test('single-word admin pages still capitalize correctly', () => {
      useNavigationStore.getState().navigate('/admin/guardrails');

      const { breadcrumbs } = useNavigationStore.getState();
      expect(breadcrumbs[2]).toEqual({
        label: 'Guardrails',
        path: '/admin/guardrails',
      });
    });
  });
});
