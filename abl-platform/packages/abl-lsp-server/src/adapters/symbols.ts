import { SymbolKind as LSPSymbolKind } from 'vscode-languageserver';
import type { DocumentSymbol as LSPDocumentSymbol } from 'vscode-languageserver';
import type { DocumentSymbol as ABLDocumentSymbol } from '@abl/language-service';

const SYMBOL_KIND_MAP: Record<string, LSPSymbolKind> = {
  agent: LSPSymbolKind.Class,
  section: LSPSymbolKind.Namespace,
  tool: LSPSymbolKind.Function,
  step: LSPSymbolKind.Method,
  field: LSPSymbolKind.Field,
  constraint: LSPSymbolKind.Property,
  handoff: LSPSymbolKind.Interface,
  delegate: LSPSymbolKind.Event,
  handler: LSPSymbolKind.Constructor,
};

export function toLSPDocumentSymbol(symbol: ABLDocumentSymbol): LSPDocumentSymbol {
  const startLine = Math.max(0, symbol.line - 1);
  const endLine = symbol.endLine != null ? Math.max(0, symbol.endLine - 1) : startLine;

  return {
    name: symbol.name,
    kind: SYMBOL_KIND_MAP[symbol.kind] ?? LSPSymbolKind.Variable,
    range: {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: 0 },
    },
    selectionRange: {
      start: { line: startLine, character: 0 },
      end: { line: startLine, character: symbol.name.length },
    },
    children: symbol.children.map(toLSPDocumentSymbol),
  };
}

export function toLSPDocumentSymbols(symbols: ABLDocumentSymbol[]): LSPDocumentSymbol[] {
  return symbols.map(toLSPDocumentSymbol);
}
