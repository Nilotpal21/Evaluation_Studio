'use client';

import React, { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ZoomIn, ZoomOut, Maximize2, LayoutGrid, Map, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';

interface CanvasControlsProps {
  onResetLayout?: () => void;
  errorCount?: number;
  showLegend?: boolean;
  onToggleLegend?: () => void;
}

export function CanvasControls({
  onResetLayout,
  errorCount = 0,
  showLegend = true,
  onToggleLegend,
}: CanvasControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div
      className={clsx(
        'absolute top-3 right-3 z-40',
        'flex items-center gap-1.5 px-2 py-1.5',
        'bg-background-elevated/90 backdrop-blur-sm',
        'border border-default rounded-lg shadow-sm',
      )}
    >
      {errorCount > 0 && (
        <>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-warning-subtle text-warning">
            <AlertTriangle className="w-3 h-3" />
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
          <div className="w-px h-4 bg-border" />
        </>
      )}

      {onResetLayout && (
        <ToolbarButton
          onClick={() => {
            onResetLayout();
            setTimeout(() => fitView({ padding: 0.15, maxZoom: 1.2 }), 100);
          }}
          label="Auto-layout"
          icon={<LayoutGrid className="w-3.5 h-3.5" />}
        />
      )}

      {onToggleLegend && (
        <ToolbarButton
          onClick={onToggleLegend}
          label="Toggle legend"
          icon={<Map className="w-3.5 h-3.5" />}
          active={showLegend}
        />
      )}

      <div className="w-px h-4 bg-border" />

      <ToolbarButton
        onClick={() => zoomOut()}
        label="Zoom out"
        icon={<ZoomOut className="w-3.5 h-3.5" />}
      />
      <ToolbarButton
        onClick={() => zoomIn()}
        label="Zoom in"
        icon={<ZoomIn className="w-3.5 h-3.5" />}
      />
      <ToolbarButton
        onClick={() => fitView({ padding: 0.15, maxZoom: 1.2 })}
        label="Fit to view"
        icon={<Maximize2 className="w-3.5 h-3.5" />}
      />
    </div>
  );
}

function ToolbarButton({
  onClick,
  label,
  icon,
  active,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'p-1.5 rounded-md transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus/50',
        active
          ? 'bg-accent-subtle text-accent'
          : 'text-foreground-muted hover:text-foreground hover:bg-background-muted',
      )}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}
