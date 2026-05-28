import { describe, it, expect } from 'vitest';
import { toLSPDiagnostic, toLSPDiagnostics } from '../adapters/diagnostics.js';
import { toLSPCompletionItem, toLSPCompletionItems } from '../adapters/completions.js';
import { toLSPDocumentSymbol, toLSPDocumentSymbols } from '../adapters/symbols.js';
import { toLSPHover } from '../adapters/hover.js';
import type { Diagnostic, CompletionItem, DocumentSymbol, HoverInfo } from '@abl/language-service';

describe('diagnostics adapter', () => {
  it('maps error severity', () => {
    const d: Diagnostic = {
      severity: 'error',
      message: 'bad',
      line: 1,
      column: 1,
      source: 'syntax',
    };
    const result = toLSPDiagnostic(d);
    expect(result.severity).toBe(1); // DiagnosticSeverity.Error
    expect(result.range.start.line).toBe(0);
    expect(result.range.start.character).toBe(0);
    expect(result.source).toBe('abl-syntax');
  });

  it('maps warning severity', () => {
    const d: Diagnostic = { severity: 'warning', message: 'warn', line: 5, column: 3 };
    const result = toLSPDiagnostic(d);
    expect(result.severity).toBe(2); // DiagnosticSeverity.Warning
    expect(result.range.start.line).toBe(4);
    expect(result.range.start.character).toBe(2);
    expect(result.source).toBe('abl');
  });

  it('maps info and hint severity', () => {
    const info: Diagnostic = { severity: 'info', message: 'info', line: 1, column: 1 };
    const hint: Diagnostic = { severity: 'hint', message: 'hint', line: 1, column: 1 };
    expect(toLSPDiagnostic(info).severity).toBe(3);
    expect(toLSPDiagnostic(hint).severity).toBe(4);
  });

  it('handles endLine and endColumn', () => {
    const d: Diagnostic = {
      severity: 'error',
      message: 'range',
      line: 2,
      column: 3,
      endLine: 4,
      endColumn: 10,
    };
    const result = toLSPDiagnostic(d);
    expect(result.range.start).toEqual({ line: 1, character: 2 });
    expect(result.range.end).toEqual({ line: 3, character: 9 });
  });

  it('converts array of diagnostics', () => {
    const arr: Diagnostic[] = [
      { severity: 'error', message: 'a', line: 1, column: 1 },
      { severity: 'warning', message: 'b', line: 2, column: 1 },
    ];
    const result = toLSPDiagnostics(arr);
    expect(result).toHaveLength(2);
  });
});

describe('completions adapter', () => {
  it('maps keyword kind', () => {
    const item: CompletionItem = {
      label: 'when',
      kind: 'keyword',
      insertText: 'when: ',
      detail: 'Conditional',
    };
    const result = toLSPCompletionItem(item);
    expect(result.kind).toBe(14); // CompletionItemKind.Keyword
    expect(result.label).toBe('when');
    expect(result.insertText).toBe('when: ');
    expect(result.detail).toBe('Conditional');
  });

  it('maps section kind to Module', () => {
    const item: CompletionItem = { label: 'tools', kind: 'section', insertText: 'tools: ' };
    expect(toLSPCompletionItem(item).kind).toBe(9); // Module
  });

  it('maps tool kind to Function', () => {
    const item: CompletionItem = { label: 'search_api', kind: 'tool', insertText: 'search_api' };
    expect(toLSPCompletionItem(item).kind).toBe(3); // Function
  });

  it('maps agent kind to Class', () => {
    const item: CompletionItem = {
      label: 'booking_agent',
      kind: 'agent',
      insertText: 'booking_agent',
    };
    expect(toLSPCompletionItem(item).kind).toBe(7); // Class
  });

  it('pads sortOrder as sortText', () => {
    const item: CompletionItem = { label: 'a', kind: 'keyword', insertText: 'a', sortOrder: 3 };
    const result = toLSPCompletionItem(item);
    expect(result.sortText).toBe('00003');
  });

  it('converts array of completions', () => {
    const items: CompletionItem[] = [
      { label: 'a', kind: 'keyword', insertText: 'a' },
      { label: 'b', kind: 'tool', insertText: 'b' },
    ];
    expect(toLSPCompletionItems(items)).toHaveLength(2);
  });
});

describe('symbols adapter', () => {
  it('maps agent kind to Class', () => {
    const sym: DocumentSymbol = { name: 'booking_agent', kind: 'agent', line: 1, children: [] };
    const result = toLSPDocumentSymbol(sym);
    expect(result.kind).toBe(5); // SymbolKind.Class
    expect(result.range.start.line).toBe(0);
    expect(result.name).toBe('booking_agent');
  });

  it('maps tool kind to Function', () => {
    const sym: DocumentSymbol = { name: 'search_api', kind: 'tool', line: 10, children: [] };
    const result = toLSPDocumentSymbol(sym);
    expect(result.kind).toBe(12); // SymbolKind.Function
    expect(result.range.start.line).toBe(9);
  });

  it('maps step kind to Method', () => {
    const sym: DocumentSymbol = { name: 'greeting', kind: 'step', line: 5, children: [] };
    expect(toLSPDocumentSymbol(sym).kind).toBe(6); // Method
  });

  it('recursively maps children', () => {
    const sym: DocumentSymbol = {
      name: 'agent',
      kind: 'agent',
      line: 1,
      children: [
        {
          name: 'Tools',
          kind: 'section',
          line: 3,
          children: [{ name: 'api', kind: 'tool', line: 4, children: [] }],
        },
      ],
    };
    const result = toLSPDocumentSymbol(sym);
    expect(result.children).toHaveLength(1);
    expect(result.children![0].kind).toBe(3); // Namespace
    expect(result.children![0].children).toHaveLength(1);
    expect(result.children![0].children![0].kind).toBe(12); // Function
  });

  it('converts array of symbols', () => {
    const syms: DocumentSymbol[] = [{ name: 'a', kind: 'agent', line: 1, children: [] }];
    expect(toLSPDocumentSymbols(syms)).toHaveLength(1);
  });
});

describe('hover adapter', () => {
  it('maps hover info with 1-based to 0-based position', () => {
    const info: HoverInfo = { contents: '**agent** - Agent definition', line: 3, column: 5 };
    const result = toLSPHover(info);
    expect(result.contents).toEqual({ kind: 'markdown', value: '**agent** - Agent definition' });
    expect(result.range!.start.line).toBe(2);
    expect(result.range!.start.character).toBe(4);
  });
});
