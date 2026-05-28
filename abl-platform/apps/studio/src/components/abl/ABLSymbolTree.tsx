/**
 * ABL Symbol Tree Component
 *
 * Collapsible tree view showing document symbols from the ABL language service.
 * Renders: Agent (root) -> Sections (Tools, Flow, Constraints, etc.) -> Items
 * Supports cursor-line highlighting and click-to-navigate.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { DocumentSymbol, SymbolKind } from '@abl/language-service';
import {
  Bot,
  Wrench,
  ArrowRight,
  Shield,
  ArrowLeftRight,
  TextCursorInput,
  FolderOpen,
  FolderClosed,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Search,
  Lock,
  Package,
} from 'lucide-react';
import clsx from 'clsx';
import { Badge } from '../ui/Badge';
import {
  useImportedSymbols,
  type ImportedAgent,
  type ImportedTool,
} from '../../hooks/useImportedSymbols';

interface ABLSymbolTreeProps {
  symbols: DocumentSymbol[];
  onNavigate: (line: number) => void;
  cursorLine?: number;
}

/**
 * Returns the appropriate lucide icon for a given symbol kind.
 * Section icons toggle between FolderOpen/FolderClosed based on collapsed state.
 */
function getSymbolIcon(kind: SymbolKind, isCollapsed: boolean) {
  switch (kind) {
    case 'agent':
      return Bot;
    case 'tool':
      return Wrench;
    case 'step':
      return ArrowRight;
    case 'constraint':
      return Shield;
    case 'handoff':
    case 'delegate':
      return ArrowLeftRight;
    case 'field':
      return TextCursorInput;
    case 'section':
      return isCollapsed ? FolderClosed : FolderOpen;
    case 'handler':
      return AlertCircle;
    default:
      return Bot;
  }
}

/**
 * Determine whether the cursor is within a symbol's line range.
 */
function isSymbolActive(symbol: DocumentSymbol, cursorLine?: number): boolean {
  if (cursorLine === undefined) return false;
  const start = symbol.line;
  const end = symbol.endLine ?? symbol.line;
  return cursorLine >= start && cursorLine <= end;
}

/**
 * Generate a safe, unique key for a symbol node
 */
function getSymbolKey(symbol: DocumentSymbol, index?: number): string {
  // Ensure name is always a string (in case it's unexpectedly an object)
  const safeName = typeof symbol.name === 'string' ? symbol.name : JSON.stringify(symbol.name);
  const indexSuffix = index !== undefined ? `:${index}` : '';
  return `${symbol.kind}:${safeName}:${symbol.line}${indexSuffix}`;
}

/**
 * Recursively renders a single symbol tree node with collapsible children.
 */
