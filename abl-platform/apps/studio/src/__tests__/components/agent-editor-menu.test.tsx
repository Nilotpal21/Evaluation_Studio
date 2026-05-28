/**
 * AgentEditorMenu Component Tests
 *
 * Tests for the left sidebar navigation of the unified agent editor.
 * Covers section rendering, active state, dirty indicators, count badges,
 * collapse toggle, agent header, and agent switcher dropdown.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// =============================================================================
// MOCKS
// =============================================================================

// Override the global lucide-react mock to include icons specific to this component
vi.mock('lucide-react', () => {
  const createIcon = (name: string) => {
    const IconComponent = (props: any) => (
      <svg data-testid={`icon-${name.toLowerCase()}`} {...props}>
        <title>{name}</title>
      </svg>
    );
    IconComponent.displayName = name;
    return IconComponent;
  };

  return {
    Sparkles: createIcon('Sparkles'),
    Settings2: createIcon('Settings2'),
    Wrench: createIcon('Wrench'),
    ClipboardList: createIcon('ClipboardList'),
    Brain: createIcon('Brain'),
    GitBranch: createIcon('GitBranch'),
    ShieldCheck: createIcon('ShieldCheck'),
    Shield: createIcon('Shield'),
    UserCog: createIcon('UserCog'),
    ArrowRightLeft: createIcon('ArrowRightLeft'),
    RefreshCw: createIcon('RefreshCw'),
    ArrowUpFromLine: createIcon('ArrowUpFromLine'),
    Play: createIcon('Play'),
    AlertTriangle: createIcon('AlertTriangle'),
    CheckCircle2: createIcon('CheckCircle2'),
    FileText: createIcon('FileText'),
    Code: createIcon('Code'),
    ChevronsLeft: createIcon('ChevronsLeft'),
    ChevronsRight: createIcon('ChevronsRight'),
    PanelLeftClose: createIcon('PanelLeftClose'),
    PanelLeftOpen: createIcon('PanelLeftOpen'),
    ChevronsUpDown: createIcon('ChevronsUpDown'),
    ChevronDown: createIcon('ChevronDown'),
    Bot: createIcon('Bot'),
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { AgentEditorMenu } from '../../components/agent-editor/AgentEditorMenu';
import type { EditorSection, SectionDataMap } from '../../components/agent-editor/types';

// =============================================================================
// HELPERS
// =============================================================================

/** All 17 editor sections */
const ALL_SECTIONS: EditorSection[] = [
  'identity',
  'execution',
  'tools',
  'gather',
  'memory',
  'flow',
  'constraints',
  'guardrails',
  'behavior',
  'handoffs',
  'delegates',
  'escalation',
  'onStart',
  'errorHandling',
  'completion',
  'templates',
  'definition',
];

/** Minimal section data with zeroed counts */
function makeSectionData(overrides: Partial<SectionDataMap> = {}): SectionDataMap {
  return {
    identity: { goal: '', persona: '', limitations: [] },
    execution: {},
    tools: [],
    gather: [],
    memory: {
      sessionVars: [],
      persistentPaths: [],
      rememberTriggers: [],
      recallInstructions: [],
    },
    flow: null,
    constraints: [],
    guardrails: [],
    behavior: { conversationBehavior: undefined, profiles: [] },
    handoffs: [],
    delegates: [],
    escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
    onStart: { calls: [], sets: [], hooks: [], hasOnStart: false },
    errorHandling: [],
    completion: [],
    templates: [],
    definition: '',
    ...overrides,
  };
}

const defaultProps = {
  activeSection: 'identity' as EditorSection,
  onSectionChange: vi.fn(),
  sectionData: makeSectionData(),
  visibleSections: ALL_SECTIONS,
  collapsed: false,
  onToggleCollapse: vi.fn(),
  dirtySections: new Set<EditorSection>(),
};

const TRUNCATED_LABEL_CLIENT_WIDTH = 96;
const CHARACTER_WIDTH = 8;

function installOverflowMeasurements() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('truncate') ? TRUNCATED_LABEL_CLIENT_WIDTH : 240;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return (this.textContent ?? '').length * CHARACTER_WIDTH;
    },
  });
}

