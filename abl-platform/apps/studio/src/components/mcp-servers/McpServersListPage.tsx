/**
 * McpServersListPage Component
 *
 * Lists all registered MCP servers for the current project.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Plus, Server, Loader2 } from 'lucide-react';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ErrorAlert } from '../ui/ErrorAlert';
import { DataTable, type Column } from '../ui/DataTable';
import { TransportBadge, ConnectionStatusBadge } from './McpServerStatusBadge';
import { useMcpServerStore, type McpServer } from '../../store/mcp-server-store';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { fetchMcpServers } from '../../api/mcp-servers';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { McpServerCreateDialog } from './McpServerCreateDialog';

const MCP_PAGE_SIZE = 10;

const columns: Column<McpServer>[] = [
  {
    key: 'name',
    label: 'Name',
    sortable: true,
    sortValue: (row) => row.name,
    render: (row) => (
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{row.name}</div>
      </div>
    ),
  },
  {
    key: 'transport',
    label: 'Transport',
    width: '100px',
    render: (row) => <TransportBadge transport={row.transport} />,
  },
  {
    key: 'status',
    label: 'Status',
    width: '120px',
    render: (row) => <ConnectionStatusBadge status={row.lastConnectionStatus} />,
  },
  {
    key: 'endpoint',
    label: 'Endpoint',
    render: (row) => (
      <span className="text-xs text-muted truncate block max-w-[200px]">{row.url || '—'}</span>
    ),
  },
  {
    key: 'tools',
    label: 'Tools',
    width: '80px',
    render: (row) => <span className="text-sm text-foreground">{row.discoveredToolCount}</span>,
  },
  {
    key: 'created',
    label: 'Created',
    width: '140px',
    sortable: true,
    sortValue: (row) => new Date(row.createdAt).getTime(),
    render: (row) => (
      <div>
        <span className="text-xs text-muted">{new Date(row.createdAt).toLocaleDateString()}</span>
        {row.createdBy && <div className="text-xs text-muted truncate">{row.createdBy}</div>}
      </div>
    ),
  },
  {
    key: 'updated',
    label: 'Updated',
    width: '120px',
    sortable: true,
    sortValue: (row) => new Date(row.updatedAt).getTime(),
    render: (row) => (
      <span className="text-xs text-muted">{new Date(row.updatedAt).toLocaleDateString()}</span>
    ),
  },
];

export function McpServersListPage() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const navigate = useNavigationStore((s) => s.navigate);
  const servers = useMcpServerStore((s) => s.servers);
  const isLoading = useMcpServerStore((s) => s.isLoading);
  const error = useMcpServerStore((s) => s.error);
  const setServers = useMcpServerStore((s) => s.setServers);
  const setLoading = useMcpServerStore((s) => s.setLoading);
  const setError = useMcpServerStore((s) => s.setError);

  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState(1);

  const projectId = currentProject?.id;

  const loadServers = useCallback(async () => {
    if (!projectId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchMcpServers(projectId);
      setServers(result.servers);
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to load MCP servers'));
    } finally {
      setLoading(false);
    }
  }, [projectId, setServers, setLoading, setError]);

  const totalPages = Math.max(1, Math.ceil(servers.length / MCP_PAGE_SIZE));
  const paginatedServers = useMemo(() => {
    const start = (page - 1) * MCP_PAGE_SIZE;
    return servers.slice(start, start + MCP_PAGE_SIZE);
  }, [servers, page]);

  // Reset to page 1 when servers list changes
  useEffect(() => {
    setPage(1);
  }, [servers.length]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const handleRowClick = (server: McpServer) => {
    if (projectId) {
      navigate(`/projects/${projectId}/mcp-servers/${server.id}`);
    }
  };

  const isEmptyStateShown = !isLoading && !error && servers.length === 0;

  return (
    <>
      <ListPageShell
        title="MCP Servers"
        description={`${servers.length} server${servers.length !== 1 ? 's' : ''} registered`}
        hidePrimaryAction={isEmptyStateShown}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
            Register Server
          </Button>
        }
        pagination={{ page, pageSize: MCP_PAGE_SIZE, total: servers.length, onPageChange: setPage }}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-muted animate-spin" />
          </div>
        ) : error ? (
          <div className="py-8 flex flex-col items-center gap-4">
            <ErrorAlert error={error} onDismiss={() => setError(null)} />
            <Button variant="secondary" onClick={loadServers}>
              Retry
            </Button>
          </div>
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<Server className="w-6 h-6" />}
            title="No MCP servers yet"
            description="Register an MCP server to discover and import its tools into your project."
            action={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                Register Server
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={paginatedServers}
            keyExtractor={(row) => row.id}
            onRowClick={handleRowClick}
          />
        )}
      </ListPageShell>

      {showCreate && (
        <McpServerCreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(server) => {
            setShowCreate(false);
            if (projectId) {
              navigate(`/projects/${projectId}/mcp-servers/${server.id}`);
            }
          }}
        />
      )}
    </>
  );
}
