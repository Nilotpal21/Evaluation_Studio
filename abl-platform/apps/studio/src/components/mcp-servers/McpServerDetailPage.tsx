/**
 * McpServerDetailPage Component
 *
 * Consistent with ToolDetailPage layout — SegmentedControl tabs,
 * bordered content area, matching header pattern.
 *
 * Tabs: Tools | Configuration
 */

import { useEffect, useState, useCallback, useRef, useMemo, type MutableRefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import {
  ArrowLeft,
  Loader2,
  Plug,
  Trash2,
  Pencil,
  Check,
  X,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Wrench,
  Settings,
  AlertCircle,
  Lock,
  Plus,
  Minus,
  Calendar,
  User,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { TransportBadge, ConnectionStatusBadge } from './McpServerStatusBadge';
import { useMcpServerStore, type McpServer } from '../../store/mcp-server-store';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import {
  fetchMcpServer,
  updateMcpServer,
  deleteMcpServer,
  testMcpServerConnection,
  fetchServerTools,
  discoverToolsPreview,
  discoverAndImportTools,
  type ServerTool,
  type DiscoveredToolPreview,
  type McpTransportType,
  type McpAuthType,
} from '../../api/mcp-servers';
import { deleteTool } from '../../api/tools';
import { sanitizeError } from '../../lib/sanitize-error';

// ─── Section Options ────────────────────────────────────────────────────

// ─── Tools Tab ──────────────────────────────────────────────────────────

/** Unified tool row — merges discovered + imported into one flat list */
interface UnifiedTool {
  name: string;
  displayName: string;
  description: string | null;
  imported: boolean;
  importedToolId?: string;
  stale: boolean; // imported but no longer on server
}

/** Extract the raw tool name from an imported DB name like `servername__toolname` */
function stripServerPrefix(dbName: string): string {
  const idx = dbName.indexOf('__');
  return idx >= 0 ? dbName.slice(idx + 2) : dbName;
}

interface ToolsTabProps {
  projectId: string;
  serverId: string;
  onNavigateToTool: (toolId: string) => void;
}

function ToolsTab({ projectId, serverId, onNavigateToTool }: ToolsTabProps) {
  const t = useTranslations('mcp.detail');
  const [importedTools, setImportedTools] = useState<ServerTool[]>([]);
  const [discoveredTools, setDiscoveredTools] = useState<DiscoveredToolPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importingNames, setImportingNames] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  const loadImportedTools = useCallback(async () => {
    try {
      const result = await fetchServerTools(projectId, serverId);
      setImportedTools(result.tools);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to load tools'));
    }
  }, [projectId, serverId]);

  const discoverFromServer = useCallback(async () => {
    setIsSyncing(true);
    setDiscoverError(null);
    try {
      const result = await discoverToolsPreview(projectId, serverId);
      setDiscoveredTools(result.tools);
    } catch (err) {
      setDiscoverError(sanitizeError(err, 'Could not reach server'));
    } finally {
      setIsSyncing(false);
    }
  }, [projectId, serverId]);

  // Load imported tools + discover on mount
  useEffect(() => {
    async function init() {
      setLoading(true);
      setError(null);
      setDiscoverError(null);
      await Promise.all([loadImportedTools(), discoverFromServer()]);
      setLoading(false);
    }
    init();
  }, [loadImportedTools, discoverFromServer]);

  const formatImportErrors = (result: {
    failed?: Array<{ toolName: string; error: string }>;
    conflicting?: Array<{ toolName: string; reason: string }>;
    schemaDrift?: Array<{ toolName: string; field: string }>;
  }): string | null => {
    const parts: string[] = [];
    if (result.failed?.length) {
      parts.push(`Failed: ${result.failed.map((f) => `${f.toolName} (${f.error})`).join(', ')}`);
    }
    if (result.conflicting?.length) {
      parts.push(
        `Conflicting: ${result.conflicting.map((c) => `${c.toolName} (${c.reason})`).join(', ')}`,
      );
    }
    if (result.schemaDrift?.length) {
      parts.push(
        `Schema drift: ${result.schemaDrift.map((s) => `${s.toolName}.${s.field}`).join(', ')}`,
      );
    }
    return parts.length > 0 ? parts.join('. ') : null;
  };

  const handleImportTool = async (toolName: string) => {
    setImportingNames((prev) => new Set(prev).add(toolName));
    setActionError(null);
    try {
      const result = await discoverAndImportTools(projectId, serverId, [toolName]);
      const errorMsg = formatImportErrors(result);
      if (errorMsg) setActionError(errorMsg);
      await loadImportedTools();
      await discoverFromServer();
    } catch (err) {
      setActionError(sanitizeError(err, `Failed to import ${toolName}`));
    } finally {
      setImportingNames((prev) => {
        const next = new Set(prev);
        next.delete(toolName);
        return next;
      });
    }
  };

  const handleImportAll = async () => {
    const names = unifiedTools.filter((tool) => !tool.imported).map((tool) => tool.name);
    if (names.length === 0) {
      setActionError(t('all_imported'));
      return;
    }
    setImportingNames(new Set(names));
    setActionError(null);
    try {
      const result = await discoverAndImportTools(projectId, serverId, names);
      const errorMsg = formatImportErrors(result);
      if (errorMsg) setActionError(errorMsg);
      await loadImportedTools();
      await discoverFromServer();
    } catch (err) {
      setActionError(sanitizeError(err, 'Failed to import tools'));
    } finally {
      setImportingNames(new Set());
    }
  };

  const handleImportSelected = async () => {
    const names = Array.from(selectedNames).filter(
      (name) => !unifiedTools.find((t) => t.name === name)?.imported,
    );
    if (names.length === 0) return;
    setImportingNames(new Set(names));
    setActionError(null);
    try {
      const result = await discoverAndImportTools(projectId, serverId, names);
      const errorMsg = formatImportErrors(result);
      if (errorMsg) setActionError(errorMsg);
      await loadImportedTools();
      await discoverFromServer();
    } catch (err) {
      setActionError(sanitizeError(err, 'Failed to import selected tools'));
    } finally {
      setImportingNames(new Set());
      setSelectedNames(new Set());
    }
  };

  const handleRemoveTool = async (toolId: string) => {
    setRemovingIds((prev) => new Set(prev).add(toolId));
    setActionError(null);
    try {
      await deleteTool(projectId, toolId);
      await loadImportedTools();
    } catch (err) {
      setActionError(sanitizeError(err, 'Failed to remove tool'));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(toolId);
        return next;
      });
    }
  };

  // Build a single unified list matching discovered ↔ imported by raw MCP tool name.
  const importedByMcpName = new Map(
    importedTools.map((t) => [stripServerPrefix(t.toolName).toLowerCase(), t]),
  );

  const unifiedTools: UnifiedTool[] = (() => {
    const tools: UnifiedTool[] = [];
    const matchedMcpNames = new Set<string>();

    for (const d of discoveredTools) {
      const mcpName = d.name.toLowerCase();
      const imp = importedByMcpName.get(mcpName);
      if (imp) matchedMcpNames.add(mcpName);
      tools.push({
        name: d.name,
        displayName: d.name,
        description: d.description,
        imported: !!imp,
        importedToolId: imp?.id,
        stale: false,
      });
    }

    for (const t of importedTools) {
      const mcpName = stripServerPrefix(t.toolName).toLowerCase();
      if (!matchedMcpNames.has(mcpName)) {
        tools.push({
          name: stripServerPrefix(t.toolName),
          displayName: stripServerPrefix(t.toolName),
          description: t.description,
          imported: true,
          importedToolId: t.id,
          stale: true,
        });
      }
    }

    return tools;
  })();

  const importedCount = unifiedTools.filter((t) => t.imported).length;
  const availableCount = unifiedTools.filter((t) => !t.imported).length;

  const selectedImportableCount = Array.from(selectedNames).filter((name) => {
    const tool = unifiedTools.find((t) => t.name === name);
    return tool && !tool.imported;
  }).length;

  const toggleSelection = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const importedToolsList = unifiedTools.filter((t) => t.imported);
  const availableToolsList = unifiedTools.filter((t) => !t.imported);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  const renderToolRow = (tool: UnifiedTool) => (
    <div
      key={tool.name}
      className={clsx(
        'flex items-center gap-3 px-3 py-3 group',
        tool.imported && tool.importedToolId && 'cursor-pointer',
      )}
      onClick={() => {
        if (tool.imported && tool.importedToolId) {
          onNavigateToTool(tool.importedToolId);
        }
      }}
    >
      {/* Selection / Status indicator */}
      <div className="shrink-0 w-6 flex justify-center" onClick={(e) => e.stopPropagation()}>
        {tool.imported ? (
          <CheckCircle2 className="w-4 h-4 text-success" />
        ) : (
          <Checkbox
            checked={selectedNames.has(tool.name)}
            onChange={() => toggleSelection(tool.name)}
          />
        )}
      </div>

      {/* Tool info */}
      <div className="flex-1 min-w-0">
        <span
          className={clsx(
            'text-sm font-medium',
            tool.imported
              ? 'text-foreground group-hover:text-accent transition-default'
              : 'text-foreground',
          )}
        >
          {tool.displayName}
        </span>
        {tool.description && (
          <p className="text-xs text-muted truncate mt-0.5">{tool.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {tool.stale && <Badge variant="warning">{t('stale_label')}</Badge>}
        {tool.imported && tool.importedToolId ? (
          <button
            onClick={() => handleRemoveTool(tool.importedToolId!)}
            disabled={removingIds.has(tool.importedToolId)}
            className={clsx(
              'p-1 rounded text-muted opacity-0 group-hover:opacity-100 transition-default',
              removingIds.has(tool.importedToolId)
                ? 'cursor-not-allowed opacity-50'
                : 'hover:text-error hover:bg-error-subtle',
            )}
            title={t('remove_tool_hint')}
          >
            {removingIds.has(tool.importedToolId) ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleImportTool(tool.name)}
            disabled={importingNames.has(tool.name)}
            loading={importingNames.has(tool.name)}
          >
            {t('import_label')}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Top actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>{t('tools_count', { count: unifiedTools.length })}</span>
          <span className="text-border">·</span>
          <span className="text-success">{t('imported_count', { count: importedCount })}</span>
          {availableCount > 0 && (
            <>
              <span className="text-border">·</span>
              <span>{t('available_count', { count: availableCount })}</span>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={
            isSyncing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )
          }
          onClick={discoverFromServer}
          disabled={isSyncing}
        />
      </div>

      {/* Error banners */}
      {error && (
        <div className="p-3 rounded-lg bg-error-subtle border border-error/20 text-sm text-error flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}
      {discoverError && (
        <div className="p-3 rounded-lg bg-warning-subtle border border-warning/20 text-sm text-warning flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            {discoverError}. {t('showing_imported_only')}
          </span>
        </div>
      )}
      {actionError && (
        <div className="p-3 rounded-lg bg-error-subtle border border-error/20 text-sm text-error flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {actionError}
        </div>
      )}

      {unifiedTools.length === 0 ? (
        <EmptyState
          icon={<Wrench className="w-5 h-5" />}
          title={t('no_tools_found')}
          description={t('no_tools_hint')}
        />
      ) : (
        <div className="space-y-6">
          {/* ── Imported Tools Group ─────────────────────────────── */}
          {importedToolsList.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-4 h-4 text-success" />
                <h3 className="text-sm font-medium text-foreground">{t('group_imported')}</h3>
                <span className="text-xs text-muted">({importedToolsList.length})</span>
              </div>
              <div className="rounded-lg border border-default divide-y divide-default">
                {importedToolsList.map(renderToolRow)}
              </div>
            </div>
          )}

          {/* ── Available Tools Group ────────────────────────────── */}
          {availableToolsList.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-muted" />
                  <h3 className="text-sm font-medium text-foreground">{t('group_available')}</h3>
                  <span className="text-xs text-muted">({availableToolsList.length})</span>
                </div>
                <div className="flex items-center gap-2">
                  {selectedImportableCount > 0 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleImportSelected}
                      disabled={importingNames.size > 0}
                      loading={importingNames.size > 0}
                    >
                      {t('import_selected', { count: selectedImportableCount })}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleImportAll}
                      disabled={importingNames.size > 0}
                    >
                      {t('import_all', { count: availableToolsList.length })}
                    </Button>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-default divide-y divide-default">
                {availableToolsList.map(renderToolRow)}
              </div>
            </div>
          )}

          {/* All imported message */}
          {availableToolsList.length === 0 && importedToolsList.length > 0 && (
            <p className="text-xs text-muted text-center py-2">{t('all_imported')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Configuration Tab ──────────────────────────────────────────────────

interface ConfigurationTabProps {
  server: McpServer;
  projectId: string;
  serverId: string;
  onUpdated: () => Promise<void>;
  saveRef: MutableRefObject<(() => Promise<void>) | null>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}

function ConfigurationTab({
  server,
  projectId,
  serverId,
  onUpdated,
  saveRef,
  onDirtyChange,
  onSavingChange,
}: ConfigurationTabProps) {
  const t = useTranslations('mcp.detail');
  const tCreate = useTranslations('mcp.create_dialog');

  const AUTH_TYPE_OPTIONS = useMemo(
    () => [
      { value: 'none', label: tCreate('auth_none') },
      { value: 'bearer', label: tCreate('auth_bearer') },
      { value: 'api_key', label: tCreate('auth_api_key') },
      { value: 'custom_headers', label: tCreate('auth_custom_headers') },
      { value: 'oauth2_client_credentials', label: tCreate('auth_oauth2') },
    ],
    [tCreate],
  );

  const TRANSPORT_OPTIONS = useMemo(
    () => [
      { value: 'sse', label: tCreate('transport_sse') },
      { value: 'http', label: tCreate('transport_http') },
    ],
    [tCreate],
  );

  const [transport, setTransport] = useState<McpTransportType>(server.transport);
  const [url, setUrl] = useState(server.url || '');
  const [connectionTimeoutMs, setConnectionTimeoutMs] = useState(
    String(server.connectionTimeoutMs),
  );
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(String(server.requestTimeoutMs));
  const [autoReconnect, setAutoReconnect] = useState(server.autoReconnect);
  const [maxReconnectAttempts, setMaxReconnectAttempts] = useState(
    String(server.maxReconnectAttempts),
  );

  const [authType, setAuthType] = useState<McpAuthType>(server.authType || 'none');
  const [replacingAuth, setReplacingAuth] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('X-API-Key');
  const [authHeaderValue, setAuthHeaderValue] = useState('');
  const [authCustomHeaders, setAuthCustomHeaders] = useState<Array<{ key: string; value: string }>>(
    [],
  );
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState('');
  const [oauthScope, setOauthScope] = useState('');

  // Custom headers (separate from auth — plain-text, may contain {{session.X}} templates)
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>(() => {
    if (!server.headers) return [];
    return Object.entries(server.headers).map(([key, value]) => ({ key, value }));
  });
  const [customHeadersDirty, setCustomHeadersDirty] = useState(false);

  const [replacingEnv, setReplacingEnv] = useState(false);
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([]);

  const [priority, setPriority] = useState(String(server.priority));
  const [tags, setTags] = useState(server.tags.join(', '));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setTransport(server.transport);
    setUrl(server.url || '');
    setConnectionTimeoutMs(String(server.connectionTimeoutMs));
    setRequestTimeoutMs(String(server.requestTimeoutMs));
    setAutoReconnect(server.autoReconnect);
    setMaxReconnectAttempts(String(server.maxReconnectAttempts));
    setAuthType(server.authType || 'none');
    setReplacingAuth(false);
    setCustomHeaders(
      server.headers ? Object.entries(server.headers).map(([key, value]) => ({ key, value })) : [],
    );
    setCustomHeadersDirty(false);
    setReplacingEnv(false);
    setEnvPairs([]);
    setPriority(String(server.priority));
    setTags(server.tags.join(', '));
    setError(null);
    setSuccess(false);
  }, [server]);

  const urlError = (() => {
    if (!url.trim()) return undefined;
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
      return tCreate('url_protocol_error');
    return undefined;
  })();

  const isDirty = (() => {
    if (transport !== server.transport) return true;
    if (url.trim() !== (server.url || '')) return true;
    if (connectionTimeoutMs !== String(server.connectionTimeoutMs)) return true;
    if (requestTimeoutMs !== String(server.requestTimeoutMs)) return true;
    if (autoReconnect !== server.autoReconnect) return true;
    if (maxReconnectAttempts !== String(server.maxReconnectAttempts)) return true;
    if (priority !== String(server.priority)) return true;
    const newTags = tags
      ? tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    if (JSON.stringify(newTags) !== JSON.stringify(server.tags)) return true;
    if (replacingAuth) return true;
    if (replacingEnv) return true;
    if (customHeadersDirty) return true;
    return false;
  })();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const payload: Record<string, unknown> = {};

      if (transport !== server.transport) payload.transport = transport;
      if (url.trim() !== (server.url || '')) payload.url = url.trim() || null;
      const connTimeout = parseInt(connectionTimeoutMs, 10);
      if (!isNaN(connTimeout) && connTimeout !== server.connectionTimeoutMs)
        payload.connectionTimeoutMs = connTimeout;
      const reqTimeout = parseInt(requestTimeoutMs, 10);
      if (!isNaN(reqTimeout) && reqTimeout !== server.requestTimeoutMs)
        payload.requestTimeoutMs = reqTimeout;
      if (autoReconnect !== server.autoReconnect) payload.autoReconnect = autoReconnect;
      const maxReconn = parseInt(maxReconnectAttempts, 10);
      if (!isNaN(maxReconn) && maxReconn !== server.maxReconnectAttempts)
        payload.maxReconnectAttempts = maxReconn;
      const pri = parseInt(priority, 10);
      if (!isNaN(pri) && pri !== server.priority) payload.priority = pri;
      const newTags = tags
        ? tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      if (JSON.stringify(newTags) !== JSON.stringify(server.tags)) payload.tags = newTags;

      if (replacingAuth || server.authType === 'none') {
        if (authType !== 'none') {
          payload.authType = authType;
          // ABLP-913: when the user picks inline auth on a profile-backed server,
          // explicitly clear authProfileId. Without this, runtime registry keeps
          // resolving the stale profile and the new inline credentials are ignored.
          payload.authProfileId = null;
          switch (authType) {
            case 'bearer':
              payload.authConfig = { token: authToken };
              break;
            case 'api_key':
              payload.authConfig = { headerName: authHeaderName, value: authHeaderValue };
              break;
            case 'custom_headers':
              payload.authConfig = {
                headers: Object.fromEntries(
                  authCustomHeaders.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]),
                ),
              };
              break;
            case 'oauth2_client_credentials':
              payload.authConfig = {
                clientId: oauthClientId,
                clientSecret: oauthClientSecret,
                tokenEndpoint: oauthTokenEndpoint,
                ...(oauthScope ? { scope: oauthScope } : {}),
              };
              break;
          }
        } else if (replacingAuth) {
          payload.authType = 'none';
          // Switching to no-auth: also clear any lingering profile binding.
          payload.authProfileId = null;
        }
      }

      if (replacingEnv) {
        const env: Record<string, string> = {};
        for (const pair of envPairs) {
          if (pair.key.trim()) env[pair.key.trim()] = pair.value;
        }
        if (Object.keys(env).length > 0) payload.env = env;
      }

      // Custom headers (plain-text, not encrypted)
      if (customHeadersDirty) {
        const hdrs: Record<string, string> = {};
        for (const h of customHeaders) {
          if (h.key.trim()) hdrs[h.key.trim()] = h.value;
        }
        payload.headers = Object.keys(hdrs).length > 0 ? hdrs : null;
      }

      await updateMcpServer(projectId, serverId, payload as any);
      await onUpdated();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  saveRef.current = handleSave;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);

  const addEnvPair = () => setEnvPairs([...envPairs, { key: '', value: '' }]);
  const removeEnvPair = (index: number) => setEnvPairs(envPairs.filter((_, i) => i !== index));
  const updateEnvPair = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...envPairs];
    updated[index] = { ...updated[index], [field]: val };
    setEnvPairs(updated);
  };

  return (
    <div className="space-y-6">
      {success && (
        <div className="p-2.5 rounded-lg bg-success-subtle border border-success/20 text-xs text-success flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {t('config_saved')}
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-error-subtle border border-error/20 text-xs text-error flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Connection Settings */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('connection_label')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label={t('transport_label')}
            options={TRANSPORT_OPTIONS}
            value={transport}
            onChange={(v) => setTransport(v as McpTransportType)}
          />
          <Input
            label={t('server_url_label')}
            placeholder="https://mcp-server.example.com/sse"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={urlError}
          />
          <Input
            label={t('connection_timeout_label')}
            type="number"
            value={connectionTimeoutMs}
            onChange={(e) => setConnectionTimeoutMs(e.target.value)}
          />
          <Input
            label={t('request_timeout_label')}
            type="number"
            value={requestTimeoutMs}
            onChange={(e) => setRequestTimeoutMs(e.target.value)}
          />
          <div>
            <label className="text-xs font-medium text-muted block mb-1">
              {t('auto_reconnect_label')}
            </label>
            <button
              onClick={() => setAutoReconnect(!autoReconnect)}
              className={clsx(
                'text-sm font-medium cursor-pointer transition-default px-3 py-1.5 rounded-md border',
                autoReconnect
                  ? 'text-success border-success/30 bg-success-subtle'
                  : 'text-muted border-default bg-background-muted',
              )}
            >
              {autoReconnect ? t('enabled') : t('disabled')}
            </button>
          </div>
          <Input
            label={t('max_reconnect_label')}
            type="number"
            value={maxReconnectAttempts}
            onChange={(e) => setMaxReconnectAttempts(e.target.value)}
          />
        </div>
      </div>

      {/* Authentication */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('auth_label')}</h3>
          <span title={tCreate('auth_encrypted_hint')} className="text-muted cursor-help">
            <Lock className="w-3 h-3" />
          </span>
        </div>

        {server.authType !== 'none' && !replacingAuth ? (
          <div className="flex items-center justify-between p-2.5 rounded-md bg-background-muted border border-default">
            <div className="flex items-center gap-2 text-xs text-muted">
              <Lock className="w-3.5 h-3.5" />
              <span>
                {server.authType === 'bearer' && tCreate('auth_bearer_configured')}
                {server.authType === 'api_key' && tCreate('auth_api_key_configured')}
                {server.authType === 'custom_headers' && tCreate('auth_custom_configured')}
                {server.authType === 'oauth2_client_credentials' &&
                  tCreate('auth_oauth2_configured')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplacingAuth(true);
                setAuthType(server.authType);
              }}
              className="text-xs text-accent hover:text-accent/80 transition-default"
            >
              {tCreate('replace')}
            </button>
          </div>
        ) : (
          <>
            <Select
              options={AUTH_TYPE_OPTIONS}
              value={authType}
              onChange={(v) => setAuthType(v as McpAuthType)}
            />
            {authType === 'bearer' && (
              <div className="mt-2">
                <Input
                  label={tCreate('token_label')}
                  type="password"
                  placeholder={tCreate('token_placeholder')}
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                />
              </div>
            )}
            {authType === 'api_key' && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Input
                  label={tCreate('header_name_label')}
                  placeholder="X-API-Key"
                  value={authHeaderName}
                  onChange={(e) => setAuthHeaderName(e.target.value)}
                />
                <Input
                  label={tCreate('header_value_label')}
                  type="password"
                  placeholder={tCreate('api_key_placeholder')}
                  value={authHeaderValue}
                  onChange={(e) => setAuthHeaderValue(e.target.value)}
                />
              </div>
            )}
            {authType === 'custom_headers' && (
              <div className="mt-2 space-y-2">
                {authCustomHeaders.map((h, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                      placeholder="Header-Name"
                      value={h.key}
                      onChange={(e) => {
                        const updated = [...authCustomHeaders];
                        updated[i] = { ...updated[i], key: e.target.value };
                        setAuthCustomHeaders(updated);
                      }}
                    />
                    <input
                      type="password"
                      className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                      placeholder="value"
                      value={h.value}
                      onChange={(e) => {
                        const updated = [...authCustomHeaders];
                        updated[i] = { ...updated[i], value: e.target.value };
                        setAuthCustomHeaders(updated);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAuthCustomHeaders(authCustomHeaders.filter((_, idx) => idx !== i))
                      }
                      className="p-1 text-muted hover:text-error transition-default"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setAuthCustomHeaders([...authCustomHeaders, { key: '', value: '' }])
                  }
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-default"
                >
                  <Plus className="w-3 h-3" /> {tCreate('add_header')}
                </button>
              </div>
            )}
            {authType === 'oauth2_client_credentials' && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label={tCreate('client_id_label')}
                    placeholder={tCreate('client_id_placeholder')}
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                  />
                  <Input
                    label={tCreate('client_secret_label')}
                    type="password"
                    placeholder={tCreate('client_secret_placeholder')}
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                  />
                </div>
                <Input
                  label={tCreate('token_endpoint_label')}
                  placeholder={tCreate('token_endpoint_placeholder')}
                  value={oauthTokenEndpoint}
                  onChange={(e) => setOauthTokenEndpoint(e.target.value)}
                />
                <Input
                  label={tCreate('scope_label')}
                  placeholder={tCreate('scope_placeholder')}
                  value={oauthScope}
                  onChange={(e) => setOauthScope(e.target.value)}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Custom Headers (plain-text, may contain {{session.X}} templates) */}
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <div className="flex items-baseline gap-1.5">
            <h3 className="text-sm font-semibold text-foreground">
              {tCreate('custom_headers_label')}
            </h3>
            <span className="text-xs text-muted">({tCreate('custom_headers_hint')})</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => {
              setCustomHeaders([...customHeaders, { key: '', value: '' }]);
              setCustomHeadersDirty(true);
            }}
          >
            {tCreate('add_header')}
          </Button>
        </div>
        {customHeaders.length === 0 ? (
          <p className="text-xs text-muted">{tCreate('no_custom_headers_server')}</p>
        ) : (
          <div className="space-y-2">
            {customHeaders.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                  placeholder={tCreate('header_name_placeholder')}
                  value={h.key}
                  onChange={(e) => {
                    const updated = [...customHeaders];
                    updated[i] = { ...updated[i], key: e.target.value };
                    setCustomHeaders(updated);
                    setCustomHeadersDirty(true);
                  }}
                />
                <input
                  className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                  placeholder={tCreate('header_value_placeholder')}
                  value={h.value}
                  onChange={(e) => {
                    const updated = [...customHeaders];
                    updated[i] = { ...updated[i], value: e.target.value };
                    setCustomHeaders(updated);
                    setCustomHeadersDirty(true);
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setCustomHeaders(customHeaders.filter((_, idx) => idx !== i));
                    setCustomHeadersDirty(true);
                  }}
                  className="p-1 text-muted hover:text-error transition-default"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <details className="group mt-2">
          <summary className="text-xs text-muted cursor-pointer hover:text-foreground transition-default select-none inline-flex items-center gap-1.5">
            <span className="transition-transform duration-200 group-open:rotate-90">&#9654;</span>
            {tCreate('show_template_variables')}
          </summary>
          <div className="text-xs text-muted space-y-1 mt-2 ml-3">
            <ul className="list-disc list-inside space-y-0.5 ml-2">
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{session._metadata.key}}'}
                </code>{' '}
                — {tCreate('template_session_vars')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{secrets.KEY_NAME}}'}
                </code>{' '}
                — {tCreate('template_project_secrets')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{_context.userId}}'}
                </code>{' '}
                — {tCreate('template_context_vars')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{env.KEY_NAME}}'}
                </code>{' '}
                — {tCreate('template_env_vars')}
              </li>
            </ul>
            <p className="mt-1">{tCreate('template_resolved_at_runtime')}</p>
          </div>
        </details>
      </div>

      {/* Environment Variables */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-foreground">{t('env_label')}</h3>
            <span title={tCreate('env_encrypted_hint')} className="text-muted cursor-help">
              <Lock className="w-3 h-3" />
            </span>
          </div>
          {replacingEnv && (
            <button
              type="button"
              onClick={addEnvPair}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-default"
            >
              <Plus className="w-3 h-3" /> {tCreate('env_add')}
            </button>
          )}
        </div>
        {!replacingEnv ? (
          <div className="flex items-center justify-between p-2.5 rounded-md bg-background-muted border border-default">
            <div className="flex items-center gap-2 text-xs text-muted">
              <Lock className="w-3.5 h-3.5" />
              <span>{tCreate('env_configured')}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplacingEnv(true);
                setEnvPairs([]);
              }}
              className="text-xs text-accent hover:text-accent/80 transition-default"
            >
              {tCreate('replace_all')}
            </button>
          </div>
        ) : (
          <>
            {envPairs.length === 0 && <p className="text-xs text-muted">{tCreate('env_empty')}</p>}
            <div className="space-y-2">
              {envPairs.map((pair, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                    placeholder="KEY"
                    value={pair.key}
                    onChange={(e) => updateEnvPair(i, 'key', e.target.value)}
                  />
                  <input
                    type="password"
                    className="flex-1 px-2 py-1.5 text-sm rounded border border-default bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
                    placeholder="value"
                    value={pair.value}
                    onChange={(e) => updateEnvPair(i, 'value', e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvPair(i)}
                    className="p-1 text-muted hover:text-error transition-default"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Settings */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('settings_label')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label={t('priority_label')}
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
          <Input
            label={t('tags_label')}
            placeholder={t('tags_placeholder')}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>
      </div>

      {/* Status (read-only) */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('status_label')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ConfigField label={t('connection_status_label')}>
            <ConnectionStatusBadge status={server.lastConnectionStatus} />
          </ConfigField>
          <ConfigField label={t('imported_tools_label')}>
            <span className="text-sm text-foreground">{server.discoveredToolCount}</span>
          </ConfigField>
          {server.lastConnectionAt && (
            <ConfigField label={t('last_connected_label')}>
              <span className="text-sm text-foreground">
                {new Date(server.lastConnectionAt).toLocaleString()}
              </span>
            </ConfigField>
          )}
          {server.lastConnectionLatencyMs != null && (
            <ConfigField label={t('last_latency_label')}>
              <span className="text-sm text-foreground">{server.lastConnectionLatencyMs}ms</span>
            </ConfigField>
          )}
        </div>
        {server.lastConnectionError && (
          <div className="mt-3 p-2.5 rounded-md bg-error-subtle border border-error/20 text-xs text-error">
            {server.lastConnectionError}
          </div>
        )}
      </div>

      {/* Metadata (read-only) */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('metadata_label')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ConfigField label={t('created_label')}>
            <span className="text-sm text-foreground inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-muted" />
                {new Date(server.createdAt).toLocaleDateString()}
              </span>
              {server.createdBy && (
                <span className="inline-flex items-center gap-1 text-muted">
                  <User className="w-3.5 h-3.5" />
                  {server.createdBy}
                </span>
              )}
            </span>
          </ConfigField>
          <ConfigField label={t('updated_label')}>
            <span className="text-sm text-foreground inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-muted" />
                {new Date(server.updatedAt).toLocaleDateString()}
              </span>
              {server.modifiedBy && (
                <span className="inline-flex items-center gap-1 text-muted">
                  <User className="w-3.5 h-3.5" />
                  {server.modifiedBy}
                </span>
              )}
            </span>
          </ConfigField>
        </div>
      </div>
    </div>
  );
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted block mb-1">{label}</label>
      {children}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────

export function McpServerDetailPage() {
  const t = useTranslations('mcp.detail');

  const TABS = useMemo(
    () => [
      { id: 'overview', label: t('tab_overview') },
      { id: 'tools', label: t('tab_tools') },
    ],
    [t],
  );

  const SECTION_OPTIONS: SegmentOption[] = useMemo(
    () => [
      { id: 'tools', label: t('tab_tools'), icon: <Wrench className="w-3.5 h-3.5" /> },
      {
        id: 'configuration',
        label: t('tab_configuration'),
        icon: <Settings className="w-3.5 h-3.5" />,
      },
    ],
    [t],
  );
  const { currentProject } = useProjectStore();
  const { subPage: serverId, navigate } = useNavigationStore();
  const {
    currentServer,
    testResult: connectionTestResult,
    isTesting,
    setCurrentServer,
    setTestResult: setConnectionTestResult,
    setTesting,
    removeServer,
  } = useMcpServerStore();

  const projectId = currentProject?.id;

  const [activeSection, setActiveSection] = useState('tools');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const configSaveRef = useRef<(() => Promise<void>) | null>(null);

  // Inline editing state (matching ToolDetailPage pattern)
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);

  const loadServer = useCallback(async () => {
    if (!projectId || !serverId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMcpServer(projectId, serverId);
      setCurrentServer(result.server);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to load server'));
    } finally {
      setLoading(false);
    }
  }, [projectId, serverId, setCurrentServer]);

  useEffect(() => {
    loadServer();
    return () => {
      setCurrentServer(null);
      setConnectionTestResult(null);
    };
  }, [loadServer, setCurrentServer, setConnectionTestResult]);

  const handleTestConnection = async () => {
    if (!projectId || !serverId) return;
    setTesting(true);
    setConnectionTestResult(null);
    try {
      const res = await testMcpServerConnection(projectId, serverId);
      setConnectionTestResult(res.result);
      // Reload server to pick up persisted connection status for the Configuration tab
      await loadServer();
    } catch (err) {
      setConnectionTestResult({
        connected: false,
        error: sanitizeError(err, 'Connection test failed'),
        latencyMs: 0,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!projectId || !serverId) return;
    setDeleting(true);
    try {
      await deleteMcpServer(projectId, serverId);
      removeServer(serverId);
      navigate(`/projects/${projectId}/mcp-servers`);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to delete server'));
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  };

  const goBack = () => {
    if (projectId) navigate(`/projects/${projectId}/mcp-servers`);
  };

  const handleNavigateToTool = (toolId: string) => {
    if (projectId) navigate(`/projects/${projectId}/tools/${toolId}`);
  };

  // ─── Inline Editing Handlers ────────────────────────────────────────

  const startEditingName = () => {
    if (!currentServer) return;
    setEditName(currentServer.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const startEditingDescription = () => {
    setEditDescription(currentServer?.description || '');
    setEditingDescription(true);
    setTimeout(() => descInputRef.current?.focus(), 0);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setEditName('');
  };

  const cancelEditDescription = () => {
    setEditingDescription(false);
    setEditDescription('');
  };

  const saveInlineName = async () => {
    if (!projectId || !serverId || !currentServer) return;
    const trimmed = editName.trim();
    if (trimmed.length < 2) {
      setError(t('name_min_length'));
      return;
    }
    if (trimmed === currentServer.name) {
      setEditingName(false);
      return;
    }
    setSavingMeta(true);
    setError(null);
    try {
      await updateMcpServer(projectId, serverId, { name: trimmed });
      await loadServer();
      setEditingName(false);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to update name'));
    } finally {
      setSavingMeta(false);
    }
  };

  const saveInlineDescription = async () => {
    if (!projectId || !serverId || !currentServer) return;
    const trimmed = editDescription.trim();
    if (trimmed === (currentServer.description || '')) {
      setEditingDescription(false);
      return;
    }
    setSavingMeta(true);
    setError(null);
    try {
      await updateMcpServer(projectId, serverId, { description: trimmed || undefined } as any);
      await loadServer();
      setEditingDescription(false);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to update description'));
    } finally {
      setSavingMeta(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  if (error && !currentServer) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <button
            onClick={goBack}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-4"
          >
            <ArrowLeft className="w-4 h-4" /> {t('back')}
          </button>
          <div className="p-4 rounded-lg bg-error-subtle border border-error/20 text-sm text-error">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!currentServer) return null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={goBack}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-4"
          >
            <ArrowLeft className="w-4 h-4" /> {t('mcp_servers')}
          </button>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/* Title row: inline-editable name + badges */}
              <div className="flex items-center gap-2.5">
                {editingName ? (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <input
                      ref={nameInputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveInlineName();
                        if (e.key === 'Escape') cancelEditName();
                      }}
                      className="flex-1 min-w-0 text-2xl font-semibold text-foreground tracking-tight bg-transparent border-b-2 border-accent outline-none py-0.5"
                      disabled={savingMeta}
                    />
                    <button
                      onClick={saveInlineName}
                      disabled={savingMeta}
                      className="p-1 rounded text-success hover:bg-success-subtle transition-default"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={cancelEditName}
                      disabled={savingMeta}
                      className="p-1 rounded text-muted hover:bg-background-muted transition-default"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <h1
                    className="text-2xl font-semibold text-foreground truncate tracking-tight cursor-pointer group flex items-center gap-1.5 hover:text-accent transition-default"
                    onClick={startEditingName}
                    title={t('click_edit_name')}
                  >
                    {currentServer.name}
                    <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-60 transition-default shrink-0" />
                  </h1>
                )}
                <TransportBadge transport={currentServer.transport} />
                <ConnectionStatusBadge status={currentServer.lastConnectionStatus} />
              </div>

              {/* Description: inline-editable below title */}
              <div className="mt-2">
                {editingDescription ? (
                  <div className="flex items-start gap-1.5">
                    <textarea
                      ref={descInputRef}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveInlineDescription();
                        if (e.key === 'Escape') cancelEditDescription();
                      }}
                      rows={2}
                      className="flex-1 text-sm text-muted bg-transparent border-b-2 border-accent outline-none resize-none py-0.5"
                      placeholder={t('describe_server')}
                      disabled={savingMeta}
                    />
                    <button
                      onClick={saveInlineDescription}
                      disabled={savingMeta}
                      className="p-1 rounded text-success hover:bg-success-subtle transition-default mt-0.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={cancelEditDescription}
                      disabled={savingMeta}
                      className="p-1 rounded text-muted hover:bg-background-muted transition-default mt-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <p
                    className="text-sm text-muted cursor-pointer group flex items-center gap-1.5 hover:text-foreground transition-default"
                    onClick={startEditingDescription}
                    title={t('click_edit_description')}
                  >
                    {currentServer.description || t('add_description')}
                    <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-default shrink-0" />
                  </p>
                )}
              </div>

              <div className="flex items-center gap-4 mt-2 text-xs text-muted flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="w-3 h-3" />
                  {t('created_label')} {new Date(currentServer.createdAt).toLocaleDateString()}
                  {currentServer.createdBy && (
                    <span className="inline-flex items-center gap-1 ml-0.5">
                      <User className="w-3 h-3" /> {currentServer.createdBy}
                    </span>
                  )}
                </span>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1.5">
                  <Pencil className="w-3 h-3" />
                  {t('updated_label')} {new Date(currentServer.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <AnimatePresence>
              {activeSection === 'configuration' && (
                <motion.div
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2 shrink-0"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={
                      isTesting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Plug className="w-4 h-4" />
                      )
                    }
                    onClick={handleTestConnection}
                    disabled={isTesting}
                  >
                    {t('test_label')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 className="w-4 h-4" />}
                    onClick={() => setShowDelete(true)}
                  >
                    {t('delete_label')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Check className="w-4 h-4" />}
                    onClick={() => configSaveRef.current?.()}
                    disabled={!configDirty || configSaving}
                    loading={configSaving}
                  >
                    {t('save_changes')}
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Connection test result banner */}
        {connectionTestResult && (
          <div
            className={clsx(
              'mb-6 p-3 rounded-lg border text-sm flex items-center gap-2',
              connectionTestResult.connected
                ? 'bg-success-subtle border-success/20 text-success'
                : 'bg-error-subtle border-error/20 text-error',
            )}
          >
            {connectionTestResult.connected ? (
              <>
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  {t('test_success', { toolCount: connectionTestResult.toolCount ?? 0 })}
                  <span className="text-muted ml-2">
                    {t('test_latency', { latencyMs: connectionTestResult.latencyMs })}
                  </span>
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 shrink-0" />
                <span>{t('test_failed', { error: connectionTestResult.error ?? '' })}</span>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 text-sm text-error">
            {error}
          </div>
        )}

        {/* Segmented Control Navigation */}
        <div className="flex justify-center mb-6">
          <SegmentedControl
            options={SECTION_OPTIONS}
            value={activeSection}
            onChange={setActiveSection}
            size="md"
          />
        </div>

        {/* Bordered content area */}
        <div className="relative min-h-[400px] rounded-lg border border-default bg-background-elevated p-5 sm:p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
              {activeSection === 'tools' && projectId && serverId && (
                <ToolsTab
                  projectId={projectId}
                  serverId={serverId}
                  onNavigateToTool={handleNavigateToTool}
                />
              )}
              {activeSection === 'configuration' && projectId && serverId && (
                <ConfigurationTab
                  server={currentServer}
                  projectId={projectId}
                  serverId={serverId}
                  onUpdated={loadServer}
                  saveRef={configSaveRef}
                  onDirtyChange={setConfigDirty}
                  onSavingChange={setConfigSaving}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Delete confirm */}
      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title={t('delete_title')}
        description={t('delete_description', {
          name: currentServer.name,
          toolCount: currentServer.discoveredToolCount,
        })}
        confirmLabel={t('delete_confirm')}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
