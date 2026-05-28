'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Code, Globe, Server, Zap, Copy, CheckCircle, Package, Lock } from 'lucide-react';
import { BasePickerModal, type PickerItem, type PickerTab } from './BasePickerModal';
import { ToolTypeBadge } from '../../tools/ToolTypeBadge';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { fetchTools } from '../../../api/tools';
import type { ToolType, ToolWithVersion } from '../../../store/tool-store';
import { useFeatures } from '../../../hooks/use-features';
import { useImportedSymbols, type ImportedTool } from '../../../hooks/useImportedSymbols';
import { buildToolSignatureSnippet, buildImportedToolReferenceSnippet } from '../tool-snippets';

const KNOWN_TOOL_TYPES: Set<string> = new Set<string>([
  'http',
  'sandbox',
  'mcp',
  'searchai',
  'workflow',
]);
function isToolType(value: string | undefined): value is ToolType {
  return value !== undefined && KNOWN_TOOL_TYPES.has(value);
}

interface ToolPickerItem extends PickerItem {
  toolData?: ToolWithVersion;
  importedData?: ImportedTool;
  isImported?: boolean;
}

interface ToolPickerModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onInsert: (snippet: string) => void;
}

const TOOL_TAB_FILTERS: Record<string, ((item: PickerItem) => boolean) | undefined> = {
  all: undefined,
  http: (item) => (item as ToolPickerItem).toolData?.toolType === 'http',
  mcp: (item) => (item as ToolPickerItem).toolData?.toolType === 'mcp',
  sandbox: (item) => (item as ToolPickerItem).toolData?.toolType === 'sandbox',
  searchai: (item) => (item as ToolPickerItem).toolData?.toolType === 'searchai',
  imported: (item) => Boolean((item as ToolPickerItem).isImported),
};

