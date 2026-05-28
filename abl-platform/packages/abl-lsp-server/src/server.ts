#!/usr/bin/env node

import { createConnection, ProposedFeatures, TextDocuments } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  getDiagnostics,
  getCompletions,
  getHoverInfo,
  getDocumentSymbols,
} from '@abl/language-service';
import { SERVER_CAPABILITIES } from './capabilities.js';
import { toLSPDiagnostics } from './adapters/diagnostics.js';
import { toLSPCompletionItems } from './adapters/completions.js';
import { toLSPDocumentSymbols } from './adapters/symbols.js';
import { toLSPHover } from './adapters/hover.js';
import { createWorkspaceScanner } from './workspace-scanner.js';

// --- Connection setup ---
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const scanner = createWorkspaceScanner();

// --- Debounce timer for diagnostics ---
const DIAGNOSTICS_DEBOUNCE_MS = 300;
const pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDiagnostics(uri: string, document: TextDocument): void {
  const existing = pendingDiagnostics.get(uri);
  if (existing) clearTimeout(existing);

  pendingDiagnostics.set(
    uri,
    setTimeout(() => {
      pendingDiagnostics.delete(uri);
      const text = document.getText();
      const diagnostics = getDiagnostics(text);
      connection.sendDiagnostics({
        uri,
        diagnostics: toLSPDiagnostics(diagnostics),
      });
    }, DIAGNOSTICS_DEBOUNCE_MS),
  );
}

// --- Lifecycle ---
let workspaceFolders: string[] = [];

connection.onInitialize((params) => {
  if (params.workspaceFolders) {
    workspaceFolders = params.workspaceFolders.map((f) => {
      try {
        return new URL(f.uri).pathname;
      } catch {
        return f.uri;
      }
    });
  } else if (params.rootUri) {
    try {
      workspaceFolders = [new URL(params.rootUri).pathname];
    } catch {
      workspaceFolders = [params.rootUri];
    }
  }

  return {
    capabilities: SERVER_CAPABILITIES,
  };
});

connection.onInitialized(() => {
  // Scan workspace for agent/tool names
  scanner.scan(workspaceFolders);
});

// --- Document events ---
documents.onDidChangeContent((change) => {
  scheduleDiagnostics(change.document.uri, change.document);
});

documents.onDidClose((event) => {
  const existing = pendingDiagnostics.get(event.document.uri);
  if (existing) {
    clearTimeout(existing);
    pendingDiagnostics.delete(event.document.uri);
  }
  // Clear diagnostics for closed documents
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// --- Completions ---
connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const text = document.getText();
  const position = { line: params.position.line + 1, column: params.position.character + 1 };
  const context = scanner.scan(workspaceFolders);

  const items = getCompletions(text, position, context);
  return toLSPCompletionItems(items);
});

// --- Hover ---
connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const text = document.getText();
  const position = { line: params.position.line + 1, column: params.position.character + 1 };

  const info = getHoverInfo(text, position);
  if (!info) return null;

  return toLSPHover(info);
});

// --- Document Symbols ---
connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const text = document.getText();
  const symbols = getDocumentSymbols(text);
  return toLSPDocumentSymbols(symbols);
});

// --- File watcher ---
connection.onDidChangeWatchedFiles((_change) => {
  scanner.invalidate();
});

// --- Start ---
documents.listen(connection);
connection.listen();
