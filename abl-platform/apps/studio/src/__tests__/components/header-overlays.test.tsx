/**
 * Header Overlay Component Tests
 *
 * Tests for slide-over/overlay wrappers: VersionsSlideOver, DslEditorOverlay, ChatSlideOver.
 * These are structural shells that provide animated slide-over panels around placeholder content.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('lucide-react', () => {
  const icon = ({ className, ...props }: Record<string, unknown>) => (
    <span data-testid="icon" className={className as string} {...props} />
  );
  return {
    X: icon,
    GitBranch: icon,
    Code2: icon,
    MessageSquare: icon,
    Save: icon,
    Check: icon,
    Loader2: icon,
    ArrowUpCircle: icon,
    ArrowRight: icon,
    GitCompare: icon,
    RefreshCw: icon,
    ChevronDown: icon,
    ChevronRight: icon,
    Wrench: icon,
    Plus: icon,
    Minus: icon,
  };
});

vi.mock('framer-motion', () => {
  const motion = new Proxy(
    {},
    {
      get: (_target, prop) => {
        // Return a forwardRef component for every motion.* tag
        return React.forwardRef(({ children, ...props }: any, ref: any) =>
          React.createElement(prop as string, { ...props, ref }, children),
        );
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => children,
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn() }),
    useMotionValue: (init: number) => ({ get: () => init, set: vi.fn() }),
    useTransform: () => ({ get: () => 0 }),
  };
});

vi.mock('@/lib/animation', () => ({
  springs: {
    snappy: { type: 'spring', stiffness: 500, damping: 30 },
    default: { type: 'spring', stiffness: 400, damping: 30 },
    gentle: { type: 'spring', stiffness: 300, damping: 30 },
    soft: { type: 'spring', stiffness: 200, damping: 20 },
  },
  transitions: {
    pageEnter: { duration: 0.2 },
    stageSlide: { duration: 0.25 },
    backdrop: { duration: 0.15 },
    iconSwap: { duration: 0.15 },
  },
  EASE_SPRING: [0.22, 1, 0.36, 1],
  STAGGER_DELAY: 0.05,
}));

vi.mock('@/components/abl/ABLEditor', () => ({
  ABLEditor: ({ className }: { className?: string }) => (
    <div data-testid="abl-editor" className={className}>
      Monaco Editor
    </div>
  ),
}));

vi.mock('next/dynamic', () => ({
  default: () => {
    // Return the already-mocked ABLEditor directly
    return ({ className }: { className?: string }) =>
      React.createElement('div', { 'data-testid': 'abl-editor', className }, 'Monaco Editor');
  },
}));

vi.mock('@/store/editor-store', () => ({
  useEditorStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        setOriginalContent: vi.fn(),
        dslContent: '',
        isDirty: false,
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        dslContent: '',
        markSaved: vi.fn(),
        setSaveError: vi.fn(),
      }),
    },
  ),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../components/agents/VersionListTab', () => ({
  VersionListTab: ({ projectId, agentName }: { projectId: string; agentName: string }) => (
    <div data-testid="version-list-tab">Version list for {agentName}</div>
  ),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { VersionsSlideOver } from '../../components/agent-detail/VersionsSlideOver';
import { DslEditorOverlay } from '../../components/agent-detail/DslEditorOverlay';
import { ChatSlideOver } from '../../components/agent-detail/ChatSlideOver';

// =============================================================================
// VersionsSlideOver
// =============================================================================

describe('VersionsSlideOver', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    projectId: 'proj-1',
    agentName: 'booking_agent',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true', () => {
    render(<VersionsSlideOver {...defaultProps} />);
    expect(screen.getByText('Versions')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    render(<VersionsSlideOver {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Versions')).not.toBeInTheDocument();
  });

  it('renders close button', () => {
    render(<VersionsSlideOver {...defaultProps} />);
    expect(screen.getByLabelText('Close versions panel')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<VersionsSlideOver {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close versions panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<VersionsSlideOver {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('versions-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders version list tab inside panel', () => {
    render(<VersionsSlideOver {...defaultProps} />);
    expect(screen.getByTestId('version-list-tab')).toBeInTheDocument();
  });
});

// =============================================================================
// DslEditorOverlay
// =============================================================================

describe('DslEditorOverlay', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    projectId: 'proj-1',
    agentName: 'booking_agent',
    dsl: 'AGENT booking_agent {}',
    onSaved: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true', () => {
    render(<DslEditorOverlay {...defaultProps} />);
    // i18n key: t('title') with namespace 'agents.dsl_editor' → 'ABL™ Editor'
    expect(screen.getByText('ABL™ Editor')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    render(<DslEditorOverlay {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('ABL™ Editor')).not.toBeInTheDocument();
  });

  it('renders close button', () => {
    render(<DslEditorOverlay {...defaultProps} />);
    expect(screen.getByLabelText('Close ABL editor')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<DslEditorOverlay {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close ABL editor'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<DslEditorOverlay {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('dsl-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders ABLEditor when open', () => {
    render(<DslEditorOverlay {...defaultProps} />);
    expect(screen.getByTestId('abl-editor')).toBeInTheDocument();
  });
});

// =============================================================================
// ChatSlideOver
// =============================================================================

describe('ChatSlideOver', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true', () => {
    render(<ChatSlideOver {...defaultProps} />);
    // i18n key: t('title') with namespace 'agents.chat_slide_over' → 'Chat'
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    render(<ChatSlideOver {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
  });

  it('renders close button', () => {
    render(<ChatSlideOver {...defaultProps} />);
    expect(screen.getByLabelText('Close chat panel')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ChatSlideOver {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close chat panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<ChatSlideOver {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('chat-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows placeholder content for chat panel', () => {
    render(<ChatSlideOver {...defaultProps} />);
    // i18n key: t('placeholder') → 'Chat panel will be mounted here.'
    expect(screen.getByText('Chat panel will be mounted here.')).toBeInTheDocument();
  });
});