export function ToolPickerModal({ open, onClose, projectId, onInsert }: ToolPickerModalProps) {
  const t = useTranslations('tools.picker');
  const { hasCodeTools } = useFeatures();
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { tools: importedTools } = useImportedSymbols();

  const toolTabs: PickerTab[] = useMemo(
    () => [
      { id: 'all', label: t('tab_all') },
      { id: 'http', label: t('tab_http'), filter: TOOL_TAB_FILTERS.http },
      { id: 'mcp', label: t('tab_mcp'), filter: TOOL_TAB_FILTERS.mcp },
      ...(hasCodeTools
        ? [{ id: 'sandbox', label: t('tab_sandbox'), filter: TOOL_TAB_FILTERS.sandbox }]
        : []),
      { id: 'searchai', label: t('tab_searchai'), filter: TOOL_TAB_FILTERS.searchai },
      { id: 'imported', label: t('tab_imported'), filter: TOOL_TAB_FILTERS.imported },
    ],
    [t, hasCodeTools],
  );

  const loadTools = () => {
    setLoading(true);
    setError(null);
    fetchTools(projectId, { limit: 200 })
      .then((result) => {
        setTools(result.data);
        setError(null);
      })
      .catch(() => {
        setError(t('error_load'));
        setTools([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    loadTools();
  }, [open, projectId]);

  const pickerItems: ToolPickerItem[] = useMemo(() => {
    const projectItems: ToolPickerItem[] = tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description ?? undefined,
      category: tool.toolType.toUpperCase(),
      toolData: tool,
    }));

    const importedItems: ToolPickerItem[] = importedTools.map((it) => ({
      id: `imported-${it.dependencyId}-${it.name}`,
      name: `${it.alias}.${it.name}`,
      description: it.description ?? it.moduleProjectName,
      category: 'IMPORTED',
      importedData: it,
      isImported: true,
    }));

    return [...projectItems, ...importedItems];
  }, [tools, importedTools]);

  const generateSnippet = (item: ToolPickerItem): string => {
    if (item.isImported && item.importedData) {
      return buildImportedToolReferenceSnippet(item.importedData.alias, item.importedData.name);
    }
    if (item.toolData) {
      return buildToolSignatureSnippet(item.toolData);
    }
    return '';
  };

  const handleCopy = (snippet: string) => {
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderItem = (item: ToolPickerItem, _isSelected: boolean) => {
    if (item.isImported && item.importedData) {
      const it = item.importedData;
      return (
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Lock className="w-3 h-3 text-subtle flex-shrink-0" />
              <span
                className="font-mono text-sm font-medium text-foreground truncate"
                title={`${it.alias}.${it.name}`}
              >
                {it.alias}.{it.name}
              </span>
              {isToolType(it.toolType) ? (
                <ToolTypeBadge type={it.toolType} />
              ) : (
                <Badge variant="purple" className="text-xs">
                  {t('tab_imported')}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted mt-0.5 truncate">{it.moduleProjectName}</p>
          </div>
        </div>
      );
    }

    const tool = item.toolData;
    if (!tool) return null;
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">{tool.name}</span>
            <ToolTypeBadge type={tool.toolType} />
          </div>
          {tool.description && (
            <p className="text-xs text-muted mt-0.5 truncate">{tool.description}</p>
          )}
        </div>
      </div>
    );
  };

  const renderPreview = (item: ToolPickerItem | null) => {
    if (!item) {
      return <div className="text-center text-muted">{t('select_preview')}</div>;
    }

    if (item.isImported && item.importedData) {
      const it = item.importedData;
      const snippet = generateSnippet(item);
      return (
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Package className="w-5 h-5 text-purple" />
              <h3 className="text-lg font-semibold text-foreground">
                {it.alias}.{it.name}
              </h3>
              <Lock className="w-4 h-4 text-subtle" />
            </div>
            <p className="text-sm text-muted">{it.moduleProjectName}</p>
          </div>

          <div className="space-y-2 text-sm">
            {it.toolType && (
              <div className="flex items-center gap-2">
                <span className="text-subtle">{t('type_label')}</span>
                <span className="text-foreground font-medium">{it.toolType.toUpperCase()}</span>
              </div>
            )}
            {it.resolvedVersion && (
              <div className="flex items-center gap-2">
                <span className="text-subtle">{t('imported_version')}</span>
                <span className="text-foreground">{it.resolvedVersion}</span>
              </div>
            )}
            {it.description && (
              <div className="flex items-center gap-2">
                <span className="text-subtle">{t('imported_description')}</span>
                <span className="text-foreground">{it.description}</span>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-foreground">{t('generated_dsl')}</h4>
              <button
                onClick={() => handleCopy(snippet)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
              >
                {copied ? (
                  <>
                    <CheckCircle className="w-3 h-3" />
                    <span>{t('copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>{t('copy')}</span>
                  </>
                )}
              </button>
            </div>
            <pre className="p-4 bg-background-muted border border-default rounded-lg text-xs font-mono text-foreground overflow-x-auto">
              {snippet}
            </pre>
          </div>

          <Button
            variant="primary"
            size="md"
            className="w-full"
            onClick={() => {
              onInsert(snippet);
              onClose();
            }}
          >
            {t('insert_tool')}
          </Button>
        </div>
      );
    }

    const tool = item.toolData;
    if (!tool) {
      return <div className="text-center text-muted">{t('select_preview')}</div>;
    }
    const snippet = generateSnippet(item);

    return (
      <div className="space-y-4">
        {/* Tool header */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-lg font-semibold text-foreground">{tool.name}</h3>
            <ToolTypeBadge type={tool.toolType} />
          </div>
          {tool.description && <p className="text-sm text-muted">{tool.description}</p>}
        </div>

        {/* Metadata */}
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-subtle">{t('type_label')}</span>
            <span className="text-foreground font-medium">{tool.toolType.toUpperCase()}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-subtle">{t('last_updated')}</span>
            <span className="text-foreground">{new Date(tool.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        {/* Generated DSL */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-foreground">{t('generated_dsl')}</h4>
            <button
              onClick={() => handleCopy(snippet)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
            >
              {copied ? (
                <>
                  <CheckCircle className="w-3 h-3" />
                  <span>{t('copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>{t('copy')}</span>
                </>
              )}
            </button>
          </div>
          <pre className="p-4 bg-background-muted border border-default rounded-lg text-xs font-mono text-foreground overflow-x-auto">
            {snippet}
          </pre>
        </div>

        {/* Insert button */}
        <Button
          variant="primary"
          size="md"
          className="w-full"
          onClick={() => {
            onInsert(snippet);
            onClose();
          }}
        >
          {t('insert_tool')}
        </Button>
      </div>
    );
  };

  // Show error state if loading failed
  if (error) {
    return (
      <BasePickerModal
        open={open}
        onClose={onClose}
        title={t('insert_tool')}
        searchPlaceholder={t('search_placeholder')}
        tabs={toolTabs}
        items={[]}
        renderItem={() => null}
        renderPreview={() => (
          <div className="flex flex-col items-center justify-center h-full space-y-4">
            <Plus className="w-12 h-12 text-error" />
            <div className="text-center">
              <p className="text-sm text-muted mb-4">{error}</p>
              <Button variant="primary" onClick={loadTools}>
                {t('retry')}
              </Button>
            </div>
          </div>
        )}
        onSelect={() => {}}
        emptyMessage={t('error_load')}
        loading={false}
      />
    );
  }

  const createOptions = [
    {
      id: 'http',
      label: t('create_http'),
      icon: <Globe className="w-4 h-4" />,
      onClick: () => {
        // TODO: Open HTTP tool creation form
        console.log('Create HTTP tool');
      },
    },
    {
      id: 'mcp',
      label: t('create_mcp'),
      icon: <Server className="w-4 h-4" />,
      onClick: () => {
        // TODO: Open MCP tool creation form
        console.log('Create MCP tool');
      },
    },
    {
      id: 'sandbox',
      label: t('create_sandbox'),
      icon: <Code className="w-4 h-4" />,
      onClick: () => {
        // TODO: Open Sandbox tool creation form
        console.log('Create Sandbox tool');
      },
    },
    {
      id: 'lambda',
      label: t('create_lambda'),
      icon: <Zap className="w-4 h-4" />,
      onClick: () => {
        // TODO: Open Lambda tool creation form
        console.log('Create Lambda tool');
      },
    },
  ];

  const filteredCreateOptions = createOptions.filter((opt) => opt.id !== 'sandbox' || hasCodeTools);

  const footer = (
    <div className="flex items-center gap-4 text-xs text-subtle">
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">↑↓</kbd>{' '}
        {t('navigate_hint')}
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">⏎</kbd>{' '}
        {t('insert_hint')}
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">Esc</kbd>{' '}
        {t('close_hint')}
      </span>
    </div>
  );

  return (
    <BasePickerModal
      open={open}
      onClose={onClose}
      title={t('insert_tool')}
      searchPlaceholder={t('search_placeholder')}
      tabs={toolTabs}
      items={pickerItems}
      categories={['HTTP', 'MCP', 'SANDBOX', 'SEARCHAI', 'IMPORTED']}
      renderItem={renderItem}
      renderPreview={renderPreview}
      onSelect={(item) => {
        const snippet = generateSnippet(item);
        onInsert(snippet);
        onClose();
      }}
      createOptions={filteredCreateOptions}
      footer={footer}
      emptyMessage={t('empty_state')}
      loading={loading}
    />
  );
}
