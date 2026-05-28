'use client';

import { memo, useCallback, useState, useRef, useEffect } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { Repeat, Layers, Maximize2, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import type { WorkflowNodeData } from '../../../../store/workflow-canvas-store';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { HandlePlusMenu } from './HandlePlusMenu';
import { NodeDeleteButton } from './NodeDeleteButton';

// =============================================================================
// Types
// =============================================================================

type LoopNodeXYType = Node<WorkflowNodeData, 'loop-node'>;

// =============================================================================
// Constants
// =============================================================================

const OUTPUT_HANDLES = [
  { id: 'on_complete', label: 'on complete', isFailure: false },
  { id: 'on_failure', label: 'on failure', isFailure: true },
] as const;

const LOOP_DESCRIPTION: Record<string, string> = {
  sequential:
    'Items are processed one at a time; the current iteration number appears on the active edge.',
  parallel: 'All items start simultaneously; results are collected when all branches finish.',
};

// =============================================================================
// Component
// =============================================================================

function LoopNodeComponentInner({ id, data, selected }: NodeProps<LoopNodeXYType>) {
  const executionOverlay = useWorkflowCanvasStore((s) => s.executionOverlay);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const setExpandedLoopId = useWorkflowCanvasStore((s) => s.setExpandedLoopId);
  const loopIterationData = useWorkflowCanvasStore((s) => s.loopIterationData);
  const selectedLoopIteration = useWorkflowCanvasStore((s) => s.selectedLoopIteration);
  const setSelectedLoopIteration = useWorkflowCanvasStore((s) => s.setSelectedLoopIteration);
  const executionStatus = useWorkflowCanvasStore((s) => s.executionStatus);

  // Read mode/concurrencyLimit from the Zustand store rather than from ReactFlow's
  // data prop. ReactFlow v12 does not re-render node components when only data
  // changes externally (e.g. via updateNodeConfig); it only triggers re-renders
  // on position/selection/dimension changes. Reading these from the store ensures
  // the badge and dropdown condition react immediately to config panel updates.
  const mode = useWorkflowCanvasStore(
    (s) => (s.nodes.find((n) => n.id === id)?.data.config.mode as string) ?? 'sequential',
  );
  const concurrencyLimit = useWorkflowCanvasStore(
    (s) => (s.nodes.find((n) => n.id === id)?.data.config.concurrencyLimit as number) ?? 5,
  );

  const nodeStatus = executionOverlay?.[id];
  const isParallel = mode === 'parallel';

  const iterations = loopIterationData?.[id] ?? null;
  const selectedIdx = selectedLoopIteration[id] ?? (iterations ? iterations.length - 1 : 0);
  const isTerminal = executionStatus
    ? ['completed', 'failed', 'cancelled', 'rejected'].includes(executionStatus)
    : false;

  const setNodeZIndex = useWorkflowCanvasStore((s) => s.setNodeZIndex);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [openBatchIdx, setOpenBatchIdx] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Elevate this node's z-index in the Zustand-controlled nodes array so the
  // dropdown popup paints above sibling body nodes (which come later in the DOM).
  useEffect(() => {
    setNodeZIndex(id, dropdownOpen ? 9999 : 0);
  }, [dropdownOpen, id, setNodeZIndex]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as globalThis.Node)) {
        setDropdownOpen(false);
        setOpenBatchIdx(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const connectedHandles = new Set(edges.filter((e) => e.source === id).map((e) => e.sourceHandle));

  const handleMaximize = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setExpandedLoopId(id);
    },
    [id, setExpandedLoopId],
  );

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      className={clsx(
        'group border rounded-xl',
        selected
          ? 'shadow-lg ring-2 ring-accent border-accent/40'
          : 'shadow-sm hover:shadow-md border-default',
        nodeStatus === 'running' && 'animate-pulse-ring ring-2 ring-accent',
        nodeStatus === 'completed' && 'animate-completion-flash ring-2 ring-success',
        nodeStatus === 'rejected' && 'ring-2 ring-error',
        nodeStatus === 'failed' && 'animate-error-shake ring-2 ring-error',
        nodeStatus === 'cancelled' && 'ring-2 ring-muted opacity-60',
        (nodeStatus === 'skipped' || nodeStatus === 'pending') && 'opacity-50',
      )}
      data-testid={`workflow-node-${id}`}
      data-node-type="loop"
      data-node-name={data.label}
    >
      <NodeDeleteButton nodeId={id} />

      {/* Dark header */}
      <div className="bg-foreground/20 px-3 py-2 flex items-center gap-2 rounded-t-xl">
        <Repeat className="w-3.5 h-3.5 text-foreground/60 shrink-0" />
        <span className="min-w-0 text-xs font-bold text-foreground truncate">{data.label}</span>
        <span
          className={clsx(
            'shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ring-1',
            isParallel
              ? 'bg-purple-subtle text-purple ring-purple/40'
              : 'bg-warning-subtle text-warning-muted ring-warning/40',
          )}
        >
          {isParallel ? <Layers className="w-2.5 h-2.5" /> : <Repeat className="w-2.5 h-2.5" />}
          {isParallel ? 'Parallel' : 'Sequential'}
        </span>
        <button
          onClick={handleMaximize}
          className="ml-auto shrink-0 text-foreground/50 hover:text-foreground transition-colors nodrag"
          title="Expand loop to full view"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body area — ReactFlow renders child nodes (loop_start + body steps) here */}
      <div
        className="absolute inset-0 rounded-b-xl bg-background-subtle pointer-events-none"
        style={{ top: 36 }}
      >
        {/* Description text at bottom of body */}
        <p className="absolute bottom-3 left-4 right-4 text-[11px] text-foreground/50 leading-tight select-none pointer-events-none">
          {LOOP_DESCRIPTION[mode] ?? LOOP_DESCRIPTION.sequential}
        </p>
      </div>

      {/* Iteration dropdown — sits above the body area, top-right of node, above on_complete handle */}
      {iterations && iterations.length > 0 && (!isParallel || isTerminal) && (
        <div
          ref={dropdownRef}
          className="absolute nodrag nopan pointer-events-auto"
          style={{ top: 44, right: 8, zIndex: 20 }}
          data-loop-dropdown="true"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Trigger button */}
          <button
            onClick={() => {
              setDropdownOpen((v) => !v);
              setOpenBatchIdx(null);
            }}
            className={clsx(
              'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors whitespace-nowrap',
              isTerminal
                ? 'bg-background-elevated border-default text-foreground hover:bg-muted cursor-pointer'
                : 'bg-background-elevated border-default text-foreground-muted cursor-default',
            )}
            title={isTerminal ? 'Select iteration to replay' : 'Live execution'}
          >
            {isParallel ? (
              <>
                <Layers className="w-2.5 h-2.5" />
                <span>
                  Batch{' '}
                  {Math.floor(
                    (iterations[selectedIdx]?.currentIndex ?? 0) / Math.max(1, concurrencyLimit),
                  ) + 1}{' '}
                  : Itr {(iterations[selectedIdx]?.currentIndex ?? selectedIdx) + 1}
                </span>
              </>
            ) : (
              <>
                <Repeat className="w-2.5 h-2.5" />
                <span>Itr : {(iterations[selectedIdx]?.currentIndex ?? selectedIdx) + 1}</span>
              </>
            )}
            {isTerminal && <ChevronDown className="w-2.5 h-2.5 ml-0.5" />}
          </button>

          {/* Dropdown menu — opens downward, aligned right */}
          {dropdownOpen && isTerminal && (
            <div
              className="absolute top-full right-0 mt-1 min-w-[90px] rounded-lg border border-default bg-background-elevated shadow-lg overflow-hidden"
              style={{ zIndex: 9999 }}
            >
              <div className="max-h-48 overflow-y-auto">
                {isParallel
                  ? // Parallel: flat list when single batch, otherwise group by batch
                    (() => {
                      const batchCount = Math.ceil(
                        iterations.length / Math.max(1, concurrencyLimit),
                      );
                      if (batchCount === 1) {
                        return iterations.map((it, arrIdx) => (
                          <button
                            key={it.currentIndex}
                            onClick={() => {
                              setSelectedLoopIteration(id, arrIdx);
                              setDropdownOpen(false);
                            }}
                            className={clsx(
                              'w-full text-left px-2 py-1.5 text-[11px] text-foreground hover:bg-muted transition-colors',
                              selectedIdx === arrIdx && 'bg-accent/10 text-accent',
                            )}
                          >
                            Itr : {it.currentIndex + 1}
                          </button>
                        ));
                      }
                      return Array.from({ length: batchCount }, (_, bIdx) => {
                        const bStart = bIdx * concurrencyLimit;
                        const batchItems = iterations.filter(
                          (it) =>
                            it.currentIndex >= bStart &&
                            it.currentIndex < bStart + concurrencyLimit,
                        );
                        return (
                          <div key={bIdx}>
                            <button
                              onClick={() => setOpenBatchIdx(openBatchIdx === bIdx ? null : bIdx)}
                              className="w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-foreground-muted hover:bg-muted transition-colors"
                            >
                              <span>Batch {bIdx + 1}</span>
                              <ChevronDown
                                className={clsx(
                                  'w-3 h-3 transition-transform',
                                  openBatchIdx === bIdx && 'rotate-180',
                                )}
                              />
                            </button>
                            {openBatchIdx === bIdx &&
                              batchItems.map((it) => {
                                const arrIdx = iterations.findIndex(
                                  (i) => i.currentIndex === it.currentIndex,
                                );
                                return (
                                  <button
                                    key={it.currentIndex}
                                    onClick={() => {
                                      setSelectedLoopIteration(id, arrIdx);
                                      setDropdownOpen(false);
                                      setOpenBatchIdx(null);
                                    }}
                                    className={clsx(
                                      'w-full text-left px-3 py-1 text-[11px] text-foreground hover:bg-muted transition-colors',
                                      selectedIdx === arrIdx && 'bg-accent/10 text-accent',
                                    )}
                                  >
                                    Itr : {it.currentIndex + 1}
                                  </button>
                                );
                              })}
                          </div>
                        );
                      });
                    })()
                  : // Sequential: flat list
                    iterations.map((it, arrIdx) => (
                      <button
                        key={it.currentIndex}
                        onClick={() => {
                          setSelectedLoopIteration(id, arrIdx);
                          setDropdownOpen(false);
                        }}
                        className={clsx(
                          'w-full text-left px-2 py-1.5 text-[11px] text-foreground hover:bg-muted transition-colors',
                          selectedIdx === arrIdx && 'bg-accent/10 text-accent',
                        )}
                      >
                        Itr : {it.currentIndex + 1}
                      </button>
                    ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Right-side output — single rectangle, upper half green / lower half red */}
      <div className="absolute right-0 inset-y-0 z-[10] flex items-center pointer-events-none">
        <div className="relative pointer-events-auto translate-x-1/2 overflow-visible">
          {/* Upper half — on_complete; z-[2] ensures its tooltip paints above the lower half */}
          <div className="relative z-[2] w-8 py-3 rounded-t-md border-t-2 border-l-2 border-r-2 border-default bg-background-elevated">
            <div className="absolute right-0 top-1/2 h-3.5 w-3.5 translate-x-1/2 -translate-y-1/2 pointer-events-auto">
              <HandlePlusMenu
                nodeId={id}
                handleId="on_complete"
                isFailure={false}
                isConnected={connectedHandles.has('on_complete')}
                wrapperClassName="h-full w-full"
                handleClassName="!absolute !left-1/2 !top-1/2 !-translate-x-1/2 !-translate-y-1/2"
                useNativeHandlePositioning
              />
            </div>
          </div>
          {/* Lower half — on_failure */}
          <div className="relative z-[1] w-8 py-3 rounded-b-md border-b-2 border-l-2 border-r-2 border-default bg-background-elevated">
            <div className="absolute right-0 top-1/2 h-3.5 w-3.5 translate-x-1/2 -translate-y-1/2 pointer-events-auto">
              <HandlePlusMenu
                nodeId={id}
                handleId="on_failure"
                isFailure={true}
                isConnected={connectedHandles.has('on_failure')}
                wrapperClassName="h-full w-full"
                handleClassName="!absolute !left-1/2 !top-1/2 !-translate-x-1/2 !-translate-y-1/2"
                useNativeHandlePositioning
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const LoopNodeComponent = memo(LoopNodeComponentInner);
