import { CompletionItemKind } from 'vscode-languageserver';
import type { CompletionItem as LSPCompletionItem } from 'vscode-languageserver';
import type { CompletionItem as ABLCompletionItem } from '@abl/language-service';

const KIND_MAP: Record<string, CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  section: CompletionItemKind.Module,
  tool: CompletionItemKind.Function,
  agent: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  field: CompletionItemKind.Field,
  value: CompletionItemKind.Value,
};

export function toLSPCompletionItem(item: ABLCompletionItem): LSPCompletionItem {
  const result: LSPCompletionItem = {
    label: item.label,
    kind: KIND_MAP[item.kind] ?? CompletionItemKind.Text,
    detail: item.detail,
    documentation: item.documentation,
    insertText: item.insertText,
  };

  if (item.sortOrder != null) {
    result.sortText = String(item.sortOrder).padStart(5, '0');
  }

  return result;
}

export function toLSPCompletionItems(items: ABLCompletionItem[]): LSPCompletionItem[] {
  return items.map(toLSPCompletionItem);
}
