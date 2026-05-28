'use client';

import { memo, useState } from 'react';
import { clsx } from 'clsx';
import {
  ChevronsLeft,
  ChevronsRight,
  Bot,
  Wrench,
  Globe,
  Code,
  Plug,
  Monitor,
  User,
  GitBranch,
  Repeat,
  Clock,
  Square,
  ClipboardEdit,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { springs } from '../../../../lib/animation';
import type { NodeType, NodeCategory } from '@agent-platform/shared-kernel/types';
import {
  NODE_DISPLAY_NAMES,
  NODE_COLOR_MAP,
  NODE_CATEGORY_MAP,
  STUB_NODE_TYPES,
  HIDDEN_NODE_TYPES,
} from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

// =============================================================================
// Icon mapping for sidebar nodes
// =============================================================================

const NODE_SIDEBAR_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  agent: Bot,
  tool: Wrench,
  api: Globe,
  function: Code,
  integration: Plug,
  browser: Monitor,
  human: User,
  data_entry: ClipboardEdit,
  condition: GitBranch,
  loop: Repeat,
  delay: Clock,
  end: Square,
};

// =============================================================================
// Category definitions (maps to AgentEditorMenu "menu groups")
// =============================================================================

interface NodeGroup {
  id: string;
  label: string;
  nodeTypes: NodeType[];
}

const NODE_GROUPS: NodeGroup[] = [
  { id: 'agent', label: 'Agent', nodeTypes: ['agent'] },
  { id: 'tool', label: 'Tool', nodeTypes: ['tool'] },
  { id: 'action', label: 'Actions', nodeTypes: ['function', 'integration', 'browser'] },
  { id: 'human', label: 'Human', nodeTypes: ['human', 'data_entry'] },
  { id: 'flow', label: 'Flow Control', nodeTypes: ['condition', 'loop', 'delay', 'end'] },
];

// =============================================================================
// Sidebar widths — mirrors AgentEditorMenu config
// =============================================================================

const SIDEBAR_WIDTH = 200;
const SIDEBAR_COLLAPSED_WIDTH = 56;

// =============================================================================
// Draggable node item — mirrors AgentEditorMenu renderMenuItem
// =============================================================================

interface NodeItemProps {
  nodeType: NodeType;
  collapsed: boolean;
}

function NodeItem({ nodeType, collapsed }: NodeItemProps) {
  const isStub = STUB_NODE_TYPES.includes(nodeType);
  const isHidden = HIDDEN_NODE_TYPES.includes(nodeType);
  const Icon = NODE_SIDEBAR_ICON[nodeType];
  const addNode = useWorkflowCanvasStore((s) => s.addNode);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);

  if (isHidden) return null;

  const handleAdd = () => {
    if (isStub) return;
    if (nodes.length === 0) {
      addNode(nodeType, { x: 320, y: 220 });
      return;
    }
    const rightmost = nodes.reduce(
      (best, n) => (n.position.x > best.position.x ? n : best),
      nodes[0],
    );
    addNode(nodeType, { x: rightmost.position.x + 240, y: rightmost.position.y });
  };

  return (
    <div
      className={clsx(
        'w-full flex items-center rounded-md text-sm font-medium transition-default',
        isStub ? 'cursor-not-allowed' : 'cursor-pointer',
        collapsed ? 'justify-center px-0 py-0.5' : 'gap-2.5 px-2 py-1',
        'text-muted hover:text-foreground hover:bg-background-muted',
        isStub && 'opacity-60',
      )}
      role="button"
      tabIndex={isStub ? -1 : 0}
      onClick={handleAdd}
      onKeyDown={(e) => {
        if (isStub) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleAdd();
        }
      }}
      draggable={!isStub}
      onDragStart={(e) => {
        if (isStub) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('application/workflow-node', nodeType);
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={collapsed ? NODE_DISPLAY_NAMES[nodeType] : undefined}
      data-testid={`asset-${nodeType}`}
    >
      <span
        className={clsx(
          'shrink-0 flex items-center justify-center',
          collapsed ? 'w-7 h-7' : 'w-5 h-5',
        )}
      >
        {Icon ? (
          <Icon className="w-4 h-4 text-subtle" />
        ) : (
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: NODE_COLOR_MAP[nodeType] }}
          />
        )}
      </span>
      {!collapsed && (
        <>
          <span className="truncate">{NODE_DISPLAY_NAMES[nodeType]}</span>
          {isStub && (
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-foreground-muted/10 text-foreground-muted whitespace-nowrap">
              Soon
            </span>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// AssetsSidebar — mirrors AgentEditorMenu layout
// =============================================================================

function AssetsSidebarInner() {
  const [collapsed, setCollapsed] = useState(false);

  const renderGroup = (group: NodeGroup) => {
    const visibleTypes = group.nodeTypes.filter((nt) => !HIDDEN_NODE_TYPES.includes(nt));
    if (visibleTypes.length === 0) return null;

    return (
      <div key={group.id} className="space-y-0.5">
        {!collapsed && (
          <div className="px-2 pt-2 pb-0.5">
            <span className="text-xs font-medium uppercase tracking-wider text-foreground-muted">
              {group.label}
            </span>
          </div>
        )}
        {visibleTypes.map((nt) => (
          <NodeItem key={nt} nodeType={nt} collapsed={collapsed} />
        ))}
      </div>
    );
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      transition={springs.gentle}
      className="h-full flex flex-col sidebar-bg border-r border-default overflow-hidden shrink-0"
      data-testid="assets-sidebar"
    >
      {/* Scrollable navigation */}
      <nav
        className={clsx(
          'flex-1 overflow-y-auto',
          collapsed ? 'px-2 pt-1 space-y-1.5' : 'px-2 pt-1 space-y-1.5',
        )}
      >
        {NODE_GROUPS.map(renderGroup)}
      </nav>

      {/* Bottom — Collapse toggle */}
      <div
        className={clsx(
          'py-2 border-t border-default',
          collapsed ? 'px-2 space-y-1' : 'px-2 space-y-0.5',
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'w-full flex items-center rounded-md text-sm text-subtle hover:text-foreground hover:bg-background-muted transition-default',
            collapsed ? 'justify-center px-0 py-1' : 'gap-2.5 px-2 py-1.5',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-testid="assets-sidebar-toggle"
        >
          <span
            className={clsx(
              'shrink-0 flex items-center justify-center',
              collapsed ? 'w-7 h-7' : 'w-5 h-5',
            )}
          >
            {collapsed ? (
              <ChevronsRight className="w-4 h-4" />
            ) : (
              <ChevronsLeft className="w-4 h-4" />
            )}
          </span>
          {!collapsed && <span className="truncate">Collapse</span>}
        </button>
      </div>
    </motion.aside>
  );
}

export const AssetsSidebar = memo(AssetsSidebarInner);
