/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuditLogsPage } from '../../components/admin/audit/AuditLogsPage';

const mockApiFetch = vi.fn();
const auditTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

vi.mock('../../lib/api-client', () => ({
  apiFetch: (url: string) => mockApiFetch(url),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'title') return 'Audit Logs';
    if (key === 'description') return 'Workspace audit explorer';
    if (key === 'workspace_scope') return 'Workspace';
    if (key === 'refresh') return 'Refresh';
    if (key === 'search') return 'Search';
    if (key === 'from') return 'From';
    if (key === 'to') return 'To';
    if (key === 'actions') return 'Actions';
    if (key === 'actor') return 'Actor';
    if (key === 'actor_types') return 'Actor types';
    if (key === 'apply') return 'Apply';
    if (key === 'categories') return 'Categories';
    if (key === 'comma_placeholder') return 'Comma separated';
    if (key === 'environments') return 'Environments';
    if (key === 'export_csv') return 'Export CSV';
    if (key === 'ip_address') return 'IP address';
    if (key === 'metadata_key') return 'Metadata key';
    if (key === 'metadata_value') return 'Metadata value';
    if (key === 'more_filters') return 'More filters';
    if (key === 'project_id') return 'Project ID';
    if (key === 'resource_id') return 'Resource ID';
    if (key === 'resource_types') return 'Resource types';
    if (key === 'result') return 'Result';
    if (key === 'result_all') return 'All';
    if (key === 'result_success') return 'Success';
    if (key === 'result_failure') return 'Failure';
    if (key === 'sources') return 'Sources';
    if (key === 'trace_id') return 'Trace ID';
    if (key === 'timestamp') return 'Timestamp';
    if (key === 'category') return 'Category';
    if (key === 'action_header') return 'Action';
    if (key === 'actor_header') return 'Actor';
    if (key === 'target_header') return 'Target';
    if (key === 'project_header') return 'Project';
    if (key === 'source_header') return 'Source';
    if (key === 'ip_header') return 'IP';
    if (key === 'trace_header') return 'Trace';
    if (key === 'page_info') return `Page ${values?.current} of ${values?.total}`;
    return key;
  },
}));

describe('AuditLogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    window.history.replaceState({}, '', '/admin/audit-logs');
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        logs: [
          {
            id: 'audit-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            eventType: 'project_updated',
            category: 'project_agent_configuration',
            categoryLabel: 'Project, agent & workflow configuration',
            action: 'project_updated',
            actorType: 'user',
            resourceType: 'project',
            resourceId: 'project-1',
            environment: 'production',
            traceId: 'trace-1',
            source: 'runtime-store',
            ip: '10.0.0.1',
            userAgent: null,
            metadata: { traceId: 'trace-1' },
            createdAt: '2026-05-08T10:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        scope: 'workspace',
      }),
    });
  });

  it('loads workspace audit logs and renders the full-screen filters', async () => {
    render(<AuditLogsPage />);
    const expectedTimestamp = auditTimestampFormatter.format(new Date('2026-05-08T10:00:00.000Z'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/audit?'));
    });

    const requestedUrl = String(mockApiFetch.mock.calls[0][0]);
    expect(requestedUrl).toContain('scope=workspace');
    expect(requestedUrl).toContain('limit=50');
    expect(screen.getByText('Audit Logs')).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Actions')).toBeInTheDocument();
    expect(screen.getByText('project_updated')).toBeInTheDocument();
    expect(screen.getAllByText('Project, agent & workflow configuration').length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(expectedTimestamp).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
    expect(screen.getByTestId('audit-log-category-audit-1')).toHaveClass(
      'rounded-md',
      'whitespace-normal',
    );
    expect(screen.getByText('project-1')).toBeInTheDocument();
  });

  it('sends every audit explorer filter to the API and filtered export endpoint', async () => {
    render(<AuditLogsPage />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/audit?'));
    });
    mockApiFetch.mockClear();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'billing' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-05-01T00:00' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-05-03T00:00' } });
    fireEvent.change(screen.getByLabelText('Actions'), { target: { value: 'project_created' } });
    fireEvent.click(screen.getAllByText('Project, agent & workflow configuration')[0]);
    fireEvent.click(screen.getByText('More filters'));

    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'actor-admin' } });
    fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'project-1' } });
    fireEvent.change(screen.getByLabelText('Resource types'), { target: { value: 'project' } });
    fireEvent.change(screen.getByLabelText('Resource ID'), { target: { value: 'project-1' } });
    fireEvent.change(screen.getByLabelText('Trace ID'), { target: { value: 'trace-project-1' } });
    fireEvent.change(screen.getByLabelText('Sources'), { target: { value: 'studio' } });
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: '203.0.113.' } });
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'failure' } });
    fireEvent.click(screen.getByText('user'));
    fireEvent.click(screen.getByText('production'));
    fireEvent.change(screen.getByLabelText('Metadata key'), { target: { value: 'name' } });
    fireEvent.change(screen.getByLabelText('Metadata value'), { target: { value: 'billing' } });

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/audit?'));
    });

    const auditUrl = String(mockApiFetch.mock.calls.at(-1)?.[0]);
    const auditParams = new URLSearchParams(auditUrl.split('?')[1]);
    expect(auditParams.get('scope')).toBe('workspace');
    expect(auditParams.get('q')).toBe('billing');
    expect(auditParams.get('categories')).toBe('project_agent_configuration');
    expect(auditParams.get('actions')).toBe('project_created');
    expect(auditParams.get('actor')).toBe('actor-admin');
    expect(auditParams.get('actorTypes')).toBe('user');
    expect(auditParams.get('projectId')).toBe('project-1');
    expect(auditParams.get('resourceTypes')).toBe('project');
    expect(auditParams.get('resourceId')).toBe('project-1');
    expect(auditParams.get('traceId')).toBe('trace-project-1');
    expect(auditParams.get('sources')).toBe('studio');
    expect(auditParams.get('environments')).toBe('production');
    expect(auditParams.get('success')).toBe('failure');
    expect(auditParams.get('ipAddress')).toBe('203.0.113.');
    expect(auditParams.get('metadataKey')).toBe('name');
    expect(auditParams.get('metadataValue')).toBe('billing');
    expect(auditParams.get('from')).toBeTruthy();
    expect(auditParams.get('to')).toBeTruthy();

    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '[]',
    });
    fireEvent.click(screen.getByText('JSON'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/audit/export?'));
    });
    const exportUrl = String(mockApiFetch.mock.calls.at(-1)?.[0]);
    const exportParams = new URLSearchParams(exportUrl.split('?')[1]);
    expect(exportParams.get('format')).toBe('json');
    expect(exportParams.get('categories')).toBe('project_agent_configuration');
    expect(exportParams.get('actions')).toBe('project_created');
    expect(exportParams.get('metadataKey')).toBe('name');
    expect(exportParams.get('metadataValue')).toBe('billing');
  });

  it('refreshes the audit query to the latest 24-hour window ending now', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-10T16:00:00.000Z'));
    window.history.replaceState(
      {},
      '',
      '/admin/audit-logs?from=2026-05-09T10%3A00%3A00.000Z&to=2026-05-10T10%3A00%3A00.000Z',
    );

    render(<AuditLogsPage />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
    });

    const refreshedUrl = String(mockApiFetch.mock.calls[1][0]);
    expect(refreshedUrl).toContain('from=2026-05-09T16%3A00%3A00.000Z');
    expect(refreshedUrl).toContain('to=2026-05-10T16%3A00%3A00.000Z');
  });
});
