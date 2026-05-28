/**
 * ArchSuggestionChips Component
 *
 * Contextual action chips that Arch surfaces proactively.
 * Clicking a chip sends its prompt to Arch.
 */

import React from 'react';
import {
  ShieldAlert,
  AlertTriangle,
  TestTube,
  Zap,
  Sparkles,
  Lock,
  Wrench,
  HeartPulse,
  Network,
  Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ArchSuggestion, SuggestionCategory } from '../../types/arch';

interface ArchSuggestionChipsProps {
  suggestions: ArchSuggestion[];
  onSelect: (suggestion: ArchSuggestion) => void;
  className?: string;
}

const categoryIcons: Record<SuggestionCategory, React.ReactNode> = {
  'error-handling': <AlertTriangle className="w-3 h-3" />,
  escalation: <ShieldAlert className="w-3 h-3" />,
  testing: <TestTube className="w-3 h-3" />,
  optimization: <Zap className="w-3 h-3" />,
  feature: <Sparkles className="w-3 h-3" />,
  security: <Lock className="w-3 h-3" />,
  modify: <Wrench className="w-3 h-3" />,
  health: <HeartPulse className="w-3 h-3" />,
  topology: <Network className="w-3 h-3" />,
  trace: <Search className="w-3 h-3" />,
};

const categoryStyles: Record<SuggestionCategory, string> = {
  'error-handling':
    'border-warning/30 hover:border-warning/50 hover:bg-warning-subtle text-warning',
  escalation: 'border-error/30 hover:border-error/50 hover:bg-error-subtle text-error',
  testing: 'border-info/30 hover:border-info/50 hover:bg-info-subtle text-info',
  optimization: 'border-accent/30 hover:border-accent/50 hover:bg-accent-subtle text-accent',
  feature: 'border-purple/30 hover:border-purple/50 hover:bg-purple-subtle text-purple',
  security: 'border-error/30 hover:border-error/50 hover:bg-error-subtle text-error',
  modify: 'border-purple/30 hover:border-purple/50 hover:bg-purple-subtle text-purple',
  health: 'border-success/30 hover:border-success/50 hover:bg-success-subtle text-success',
  topology: 'border-info/30 hover:border-info/50 hover:bg-info-subtle text-info',
  trace: 'border-accent/30 hover:border-accent/50 hover:bg-accent-subtle text-accent',
};

export function ArchSuggestionChips({
  suggestions,
  onSelect,
  className,
}: ArchSuggestionChipsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className={clsx('flex flex-wrap gap-2', className)}>
      {suggestions.map((suggestion, i) => (
        <button
          key={suggestion.id}
          onClick={() => onSelect(suggestion)}
          className={clsx(
            'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium',
            'transition-default btn-press',
            categoryStyles[suggestion.category],
            // Stagger entrance animation
            'opacity-0 animate-fade-in',
          )}
          style={{ animationDelay: `${i * 100}ms`, animationFillMode: 'forwards' }}
          title={suggestion.description}
        >
          {categoryIcons[suggestion.category]}
          {suggestion.label}
        </button>
      ))}
    </div>
  );
}
