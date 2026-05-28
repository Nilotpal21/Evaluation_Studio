/**
 * AnalyticsLayout Component
 *
 * Shared wrapper for workspace-level analytics admin pages.
 * Provides project selector, date range picker, and sub-nav tabs.
 */

import { useState, useEffect, useMemo } from 'react';
import { clsx } from 'clsx';
import { BarChart3 } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore, type AdminPage } from '../../store/navigation-store';
import { Select } from '../ui/Select';

// =============================================================================
// TYPES
// =============================================================================

export type DateRange = '24h' | '7d' | '30d' | '90d';

export interface AnalyticsTimeRange {
  from: string;
  to: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
}

interface AnalyticsLayoutProps {
  children: (context: AnalyticsContext) => React.ReactNode;
}

export interface AnalyticsContext {
  projectId: string | null;
  projects: ProjectInfo[];
  dateRange: DateRange;
  timeRange: AnalyticsTimeRange;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

const RANGE_MS: Record<DateRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

interface TabDef {
  id: AdminPage;
  label: string;
}

const ANALYTICS_TABS: TabDef[] = [
  { id: 'analytics-agents', label: 'Agents' },
  { id: 'analytics-sessions', label: 'Sessions' },
  { id: 'analytics-traces', label: 'Traces' },
];

// =============================================================================
// HELPERS
// =============================================================================

function getTimeRange(range: DateRange): AnalyticsTimeRange {
  const now = new Date();
  const from = new Date(now.getTime() - RANGE_MS[range]);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AnalyticsLayout({ children }: AnalyticsLayoutProps) {
  const tenantId = useAuthStore((s) => s.tenantId);
  const { page, navigate } = useNavigationStore();
  const [dateRange, setDateRange] = useState<DateRange>('7d');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  // Fetch projects for the dropdown
  useEffect(() => {
    if (!tenantId) return;
    apiFetch(`/api/projects?tenantId=${tenantId}`)
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const items = data.projects || data.data || [];
          setProjects(
            items.map((p: Record<string, unknown>) => ({
              id: (p.id as string) || (p._id as string),
              name: p.name as string,
            })),
          );
        }
      })
      .catch(() => {
        // Silently ignore — projects list is optional
      });
  }, [tenantId]);

  const timeRange = useMemo(() => getTimeRange(dateRange), [dateRange]);

  const context: AnalyticsContext = {
    projectId,
    projects,
    dateRange,
    timeRange,
  };

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-subtle flex items-center justify-center">
              <BarChart3 className="w-4.5 h-4.5 text-accent" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">
                Workspace Analytics
              </h1>
              <p className="text-sm text-muted">Monitor agent performance, sessions, and traces</p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Project selector */}
            <Select
              options={[
                { value: '', label: 'All Projects' },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={projectId || ''}
              onChange={(v) => setProjectId(v || null)}
            />

            {/* Date range pills */}
            <div className="flex items-center gap-0.5 bg-background-muted rounded-lg p-0.5">
              {DATE_RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setDateRange(r.value)}
                  className={clsx(
                    'px-3 py-1.5 rounded-md text-xs font-medium transition-default',
                    dateRange === r.value
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Sub-nav tabs */}
        <div className="flex items-center gap-1 border-b border-default">
          {ANALYTICS_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => navigate(`/admin/${tab.id}`)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-default -mb-px',
                page === tab.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {children(context)}
      </div>
    </div>
  );
}
