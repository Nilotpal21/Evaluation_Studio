'use client';

import React, { useEffect, useRef } from 'react';
import { X, ArrowUpRight, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';
import { useCanvasSelectionStore } from '../../store/canvas-store';

export function CanvasSidePanel() {
  const { sidePanelContent, closeSidePanel } = useCanvasSelectionStore();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeSidePanel();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSidePanel]);

  if (!sidePanelContent) return null;

  const { type, data } = sidePanelContent;

  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label="Canvas detail panel"
      className={clsx(
        'absolute top-0 right-0 h-full w-[360px] z-50',
        'bg-background border-l border-default',
        'shadow-xl overflow-y-auto',
        'animate-slide-in-right',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-default">
        <h3 className="text-sm font-semibold text-foreground">
          {type === 'edge' ? 'Edge Details' : ((data.name as string) ?? 'Details')}
        </h3>
        <button
          onClick={closeSidePanel}
          className="p-1 rounded-md hover:bg-background-muted transition-colors"
          aria-label="Close panel"
        >
          <X className="w-4 h-4 text-foreground-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {type === 'edge' && <EdgePanelContent data={data} />}
        {type === 'node' && <NodePanelContent data={data} />}
      </div>
    </div>
  );
}

function EdgePanelContent({ data }: { data: Record<string, unknown> }) {
  return (
    <>
      <PanelSection label="Type">
        <span
          className={clsx(
            'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
            data.edgeType === 'handoff' && 'bg-accent-subtle text-accent',
            data.edgeType === 'delegate' && 'bg-background-muted text-foreground-muted',
            data.edgeType === 'escalation' && 'bg-warning-subtle text-warning',
          )}
        >
          {data.edgeType as string}
        </span>
      </PanelSection>

      <PanelSection label="From">
        <span className="flex items-center gap-1 text-sm text-foreground">
          <ArrowRight className="w-3 h-3 text-foreground-muted" />
          {(data.sourceName as string) ?? (data.source as string)}
        </span>
      </PanelSection>

      <PanelSection label="To">
        <span className="flex items-center gap-1 text-sm text-foreground">
          <ArrowUpRight className="w-3 h-3 text-foreground-muted" />
          {(data.targetName as string) ?? (data.target as string)}
        </span>
      </PanelSection>

      {data.condition && (
        <PanelSection label="Condition">
          <p className="text-sm text-foreground-muted">{data.condition as string}</p>
        </PanelSection>
      )}
    </>
  );
}

function NodePanelContent({ data }: { data: Record<string, unknown> }) {
  return (
    <>
      <PanelSection label="Agent">
        <span className="text-sm font-medium text-foreground">{data.name as string}</span>
      </PanelSection>

      {data.executionMode && (
        <PanelSection label="Mode">
          <span className="text-sm text-foreground-muted">{data.executionMode as string}</span>
        </PanelSection>
      )}

      {data.goal && (
        <PanelSection label="Goal">
          <p className="text-sm text-foreground-muted">{data.goal as string}</p>
        </PanelSection>
      )}

      {typeof data.toolCount === 'number' && (
        <PanelSection label="Tools">
          <span className="text-sm text-foreground-muted">{data.toolCount as number} tools</span>
        </PanelSection>
      )}

      {typeof data.stepCount === 'number' && (data.stepCount as number) > 0 && (
        <PanelSection label="Flow Steps">
          <span className="text-sm text-foreground-muted">{data.stepCount as number} steps</span>
        </PanelSection>
      )}
    </>
  );
}

function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="border-b border-default pb-3">{children}</div>
    </div>
  );
}
