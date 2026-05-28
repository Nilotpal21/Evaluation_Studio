'use client';

import { Lock, Package, FlaskConical } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { ImportedTool } from '../../hooks/useImportedSymbols';

interface ImportedToolCardProps {
  tool: ImportedTool;
  onClick: () => void;
  onTest?: () => void;
}

export function ImportedToolCard({ tool, onClick, onTest }: ImportedToolCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="rounded-2xl border border-default bg-background-elevated p-4 cursor-pointer card-hover group hover:border-accent/40 transition-colors"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-base font-semibold truncate flex-1">
          {tool.alias}.{tool.name}
        </h3>
        <Lock className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        {tool.toolType && (
          <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {tool.toolType}
          </span>
        )}
        <Badge variant="purple" appearance="outlined" className="text-[10px]">
          Imported
        </Badge>
        {onTest && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTest();
            }}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-accent hover:text-accent/80 flex items-center gap-1"
            title="Test tool"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            Test
          </button>
        )}
      </div>

      {/* Description */}
      <p className="text-sm text-muted line-clamp-2 min-h-[2.5rem]">
        {tool.description ?? (
          <span className="italic text-subtle">Imported from module dependency</span>
        )}
      </p>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-default flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-1.5">
          <Package className="w-3.5 h-3.5" />
          <span className="truncate">{tool.moduleProjectName}</span>
        </div>
        {tool.resolvedVersion && <span>v{tool.resolvedVersion}</span>}
      </div>
    </div>
  );
}
