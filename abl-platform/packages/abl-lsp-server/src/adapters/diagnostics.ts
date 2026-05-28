import { DiagnosticSeverity } from 'vscode-languageserver';
import type { Diagnostic as LSPDiagnostic } from 'vscode-languageserver';
import type { Diagnostic as ABLDiagnostic } from '@abl/language-service';

const SEVERITY_MAP: Record<string, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toLSPDiagnostic(d: ABLDiagnostic): LSPDiagnostic {
  const startLine = Math.max(0, d.line - 1);
  const startCol = Math.max(0, d.column - 1);
  const endLine = d.endLine != null ? Math.max(0, d.endLine - 1) : startLine;
  const endCol = d.endColumn != null ? Math.max(0, d.endColumn - 1) : startCol + 1;

  return {
    severity: SEVERITY_MAP[d.severity] ?? DiagnosticSeverity.Error,
    range: {
      start: { line: startLine, character: startCol },
      end: { line: endLine, character: endCol },
    },
    message: d.message,
    source: d.source ? `abl-${d.source}` : 'abl',
  };
}

export function toLSPDiagnostics(diagnostics: ABLDiagnostic[]): LSPDiagnostic[] {
  return diagnostics.map(toLSPDiagnostic);
}
