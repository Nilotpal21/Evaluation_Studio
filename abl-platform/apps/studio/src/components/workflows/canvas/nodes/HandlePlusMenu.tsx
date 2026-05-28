'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Plus, Search, Link2, PlusSquare } from 'lucide-react';
import { clsx } from 'clsx';
import type { NodeType, NodeCategory } from '@agent-platform/shared-kernel/types';
import {
  NODE_DISPLAY_NAMES,
  NODE_CATEGORY_MAP,
  STUB_NODE_TYPES,
} from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { Dialog } from '../../../ui/Dialog';
import { Tabs } from '../../../ui/Tabs';
import { STEP_ICON_MAP, CATEGORY_ORDER, MENU_NODE_TYPES } from './handlePlusMenuIcons';
import { ConnectToExistingSection } from './ConnectToExistingSection';

// =============================================================================
// Constants
// =============================================================================

/** Category labels */
const CATEGORY_LABELS: Partial<Record<NodeCategory, string>> = {
  action: 'Actions',
  agent: 'AI & Agents',
  tool: 'Tools',
  flow_control: 'Flow Control',
  human_in_loop: 'Human',
};

/** Group menu node types by category */
function groupByCategory(): Map<NodeCategory, NodeType[]> {
  const groups = new Map<NodeCategory, NodeType[]>();
  for (const nt of MENU_NODE_TYPES) {
    const cat = NODE_CATEGORY_MAP[nt];
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(nt);
  }
  return groups;
}

const NODE_GROUPS = groupByCategory();

// =============================================================================
// Props
// =============================================================================

interface HandlePlusMenuProps {
  nodeId: string;
  handleId: string;
  isFailure: boolean;
  isConnected?: boolean;
  /** Node types to hide from the add-step menu (e.g. ['loop'] inside a loop body) */
  blockedTypes?: NodeType[];
  wrapperClassName?: string;
  handleClassName?: string;
  hideIdleVisual?: boolean;
  suppressHoverVisuals?: boolean;
  useNativeHandlePositioning?: boolean;
}

// Drag threshold in pixels
const DRAG_THRESHOLD = 5;

// =============================================================================
// Component
// =============================================================================

