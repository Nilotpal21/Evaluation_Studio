/**
 * ABL Editor Component
 *
 * Monaco-based editor for editing ABL files with live parsing.
 * Uses the app's design system while maintaining a code editor feel.
 */

import { useEffect, useRef, useCallback, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import type { editor, languages, IDisposable } from 'monaco-editor';
import { ablUppercaseTokenizer, ablYamlTokenizer } from '@/lib/abl-monarch';
import { getHoverInfo, getCompletions, getDocumentSymbols } from '@abl/language-service';
import type {
  CompletionItem as LSCompletionItem,
  CompletionKind,
  DocumentSymbol,
} from '@abl/language-service';
import { useEditorStore } from '../../store/editor-store';
import { useModuleStore } from '../../store/module-store';
import { useABLParsing } from '../../hooks/useABLParsing';
import { fetchTools } from '../../api/tools';
import { Save, RotateCcw, Play, AlertCircle, CheckCircle, Wrench, List } from 'lucide-react';
import clsx from 'clsx';
// Removed react-resizable-panels - using fixed width sidebar instead
import { ToolPickerDialog } from './ToolPickerDialog';
import { ABLSymbolTree } from './ABLSymbolTree';
import { ABLDiagnosticsPanel } from './ABLDiagnosticsPanel';
import { useMonacoCommands } from './commands/useMonacoCommands';
import { CommandPaletteWidget } from './commands/CommandPaletteWidget';
import { ToolPickerModal } from './pickers/ToolPickerModal';
import { GuardrailPickerModal } from './pickers/GuardrailPickerModal';
import { TemplatePickerModal } from './pickers/TemplatePickerModal';
import { TemplateInsertPanel } from '../templates/TemplateInsertPanel';
import { SimpleConstructModal } from './pickers/SimpleConstructModal';
import { MarkdownEditorModal } from './MarkdownEditorModal';
import { findFieldAtLine, updateFieldInDSL, type FieldRange } from './dsl-field-utils';
import type { Command } from './commands/CommandRegistry';

interface ABLEditorProps {
  className?: string;
  onSave?: () => void;
  /** Project ID — enables tool name autocomplete when provided */
  projectId?: string;
  /** Agent name — enables project-aware compile/diagnostics when provided with projectId */
  agentName?: string;
}

/** Map language-service CompletionKind to Monaco CompletionItemKind */
function mapCompletionKind(kind: CompletionKind, monaco: Monaco): languages.CompletionItemKind {
  switch (kind) {
    case 'keyword':
      return monaco.languages.CompletionItemKind.Keyword;
    case 'section':
      return monaco.languages.CompletionItemKind.Module;
    case 'tool':
      return monaco.languages.CompletionItemKind.Function;
    case 'agent':
      return monaco.languages.CompletionItemKind.Class;
    case 'function':
      return monaco.languages.CompletionItemKind.Function;
    case 'field':
      return monaco.languages.CompletionItemKind.Field;
    case 'value':
      return monaco.languages.CompletionItemKind.Value;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

function ABLEditorInner({ className = '', onSave, projectId, agentName }: ABLEditorProps) {
  const t = useTranslations('agents.abl_editor');
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [newToolPickerOpen, setNewToolPickerOpen] = useState(false);
  const [guardrailPickerOpen, setGuardrailPickerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templatePickerInitialTab, setTemplatePickerInitialTab] = useState<
    'all' | 'multiformat' | 'simple' | 'voice'
  >('all');
  const [templateInsertPanelOpen, setTemplateInsertPanelOpen] = useState(false);
  const [simpleConstructOpen, setSimpleConstructOpen] = useState(false);
  const [constructType, setConstructType] = useState<
    'field' | 'step' | 'memory' | 'constraint' | 'handoff'
  >('field');
  const [cursorLine, setCursorLine] = useState(1);
  const [markdownEditorOpen, setMarkdownEditorOpen] = useState(false);
  const [markdownEditorField, setMarkdownEditorField] = useState<FieldRange | null>(null);

  /** Open the markdown editor for the text field at the current cursor line */
  const openMarkdownEditor = useCallback(() => {
    const content = useEditorStore.getState().dslContent;
    const line = editorRef.current?.getPosition()?.lineNumber ?? 1;
    const field = findFieldAtLine(content, line);
    if (field) {
      setMarkdownEditorField(field);
      setMarkdownEditorOpen(true);
    }
  }, []);

  // Monaco commands hook — opens markdown editor directly for PERSONA/GOAL
  const { setup: setupCommands, cleanup: cleanupCommands } = useMonacoCommands({
    onMarkdownEdit: openMarkdownEditor,
  });

  // Tool cache for completions context
  const toolCacheRef = useRef<{
    tools: Array<{ name: string; type?: string; description?: string }>;
    timestamp: number;
  }>({ tools: [], timestamp: 0 });
  // Agent cache for completions context
  const agentCacheRef = useRef<{
    agents: Array<{ name: string }>;
    timestamp: number;
  }>({ agents: [], timestamp: 0 });
  // External agent cache for completions context
  const externalAgentCacheRef = useRef<{
    agents: Array<{ name: string }>;
    timestamp: number;
  }>({ agents: [], timestamp: 0 });
  const modelCacheRef = useRef<{
    models: Array<{
      modelId: string;
      name?: string;
      displayName?: string;
      provider?: string;
      isDefault?: boolean;
    }>;
    timestamp: number;
  }>({ models: [], timestamp: 0 });
  const CACHE_TTL_MS = 30_000;

  // Imported module symbols ref (synced from module store for non-React Monaco callbacks)
  const importedSymbolsRef = useRef<{
    agents: Array<{ name: string; description?: string }>;
    tools: Array<{ name: string; type?: string; description?: string }>;
  }>({ agents: [], tools: [] });

  // Sync imported module symbols into the ref for Monaco completion callbacks
  useEffect(() => {
    const unsub = useModuleStore.subscribe((state) => {
      const agents: Array<{ name: string; description?: string }> = [];
      const tools: Array<{ name: string; type?: string; description?: string }> = [];
      for (const dep of state.dependencies) {
        const contract = dep.contractSnapshot;
        if (!contract) continue;
        for (const agent of contract.providedAgents ?? []) {
          agents.push({
            name: `${dep.alias}__${agent.name}`,
            description: `[Imported: ${dep.moduleProjectName}] ${(agent as Record<string, unknown>).description ?? ''}`,
          });
        }
        for (const tool of contract.providedTools ?? []) {
          tools.push({
            name: `${dep.alias}__${tool.name}`,
            type: (tool as Record<string, unknown>).toolType as string | undefined,
            description: `[Imported: ${dep.moduleProjectName}] ${(tool as Record<string, unknown>).description ?? ''}`,
          });
        }
      }
      importedSymbolsRef.current = { agents, tools };
    });
    return unsub;
  }, []);

  // Track the last selected command for intelligent insertion
  const [lastCommandId, setLastCommandId] = useState<string>('');

  const handleToolInsert = useCallback(
    (snippet: string, commandIdOverride?: string) => {
      const ed = editorRef.current;
      if (!ed) return;

      // Get current section from store (set by command palette)
      const currentSection = useEditorStore.getState().commandPaletteSection || 'root';

      // Prefer the explicit override from the picker; fall back to the last
      // command-palette selection. The override path is what makes the toolbar-
      // launched legacy Tool Picker route inserts to TOOLS: instead of dropping
      // them at the cursor (which lands at line 1 before AGENT: on a fresh open).
      const effectiveCommandId = commandIdOverride ?? lastCommandId;

      // Use intelligent insertion to place snippet in correct section
      import('./commands/IntelligentInsertion')
        .then(({ insertSnippetIntelligently }) => {
          const result = insertSnippetIntelligently(
            ed,
            snippet,
            effectiveCommandId,
            currentSection as any,
          );

          if (result.success) {
            // Show success message in console (could be shown in UI later)
            if (result.message || result.warning) {
              console.log('✅', result.message || result.warning);
            }
          } else {
            console.error('❌ Failed to insert snippet:', result.message);
          }

          ed.focus();
        })
        .catch((err) => {
          console.error('Failed to load IntelligentInsertion module:', err);
        });
    },
    [lastCommandId],
  );

  const handleToolPickerInsert = useCallback(
    (snippet: string) => handleToolInsert(snippet, 'tool'),
    [handleToolInsert],
  );

  const handleCommandSelect = useCallback(
    (command: Command) => {
      // Store the command ID for intelligent insertion
      setLastCommandId(command.id);

      // Open the appropriate picker based on command type
      if (command.id.includes('tool')) {
        setNewToolPickerOpen(true);
      } else if (command.id.includes('guard')) {
        setGuardrailPickerOpen(true);
      } else if (command.id === 'rich-template') {
        setTemplateInsertPanelOpen(true);
      } else if (command.id === 'voice-template') {
        setTemplatePickerInitialTab('voice');
        setTemplatePickerOpen(true);
      } else if (command.id === 'multiformat') {
        setTemplatePickerInitialTab('multiformat');
        setTemplatePickerOpen(true);
      } else if (command.id.includes('template')) {
        setTemplatePickerInitialTab('all');
        setTemplatePickerOpen(true);
      } else if (command.id.includes('field')) {
        setConstructType('field');
        setSimpleConstructOpen(true);
      } else if (command.id.includes('step')) {
        setConstructType('step');
        setSimpleConstructOpen(true);
      } else if (command.id.includes('memory')) {
        setConstructType('memory');
        setSimpleConstructOpen(true);
      } else if (
        command.id.includes('constraint') ||
        command.id.includes('require') ||
        command.id.includes('warn')
      ) {
        setConstructType('constraint');
        setSimpleConstructOpen(true);
      } else if (command.id.includes('handoff')) {
        setConstructType('handoff');
        setSimpleConstructOpen(true);
      } else if (command.id === 'edit') {
        // Open rich markdown editor for the field at cursor
        openMarkdownEditor();
      }
    },
    [openMarkdownEditor],
  );

  const dslContent = useEditorStore((s) => s.dslContent);
  const isDirty = useEditorStore((s) => s.isDirty);
  const parseErrors = useEditorStore((s) => s.parseErrors);
  const parseWarnings = useEditorStore((s) => s.parseWarnings);
  const isParsingLive = useEditorStore((s) => s.isParsingLive);
  const compileErrors = useEditorStore((s) => s.compileErrors);
  const isCompiling = useEditorStore((s) => s.isCompiling);
  const isSaving = useEditorStore((s) => s.isSaving);
  const saveError = useEditorStore((s) => s.saveError);
  const diagnostics = useEditorStore((s) => s.diagnostics);
  const symbols = useEditorStore((s) => s.symbols);
  const showSymbolTree = useEditorStore((s) => s.showSymbolTree);
  const showDiagnostics = useEditorStore((s) => s.showDiagnostics);
  const setDslContent = useEditorStore((s) => s.setDslContent);
  const resetToOriginal = useEditorStore((s) => s.resetToOriginal);
  const setSymbols = useEditorStore((s) => s.setSymbols);
  const toggleSymbolTree = useEditorStore((s) => s.toggleSymbolTree);
  const toggleDiagnostics = useEditorStore((s) => s.toggleDiagnostics);

  const { parseLive, compileABL, saveABL } = useABLParsing(projectId, agentName);

  /** Save markdown editor changes back into the DSL */
  const handleMarkdownSave = useCallback(
    (newValue: string) => {
      if (!markdownEditorField) return;
      const content = useEditorStore.getState().dslContent;

      // Use the stored field directly (has correct line numbers)
      const updated = updateFieldInDSL(content, markdownEditorField, newValue);
      setDslContent(updated);
      parseLive(updated);
    },
    [markdownEditorField, setDslContent, parseLive],
  );

  /** Navigate the editor to a specific line and focus it */
  const navigateToLine = useCallback((line: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, []);

  /** Fetch tools for completion context with caching */
  async function loadToolsForContext(): Promise<
    Array<{ name: string; type?: string; description?: string }>
  > {
    if (!projectId) return [];
    const now = Date.now();
    if (
      toolCacheRef.current.tools.length > 0 &&
      now - toolCacheRef.current.timestamp < CACHE_TTL_MS
    ) {
      return toolCacheRef.current.tools;
    }
    try {
      const result = await fetchTools(projectId, { limit: 200 });
      const tools = result.data.map((tool) => ({
        name: tool.name,
        type: tool.toolType,
        description: tool.description || '',
      }));
      toolCacheRef.current = { tools, timestamp: now };
      return tools;
    } catch (err) {
      console.error('Failed to fetch tools for autocomplete:', err);
      return toolCacheRef.current.tools;
    }
  }

  /** Fetch available agents for completion context with caching */
  async function loadAgentsForContext(): Promise<Array<{ name: string }>> {
    if (!projectId) return [];
    const now = Date.now();
    if (
      agentCacheRef.current.agents.length > 0 &&
      now - agentCacheRef.current.timestamp < CACHE_TTL_MS
    ) {
      return agentCacheRef.current.agents;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/agents?limit=200`);
      if (res.ok) {
        const json = await res.json();
        const agents = (json.data ?? []).map((a: { name: string }) => ({ name: a.name }));
        agentCacheRef.current = { agents, timestamp: now };
        return agents;
      }
      return agentCacheRef.current.agents;
    } catch (err) {
      console.error('Failed to fetch agents for autocomplete:', err);
      return agentCacheRef.current.agents;
    }
  }

  /** Fetch external agents for completion context with caching */
  async function loadExternalAgentsForContext(): Promise<Array<{ name: string }>> {
    if (!projectId) return [];
    const now = Date.now();
    if (
      externalAgentCacheRef.current.agents.length > 0 &&
      now - externalAgentCacheRef.current.timestamp < CACHE_TTL_MS
    ) {
      return externalAgentCacheRef.current.agents;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/external-agents?limit=200`);
      if (res.ok) {
        const json = await res.json();
        const agents = (json.data ?? []).map((a: { name: string }) => ({ name: a.name }));
        externalAgentCacheRef.current = { agents, timestamp: now };
        return agents;
      }
      return externalAgentCacheRef.current.agents;
    } catch (err) {
      console.error('Failed to fetch external agents for autocomplete:', err);
      return externalAgentCacheRef.current.agents;
    }
  }

  async function loadModelsForContext(): Promise<
    Array<{
      modelId: string;
      name?: string;
      displayName?: string;
      provider?: string;
      isDefault?: boolean;
    }>
  > {
    if (!projectId) return [];
    const now = Date.now();
    if (
      modelCacheRef.current.models.length > 0 &&
      now - modelCacheRef.current.timestamp < CACHE_TTL_MS
    ) {
      return modelCacheRef.current.models;
    }

    try {
      const res = await fetch(`/api/models?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const json = await res.json();
        const models = (json.models ?? [])
          .filter((model: { modelId?: unknown }) => typeof model.modelId === 'string')
          .map(
            (model: {
              modelId: string;
              name?: string;
              displayName?: string;
              provider?: string;
              isDefault?: boolean;
            }) => ({
              modelId: model.modelId,
              name: model.name,
              displayName: model.displayName,
              provider: model.provider,
              isDefault: model.isDefault,
            }),
          );
        modelCacheRef.current = { models, timestamp: now };
        return models;
      }
      return modelCacheRef.current.models;
    } catch (err) {
      console.error('Failed to fetch models for autocomplete:', err);
      return modelCacheRef.current.models;
    }
  }

  // Handle editor mount
  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Register ABL language
      monaco.languages.register({ id: 'abl' });

      // Detect format and set appropriate tokenizer
      const isYaml = dslContent.trim().match(/^[a-z][a-z_]*\s*:/m);
      monaco.languages.setMonarchTokensProvider(
        'abl',
        isYaml ? ablYamlTokenizer : ablUppercaseTokenizer,
      );

      // Define theme matching our design system
      monaco.editor.defineTheme('abl-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: '6ea1f7', fontStyle: 'bold' }, // blue-400
          { token: 'type.identifier', foreground: '34d399' }, // green-400
          { token: 'string', foreground: 'fbbf24' }, // amber-400
          { token: 'number', foreground: '60a5fa' }, // blue-400
          { token: 'constant', foreground: '60a5fa' }, // blue-400
          { token: 'comment', foreground: '6b7280' }, // gray-500
          { token: 'operator', foreground: 'f9fafb' }, // gray-50
          { token: 'variable', foreground: 'f472b6' }, // pink-400
        ],
        colors: {
          'editor.background': '#0a0a0a', // matches --background
          'editor.foreground': '#fafafa', // matches --foreground
          'editor.lineHighlightBackground': '#1a1a1a',
          'editor.selectionBackground': '#3b82f633',
          'editorCursor.foreground': '#3b82f6',
          'editorLineNumber.foreground': '#525252',
          'editorLineNumber.activeForeground': '#a3a3a3',
        },
      });

      monaco.editor.setTheme('abl-dark');

      // --- Hover provider (P1c) ---
      const hoverDisposable = monaco.languages.registerHoverProvider('abl', {
        provideHover(model, position) {
          const info = getHoverInfo(model.getValue(), {
            line: position.lineNumber,
            column: position.column,
          });
          if (!info) return null;

          return {
            contents: [{ value: info.contents }],
            range: {
              startLineNumber: info.line,
              startColumn: 1,
              endLineNumber: info.line,
              endColumn: model.getLineMaxColumn(info.line),
            },
          };
        },
      });

      // --- Completion provider (P1d) ---
      const completionDisposable = monaco.languages.registerCompletionItemProvider('abl', {
        triggerCharacters: [':', '.'],
        provideCompletionItems: async (
          model: editor.ITextModel,
          position: { lineNumber: number; column: number },
        ) => {
          const [tools, localAgents, externalAgents, models] = await Promise.all([
            loadToolsForContext(),
            loadAgentsForContext(),
            loadExternalAgentsForContext(),
            loadModelsForContext(),
          ]);
          const importedSymbols = importedSymbolsRef.current;
          const context = {
            availableTools: [...tools, ...importedSymbols.tools],
            availableAgents: [...localAgents, ...externalAgents, ...importedSymbols.agents],
            availableModels: models,
          };

          const items: LSCompletionItem[] = getCompletions(
            model.getValue(),
            { line: position.lineNumber, column: position.column },
            context,
          );

          const wordInfo = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: wordInfo.startColumn,
            endColumn: position.column,
          };

          const suggestions: languages.CompletionItem[] = items.map((item, idx) => ({
            label: {
              label: item.label,
              detail: item.detail ? `  ${item.detail}` : undefined,
            },
            kind: mapCompletionKind(item.kind, monaco),
            insertText: item.insertText,
            range,
            sortText: String(item.sortOrder ?? idx).padStart(4, '0'),
            documentation: item.documentation,
          }));

          return { suggestions };
        },
      });

      // Track cursor position for symbol tree highlighting
      const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
        setCursorLine(e.position.lineNumber);
      });

      // --- Code Lens: "Edit in Rich Editor" on PERSONA/GOAL lines ---
      disposablesRef.current.push(hoverDisposable, completionDisposable, cursorDisposable);

      // Keyboard shortcuts
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (onSave) {
          onSave();
        } else {
          saveABL();
        }
      });

      // Cmd+E — open markdown editor for field at cursor
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => {
        openMarkdownEditor();
      });

      // Setup slash commands
      setupCommands(editor, monaco);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saveABL, onSave, setupCommands, openMarkdownEditor],
    // Note: dslContent removed from deps because Monaco onMount only fires once
    // and the tokenizer detection reads from the model directly
  );

  // Parse initial content on mount
  useEffect(() => {
    if (dslContent.trim()) {
      parseLive(dslContent);
    }
    // Only run on mount, not on every dslContent change (that's handled by handleEditorChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute document symbols on debounced content change (P1e)
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (dslContent.trim()) {
        const symbols: DocumentSymbol[] = getDocumentSymbols(dslContent);
        console.log('[ABLEditor] Extracted symbols:', symbols.length, symbols);
        setSymbols(symbols);
      } else {
        setSymbols([]);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [dslContent, setSymbols]);

  // Update markers when errors or diagnostics change
  useEffect(() => {
    if (!monacoRef.current || !editorRef.current) return;

    const monaco = monacoRef.current;
    const model = editorRef.current.getModel();
    if (!model || model.isDisposed()) return;

    const lineCount = model.getLineCount();

    const markers: editor.IMarkerData[] = [
      // Existing parse errors
      ...parseErrors.map((error) => ({
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: error.line || 1,
        startColumn: error.column || 1,
        endLineNumber: error.line || 1,
        endColumn: 1000,
      })),
      // Existing parse warnings
      ...parseWarnings.map((warning) => ({
        severity: monaco.MarkerSeverity.Warning,
        message: warning.message,
        startLineNumber: warning.line || 1,
        startColumn: warning.column || 1,
        endLineNumber: warning.line || 1,
        endColumn: 1000,
      })),
      // Language service diagnostics
      ...diagnostics
        .filter((d) => d.line >= 1 && d.line <= lineCount)
        .map((d) => ({
          severity:
            d.severity === 'error'
              ? monaco.MarkerSeverity.Error
              : d.severity === 'warning'
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.column || 1,
          endLineNumber: d.line,
          endColumn: d.column ? d.column + 1 : model.getLineMaxColumn(d.line),
        })),
    ];

    monaco.editor.setModelMarkers(model, 'abl', markers);
  }, [parseErrors, parseWarnings, diagnostics]);

  // Handle content change
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const newContent = value || '';
      setDslContent(newContent);
      parseLive(newContent);
    },
    [setDslContent, parseLive],
  );

  // Cleanup disposables on unmount
  useEffect(() => {
    return () => {
      editorRef.current = null;
      monacoRef.current = null;
      for (const d of disposablesRef.current) {
        d.dispose();
      }
      disposablesRef.current = [];
      cleanupCommands();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only cleanup on unmount, not on cleanupCommands changes

  // Status bar info
  const totalErrors = parseErrors.length + compileErrors.length;
  const hasErrors = totalErrors > 0;
  const hasWarnings = parseWarnings.length > 0;

  return (
    <div className={clsx('flex flex-col h-full bg-background', className)}>
      {/* Toolbar */}
      <div className="flex-shrink-0 px-4 py-2.5 flex items-center justify-between border-b border-default bg-background-subtle">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted">{t('title')}</span>
          {isDirty && (
            <span className="text-xs text-warning flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              {t('modified')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle symbol tree sidebar */}
          <button
            onClick={toggleSymbolTree}
            className={clsx(
              'p-2 rounded-lg transition-default btn-press',
              showSymbolTree
                ? 'text-accent bg-accent-subtle'
                : 'text-muted hover:text-foreground hover:bg-background-muted',
            )}
            title={t('toggle_outline')}
          >
            <List className="w-4 h-4" />
          </button>

          {/* Toggle diagnostics panel */}
          <button
            onClick={toggleDiagnostics}
            className={clsx(
              'p-2 rounded-lg transition-default btn-press',
              showDiagnostics
                ? 'text-accent bg-accent-subtle'
                : 'text-muted hover:text-foreground hover:bg-background-muted',
            )}
            title={t('toggle_diagnostics')}
          >
            <AlertCircle className="w-4 h-4" />
          </button>

          {/* Insert Tool Reference button */}
          {projectId && (
            <button
              onClick={() => {
                // Defensive: stamp the command id so the IntelligentInsertion
                // routing still works if a picker forgets to pass an override.
                setLastCommandId('tool');
                setToolPickerOpen(true);
              }}
              className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default btn-press"
              title={t('insert_tool_ref')}
            >
              <Wrench className="w-4 h-4 icon-hover" />
            </button>
          )}

          {/* Reset button */}
          <button
            onClick={resetToOriginal}
            disabled={!isDirty}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default btn-press disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('reset_title')}
          >
            <RotateCcw className="w-4 h-4 icon-hover" />
          </button>

          {/* Compile button — disabled only by parse errors, not stale compile errors */}
          <button
            onClick={compileABL}
            disabled={isCompiling || parseErrors.length > 0}
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-default btn-press focus-ring',
              'bg-accent text-accent-foreground hover:bg-accent-muted hover:scale-[1.02]',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
            title={t('compile_title')}
          >
            <Play className={clsx('w-3.5 h-3.5', isCompiling && 'animate-pulse-soft')} />
            {isCompiling ? t('compiling') : t('compile')}
          </button>

          {/* Save button — only shown when no parent handles save (standalone mode) */}
          {!onSave && (
            <button
              onClick={saveABL}
              disabled={isSaving || !isDirty}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-default btn-press focus-ring',
                'bg-success text-success-foreground hover:bg-success-muted hover:scale-[1.02]',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
              title={t('save_title')}
            >
              <Save className={clsx('w-3.5 h-3.5', isSaving && 'animate-pulse-soft')} />
              {isSaving ? t('saving') : t('save')}
            </button>
          )}
        </div>
      </div>

      {/* Main content area: sidebar + editor */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {showSymbolTree && (
          <div
            className="border-r border-default bg-background-subtle overflow-y-auto flex-shrink-0 self-stretch"
            style={{ width: '300px', minWidth: '300px' }}
          >
            <div className="px-3 py-2 text-xs font-medium text-muted border-b border-default sticky top-0 bg-background-subtle whitespace-nowrap">
              Outline
            </div>
            <ABLSymbolTree symbols={symbols} onNavigate={navigateToLine} cursorLine={cursorLine} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex-1 flex flex-col min-w-0 h-full">
            {/* Monaco editor */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Editor
                height="100%"
                defaultLanguage="abl"
                value={dslContent}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                theme="abl-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  lineNumbers: 'on',
                  renderLineHighlight: 'line',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  tabSize: 2,
                  insertSpaces: true,
                  automaticLayout: true,
                  padding: { top: 12, bottom: 12 },
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
            </div>

            {/* Error details panel — shown when errors exist */}
            {hasErrors && (
              <div className="flex-shrink-0 max-h-32 overflow-auto border-t border-error/30 bg-error-subtle px-4 py-2 space-y-1">
                {parseErrors.map((err, i) => (
                  <div key={`parse-${i}`} className="text-xs text-error font-mono">
                    <span className="text-error/70">
                      {t('line_col', { line: err.line, column: err.column })}
                    </span>{' '}
                    {err.message}
                  </div>
                ))}
                {compileErrors.map((err, i) => (
                  <div key={`compile-${i}`} className="text-xs text-error font-mono">
                    <span className="text-error/70">{t('compile_prefix')}</span> {err}
                  </div>
                ))}
              </div>
            )}

            {/* Diagnostics panel (language service) */}
            {showDiagnostics && (
              <ABLDiagnosticsPanel
                diagnostics={diagnostics}
                onNavigate={navigateToLine}
                onClose={toggleDiagnostics}
              />
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div
        className={clsx(
          'flex-shrink-0 px-4 py-2 flex items-center justify-between text-xs border-t',
          hasErrors ? 'bg-error-subtle border-error' : 'bg-background-subtle border-default',
        )}
      >
        <div className="flex items-center gap-4">
          {/* Parse status */}
          {isParsingLive ? (
            <span className="text-muted">{t('parsing')}</span>
          ) : hasErrors ? (
            <span className="flex items-center gap-1.5 text-error">
              <AlertCircle className="w-3.5 h-3.5" />
              {t('errors_count', { count: totalErrors })}
              {compileErrors.length > 0 && parseErrors.length === 0 && (
                <span className="text-error/70 ml-1">{t('compile_suffix')}</span>
              )}
            </span>
          ) : hasWarnings ? (
            <span className="flex items-center gap-1.5 text-warning">
              <AlertCircle className="w-3.5 h-3.5" />
              {t('warnings_count', { count: parseWarnings.length })}
            </span>
          ) : saveError ? (
            <span className="flex items-center gap-1.5 text-error">
              <AlertCircle className="w-3.5 h-3.5" />
              Error
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-success">
              <CheckCircle className="w-3.5 h-3.5" />
              {t('no_issues')}
            </span>
          )}

          {/* Save error */}
          {saveError && (
            <span className="text-error">{t('save_failed_prefix', { error: saveError })}</span>
          )}
        </div>

        <div className="text-subtle">{t('keyboard_hint')}</div>
      </div>

      {/* Tool Picker Dialog (Legacy) */}
      {projectId && (
        <ToolPickerDialog
          open={toolPickerOpen}
          onClose={() => setToolPickerOpen(false)}
          projectId={projectId}
          onInsert={handleToolPickerInsert}
        />
      )}

      {/* Tool Picker Modal (New with preview) */}
      {projectId && (
        <ToolPickerModal
          open={newToolPickerOpen}
          onClose={() => setNewToolPickerOpen(false)}
          projectId={projectId}
          onInsert={handleToolPickerInsert}
        />
      )}

      {/* Guardrail Picker Modal */}
      <GuardrailPickerModal
        open={guardrailPickerOpen}
        onClose={() => setGuardrailPickerOpen(false)}
        onInsert={handleToolInsert}
      />

      {/* Template Picker Modal (message templates) */}
      <TemplatePickerModal
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        onInsert={handleToolInsert}
        initialTab={templatePickerInitialTab}
      />

      {/* Rich Content Template Insert Panel */}
      <TemplateInsertPanel
        open={templateInsertPanelOpen}
        onClose={() => setTemplateInsertPanelOpen(false)}
        onInsert={handleToolInsert}
      />

      {/* Simple Construct Modal (Field/Step/Memory/Constraint/Handoff) */}
      <SimpleConstructModal
        open={simpleConstructOpen}
        onClose={() => setSimpleConstructOpen(false)}
        onInsert={handleToolInsert}
        type={constructType}
      />

      {/* Command Palette Widget */}
      <CommandPaletteWidget
        editorRef={editorRef}
        projectId={projectId}
        onCommandSelect={handleCommandSelect}
      />

      {/* Markdown Editor Modal for PERSONA/GOAL */}
      <MarkdownEditorModal
        open={markdownEditorOpen}
        onClose={() => setMarkdownEditorOpen(false)}
        fieldName={markdownEditorField?.name ?? ''}
        initialValue={markdownEditorField?.value ?? ''}
        onSave={handleMarkdownSave}
      />
    </div>
  );
}

export function ABLEditor(props: ABLEditorProps) {
  return (
    <ErrorBoundary>
      <ABLEditorInner {...props} />
    </ErrorBoundary>
  );
}

export default ABLEditor;
