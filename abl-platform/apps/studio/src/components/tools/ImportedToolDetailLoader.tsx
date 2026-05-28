'use client';

/**
 * ImportedToolDetailLoader
 *
 * Full-page read-only detail view for an imported tool.
 * Finds the matching tool from useImportedSymbols() and renders
 * type, description, parameters, return type, API details, and requirements.
 *
 * Includes an integrated TestToolDialog so users can test imported tools
 * directly from the detail page without external wiring.
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Wrench,
  Package,
  Lock,
  Copy,
  FlaskConical,
  Globe,
  Key,
  Settings,
  CheckCircle,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { DetailPageShell } from '../ui/DetailPageShell';
import { ReadOnlySection } from '../ui/ReadOnlySection';
import { TestToolDialog } from './TestToolDialog';
import type { ImportedTool } from '../../hooks/useImportedSymbols';
import { useImportedSymbols } from '../../hooks/useImportedSymbols';
import type { ToolTestResult, ToolWithVersion } from '../../store/tool-store';
import { apiFetch, handleResponse } from '../../lib/api-client';

interface ImportedToolDetailLoaderProps {
  alias: string;
  toolName: string;
  projectId: string;
  onBack: () => void;
  /** Optional external test handler; if omitted the built-in dialog is used */
  onTest?: () => void;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ImportedToolDetailLoader({
  alias,
  toolName,
  projectId,
  onBack,
  onTest,
}: ImportedToolDetailLoaderProps) {
  const t = useTranslations('tools.imported_detail');
  const { tools } = useImportedSymbols();

  const tool: ImportedTool | undefined = useMemo(
    () => tools.find((t) => t.alias === alias && t.name === toolName),
    [tools, alias, toolName],
  );

  const mountedName = tool ? `${tool.alias}__${tool.name}` : '';

  // ---------------------------------------------------------------------------
  // Test dialog state & helpers
  // ---------------------------------------------------------------------------

  const [testDialogOpen, setTestDialogOpen] = useState(false);

  /** Build a JSON-Schema-like object from the imported tool parameters */
  const inputSchema = useMemo(() => {
    if (!tool?.parameters?.length) return undefined;
    return {
      type: 'object' as const,
      properties: Object.fromEntries(
        tool.parameters.map((p) => [
          p.name,
          { type: p.type || 'string', description: p.description },
        ]),
      ),
      required: tool.parameters.filter((p) => p.required).map((p) => p.name),
    };
  }, [tool]);

  /**
   * Shim the ImportedTool into the ToolWithVersion shape that TestToolDialog
   * requires. Only the fields the dialog actually reads are populated.
   */
  const toolShim: ToolWithVersion | undefined = useMemo(() => {
    if (!tool) return undefined;
    return {
      id: `${tool.dependencyId}__${tool.name}`,
      name: tool.name,
      slug: tool.name,
      toolType: (tool.toolType ?? 'http') as ToolWithVersion['toolType'],
      description: tool.description ?? null,
      dslContent: '',
      sourceHash: '',
      variableNamespaceIds: [],
      projectId,
      createdBy: '',
      lastEditedBy: null,
      createdAt: '',
      updatedAt: '',
    };
  }, [tool, projectId]);

  /** Call the module-tool test API endpoint */
  const handleTest = useCallback(
    async (input: Record<string, unknown>): Promise<ToolTestResult> => {
      if (!tool) throw new Error('Tool not loaded');
      const response = await apiFetch(
        `/api/projects/${projectId}/module-tools/${tool.dependencyId}/${tool.name}/test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
        },
      );
      const data = await handleResponse<{ success: boolean; result: ToolTestResult }>(response);
      return data.result;
    },
    [tool, projectId],
  );

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  if (!tool) {
    return (
      <DetailPageShell title={t('title')} backTo={{ label: t('back'), onClick: onBack }}>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Wrench className="w-10 h-10 text-muted mb-3" />
          <p className="text-sm text-muted">
            {t('not_found_description', { alias, name: toolName })}
          </p>
        </div>
      </DetailPageShell>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const hasApiDetails = tool.endpoint || tool.method || tool.authProfileRef;
  const hasRequirements =
    (tool.requiredEnvVars && tool.requiredEnvVars.length > 0) || tool.authProfileRef;

  return (
    <DetailPageShell
      title={`${tool.alias}.${tool.name}`}
      backTo={{ label: t('back'), onClick: onBack }}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={onTest ?? (() => setTestDialogOpen(true))}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 transition-colors text-sm font-medium"
          >
            <FlaskConical className="w-4 h-4" />
            {t('test_tool')}
          </button>
          <Badge variant="purple" appearance="outlined">
            <Lock className="w-3 h-3 mr-1" />
            Imported
          </Badge>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Provenance banner */}
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 flex items-center gap-3">
          <Package className="w-5 h-5 text-accent shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground">{tool.moduleProjectName}</span>
            <div className="text-xs text-muted mt-0.5">
              Alias: <code className="bg-muted px-1 py-0.5 rounded">{tool.alias}</code>
              {tool.resolvedVersion && (
                <span className="ml-2">&middot; Version {tool.resolvedVersion}</span>
              )}
            </div>
          </div>
        </div>

        {/* Read-only notice */}
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <p className="text-xs text-warning">{t('read_only_notice')}</p>
        </div>

        {/* Overview */}
        <ReadOnlySection title={t('overview')}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t('name')}
                </label>
                <p className="text-sm text-foreground">{tool.name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t('type')}
                </label>
                <div>
                  {tool.toolType ? (
                    <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {tool.toolType}
                    </span>
                  ) : (
                    <span className="text-sm text-muted italic">Not specified</span>
                  )}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                {t('description')}
              </label>
              <p className="text-sm text-foreground">
                {tool.description ?? (
                  <span className="italic text-muted">{t('no_description')}</span>
                )}
              </p>
            </div>

            {tool.returnType && (
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  Return Type
                </label>
                <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
                  {tool.returnType}
                </code>
              </div>
            )}
          </div>
        </ReadOnlySection>

        {/* Parameters */}
        <ReadOnlySection title={t('parameters')}>
          {tool.parameters && tool.parameters.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-default">
                    <th className="text-left py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">
                      {t('param_name')}
                    </th>
                    <th className="text-left py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">
                      {t('param_type')}
                    </th>
                    <th className="text-left py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">
                      {t('param_required')}
                    </th>
                    <th className="text-left py-2 text-xs font-medium text-muted uppercase tracking-wide">
                      {t('param_description')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tool.parameters.map((param) => (
                    <tr key={param.name} className="border-b border-default/50">
                      <td className="py-2 pr-4">
                        <code className="text-sm font-mono">{param.name}</code>
                      </td>
                      <td className="py-2 pr-4">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                          {param.type}
                        </code>
                      </td>
                      <td className="py-2 pr-4">
                        {param.required ? (
                          <CheckCircle className="w-4 h-4 text-success" />
                        ) : (
                          <span className="text-xs text-muted">optional</span>
                        )}
                      </td>
                      <td className="py-2 text-muted">
                        {param.description ?? <span className="italic text-subtle">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted italic">{t('no_parameters')}</p>
          )}
        </ReadOnlySection>

        {/* API Details */}
        {hasApiDetails && (
          <ReadOnlySection title={t('api_details')}>
            <div className="space-y-3">
              {tool.endpoint && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    {t('endpoint')}
                  </label>
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-muted shrink-0" />
                    <code className="text-sm bg-muted px-2 py-1 rounded font-mono break-all">
                      {tool.endpoint}
                    </code>
                  </div>
                </div>
              )}
              {tool.method && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    {t('method')}
                  </label>
                  <Badge variant="accent" appearance="outlined">
                    {tool.method.toUpperCase()}
                  </Badge>
                </div>
              )}
              {tool.authProfileRef && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    {t('auth_profile')}
                  </label>
                  <div className="flex items-center gap-2">
                    <Key className="w-4 h-4 text-muted shrink-0" />
                    <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
                      {tool.authProfileRef}
                    </code>
                  </div>
                </div>
              )}
            </div>
          </ReadOnlySection>
        )}

        {/* Requirements */}
        {hasRequirements && (
          <ReadOnlySection title={t('requirements')}>
            <div className="space-y-3">
              {tool.requiredEnvVars && tool.requiredEnvVars.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-2">
                    {t('required_env_vars')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {tool.requiredEnvVars.map((envVar) => (
                      <span
                        key={envVar}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-background-muted text-sm font-mono border border-default"
                      >
                        <Settings className="w-3.5 h-3.5 text-muted" />
                        {envVar}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {tool.authProfileRef && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-2">
                    {t('auth_profile')}
                  </label>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-background-muted text-sm font-mono border border-default">
                    <Key className="w-3.5 h-3.5 text-muted" />
                    {tool.authProfileRef}
                  </span>
                </div>
              )}
            </div>
          </ReadOnlySection>
        )}

        {/* Runtime Name */}
        <ReadOnlySection title={t('runtime_name')}>
          <div className="flex items-center gap-2">
            <code className="text-sm bg-muted px-3 py-1.5 rounded font-mono flex-1">
              {mountedName}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(mountedName)}
              className="text-muted hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors"
              title={t('copy_runtime_name')}
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted mt-2">Use this name to reference the tool in ABL</p>
        </ReadOnlySection>
      </div>

      {/* Test Tool Dialog */}
      {testDialogOpen && toolShim && (
        <TestToolDialog
          open={testDialogOpen}
          onClose={() => setTestDialogOpen(false)}
          tool={toolShim}
          inputSchema={inputSchema}
          onTest={handleTest}
        />
      )}
    </DetailPageShell>
  );
}