export function HandlePlusMenu({
  nodeId,
  handleId,
  isFailure,
  isConnected,
  blockedTypes,
  wrapperClassName,
  handleClassName,
  hideIdleVisual = false,
  suppressHoverVisuals = false,
  useNativeHandlePositioning = false,
}: HandlePlusMenuProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [addNewQuery, setAddNewQuery] = useState('');
  const addNode = useWorkflowCanvasStore((s) => s.addNode);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);

  // Always open to "Add new" — reset whenever the modal closes. Also drop
  // the search query so it doesn't carry over to the next invocation.
  const closeMenu = useCallback(() => {
    setOpen(false);
    setTab('new');
    setAddNewQuery('');
  }, []);

  // Filter the categorised node-type list by the search query. Categories
  // with zero matching types disappear; everything is visible when query
  // is empty.
  const filteredGroups = useMemo(() => {
    const q = addNewQuery.trim().toLowerCase();
    return CATEGORY_ORDER.map((cat) => {
      const allTypes = NODE_GROUPS.get(cat) ?? [];
      const types = allTypes.filter((nt) => {
        if (blockedTypes?.includes(nt)) return false;
        if (!q) return true;
        const label = NODE_DISPLAY_NAMES[nt]?.toLowerCase() ?? '';
        return label.includes(q) || String(nt).toLowerCase().includes(q);
      });
      return { cat, types };
    }).filter((g) => g.types.length > 0);
  }, [addNewQuery, blockedTypes]);

  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

  const handleSelect = useCallback(
    (nodeType: NodeType) => {
      const sourceNode = nodes.find((n) => n.id === nodeId);
      const position = sourceNode
        ? {
            x: sourceNode.position.x + 250,
            y: sourceNode.position.y,
          }
        : undefined;

      addNode(nodeType, position, { nodeId, handleId });
      closeMenu();
    },
    [addNode, nodeId, handleId, nodes, closeMenu],
  );

  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;
    const dx = Math.abs(e.clientX - mouseDownPos.current.x);
    const dy = Math.abs(e.clientY - mouseDownPos.current.y);
    mouseDownPos.current = null;

    if (dx >= DRAG_THRESHOLD || dy >= DRAG_THRESHOLD) {
      isDragging.current = true;
      return;
    }
    setOpen((prev) => !prev);
  }, []);

  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <>
      <div
        className={clsx('relative group/handle', wrapperClassName)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleTriggerClick}
        data-testid={`handle-plus-${handleId}`}
        aria-label={`Add node after ${handleId}`}
      >
        {/* The ReactFlow Handle — circle port */}
        <Handle
          type="source"
          position={Position.Right}
          id={handleId}
          className={clsx(
            !useNativeHandlePositioning && '!relative !transform-none !top-auto !right-auto',
            '!w-3.5 !h-3.5 !rounded-full',
            '!transition-all !duration-200 !ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            suppressHoverVisuals
              ? '!bg-transparent !border-0 !scale-100'
              : hovered || open
                ? isFailure
                  ? '!bg-error !scale-[1.6] !border-0'
                  : '!bg-accent !scale-[1.6] !border-0'
                : isFailure
                  ? '!bg-error !border-0'
                  : '!bg-foreground-muted !border-0',
            !suppressHoverVisuals && (hovered || open) && 'animate-handle-glow-ring',
            hideIdleVisual && !(hovered || open) && '!bg-transparent !border-0',
            handleClassName,
          )}
          style={
            useNativeHandlePositioning
              ? undefined
              : {
                  position: 'relative',
                  transform: 'none',
                  top: 'auto',
                }
          }
        />
        {/* Inner dot — visible when connected and idle */}
        {isConnected && !(hovered || open) && !hideIdleVisual && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className={clsx('w-1.5 h-1.5 rounded-full', isFailure ? 'bg-white' : 'bg-black')}
            />
          </div>
        )}
        {/* Plus icon overlay — appears on hover (fan-out always allowed) */}
        <div
          className={clsx(
            'absolute inset-0 flex items-center justify-center pointer-events-none',
            'transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            hovered || open ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
          )}
        >
          <Plus className="w-2.5 h-2.5 text-accent-foreground" strokeWidth={3} />
        </div>
        {/* Hover hint */}
        {hovered && !open && (
          <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 pointer-events-none animate-handle-hint-in">
            <div className="whitespace-nowrap rounded-md bg-foreground text-background px-2.5 py-1.5 text-[11px] font-medium shadow-md">
              {isConnected ? (
                <>
                  <span>Add branch</span>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span>Drag to connect</span>
                </>
              ) : (
                <>
                  <span>Click to add</span>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span>Drag to connect</span>
                </>
              )}
            </div>
            <div className="absolute left-1/2 -translate-x-1/2 -top-1 w-2 h-2 rotate-45 bg-foreground" />
          </div>
        )}
      </div>

      {/* Add Step Modal */}
      <Dialog open={open} onClose={closeMenu} title="Add Step" maxWidth="lg">
        <div className="space-y-4" data-testid="handle-plus-menu">
          {/* Tab bar — uses the shared Tabs component for icon + underline
              indicator, matching the workflow detail page tab pattern. */}
          <Tabs
            tabs={[
              {
                id: 'new',
                label: 'Add new',
                icon: <PlusSquare className="w-4 h-4" />,
                testid: 'add-step-tab-new',
              },
              {
                id: 'existing',
                label: 'Add existing',
                icon: <Link2 className="w-4 h-4" />,
                testid: 'add-step-tab-existing',
              },
            ]}
            activeTab={tab}
            onTabChange={(id) => setTab(id as 'new' | 'existing')}
            layoutId="add-step-tab-indicator"
          />

          {/* Tab content. Fixed min-height so the modal does not collapse
              when switching to "Add existing" — both tabs must keep the
              same overall popup size. */}
          <div className="min-h-[480px]">
            {tab === 'existing' ? (
              <ConnectToExistingSection
                sourceNodeId={nodeId}
                sourceHandle={handleId}
                onClose={closeMenu}
              />
            ) : (
              <div className="space-y-4">
                {/* Search input — filters the categorised node-type list by
                    label or type, mirroring the Add existing tab's search. */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground-muted pointer-events-none" />
                  <input
                    type="text"
                    value={addNewQuery}
                    onChange={(e) => setAddNewQuery(e.target.value)}
                    placeholder="Search node types…"
                    className={clsx(
                      'w-full rounded-lg border border-default bg-background-subtle text-foreground',
                      'placeholder:text-subtle text-sm py-1.5 pl-8 pr-3',
                      'transition-default focus:outline-none focus:ring-1',
                      'focus:border-border-focus focus:ring-border-focus',
                    )}
                    data-testid="add-new-search"
                  />
                </div>

                {filteredGroups.length === 0 ? (
                  <p
                    className="text-xs text-foreground-muted py-2 px-1"
                    data-testid="add-new-no-matches"
                  >
                    No matches.
                  </p>
                ) : (
                  <div className="space-y-5">
                    {filteredGroups.map(({ cat, types }) => (
                      <div key={cat}>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                          {CATEGORY_LABELS[cat] ?? cat}
                        </div>
                        <div className="grid grid-cols-3 gap-2.5">
                          {types.map((nt) => {
                            const Icon = STEP_ICON_MAP[nt];
                            const isStub = STUB_NODE_TYPES.includes(nt);
                            return (
                              <button
                                key={nt}
                                type="button"
                                className={clsx(
                                  'flex items-center gap-3 p-3 rounded-xl border border-default',
                                  'text-left transition-all duration-150',
                                  isStub
                                    ? 'opacity-40 cursor-not-allowed'
                                    : 'hover:border-accent/50 hover:shadow-md hover:bg-background-muted/50 cursor-pointer',
                                )}
                                onClick={() => !isStub && handleSelect(nt)}
                                disabled={isStub}
                                data-testid={`plus-menu-${nt}`}
                              >
                                <div className="w-9 h-9 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
                                  {Icon && <Icon className="w-4.5 h-4.5 text-foreground-muted" />}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground truncate">
                                    {NODE_DISPLAY_NAMES[nt]}
                                  </div>
                                  {isStub && (
                                    <span className="text-[10px] text-foreground-muted">
                                      Coming soon
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
