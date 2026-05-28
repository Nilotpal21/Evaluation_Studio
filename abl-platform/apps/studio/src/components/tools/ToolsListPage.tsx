/**
 * ToolsListPage Component
 *
 * Lists all tools for the current project with tabs by type:
 * HTTP Tools, Code Tools, MCP Servers.
 * HTTP and Code tabs show tool cards. MCP tab shows server cards.
 */

import { useEffect, useState, useCallback, useMemo, useRef, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Wrench, Server, Upload, Package } from 'lucide-react';
import { toast } from 'sonner';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { Tabs } from '../ui/Tabs';
import { EmptyState } from '../ui/EmptyState';
import { ToolCard } from './ToolCard';
import { ToolPreviewDialog } from './ToolPreviewDialog';
import { TestToolDialog } from './TestToolDialog';
import { NewToolDropdown } from './NewToolDropdown';
import { ToolCreateDialog } from './ToolCreateDialog';
import { buildInputSchemaFromTool } from './tool-utils';
import { McpServerCard } from '../mcp-servers/McpServerCard';
import { McpServerCreateDialog } from '../mcp-servers/McpServerCreateDialog';
import { useToolStore, type ToolWithVersion, type ToolTestResult } from '../../store/tool-store';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useMcpServerStore, type McpServer } from '../../store/mcp-server-store';
import {
  fetchTools,
  deleteTool,
  duplicateTool,
  importTool,
  testTool,
  type ToolImportPayload,
} from '../../api/tools';
import { fetchMcpServers, deleteMcpServer, testMcpServerConnection } from '../../api/mcp-servers';
import { fetchVariableNamespaces, type VariableNamespace } from '../../api/variable-namespaces';
import { sanitizeError, sanitizeErrors } from '../../lib/sanitize-error';
import { ErrorAlert } from '../ui/ErrorAlert';
import { useFeatures } from '../../hooks/use-features';
import { useImportedSymbols } from '../../hooks/useImportedSymbols';
import { ImportedToolCard } from './ImportedToolCard';
import { getProjectScopedReturnTo } from './return-navigation';

type ToolTab = 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';

const DEFAULT_PAGE_SIZE = 12;
const SKELETON_COUNT = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ToolCardSkeleton() {
  return (
    <div className="rounded-2xl border border-default bg-background-elevated p-4 animate-pulse">
      {/* Type badge */}
      <div className="mb-3">
        <div className="h-5 w-16 bg-background-muted rounded" />
      </div>
      {/* Tool name */}
      <div className="h-5 w-3/4 bg-background-muted rounded mb-2" />
      {/* Description line 1 */}
      <div className="h-4 w-full bg-background-muted rounded mb-1.5" />
      {/* Description line 2 */}
      <div className="h-4 w-2/3 bg-background-muted rounded mb-4" />
      {/* Footer: date + user */}
      <div className="flex items-center justify-between pt-3 border-t border-default">
        <div className="h-3 w-24 bg-background-muted rounded" />
        <div className="h-3 w-16 bg-background-muted rounded" />
      </div>
    </div>
  );
}

