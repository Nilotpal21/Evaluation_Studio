/**
 * AgentEditorBanners Component Tests
 *
 * Tests for the contextual banner stack between the editor header and body.
 * Covers compile errors, lock status, and stale tool warnings.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock the useStaleToolCheck hook — this must be declared before the component import
vi.mock('../../hooks/useStaleToolCheck', () => ({
  getStaleToolCheckKey: vi.fn((projectId: string | null, agentName: string | null) =>
    projectId && agentName ? ['stale-tool-check', projectId, agentName] : null,
  ),
  revalidateStaleToolCheck: vi.fn().mockResolvedValue(undefined),
  useStaleToolCheck: vi.fn().mockReturnValue({
    staleTools: [],
    deletedTools: [],
    newTools: [],
    isLoading: false,
    error: null,
  }),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { AgentEditorBanners } from '../../components/agent-editor/AgentEditorBanners';
import { useStaleToolCheck } from '../../hooks/useStaleToolCheck';

// =============================================================================
// HELPERS
// =============================================================================

const defaultProps = {
  compileErrors: [] as string[],
  gatherCompatibilityWarnings: [] as string[],
  flowCompatibilityWarnings: [] as string[],
  agentName: 'booking_agent',
  projectId: 'proj-1',
};

function renderBanners(overrides: Partial<Parameters<typeof AgentEditorBanners>[0]> = {}) {
  return render(<AgentEditorBanners {...defaultProps} {...overrides} />);
}

// =============================================================================
// TESTS: EMPTY STATE
// =============================================================================

describe('AgentEditorBanners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the stale tool mock to default (no stale tools)
    vi.mocked(useStaleToolCheck).mockReturnValue({
      staleTools: [],
      deletedTools: [],
      newTools: [],
      isLoading: false,
      error: null,
    });
  });

  describe('Empty state', () => {
    it('renders nothing when no errors and no lock', () => {
      const { container } = renderBanners();
      // The component returns null when nothing to show
      expect(container.innerHTML).toBe('');
    });

    it('renders nothing when compileErrors is empty and lockedBy is undefined', () => {
      const { container } = renderBanners({
        compileErrors: [],
        lockedBy: undefined,
      });
      expect(container.innerHTML).toBe('');
    });
  });

  // ===========================================================================
  // COMPILE ERROR BANNER
  // ===========================================================================

  describe('Compile error banner', () => {
    it('shows compile error banner when compileErrors is non-empty', () => {
      renderBanners({
        compileErrors: ['Syntax error at line 5'],
      });
      expect(screen.getByText(/ABL 1 compilation error/)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText(/Syntax error at line 5/)).toBeInTheDocument();
    });

    it('shows the first error message in the banner summary', () => {
      renderBanners({
        compileErrors: ['First error', 'Second error', 'Third error'],
      });
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText(/First error/)).toBeInTheDocument();
    });

    it('shows error count when multiple errors exist', () => {
      renderBanners({
        compileErrors: ['Error 1', 'Error 2', 'Error 3'],
      });
      expect(screen.getByText(/ABL 3 compilation errors/)).toBeInTheDocument();
    });

    it('does not show error count button for a single error', () => {
      renderBanners({
        compileErrors: ['Only error'],
      });
      expect(screen.queryByText(/more/)).not.toBeInTheDocument();
    });

    it('expands to show additional errors when count button is clicked', () => {
      renderBanners({
        compileErrors: ['Error 1', 'Error 2', 'Error 3'],
      });
      fireEvent.click(screen.getByText('Show'));
      // Additional errors should now be visible
      expect(screen.getByText('Error 2')).toBeInTheDocument();
      expect(screen.getByText('Error 3')).toBeInTheDocument();
    });

    it('toggles expansion text to "Hide" when expanded', () => {
      renderBanners({
        compileErrors: ['Error 1', 'Error 2'],
      });
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText('Hide')).toBeInTheDocument();
    });

    it('collapses back when Hide button is clicked', () => {
      renderBanners({
        compileErrors: ['Error 1', 'Error 2', 'Error 3'],
      });
      // Expand
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText('Error 2')).toBeInTheDocument();

      // Collapse
      fireEvent.click(screen.getByText('Hide'));
      expect(screen.queryByText('Error 2')).not.toBeInTheDocument();
    });

    it('shows dismiss button for compile errors', () => {
      renderBanners({
        compileErrors: ['Some error'],
      });
      expect(screen.getByLabelText('Dismiss ABL issues')).toBeInTheDocument();
    });

    it('hides compile error banner when dismiss is clicked', () => {
      renderBanners({
        compileErrors: ['Some error'],
      });
      fireEvent.click(screen.getByLabelText('Dismiss ABL issues'));
      expect(screen.queryByText(/ABL 1 compilation error/)).not.toBeInTheDocument();
    });

    it('shows AlertCircle icon in error banner', () => {
      renderBanners({
        compileErrors: ['Some error'],
      });
      expect(document.querySelector('.lucide-alert-circle')).toBeInTheDocument();
    });

    it('shows compile warnings without the failure banner copy', () => {
      renderBanners({
        compileErrors: [],
        compileWarnings: ['booking: Tool resolution warning'],
      } as any);

      expect(screen.getByText(/ABL 1 compilation warning/i)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText(/Tool resolution warning/)).toBeInTheDocument();
      expect(screen.queryByText(/ABL compilation failed/)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // GATHER COMPATIBILITY WARNING BANNER
  // ===========================================================================

  describe('Gather compatibility warning banner', () => {
    it('shows a warning when visual gather editing would be lossy', () => {
      renderBanners({
        gatherCompatibilityWarnings: [
          'contact_info: PII_TYPE is not preserved by the visual editor yet.',
        ],
      });

      expect(screen.getByText(/1 gather field.*view-only/i)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText(/PII_TYPE/i)).toBeInTheDocument();
    });

    it('shows an open ABL button when a callback is provided', () => {
      const onOpenDsl = vi.fn();
      renderBanners({
        gatherCompatibilityWarnings: ['contact_info: PII_TYPE is not preserved yet.'],
        onOpenDsl,
      });

      fireEvent.click(screen.getByText('Open ABL'));
      expect(onOpenDsl).toHaveBeenCalledTimes(1);
    });

    it('expands additional gather compatibility messages', () => {
      renderBanners({
        gatherCompatibilityWarnings: [
          'Field one warning',
          'Field two warning',
          'Field three warning',
        ],
      });

      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText('Field two warning')).toBeInTheDocument();
      expect(screen.getByText('Field three warning')).toBeInTheDocument();
    });
  });

  describe('Flow compatibility warning banner', () => {
    it('shows a warning when visual flow editing would be lossy', () => {
      renderBanners({
        flowCompatibilityWarnings: ['choose: ON_ACTION is not preserved by the visual editor yet.'],
      });

      expect(screen.getByText(/1 flow step.*view-only/i)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText(/ON_ACTION/i)).toBeInTheDocument();
    });

    it('expands additional flow compatibility messages', () => {
      renderBanners({
        flowCompatibilityWarnings: ['Flow warning one', 'Flow warning two', 'Flow warning three'],
      });

      fireEvent.click(screen.getByText('Show'));
      expect(screen.getByText('Flow warning two')).toBeInTheDocument();
      expect(screen.getByText('Flow warning three')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // LOCK STATUS BANNER
  // ===========================================================================

  describe('Lock status banner', () => {
    it('shows lock warning when lockedBy is provided', () => {
      renderBanners({ lockedBy: 'alice@example.com' });
      expect(screen.getByText(/Being edited by/)).toBeInTheDocument();
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    it('shows lock user name in banner', () => {
      renderBanners({ lockedBy: 'Bob Smith' });
      expect(screen.getByText(/Bob Smith/)).toBeInTheDocument();
    });

    it('shows Lock icon in lock banner', () => {
      renderBanners({ lockedBy: 'alice@example.com' });
      expect(document.querySelector('.lucide-lock')).toBeInTheDocument();
    });

    it('does not show lock banner when lockedBy is undefined', () => {
      renderBanners({ lockedBy: undefined });
      expect(screen.queryByText(/being edited by/)).not.toBeInTheDocument();
    });

    it('does not show lock banner when lockedBy is empty string', () => {
      renderBanners({ lockedBy: '' });
      expect(screen.queryByText(/being edited by/)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // STALE TOOL WARNING BANNER
  // ===========================================================================

  describe('Stale tool warning banner', () => {
    it('shows stale tool banner when stale tools detected', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      expect(screen.getByText(/Tools may be outdated/)).toBeInTheDocument();
    });

    it('shows tool change count in stale tool banner', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [{ name: 'old-tool', projectToolId: 'pt-2' }],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText(/changed since last compile/)).toBeInTheDocument();
    });

    it('uses singular "tool" when only 1 tool changed', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText(/changed since last compile/)).toBeInTheDocument();
    });

    it('shows Recompile button when onRecompile is provided', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners({ onRecompile: vi.fn() });
      expect(screen.getByText('Recompile')).toBeInTheDocument();
    });

    it('calls onRecompile when Recompile button is clicked', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      const onRecompile = vi.fn();
      renderBanners({ onRecompile });
      fireEvent.click(screen.getByText('Recompile'));
      expect(onRecompile).toHaveBeenCalledTimes(1);
    });

    it('does not show Recompile button when onRecompile is not provided', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      expect(screen.queryByText('Recompile')).not.toBeInTheDocument();
    });

    it('shows dismiss button for stale tool banner', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      expect(screen.getByLabelText('Dismiss stale tool warning')).toBeInTheDocument();
    });

    it('hides stale tool banner when dismiss is clicked', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners();
      fireEvent.click(screen.getByLabelText('Dismiss stale tool warning'));
      expect(screen.queryByText(/Tools may be outdated/)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // NEW TOOL NOTICE BANNER
  // ===========================================================================

  describe('New tool notice banner', () => {
    it('directs users to attach new project tools instead of recompiling', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [],
        deletedTools: [],
        newTools: [
          {
            name: 'lookup_customer',
            projectToolId: 'pt-new',
          },
        ],
        isLoading: false,
        error: null,
      });

      renderBanners({ onRecompile: vi.fn() });

      expect(screen.getByText(/1 new tool available/)).toBeInTheDocument();
      expect(screen.getByText(/attach to this agent to include/)).toBeInTheDocument();
      expect(screen.queryByText('Recompile')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // MULTIPLE BANNERS
  // ===========================================================================

  describe('Multiple banners', () => {
    it('shows both compile error and lock banners simultaneously', () => {
      renderBanners({
        compileErrors: ['Parse error'],
        lockedBy: 'alice@example.com',
      });
      expect(screen.getByText(/ABL 1 compilation error/)).toBeInTheDocument();
      expect(screen.getByText(/Being edited by/)).toBeInTheDocument();
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    it('shows all three banners when all conditions are met', () => {
      vi.mocked(useStaleToolCheck).mockReturnValue({
        staleTools: [
          {
            name: 'search',
            projectToolId: 'pt-1',
            snapshotHash: 'abc',
            currentHash: 'def',
            toolType: 'function',
          },
        ],
        deletedTools: [],
        newTools: [],
        isLoading: false,
        error: null,
      });

      renderBanners({
        compileErrors: ['Error in line 3'],
        lockedBy: 'bob@example.com',
        onRecompile: vi.fn(),
      });

      expect(screen.getByText(/ABL 1 compilation error/)).toBeInTheDocument();
      expect(screen.getByText(/Tools may be outdated/)).toBeInTheDocument();
      expect(screen.getByText(/Being edited by/)).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    });
  });
});
