import { TextDocumentSyncKind } from 'vscode-languageserver';
import type { ServerCapabilities } from 'vscode-languageserver';

export const SERVER_CAPABILITIES: ServerCapabilities = {
  textDocumentSync: TextDocumentSyncKind.Incremental,
  completionProvider: {
    triggerCharacters: [':', '.', '{', ' '],
    resolveProvider: false,
  },
  hoverProvider: true,
  documentSymbolProvider: true,
};
