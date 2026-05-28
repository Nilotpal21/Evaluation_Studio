/**
 * @abl/language-service
 *
 * Language intelligence for ABL — diagnostics, completions, symbols, hover.
 * Shared across Studio, CLI, and VSCode.
 */

export type {
  Position,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  SymbolKind,
  CompletionItem,
  CompletionKind,
  CompletionContext,
  HoverInfo,
  CompileFn,
} from './types.js';

export { detectFormat } from './detect-format.js';
export { getDiagnostics } from './diagnostics.js';
export { getDocumentSymbols } from './symbols.js';
export { getCompletions } from './completions.js';
export { getHoverInfo } from './hover.js';

export type { CelFunctionMeta } from './cel-functions.js';
export { CEL_FUNCTIONS } from './cel-functions.js';

export { serializeToYAML } from './serialize-yaml.js';
