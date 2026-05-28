'use client';

import { X } from 'lucide-react';
import { useArchAuditStore } from '@/lib/arch-ai/store/arch-audit-store';
import { Select } from '@/components/ui/Select';
import type { AuditLogCategory } from '@agent-platform/arch-ai';

const AUDIT_LOG_CATEGORIES: readonly AuditLogCategory[] = [
  'llm_call',
  'tool_execution',
  'phase_transition',
  'user_action',
  'build_event',
  'editor_mode_event',
  'error',
  'system_event',
] as const;

const CATEGORY_COLORS: Record<AuditLogCategory, string> = {
  llm_call: 'bg-purple/20 text-purple border-purple/30',
  tool_execution: 'bg-info/20 text-info border-info/30',
  phase_transition: 'bg-teal/20 text-teal border-teal/30',
  user_action: 'bg-success/20 text-success border-success/30',
  build_event: 'bg-warning/20 text-warning border-warning/30',
  editor_mode_event: 'bg-info/20 text-info border-info/30',
  error: 'bg-error/20 text-error border-error/30',
  system_event: 'bg-foreground-muted/20 text-foreground-muted border-foreground-muted/30',
};

const CATEGORY_LABELS: Record<AuditLogCategory, string> = {
  llm_call: 'LLM Call',
  tool_execution: 'Tool',
  phase_transition: 'Phase',
  user_action: 'User',
  build_event: 'Build',
  editor_mode_event: 'Editor',
  error: 'Error',
  system_event: 'System',
};

const SEVERITY_OPTIONS = [
  { value: '', label: 'All Severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

const PHASE_OPTIONS = [
  { value: '', label: 'All Phases' },
  { value: 'INTERVIEW', label: 'Interview' },
  { value: 'BLUEPRINT', label: 'Blueprint' },
  { value: 'BUILD', label: 'Build' },
  { value: 'CREATE', label: 'Create' },
];

export function AuditLogFilters() {
  const filters = useArchAuditStore((s) => s.filters);
  const toggleCategory = useArchAuditStore((s) => s.toggleCategory);
  const setFilter = useArchAuditStore((s) => s.setFilter);
  const clearFilters = useArchAuditStore((s) => s.clearFilters);
  const fetchLogs = useArchAuditStore((s) => s.fetchLogs);
  const fetchSummary = useArchAuditStore((s) => s.fetchSummary);

  const hasFilters =
    filters.category.length > 0 ||
    filters.severity.length > 0 ||
    filters.phase !== '' ||
    filters.userId !== '' ||
    filters.sessionId !== '';

  const applyFilters = () => {
    fetchLogs();
    fetchSummary();
  };

  return (
    <div className="space-y-3">
      {/* Category chips */}
      <div className="flex flex-wrap gap-2">
        {AUDIT_LOG_CATEGORIES.map((cat) => {
          const active = filters.category.includes(cat);
          return (
            <button
              key={cat}
              onClick={() => {
                toggleCategory(cat);
                // Defer fetch to next tick so state updates first
                setTimeout(applyFilters, 0);
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-default ${
                active
                  ? CATEGORY_COLORS[cat]
                  : 'border-border/50 bg-background text-foreground-muted hover:bg-background-muted'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-current' : 'bg-foreground-subtle'}`}
              />
              {CATEGORY_LABELS[cat]}
            </button>
          );
        })}
      </div>

      {/* Secondary filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          options={SEVERITY_OPTIONS}
          value={filters.severity.join(',') || ''}
          onChange={(val) => {
            setFilter('severity', val ? (val.split(',') as never[]) : []);
            setTimeout(applyFilters, 0);
          }}
          className="w-36"
        />

        <Select
          options={PHASE_OPTIONS}
          value={filters.phase}
          onChange={(val) => {
            setFilter('phase', val);
            setTimeout(applyFilters, 0);
          }}
          className="w-36"
        />

        {hasFilters && (
          <button
            onClick={() => {
              clearFilters();
              setTimeout(applyFilters, 0);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-background-muted"
          >
            <X className="h-3 w-3" />
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
