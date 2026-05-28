/**
 * ToolPickerDialog Component
 *
 * Browsable dialog for searching and inserting tool signature references
 * into the ABL editor. Lets users discover available project tools and
 * insert their signatures into the TOOLS section.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Wrench, Server, ChevronDown, ChevronRight, Lock, Package } from 'lucide-react';
import clsx from 'clsx';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ToolTypeBadge } from '../tools/ToolTypeBadge';
import { fetchTools } from '../../api/tools';
import type { ToolWithVersion } from '../../store/tool-store';
import { useImportedSymbols, type ImportedTool } from '../../hooks/useImportedSymbols';
import { buildImportedToolReferenceSnippet, buildToolSignatureSnippet } from './tool-snippets';

interface ToolPickerDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onInsert: (snippet: string) => void;
}

export function ToolPickerDialog({ open, onClose, projectId, onInsert }: ToolPickerDialogProps) {
  const t = useTranslations('agent_editor.tool_picker');
  const tm = useTranslations('modules.badges');
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const { tools: importedTools } = useImportedSymbols();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchTools(projectId, { limit: 200 })
      .then((result) => setTools(result.data))
      .catch(() => setTools([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const filtered = useMemo(() => {
    if (!search) return tools;
    const q = search.toLowerCase();
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) || (tool.description || '').toLowerCase().includes(q),
    );
  }, [tools, search]);

  // Filter imported tools by search query
  const filteredImported = useMemo(() => {
    if (!search) return importedTools;
    const q = search.toLowerCase();
    return importedTools.filter(
      (it) => it.name.toLowerCase().includes(q) || it.alias.toLowerCase().includes(q),
    );
  }, [importedTools, search]);

  // Group MCP tools by server name
  const { mcpGroups, otherTools } = useMemo(() => {
    const groups = new Map<string, ToolWithVersion[]>();
    const other: ToolWithVersion[] = [];
    for (const tool of filtered) {
      if (tool.toolType === 'mcp' && tool.name.includes('__')) {
        const serverName = tool.name.split('__')[0];
        if (!groups.has(serverName)) groups.set(serverName, []);
        groups.get(serverName)!.push(tool);
      } else {
        other.push(tool);
      }
    }
    return { mcpGroups: Array.from(groups.entries()), otherTools: other };
  }, [filtered]);

  const handleInsert = useCallback(
    (tool: ToolWithVersion) => {
      onInsert(buildToolSignatureSnippet(tool));
      onClose();
      setSearch('');
    },
    [onInsert, onClose],
  );

  const handleInsertImported = useCallback(
    (importedTool: ImportedTool) => {
      onInsert(buildImportedToolReferenceSnippet(importedTool.alias, importedTool.name));
      onClose();
      setSearch('');
    },
    [onInsert, onClose],
  );

  const hasResults = filtered.length > 0 || filteredImported.length > 0;

  return (
    <Dialog
      open={open}
      onClose={() => {
        onClose();
        setSearch('');
      }}
      title={t('title')}
      description={t('description')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        <Input
          placeholder={t('search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          icon={<Search className="w-4 h-4" />}
          autoFocus
        />

        <div className="max-h-[360px] overflow-y-auto space-y-2 pr-2">
          {loading ? (
            <div className="text-center py-8 text-sm text-muted">{t('loading')}</div>
          ) : !hasResults ? (
            <div className="text-center py-8">
              <Wrench className="w-6 h-6 text-muted mx-auto mb-2" />
              <p className="text-sm text-muted">{search ? t('no_match') : t('no_tools')}</p>
            </div>
          ) : (
            <>
              {/* Non-MCP tools */}
              {otherTools.map((tool) => (
                <PickerToolRow key={tool.id} tool={tool} onInsert={handleInsert} />
              ))}

              {/* MCP tools grouped by server */}
              {mcpGroups.map(([serverName, serverTools]) => (
                <PickerServerGroup
                  key={serverName}
                  serverName={serverName}
                  tools={serverTools}
                  onInsert={handleInsert}
                />
              ))}

              {/* Imported module tools */}
              {filteredImported.length > 0 && (
                <ImportedToolsGroup
                  tools={filteredImported}
                  onInsert={handleInsertImported}
                  importedLabel={tm('imported')}
                />
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function PickerServerGroup({
  serverName,
  tools,
  onInsert,
}: {
  serverName: string;
  tools: ToolWithVersion[];
  onInsert: (tool: ToolWithVersion) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'bg-background-subtle hover:bg-background-muted transition-default',
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted" />
        )}
        <Server className="w-3 h-3 text-purple" />
        <span className="text-xs font-medium text-foreground">{serverName}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-subtle text-purple font-medium">
          {tools.length}
        </span>
      </button>
      {isOpen && (
        <div className="space-y-1 px-2 py-1.5">
          {tools.map((tool) => (
            <PickerToolRow
              key={tool.id}
              tool={tool}
              onInsert={onInsert}
              displayName={tool.name.split('__').slice(1).join('__')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ImportedToolsGroup({
  tools,
  onInsert,
  importedLabel,
}: {
  tools: ImportedTool[];
  onInsert: (tool: ImportedTool) => void;
  importedLabel: string;
}) {
  const t = useTranslations('agent_editor.tool_picker');
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'bg-background-subtle hover:bg-background-muted transition-default',
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted" />
        )}
        <Package className="w-3 h-3 text-purple" />
        <span className="text-xs font-medium text-foreground">{importedLabel}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-subtle text-purple font-medium">
          {tools.length}
        </span>
      </button>
      {isOpen && (
        <div className="space-y-1 px-2 py-1.5">
          {tools.map((importedTool) => (
            <div
              key={`${importedTool.dependencyId}-${importedTool.name}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-default bg-background-subtle hover:bg-background-muted transition-default"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono text-sm font-medium text-foreground truncate"
                    title={`${importedTool.alias}.${importedTool.name}`}
                  >
                    {importedTool.alias}.{importedTool.name}
                  </span>
                  <Badge variant="purple" className="text-xs">
                    {importedLabel}
                  </Badge>
                  <Lock className="w-3 h-3 text-subtle" />
                </div>
                <p className="text-xs text-muted mt-0.5 truncate">
                  {importedTool.moduleProjectName}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => onInsert(importedTool)}>
                {t('insert')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PickerToolRow({
  tool,
  onInsert,
  displayName,
}: {
  tool: ToolWithVersion;
  onInsert: (tool: ToolWithVersion) => void;
  displayName?: string;
}) {
  const t = useTranslations('agent_editor.tool_picker');
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-default bg-background-subtle hover:bg-background-muted transition-default">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-sm font-medium text-foreground truncate"
            title={displayName ?? tool.name}
          >
            {displayName ?? tool.name}
          </span>
          <ToolTypeBadge type={tool.toolType} />
        </div>
        {tool.description && (
          <p className="text-xs text-muted mt-0.5 truncate">{tool.description}</p>
        )}
      </div>
      <Button variant="secondary" size="sm" onClick={() => onInsert(tool)}>
        {t('insert')}
      </Button>
    </div>
  );
}
