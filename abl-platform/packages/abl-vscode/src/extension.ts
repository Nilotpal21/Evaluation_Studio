import * as path from 'path';
import { workspace, commands, window } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'abl-yaml' },
      { scheme: 'file', language: 'abl-legacy' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.agent.{yaml,abl}'),
    },
  };

  client = new LanguageClient(
    'ablLanguageServer',
    'ABL Language Server',
    serverOptions,
    clientOptions,
  );

  // Register validate command
  const validateCmd = commands.registerCommand('abl.validate', () => {
    const editor = window.activeTextEditor;
    if (editor) {
      // Touch the document to trigger re-validation
      client?.sendNotification('textDocument/didChange', {
        textDocument: {
          uri: editor.document.uri.toString(),
          version: editor.document.version,
        },
        contentChanges: [],
      });
      window.showInformationMessage('ABL: Validation triggered');
    }
  });

  context.subscriptions.push(validateCmd);

  // Start the client (also launches the server)
  client.start();
}

export function deactivate(): Promise<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
