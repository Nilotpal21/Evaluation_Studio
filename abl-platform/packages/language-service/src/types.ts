/**
 * Position in a document (1-based line, 1-based column).
 */
export interface Position {
  line: number;
  column: number;
}

/**
 * Severity level for diagnostics.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * A diagnostic message with position information.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source?: string; // 'syntax' | 'structural' | 'compile'
}

/**
 * A symbol in the document outline (tree-view).
 */
export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine?: number;
  children: DocumentSymbol[];
}

export type SymbolKind =
  | 'agent'
  | 'section'
  | 'tool'
  | 'step'
  | 'field'
  | 'constraint'
  | 'handoff'
  | 'delegate'
  | 'handler';

/**
 * A completion suggestion.
 */
export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText: string;
  sortOrder?: number;
}

export type CompletionKind =
  | 'keyword'
  | 'section'
  | 'tool'
  | 'agent'
  | 'function'
  | 'field'
  | 'value';

/**
 * Context passed to getCompletions for project-aware suggestions.
 */
export interface CompletionContext {
  availableTools?: Array<{ name: string; type?: string; description?: string }>;
  availableAgents?: Array<{ name: string }>;
  availableModels?: Array<{
    modelId: string;
    name?: string;
    displayName?: string;
    provider?: string;
    isDefault?: boolean;
  }>;
  format?: 'yaml' | 'legacy';
}

/**
 * Hover information for a position.
 */
export interface HoverInfo {
  contents: string; // Markdown
  line: number;
  column: number;
}

/**
 * Optional compile function injected for Tier 3 diagnostics.
 * This allows the language service to remain free of @abl/compiler dependencies.
 */
export type CompileFn = (source: string) => Diagnostic[];