function renderMenu(overrides: Partial<Parameters<typeof AgentEditorMenu>[0]> = {}) {
  return render(<AgentEditorMenu {...defaultProps} {...overrides} />);
}

// =============================================================================
// TESTS: SECTION RENDERING
// =============================================================================

describe('AgentEditorMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installOverflowMeasurements();
  });

  describe('Section rendering', () => {
    it('renders all visible sections as menu items', () => {
      renderMenu();
      // Verify each section label is rendered
      expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      expect(screen.getByText('Execution')).toBeInTheDocument();
      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.getByText('Gather Fields')).toBeInTheDocument();
      expect(screen.getByText('Memory')).toBeInTheDocument();
      expect(screen.getByText('Flow Steps')).toBeInTheDocument();
      expect(screen.getByText('Constraints')).toBeInTheDocument();
      expect(screen.getByText('Guardrails')).toBeInTheDocument();
      expect(screen.getByText('Behavior Profiles')).toBeInTheDocument();
      expect(screen.getByText('Handoffs')).toBeInTheDocument();
      expect(screen.getByText('Delegates')).toBeInTheDocument();
      expect(screen.getByText('Escalation')).toBeInTheDocument();
      expect(screen.getByText('On Start')).toBeInTheDocument();
      expect(screen.getByText('Error Handling')).toBeInTheDocument();
      expect(screen.getByText('Completion')).toBeInTheDocument();
      expect(screen.getByText('Templates & Messages')).toBeInTheDocument();
    });

    it('hides sections that are not in visibleSections', () => {
      renderMenu({ visibleSections: ['identity', 'tools'] });
      expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.queryByText('Execution')).not.toBeInTheDocument();
      expect(screen.queryByText('Gather Fields')).not.toBeInTheDocument();
      expect(screen.queryByText('Memory')).not.toBeInTheDocument();
    });

    it('hides an entire group when none of its items are visible', () => {
      // Only show identity items, so Capabilities/Behavior/Coordination/Lifecycle groups hidden
      renderMenu({ visibleSections: ['identity', 'execution'] });
      expect(screen.getByText('Identity')).toBeInTheDocument();
      expect(screen.queryByText('Capabilities')).not.toBeInTheDocument();
      expect(screen.queryByText('Behavior')).not.toBeInTheDocument();
      expect(screen.queryByText('Coordination')).not.toBeInTheDocument();
      expect(screen.queryByText('Lifecycle')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // ACTIVE SECTION
  // ===========================================================================

  describe('Active section', () => {
    it('highlights the active section with accent styling', () => {
      renderMenu({ activeSection: 'tools' });
      const toolsButton = screen.getByText('Tools').closest('button')!;
      expect(toolsButton).toHaveAttribute('aria-current', 'page');
      expect(toolsButton.className).toContain('bg-[hsl(var(--color-brand-active-bg))]');
    });

    it('does not highlight inactive sections with accent styling', () => {
      renderMenu({ activeSection: 'tools' });
      const identityButton = screen.getByText('Goal & Persona').closest('button')!;
      expect(identityButton.className).not.toContain('bg-accent-subtle');
    });

    it('applies border-l-2 to active section', () => {
      renderMenu({ activeSection: 'memory' });
      const memoryButton = screen.getByText('Memory').closest('button')!;
      expect(memoryButton.className).toContain('border-l-2');
      expect(memoryButton.className).toContain('border-[hsl(var(--color-brand-primary))]');
    });
  });

  // ===========================================================================
  // DIRTY INDICATOR
  // ===========================================================================

  describe('Dirty indicator', () => {
    it('shows dirty indicator dot on dirty sections', () => {
      const { container } = renderMenu({
        dirtySections: new Set<EditorSection>(['tools', 'identity']),
      });
      // Dirty indicators are small circles with bg-accent and rounded-full
      const dirtyDots = container.querySelectorAll('.bg-accent.rounded-full');
      // Should have at least 2 dots (one for tools, one for identity)
      expect(dirtyDots.length).toBeGreaterThanOrEqual(2);
    });

    it('does not show dirty indicator on clean sections', () => {
      renderMenu({ dirtySections: new Set<EditorSection>() });
      // Find the icon wrapper spans with position relative
      const toolsButton = screen.getByText('Tools').closest('button')!;
      const iconWrapper = toolsButton.querySelector('.relative');
      // Should not have a dirty dot
      const dirtyDot = iconWrapper?.querySelector('.bg-accent.rounded-full');
      expect(dirtyDot).toBeNull();
    });
  });

  // ===========================================================================
  // SECTION CHANGE CALLBACK
  // ===========================================================================

  describe('Section change', () => {
    it('calls onSectionChange when a section is clicked', () => {
      const onSectionChange = vi.fn();
      renderMenu({ onSectionChange });
      fireEvent.click(screen.getByText('Tools').closest('button')!);
      expect(onSectionChange).toHaveBeenCalledWith('tools');
    });

    it('calls onSectionChange with correct section for each click', () => {
      const onSectionChange = vi.fn();
      renderMenu({ onSectionChange });

      fireEvent.click(screen.getByText('Memory').closest('button')!);
      expect(onSectionChange).toHaveBeenCalledWith('memory');

      fireEvent.click(screen.getByText('Handoffs').closest('button')!);
      expect(onSectionChange).toHaveBeenCalledWith('handoffs');

      fireEvent.click(screen.getByText('On Start').closest('button')!);
      expect(onSectionChange).toHaveBeenCalledWith('onStart');
    });
  });

  // ===========================================================================
  // COUNT BADGES
  // ===========================================================================

  describe('Count badges', () => {
    it('shows count badge for tools when tools exist', () => {
      renderMenu({
        sectionData: makeSectionData({
          tools: [
            { name: 'search', toolType: 'function', source: 'project' },
            { name: 'fetch', toolType: 'function', source: 'project' },
            { name: 'lookup', toolType: 'function', source: 'project' },
          ] as any,
        }),
      });
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows count badge for gather fields', () => {
      renderMenu({
        sectionData: makeSectionData({
          gather: [
            { name: 'email', type: 'string', required: true },
            { name: 'phone', type: 'string', required: false },
          ] as any,
        }),
      });
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('shows count badge for constraints', () => {
      renderMenu({
        sectionData: makeSectionData({
          constraints: [{ rule: 'no-pii' }, { rule: 'max-length' }] as any,
        }),
      });
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('shows count badge for flow steps', () => {
      renderMenu({
        sectionData: makeSectionData({
          flow: {
            steps: [{ name: 'greet' }, { name: 'collect' }, { name: 'confirm' }],
          } as any,
        }),
      });
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('does not show count badge when count is zero', () => {
      const { container } = renderMenu({
        sectionData: makeSectionData({ tools: [] }),
      });
      // The tools button should not contain a badge span with tabular-nums class
      const toolsButton = screen.getByText('Tools').closest('button')!;
      const badge = toolsButton.querySelector('.tabular-nums');
      expect(badge).toBeNull();
    });

    it('shows count badge for escalation triggers', () => {
      renderMenu({
        sectionData: makeSectionData({
          escalation: {
            triggers: [{ when: 'frustrated', reason: 'user upset', priority: 'high' }],
            contextForHuman: [],
            onHumanComplete: [],
          },
        }),
      });
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // COLLAPSE TOGGLE
  // ===========================================================================

  describe('Collapse toggle', () => {
    it('renders collapse toggle button', () => {
      renderMenu();
      expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument();
    });

    it('calls onToggleCollapse when collapse button is clicked', () => {
      const onToggleCollapse = vi.fn();
      renderMenu({ onToggleCollapse });
      fireEvent.click(screen.getByLabelText('Collapse sidebar'));
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });

    it('shows PanelLeftClose icon when expanded', () => {
      renderMenu({ collapsed: false });
      expect(screen.getByTestId('icon-panelleftclose')).toBeInTheDocument();
    });

    it('shows PanelLeftOpen icon when collapsed', () => {
      renderMenu({ collapsed: true });
      expect(screen.getByTestId('icon-panelleftopen')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // COLLAPSED MODE
  // ===========================================================================

  describe('Collapsed mode', () => {
    it('hides section labels when collapsed', () => {
      renderMenu({ collapsed: true });
      expect(screen.queryByText('Goal & Persona')).not.toBeInTheDocument();
      expect(screen.queryByText('Tools')).not.toBeInTheDocument();
      expect(screen.queryByText('Memory')).not.toBeInTheDocument();
    });

    it('hides group labels when collapsed', () => {
      renderMenu({ collapsed: true });
      expect(screen.queryByText('Identity')).not.toBeInTheDocument();
      expect(screen.queryByText('Capabilities')).not.toBeInTheDocument();
      expect(screen.queryByText('Behavior')).not.toBeInTheDocument();
      expect(screen.queryByText('Coordination')).not.toBeInTheDocument();
      expect(screen.queryByText('Lifecycle')).not.toBeInTheDocument();
    });

    it('hides collapse label text when collapsed', () => {
      renderMenu({ collapsed: true });
      expect(screen.queryByText('Collapse')).not.toBeInTheDocument();
    });

    it('still renders icon elements when collapsed', () => {
      renderMenu({ collapsed: true });
      // Icons are still rendered as SVGs with data-testids
      expect(screen.getByTestId('icon-sparkles')).toBeInTheDocument();
      expect(screen.getByTestId('icon-wrench')).toBeInTheDocument();
      expect(screen.getByTestId('icon-brain')).toBeInTheDocument();
    });

    it('sets title attribute on buttons when collapsed for tooltip behavior', () => {
      const { container } = renderMenu({ collapsed: true });
      // Collapsed buttons should have title attributes for hover tooltips
      const buttons = container.querySelectorAll('button[title]');
      const titles = Array.from(buttons).map((b) => b.getAttribute('title'));
      expect(titles).toContain('Goal & Persona');
      expect(titles).toContain('Tools');
      expect(titles).toContain('Memory');
    });

    it('sets title attribute when expanded so truncated labels reveal their full text', () => {
      renderMenu({ collapsed: false });
      const toolsButton = screen.getByText('Tools').closest('button')!;
      const behaviorProfilesButton = screen.getByText('Behavior Profiles').closest('button')!;
      expect(toolsButton).toHaveAttribute('title', 'Tools');
      expect(behaviorProfilesButton).toHaveAttribute('title', 'Behavior Profiles');
    });

    it('reveals the full label in an accessible hover tooltip for truncated expanded items', async () => {
      const user = userEvent.setup();

      renderMenu({ collapsed: false });

      const behaviorProfilesButton = screen.getByText('Behavior Profiles').closest('button')!;
      expect(behaviorProfilesButton.querySelector('.truncate')).toBeInTheDocument();

      await user.hover(behaviorProfilesButton);

      expect(await screen.findByRole('tooltip')).toHaveTextContent('Behavior Profiles');
    });

    it('does not render a hover tooltip for expanded labels that fit', async () => {
      const user = userEvent.setup();

      renderMenu({ collapsed: false });

      const toolsButton = screen.getByText('Tools').closest('button')!;
      expect(toolsButton.querySelector('.truncate')).toBeInTheDocument();

      await user.hover(toolsButton);

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('hides count badges when collapsed', () => {
      renderMenu({
        collapsed: true,
        sectionData: makeSectionData({
          tools: [{ name: 'search', toolType: 'function', source: 'project' }] as any,
        }),
      });
      // Count badge text "1" should not be rendered
      const badges = screen.queryAllByText('1');
      // Filter to tabular-nums badges specifically
      const countBadges = badges.filter((el) => el.className?.includes('tabular-nums'));
      expect(countBadges).toHaveLength(0);
    });
  });

  // ===========================================================================
  // EXPANDED MODE
  // ===========================================================================

  describe('Expanded mode', () => {
    it('shows icons and labels when expanded', () => {
      renderMenu({ collapsed: false });
      expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      expect(screen.getByTestId('icon-sparkles')).toBeInTheDocument();
      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.getByTestId('icon-wrench')).toBeInTheDocument();
    });

    it('shows group labels when expanded', () => {
      renderMenu({ collapsed: false });
      expect(screen.getByText('Identity')).toBeInTheDocument();
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Behavior Profiles')).toBeInTheDocument();
      expect(screen.getByText('Coordination')).toBeInTheDocument();
      expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // AGENT HEADER (PAGE MODE)
  // ===========================================================================

  describe('Agent header in page mode', () => {
    it('shows agent name when agentName is provided and expanded', () => {
      renderMenu({ agentName: 'booking_agent' });
      expect(screen.getByText('booking_agent')).toBeInTheDocument();
      expect(screen.getByText('booking_agent').closest('button')).toHaveAttribute(
        'title',
        'booking_agent',
      );
    });

    it('keeps the compact header focused on the agent name', () => {
      renderMenu({
        agentName: 'booking_agent',
        agentGoal: 'Help users book flights',
      });
      expect(screen.getByText('booking_agent')).toBeInTheDocument();
      expect(screen.queryByText('Help users book flights')).not.toBeInTheDocument();
    });

    it('does not show agent name text when collapsed (shows icon instead)', () => {
      renderMenu({ agentName: 'booking_agent', collapsed: true });
      // The name text is hidden; only the bot icon and a title attribute are shown
      expect(screen.queryByText('booking_agent')).not.toBeInTheDocument();
    });

    it('shows bot icon with title when collapsed and agentName provided', () => {
      const { container } = renderMenu({
        agentName: 'booking_agent',
        collapsed: true,
      });
      const botIconContainer = container.querySelector('[title="booking_agent"]');
      expect(botIconContainer).toBeInTheDocument();
    });

    it('does not render agent header when agentName is not provided', () => {
      const { container } = renderMenu();
      // No bot icon in the header area (there may be bot icons in the switcher area)
      // The specific header area is the first child with px-2 pt-3 pb-2
      expect(screen.queryByText('booking_agent')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // AGENT SWITCHER
  // ===========================================================================

  describe('Agent switcher', () => {
    const agents = [
      { name: 'booking_agent' },
      { name: 'support_agent' },
      { name: 'billing_agent' },
    ];

    it('shows chevron dropdown when agents prop has multiple agents', () => {
      renderMenu({ agentName: 'booking_agent', agents });
      expect(screen.getByTestId('icon-chevronsupdown')).toBeInTheDocument();
    });

    it('does not show chevron when only one agent', () => {
      renderMenu({
        agentName: 'booking_agent',
        agents: [{ name: 'booking_agent' }],
      });
      expect(screen.queryByTestId('icon-chevronsupdown')).not.toBeInTheDocument();
    });

    it('opens dropdown when agent header is clicked with multiple agents', () => {
      renderMenu({ agentName: 'booking_agent', agents });
      // Click on the agent header button
      const headerButton = screen.getByText('booking_agent').closest('button')!;
      fireEvent.click(headerButton);
      // All agent names should appear in dropdown
      expect(screen.getByText('support_agent')).toBeInTheDocument();
      expect(screen.getByText('billing_agent')).toBeInTheDocument();
    });

    it('calls onAgentSwitch when a different agent is selected', () => {
      const onAgentSwitch = vi.fn();
      renderMenu({
        agentName: 'booking_agent',
        agents,
        onAgentSwitch,
      });
      // Open dropdown
      const headerButton = screen.getByText('booking_agent').closest('button')!;
      fireEvent.click(headerButton);
      // Click a different agent
      fireEvent.click(screen.getByText('support_agent'));
      expect(onAgentSwitch).toHaveBeenCalledWith('support_agent');
    });

    it('closes dropdown after selecting an agent', () => {
      const onAgentSwitch = vi.fn();
      renderMenu({
        agentName: 'booking_agent',
        agents,
        onAgentSwitch,
      });
      // Open dropdown
      fireEvent.click(screen.getByText('booking_agent').closest('button')!);
      expect(screen.getByText('support_agent')).toBeInTheDocument();

      // Select an agent
      fireEvent.click(screen.getByText('support_agent'));

      // Dropdown should close — support_agent should only appear once now
      // (the header still shows booking_agent since agentName prop didn't change)
      const supportAgentElements = screen.queryAllByText('support_agent');
      expect(supportAgentElements).toHaveLength(0);
    });

    it('highlights the current agent in the dropdown', () => {
      renderMenu({ agentName: 'booking_agent', agents });
      // Open dropdown
      fireEvent.click(screen.getByText('booking_agent').closest('button')!);

      // Find the booking_agent item in the dropdown
      // There will be two "booking_agent" texts — one in header, one in dropdown
      const allBookingAgentEls = screen.getAllByText('booking_agent');
      // The dropdown item (second occurrence) should have accent styling
      const dropdownItem = allBookingAgentEls[1].closest('button')!;
      expect(dropdownItem.className).toContain('bg-accent-subtle');
      expect(dropdownItem.className).toContain('text-accent');
    });

    it('does not open dropdown when agents has only one entry', () => {
      renderMenu({
        agentName: 'booking_agent',
        agents: [{ name: 'booking_agent' }],
      });
      const headerButton = screen.getByText('booking_agent').closest('button')!;
      fireEvent.click(headerButton);
      // Should not show any dropdown — only one "booking_agent" text
      const allBookingAgentEls = screen.getAllByText('booking_agent');
      expect(allBookingAgentEls).toHaveLength(1);
    });

    it('does not show switcher when agents prop is not provided', () => {
      renderMenu({ agentName: 'booking_agent' });
      expect(screen.queryByTestId('icon-chevronsupdown')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // GROUPS
  // ===========================================================================

  describe('Group labels', () => {
    it('renders all five group labels when expanded', () => {
      renderMenu();
      expect(screen.getByText('Identity')).toBeInTheDocument();
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Behavior')).toBeInTheDocument();
      expect(screen.getByText('Coordination')).toBeInTheDocument();
      expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    });

    it('groups sections correctly under Identity', () => {
      // Only show identity sections
      renderMenu({ visibleSections: ['identity', 'execution'] });
      expect(screen.getByText('Identity')).toBeInTheDocument();
      expect(screen.getByText('Goal & Persona')).toBeInTheDocument();
      expect(screen.getByText('Execution')).toBeInTheDocument();
    });

    it('groups sections correctly under Capabilities', () => {
      renderMenu({ visibleSections: ['tools', 'gather', 'memory'] });
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.getByText('Gather Fields')).toBeInTheDocument();
      expect(screen.getByText('Memory')).toBeInTheDocument();
    });

    it('groups sections correctly under Behavior', () => {
      renderMenu({
        visibleSections: ['flow', 'constraints', 'guardrails', 'behavior'],
      });
      expect(screen.getByText('Behavior')).toBeInTheDocument();
      expect(screen.getByText('Flow Steps')).toBeInTheDocument();
      expect(screen.getByText('Constraints')).toBeInTheDocument();
      expect(screen.getByText('Guardrails')).toBeInTheDocument();
      expect(screen.getByText('Behavior')).toBeInTheDocument();
    });

    it('groups sections correctly under Coordination', () => {
      renderMenu({
        visibleSections: ['handoffs', 'delegates', 'escalation'],
      });
      expect(screen.getByText('Coordination')).toBeInTheDocument();
      expect(screen.getByText('Handoffs')).toBeInTheDocument();
      expect(screen.getByText('Delegates')).toBeInTheDocument();
      expect(screen.getByText('Escalation')).toBeInTheDocument();
    });

    it('groups sections correctly under Lifecycle', () => {
      renderMenu({
        visibleSections: ['onStart', 'errorHandling', 'completion', 'templates'],
      });
      expect(screen.getByText('Lifecycle')).toBeInTheDocument();
      expect(screen.getByText('On Start')).toBeInTheDocument();
      expect(screen.getByText('Error Handling')).toBeInTheDocument();
      expect(screen.getByText('Completion')).toBeInTheDocument();
      expect(screen.getByText('Templates & Messages')).toBeInTheDocument();
    });

    it('renders group labels with uppercase tracking-wider styling', () => {
      const { container } = renderMenu();
      const groupLabels = container.querySelectorAll('.uppercase.tracking-\\[0\\.07em\\]');
      expect(groupLabels.length).toBe(5);
    });
  });
});