function SymbolNode({
  symbol,
  depth,
  onNavigate,
  cursorLine,
  collapsedSet,
  toggleCollapsed,
  index,
}: {
  symbol: DocumentSymbol;
  depth: number;
  onNavigate: (line: number) => void;
  cursorLine?: number;
  collapsedSet: Set<string>;
  toggleCollapsed: (key: string) => void;
  index?: number;
}) {
  const hasChildren = symbol.children.length > 0;
  const nodeKey = getSymbolKey(symbol, index);
  const isCollapsed = collapsedSet.has(nodeKey);
  const active = isSymbolActive(symbol, cursorLine);

  const Icon = getSymbolIcon(symbol.kind, isCollapsed);

  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-sm transition-default',
          'hover:bg-background-elevated',
          active ? 'bg-background-muted text-foreground font-medium' : 'text-muted',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onNavigate(symbol.line)}
        role="treeitem"
        aria-expanded={hasChildren ? !isCollapsed : undefined}
      >
        {/* Chevron toggle for nodes with children */}
        {hasChildren ? (
          <button
            className="flex-shrink-0 p-0.5 rounded hover:bg-background-muted transition-default"
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapsed(nodeKey);
            }}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? (
              <ChevronRight className="w-3.5 h-3.5 text-subtle" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-subtle" />
            )}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}

        {/* Symbol icon */}
        <Icon className="w-4 h-4 flex-shrink-0" />

        {/* Symbol name */}
        <span className="truncate">
          {typeof symbol.name === 'string' ? symbol.name : JSON.stringify(symbol.name)}
        </span>
      </div>

      {/* Children (rendered when not collapsed) */}
      {hasChildren && !isCollapsed && (
        <div role="group">
          {symbol.children.map((child, childIndex) => {
            const childKey = getSymbolKey(child, childIndex);
            return (
              <SymbolNode
                key={childKey}
                symbol={child}
                depth={depth + 1}
                onNavigate={onNavigate}
                cursorLine={cursorLine}
                collapsedSet={collapsedSet}
                toggleCollapsed={toggleCollapsed}
                index={childIndex}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function filterSymbols(symbols: DocumentSymbol[], query: string): DocumentSymbol[] {
  if (!query) return symbols;
  const lower = query.toLowerCase();
  return symbols.reduce<DocumentSymbol[]>((acc, symbol) => {
    const symbolName = typeof symbol.name === 'string' ? symbol.name : JSON.stringify(symbol.name);
    const nameMatch = symbolName.toLowerCase().includes(lower);
    const filteredChildren = filterSymbols(symbol.children, query);
    if (nameMatch || filteredChildren.length > 0) {
      acc.push({
        ...symbol,
        children: nameMatch ? symbol.children : filteredChildren,
      });
    }
    return acc;
  }, []);
}

/**
 * Renders a read-only imported symbol row with lock icon and provenance badge.
 */
function ImportedSymbolRow({
  name,
  alias,
  icon: Icon,
}: {
  name: string;
  alias: string;
  icon: React.ElementType;
}) {
  const tm = useTranslations('modules.badges');
  return (
    <div
      className={clsx(
        'flex items-center gap-1.5 py-1 px-2 rounded-md text-sm transition-default',
        'text-muted cursor-default',
      )}
      style={{ paddingLeft: '32px' }}
      title={tm('fromModule', { alias })}
    >
      <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
      <span className="truncate font-mono text-xs">
        {alias}.{name}
      </span>
      <Lock className="w-3 h-3 flex-shrink-0 text-subtle ml-auto" />
      <Badge variant="purple" className="text-[10px] px-1.5 py-0 shrink-0">
        {tm('imported')}
      </Badge>
    </div>
  );
}

/**
 * Collapsible group showing imported module symbols in the symbol tree.
 */
function ImportedModulesGroup({
  agents,
  tools,
  collapsedSet,
  toggleCollapsed,
  searchQuery,
}: {
  agents: ImportedAgent[];
  tools: ImportedTool[];
  collapsedSet: Set<string>;
  toggleCollapsed: (key: string) => void;
  searchQuery: string;
}) {
  const tm = useTranslations('modules.authoring');
  const groupKey = 'imported-modules-group';
  const isCollapsed = collapsedSet.has(groupKey);

  // Filter by search query
  const lower = searchQuery.toLowerCase();
  const filteredAgents = searchQuery
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(lower) || a.alias.toLowerCase().includes(lower),
      )
    : agents;
  const filteredTools = searchQuery
    ? tools.filter(
        (t) => t.name.toLowerCase().includes(lower) || t.alias.toLowerCase().includes(lower),
      )
    : tools;

  if (filteredAgents.length === 0 && filteredTools.length === 0) return null;

  return (
    <div className="border-t border-default mt-1 pt-1">
      <div
        className={clsx(
          'flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-sm transition-default',
          'hover:bg-background-elevated text-muted',
        )}
        onClick={() => toggleCollapsed(groupKey)}
        role="treeitem"
        aria-expanded={!isCollapsed}
      >
        <button
          className="flex-shrink-0 p-0.5 rounded hover:bg-background-muted transition-default"
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(groupKey);
          }}
          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-subtle" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-subtle" />
          )}
        </button>
        <Package className="w-4 h-4 flex-shrink-0 text-purple" />
        <span className="truncate font-medium">{tm('imported_modules')}</span>
      </div>

      {!isCollapsed && (
        <div role="group">
          {filteredAgents.length > 0 && (
            <div>
              <div
                className="px-2 py-0.5 text-[10px] font-semibold text-subtle uppercase tracking-wider"
                style={{ paddingLeft: '32px' }}
              >
                {tm('imported_agents', { count: filteredAgents.length })}
              </div>
              {filteredAgents.map((agent) => (
                <ImportedSymbolRow
                  key={`imported-agent-${agent.dependencyId}-${agent.name}`}
                  name={agent.name}
                  alias={agent.alias}
                  icon={Bot}
                />
              ))}
            </div>
          )}
          {filteredTools.length > 0 && (
            <div>
              <div
                className="px-2 py-0.5 text-[10px] font-semibold text-subtle uppercase tracking-wider"
                style={{ paddingLeft: '32px' }}
              >
                {tm('imported_tools', { count: filteredTools.length })}
              </div>
              {filteredTools.map((tool) => (
                <ImportedSymbolRow
                  key={`imported-tool-${tool.dependencyId}-${tool.name}`}
                  name={tool.name}
                  alias={tool.alias}
                  icon={Wrench}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ABLSymbolTree({ symbols, onNavigate, cursorLine }: ABLSymbolTreeProps) {
  const t = useTranslations('abl_editor');
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const { agents: importedAgents, tools: importedTools } = useImportedSymbols();

  const filteredSymbols = filterSymbols(symbols, searchQuery);

  const toggleCollapsed = (key: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const hasImportedSymbols = importedAgents.length > 0 || importedTools.length > 0;

  if (symbols.length === 0 && !hasImportedSymbols) {
    return <div className="px-3 py-4 text-xs text-subtle text-center">{t('no_symbols')}</div>;
  }

  return (
    <>
      <div className="px-2 py-1.5 border-b border-default bg-background-subtle">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('filter_symbols')}
            className="w-full pl-7 pr-2 py-1 text-xs bg-background-muted border border-default rounded-md text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus transition-default"
          />
        </div>
      </div>
      {filteredSymbols.length === 0 && !hasImportedSymbols ? (
        <div className="px-3 py-4 text-xs text-subtle text-center">{t('no_matching_symbols')}</div>
      ) : (
        <div className="py-1 pb-6" role="tree">
          {filteredSymbols.map((symbol, symbolIndex) => {
            const key = getSymbolKey(symbol, symbolIndex);
            return (
              <SymbolNode
                key={key}
                symbol={symbol}
                depth={0}
                onNavigate={onNavigate}
                cursorLine={cursorLine}
                collapsedSet={collapsedSet}
                toggleCollapsed={toggleCollapsed}
                index={symbolIndex}
              />
            );
          })}

          {/* Imported Modules section */}
          {hasImportedSymbols && (
            <ImportedModulesGroup
              agents={importedAgents}
              tools={importedTools}
              collapsedSet={collapsedSet}
              toggleCollapsed={toggleCollapsed}
              searchQuery={searchQuery}
            />
          )}
        </div>
      )}
    </>
  );
}

export default ABLSymbolTree;
