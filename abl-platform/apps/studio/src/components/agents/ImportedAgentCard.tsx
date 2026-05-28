'use client';

import { Bot, Lock, Package } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { ImportedAgent } from '../../hooks/useImportedSymbols';

interface ImportedAgentCardProps {
  agent: ImportedAgent;
  onClick: () => void;
}

export function ImportedAgentCard({ agent, onClick }: ImportedAgentCardProps) {
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
      className="rounded-xl border border-default bg-background-elevated p-5 cursor-pointer card-hover group focus-ring hover:border-accent/40 transition-colors"
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-accent/10">
          <Bot className="w-5 h-5 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">
              {agent.alias}.{agent.name}
            </span>
            <Lock className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Badge variant="purple" appearance="outlined" className="text-[10px]">
              Imported
            </Badge>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-muted my-3" />

      <p className="text-sm text-muted line-clamp-2 min-h-[2.625rem]">
        {agent.description ? (
          <span>{agent.description}</span>
        ) : (
          <span className="italic text-subtle">Imported from module dependency</span>
        )}
      </p>

      {/* Footer */}
      <div className="border-t border-muted mt-3 pt-3 flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-1.5">
          <Package className="w-3.5 h-3.5" />
          <span className="truncate">{agent.moduleProjectName}</span>
        </div>
        {agent.resolvedVersion && <span>v{agent.resolvedVersion}</span>}
      </div>
    </div>
  );
}