export function ToolsListPage() {
  const t = useTranslations('tools');
  const currentProject = useProjectStore((s) => s.currentProject);
  const navigate = useNavigationStore((s) => s.navigate);
  const servers = useMcpServerStore((s) => s.servers);
  const setServers = useMcpServerStore((s) => s.setServers);
  const setServersLoading = useMcpServerStore((s) => s.setLoading);
  const setServersError = useMcpServerStore((s) => s.setError);
  const tools = useToolStore((s) => s.tools);
  const isLoading = useToolStore((s) => s.isLoading);
  const error = useToolStore((s) => s.error);
  const pagination = useToolStore((s) => s.pagination);
  const searchQuery = useToolStore((s) => s.searchQuery);
  const httpCount = useToolStore((s) => s.httpCount);
  const sandboxCount = useToolStore((s) => s.sandboxCount);
  const mcpCount = useToolStore((s) => s.mcpCount);
  const searchaiCount = useToolStore((s) => s.searchaiCount);
  const workflowCount = useToolStore((s) => s.workflowCount);
  const setTools = useToolStore((s) => s.setTools);
  const setLoading = useToolStore((s) => s.setLoading);
  const setError = useToolStore((s) => s.setError);
  const setSearchQuery = useToolStore((s) => s.setSearchQuery);

  const { hasCodeTools } = useFeatures();
  const { tools: importedTools } = useImportedSymbols();
  const projectId = currentProject?.id;
  const [activeTab, setActiveTab] = useState<ToolTab>('http');
  const [currentPage, setCurrentPage] = useState(1);
  const [previewTool, setPreviewTool] = useState<ToolWithVersion | null>(null);
  const [testingTool, setTestingTool] = useState<ToolWithVersion | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSearch, setMcpSearch] = useState('');
  const [editServer, setEditServer] = useState<McpServer | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showWorkflowCreate, setShowWorkflowCreate] = useState(false);
  const [variableNamespaces, setVariableNamespaces] = useState<VariableNamespace[]>([]);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const isMcpTab = activeTab === 'mcp';
  const isSearchaiTab = activeTab === 'searchai';
  const isWorkflowTab = activeTab === 'workflow';

  // Read initial tab from URL query param (e.g., ?tab=searchai)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab && ['http', 'sandbox', 'mcp', 'searchai', 'workflow'].includes(tab)) {
      if (tab === 'sandbox' && !hasCodeTools) return;
      setActiveTab(tab as ToolTab);
    }
  }, [hasCodeTools]);

  const tabs = useMemo(
    () => [
      { id: 'http', label: t('list.tab_http'), count: httpCount },
      ...(hasCodeTools ? [{ id: 'sandbox', label: t('list.tab_code'), count: sandboxCount }] : []),
      { id: 'searchai', label: t('list.tab_searchai'), count: searchaiCount },
      {
        id: 'workflow',
        label: t('list.tab_workflow'),
        count: workflowCount,
        testid: 'tools-tab-workflow',
      },
      { id: 'mcp', label: t('list.tab_mcp'), count: servers.length },
    ],
    [httpCount, sandboxCount, searchaiCount, workflowCount, servers.length, t, hasCodeTools],
  );

  // ─── Tool loading (HTTP / Sandbox) ──────────────────────────────────────

  const loadTools = useCallback(async () => {
    if (!projectId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchTools(projectId, {
        search: searchQuery || undefined,
      });
      setTools(result.data, result.pagination);
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to load tools'));
    } finally {
      setLoading(false);
    }
  }, [projectId, searchQuery, setTools, setLoading, setError]);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  useEffect(() => {
    if (!projectId) return;
    fetchVariableNamespaces(projectId)
      .then((data) => setVariableNamespaces(data.namespaces || []))
      .catch((err) => {
        console.error('Failed to load variable namespaces:', err);
        toast.error(sanitizeError(err, 'Failed to load variable namespaces'));
      });
  }, [projectId]);

  // ─── MCP server loading ─────────────────────────────────────────────────

  const loadServers = useCallback(async () => {
    if (!projectId) return;

    setMcpLoading(true);
    setMcpError(null);

    try {
      const result = await fetchMcpServers(projectId);
      setServers(result.servers);
    } catch (err) {
      setMcpError(sanitizeError(err, 'Failed to load MCP servers'));
    } finally {
      setMcpLoading(false);
    }
  }, [projectId, setServers]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  // ─── Tool actions ───────────────────────────────────────────────────────

  const handleEdit = useCallback(
    (toolId: string) => {
      if (projectId) {
        navigate(`/projects/${projectId}/tools/${toolId}`);
      }
    },
    [projectId, navigate],
  );

  const handlePreview = useCallback((tool: ToolWithVersion) => {
    setPreviewTool(tool);
  }, []);

  const handleTest = useCallback((tool: ToolWithVersion) => {
    setTestingTool(tool);
  }, []);

  const handleDuplicate = useCallback(
    async (toolId: string) => {
      if (!projectId) return;

      try {
        const result = await duplicateTool(projectId, toolId);
        if (result.success && result.tool) {
          navigate(`/projects/${projectId}/tools/${result.tool.id}`);
        }
      } catch (err) {
        setError(sanitizeErrors(err, 'Failed to duplicate tool'));
      }
    },
    [projectId, navigate, setError],
  );

  const handleDeleteTool = useCallback(
    async (toolId: string) => {
      if (!projectId) return;

      try {
        await deleteTool(projectId, toolId);
        await loadTools();
      } catch (err) {
        setError(sanitizeErrors(err, 'Failed to delete tool'));
      }
    },
    [projectId, loadTools, setError],
  );

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportTool = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !projectId) return;

      setImporting(true);
      setError(null);

      try {
        const raw = await file.text();
        let payload: unknown;

        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error(t('list.import_invalid_file'));
        }

        if (!isRecord(payload)) {
          throw new Error(t('list.import_invalid_file'));
        }

        const result = await importTool(projectId, payload as ToolImportPayload);
        toast.success(t('list.import_success', { name: result.tool.name }));
        navigate(`/projects/${projectId}/tools/${result.tool.id}`);
      } catch (err) {
        setError(sanitizeErrors(err, t('list.import_failed')));
      } finally {
        event.target.value = '';
        setImporting(false);
      }
    },
    [projectId, navigate, setError, t],
  );

  const handleTestExecute = useCallback(
    async (input: Record<string, unknown>): Promise<ToolTestResult> => {
      if (!projectId || !testingTool) {
        return {
          output: null,
          error: t('list.missing_context'),
          latencyMs: 0,
          logs: [],
        };
      }

      try {
        const response = await testTool(projectId, testingTool.id, input);
        return response.result;
      } catch (err) {
        return {
          output: null,
          error: sanitizeError(err, t('list.test_failed')),
          latencyMs: 0,
          logs: [],
        };
      }
    },
    [projectId, testingTool],
  );

  // ─── MCP server actions ─────────────────────────────────────────────────

  const handleServerViewDetails = useCallback(
    (serverId: string) => {
      if (projectId) {
        navigate(`/projects/${projectId}/mcp-servers/${serverId}`);
      }
    },
    [projectId, navigate],
  );

  const handleServerEdit = useCallback((server: McpServer) => {
    setEditServer(server);
  }, []);

  const handleServerTest = useCallback(
    async (serverId: string) => {
      if (!projectId) return;
      try {
        await testMcpServerConnection(projectId, serverId);
        await loadServers();
      } catch (err) {
        setMcpError(sanitizeError(err, 'Connection test failed'));
      }
    },
    [projectId, loadServers],
  );

  const handleServerDelete = useCallback(
    async (serverId: string) => {
      if (!projectId) return;
      try {
        await deleteMcpServer(projectId, serverId);
        await loadServers();
      } catch (err) {
        setMcpError(sanitizeError(err, 'Failed to delete server'));
      }
    },
    [projectId, loadServers],
  );

  const getReturnTo = useCallback(() => {
    return projectId ? getProjectScopedReturnTo(projectId) : null;
  }, [projectId]);

  const handleMcpServerDialogClose = useCallback(() => {
    setShowCreate(false);
    setEditServer(null);

    const returnTo = editServer ? null : getReturnTo();
    if (returnTo) {
      navigate(returnTo, { replace: true });
    }
  }, [editServer, getReturnTo, navigate]);

  const handleMcpServerCreated = useCallback(
    (server: McpServer) => {
      setShowCreate(false);
      setEditServer(null);
      if (!projectId) return;

      const returnTo = editServer ? null : getReturnTo();
      if (returnTo) {
        navigate(returnTo, { replace: true });
      } else {
        navigate(`/projects/${projectId}/mcp-servers/${server.id}`);
      }
    },
    [editServer, getReturnTo, navigate, projectId],
  );

  // ─── Filtering & pagination ─────────────────────────────────────────────

  // Tool filtering (HTTP / Sandbox tabs)
  const filteredTools = useMemo(() => {
    return tools.filter((t) => t.toolType === activeTab);
  }, [tools, activeTab]);

  // MCP server filtering
  const filteredServers = useMemo(() => {
    if (!mcpSearch) return servers;
    const q = mcpSearch.toLowerCase();
    return servers.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.url && s.url.toLowerCase().includes(q)),
    );
  }, [servers, mcpSearch]);

  // Pagination for tools
  const paginatedTools = useMemo(() => {
    const start = (currentPage - 1) * DEFAULT_PAGE_SIZE;
    return filteredTools.slice(start, start + DEFAULT_PAGE_SIZE);
  }, [filteredTools, currentPage]);

  // Pagination for servers
  const paginatedServers = useMemo(() => {
    const start = (currentPage - 1) * DEFAULT_PAGE_SIZE;
    return filteredServers.slice(start, start + DEFAULT_PAGE_SIZE);
  }, [filteredServers, currentPage]);

  // Reset page when tab or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchQuery, mcpSearch]);

  // ─── Derived values for ListPageShell ─────────────────────────────────

  const currentLoading = isMcpTab ? mcpLoading : isLoading;
  const currentError = isMcpTab ? mcpError : error;
  const currentSearchValue = isMcpTab ? mcpSearch : searchQuery;
  const currentSearchPlaceholder = isMcpTab ? t('list.search_servers') : t('search_placeholder');
  const currentTotal = isMcpTab ? filteredServers.length : filteredTools.length;
  const isEmptyStateShown = !currentLoading && !currentError && currentTotal === 0;

  const handleSearchChange = useCallback(
    (value: string) => {
      if (isMcpTab) {
        setMcpSearch(value);
      } else {
        setSearchQuery(value);
      }
    },
    [isMcpTab, setSearchQuery],
  );

  const primaryAction = isSearchaiTab ? undefined : isWorkflowTab ? (
    <Button
      icon={<Plus className="w-4 h-4" />}
      onClick={() => setShowWorkflowCreate(true)}
      data-testid="workflow-register-button"
    >
      {t('list.register_workflow')}
    </Button>
  ) : isMcpTab ? (
    <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
      {t('list.register_server')}
    </Button>
  ) : (
    <NewToolDropdown onMcpSelect={() => setActiveTab('mcp')} testid="tool-create-button" />
  );

  const secondaryActions = projectId ? (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportTool}
        data-testid="tool-import-input"
      />
      <Button
        variant="secondary"
        size="sm"
        icon={<Upload className="w-4 h-4" />}
        onClick={handleImportClick}
        loading={importing}
      >
        {t('list.import_tool')}
      </Button>
    </>
  ) : undefined;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={t('list.tool_count', { count: pagination.total })}
        hidePrimaryAction={isEmptyStateShown}
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        searchPlaceholder={currentSearchPlaceholder}
        searchValue={currentSearchValue}
        onSearchChange={handleSearchChange}
        pagination={{
          page: currentPage,
          pageSize: DEFAULT_PAGE_SIZE,
          total: currentTotal,
          onPageChange: setCurrentPage,
        }}
        className="bg-noise"
      >
        {/* Tabs */}
        <div className="mb-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as ToolTab)}
            layoutId="tools-tabs"
          />
        </div>

        {/* Content */}
        {currentLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: SKELETON_COUNT }, (_, i) => (
              <ToolCardSkeleton key={i} />
            ))}
          </div>
        ) : currentError ? (
          <div className="py-8 flex flex-col items-center gap-4">
            <ErrorAlert
              error={currentError}
              onDismiss={() => (isMcpTab ? setMcpError(null) : setError(null))}
            />
            <Button variant="secondary" onClick={isMcpTab ? loadServers : loadTools}>
              {t('list.retry')}
            </Button>
          </div>
        ) : isMcpTab ? (
          /* MCP Tab — Server Cards */
          filteredServers.length === 0 ? (
            <EmptyState
              icon={<Server className="w-6 h-6" />}
              title={mcpSearch ? t('list.no_matching_servers') : t('list.no_mcp_servers')}
              description={mcpSearch ? t('list.try_adjusting_search') : t('list.register_mcp_hint')}
              action={
                !mcpSearch ? (
                  <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                    {t('list.register_server')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {paginatedServers.map((server) => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  onViewDetails={handleServerViewDetails}
                  onEdit={handleServerEdit}
                  onTest={handleServerTest}
                  onDelete={handleServerDelete}
                />
              ))}
            </div>
          )
        ) : /* HTTP / Sandbox Tabs — Tool Cards */
        filteredTools.length === 0 ? (
          <EmptyState
            icon={<Wrench className="w-6 h-6" />}
            title={
              searchQuery
                ? t('list.no_matching_tools')
                : isSearchaiTab
                  ? t('list.no_searchai_tools_yet')
                  : isWorkflowTab
                    ? t('list.no_workflow_tools_yet')
                    : activeTab === 'http'
                      ? t('list.no_http_tools_yet')
                      : t('list.no_code_tools_yet')
            }
            description={
              searchQuery
                ? t('list.try_adjusting_search')
                : isSearchaiTab
                  ? t('list.searchai_tools_hint')
                  : isWorkflowTab
                    ? t('list.workflow_tools_hint')
                    : t('list.create_first_tool')
            }
            action={
              !searchQuery && !isSearchaiTab && projectId ? (
                <Button
                  icon={<Plus className="w-4 h-4" />}
                  onClick={() =>
                    isWorkflowTab
                      ? setShowWorkflowCreate(true)
                      : navigate(`/projects/${projectId}/tools/new?type=${activeTab}`)
                  }
                >
                  {isWorkflowTab ? t('list.register_workflow') : t('list.create_tool')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {paginatedTools.map((tool, i) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                index={i}
                variableNamespaces={variableNamespaces}
                onEdit={handleEdit}
                onTest={handleTest}
                onPreview={handlePreview}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteTool}
              />
            ))}
          </div>
        )}

        {/* Imported Tools Section */}
        {importedTools.length > 0 && (
          <div className="mt-8 border-t border-default pt-6">
            <h3 className="text-sm font-medium text-foreground-muted mb-4 flex items-center gap-2">
              <Package className="h-4 w-4" />
              {t('list.imported_tools', { count: importedTools.length })}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {importedTools.map((tool) => (
                <ImportedToolCard
                  key={`${tool.alias}.${tool.name}`}
                  tool={tool}
                  onClick={() =>
                    navigate(`/projects/${projectId}/tools/imported/${tool.alias}/${tool.name}`)
                  }
                />
              ))}
            </div>
          </div>
        )}
      </ListPageShell>

      {/* Preview Dialog */}
      <ToolPreviewDialog
        open={!!previewTool}
        onClose={() => setPreviewTool(null)}
        tool={previewTool}
        onEdit={handleEdit}
        onTest={handleTest}
      />

      {/* Test Dialog */}
      {testingTool && (
        <TestToolDialog
          open={!!testingTool}
          onClose={() => setTestingTool(null)}
          tool={testingTool}
          inputSchema={buildInputSchemaFromTool(testingTool)}
          onTest={handleTestExecute}
        />
      )}

      {/* MCP Server Create/Edit Dialog */}
      {(showCreate || editServer) && (
        <McpServerCreateDialog
          onClose={handleMcpServerDialogClose}
          onCreated={handleMcpServerCreated}
          editServer={editServer || undefined}
        />
      )}

      {/* Workflow Tool Create Dialog */}
      <ToolCreateDialog
        open={showWorkflowCreate}
        onClose={() => setShowWorkflowCreate(false)}
        defaultToolType="workflow"
      />
    </>
  );
}
