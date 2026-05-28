'use client';

/**
 * ConnectToExistingSection
 *
 * Bottom-most section of the HandlePlusMenu modal. Lets the user route the
 * current source handle to an existing downstream canvas node instead of
 * creating a new one. The eligibility list is computed via
 * `getEligibleConnectTargets`, which composes the same three guards
 * `onConnect` applies — so the picker can never present an option the store
 * would reject.
 *
 * Layout mirrors the Add-new tab: each distinct node TYPE on the canvas
 * gets its own section (e.g. END, AGENT, FUNCTION), and within each
 * section the eligible nodes render as 3-column cards using the same
 * visual treatment as Add-new's node-type cards.
 *
 * The click handler calls `onConnect` directly; no new store action exists.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { NodeType } from '@agent-platform/shared-kernel/types';
import { NODE_DISPLAY_NAMES, NODE_CATEGORY_MAP } from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore, MAX_FAN_OUT } from '../../../../store/workflow-canvas-store';
import { getEligibleConnectTargets } from '../../../../store/workflow-canvas-helpers';
import type { WorkflowFlowNode } from '../../../../store/workflow-canvas-store';
import { STEP_ICON_MAP, CATEGORY_ORDER, MENU_NODE_TYPES } from './handlePlusMenuIcons';

interface ConnectToExistingSectionProps {
  sourceNodeId: string;
  sourceHandle: string;
  onClose: () => void;
}

export function ConnectToExistingSection({
  sourceNodeId,
  sourceHandle,
  onClose,
}: ConnectToExistingSectionProps) {
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const onConnect = useWorkflowCanvasStore((s) => s.onConnect);

  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const eligible = useMemo(() => {
    const raw = getEligibleConnectTargets(nodes, edges, sourceNodeId, sourceHandle, MAX_FAN_OUT);
    // Sort alphabetically by label (case-insensitive). Falls back to node id
    // so ordering stays deterministic when two nodes share a label.
    return [...raw].sort((a, b) => {
      const aKey = (a.data.label || a.id).toLowerCase();
      const bKey = (b.data.label || b.id).toLowerCase();
      return aKey.localeCompare(bKey);
    });
  }, [nodes, edges, sourceNodeId, sourceHandle]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((n) => {
      const label = (n.data.label || '').toLowerCase();
      const type = String(n.data.nodeType).toLowerCase();
      return label.includes(q) || type.includes(q);
    });
  }, [eligible, query]);

  // Group filtered nodes by node type, then order the resulting type
  // sections per the Add-new tab's canonical type order (categories in
  // CATEGORY_ORDER → types in MENU_NODE_TYPES order within each category).
  // Types present on canvas but not in MENU_NODE_TYPES are appended at
  // the end so nothing silently disappears from the picker.
  const groupedSections = useMemo(() => {
    const groups = new Map<NodeType, WorkflowFlowNode[]>();
    for (const node of filtered) {
      const t = node.data.nodeType as NodeType;
      const list = groups.get(t);
      if (list) list.push(node);
      else groups.set(t, [node]);
    }

    const ordered: { type: NodeType; nodes: WorkflowFlowNode[] }[] = [];
    const seen = new Set<NodeType>();
    for (const cat of CATEGORY_ORDER) {
      for (const t of MENU_NODE_TYPES) {
        if (NODE_CATEGORY_MAP[t] === cat && groups.has(t) && !seen.has(t)) {
          ordered.push({ type: t, nodes: groups.get(t)! });
          seen.add(t);
        }
      }
    }
    // Safety net: include any unknown types on the canvas.
    for (const [t, list] of groups) {
      if (!seen.has(t)) ordered.push({ type: t, nodes: list });
    }
    return ordered;
  }, [filtered]);

  // Flat list of cards in render order — used for keyboard navigation so
  // arrow keys walk through cards across section boundaries.
  const flatOrder = useMemo(() => groupedSections.flatMap((g) => g.nodes), [groupedSections]);

  const handlePick = useCallback(
    (targetNodeId: string) => {
      // Loop containers are picked by the user, but the actual engine
      // target is the loop's internal `loop_start` socket — that's the
      // node `onConnect` expects (and the one the validator's outer→
      // loop_start carve-out allows). Resolve the container to its
      // loop_start child here so the picker UX hides the implementation
      // detail completely.
      const picked = nodes.find((n) => n.id === targetNodeId);
      let resolvedTarget = targetNodeId;
      if (picked?.data.nodeType === 'loop') {
        const loopStart = nodes.find(
          (n) => n.parentId === picked.id && n.data.nodeType === 'loop_start',
        );
        // A loop container must always have a loop_start child (created together
        // by the store). If it is somehow absent, bail out rather than passing
        // the container ID to onConnect, which would create an invalid edge.
        if (!loopStart) return;
        resolvedTarget = loopStart.id;
      }

      onConnect({
        source: sourceNodeId,
        sourceHandle,
        target: resolvedTarget,
        targetHandle: null,
      });
      onClose();
    },
    [onConnect, sourceNodeId, sourceHandle, onClose, nodes],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatOrder.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = focusedIndex === null ? 0 : Math.min(focusedIndex + 1, flatOrder.length - 1);
        setFocusedIndex(next);
        cardRefs.current[next]?.focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = focusedIndex === null ? 0 : Math.max(focusedIndex - 1, 0);
        setFocusedIndex(next);
        cardRefs.current[next]?.focus();
      } else if (e.key === 'Enter' && focusedIndex !== null) {
        e.preventDefault();
        handlePick(flatOrder[focusedIndex].id);
      }
    },
    [flatOrder, focusedIndex, handlePick],
  );

  if (eligible.length === 0) {
    return (
      <div data-testid="connect-to-existing-section">
        <p
          className="text-xs text-foreground-muted py-2 px-1"
          data-testid="connect-to-existing-empty"
        >
          No connectable nodes yet. Add a new step first or build out the flow before joining
          branches.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="connect-to-existing-section" onKeyDown={handleKeyDown}>
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground-muted pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusedIndex(null);
          }}
          placeholder="Search nodes by name or type…"
          className={clsx(
            'w-full rounded-lg border border-default bg-background-subtle text-foreground',
            'placeholder:text-subtle text-sm py-1.5 pl-8 pr-3',
            'transition-default focus:outline-none focus:ring-1',
            'focus:border-border-focus focus:ring-border-focus',
          )}
          data-testid="connect-to-existing-search"
        />
      </div>

      {groupedSections.length === 0 ? (
        <p
          className="text-xs text-foreground-muted py-2 px-1"
          data-testid="connect-to-existing-no-matches"
        >
          No matches.
        </p>
      ) : (
        <div className="space-y-5">
          {(() => {
            // Render every section. We track a flat index across all
            // sections so card refs align with `flatOrder` for keyboard
            // navigation.
            let flatIdx = -1;
            return groupedSections.map(({ type, nodes: typeNodes }) => {
              const Icon = STEP_ICON_MAP[type];
              const typeLabel = NODE_DISPLAY_NAMES[type] ?? String(type);
              return (
                <div key={type} data-testid={`connect-to-existing-group-${type}`}>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                    {typeLabel}
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {typeNodes.map((node) => {
                      flatIdx += 1;
                      const refIdx = flatIdx;
                      const cardLabel = node.data.label || typeLabel;
                      return (
                        <button
                          key={node.id}
                          ref={(el) => {
                            cardRefs.current[refIdx] = el;
                          }}
                          type="button"
                          // Native title attribute — surfaces the full node
                          // name on hover when the label truncates inside
                          // the card. Browsers + screen readers handle it
                          // without needing a Tooltip provider wrap.
                          title={cardLabel}
                          aria-label={cardLabel}
                          className={clsx(
                            'flex items-center gap-3 p-3 rounded-xl border border-default',
                            'text-left transition-all duration-150',
                            'hover:border-accent/50 hover:shadow-md hover:bg-background-muted/50 cursor-pointer',
                            'focus:outline-none focus:border-accent focus:ring-1 focus:ring-border-focus',
                          )}
                          onClick={() => handlePick(node.id)}
                          onFocus={() => setFocusedIndex(refIdx)}
                          data-testid={`connect-to-existing-row-${node.id}`}
                        >
                          <div className="w-9 h-9 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
                            {Icon && <Icon className="w-4.5 h-4.5 text-foreground-muted" />}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground truncate">
                              {cardLabel}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
