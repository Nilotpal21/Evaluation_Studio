'use client';

import { FilterSelect } from '../ui/FilterSelect';
import { GOVERNANCE_PIPELINE_TYPES } from '../../lib/governance-contracts';
import type { AuditQueryParams } from '../../hooks/useGovernanceAudit';

interface AuditFiltersProps {
  filters: AuditQueryParams;
  onChange: (filters: AuditQueryParams) => void;
}

const PIPELINE_OPTIONS = [
  { value: '', label: 'All pipeline types' },
  ...GOVERNANCE_PIPELINE_TYPES.map((pt) => ({
    value: pt,
    label: pt.replace(/_/g, ' '),
  })),
];

const SEVERITY_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

const EVENT_TYPE_OPTIONS = [
  { value: '', label: 'All event types' },
  { value: 'breach', label: 'Breach' },
  { value: 'recovery', label: 'Recovery' },
];

export function AuditFilters({ filters, onChange }: AuditFiltersProps) {
  const pipelineValue = filters.pipelineTypes?.[0] ?? '';
  const severityValue = filters.severities?.[0] ?? '';
  const eventTypeValue = filters.eventTypes?.[0] ?? '';

  return (
    <div className="flex flex-wrap gap-3">
      <FilterSelect
        options={PIPELINE_OPTIONS}
        value={pipelineValue}
        onChange={(v) => onChange({ ...filters, pipelineTypes: v ? [v] : undefined, page: 1 })}
      />
      <FilterSelect
        options={SEVERITY_OPTIONS}
        value={severityValue}
        onChange={(v) => onChange({ ...filters, severities: v ? [v] : undefined, page: 1 })}
      />
      <FilterSelect
        options={EVENT_TYPE_OPTIONS}
        value={eventTypeValue}
        onChange={(v) => onChange({ ...filters, eventTypes: v ? [v] : undefined, page: 1 })}
      />
    </div>
  );
}
