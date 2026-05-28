import { compileABLtoIR } from '@abl/compiler';
import { parseAgentBasedABL } from '@abl/core';
import {
  buildProjectCompileContext,
  collectRecoverableParseWarnings,
  collectTargetCompilationMessages,
  STUDIO_PROJECT_AWARE_COMPILE_MODE,
} from '@/lib/abl/project-aware-compile';

export type DslSaveDiagnostics = {
  status: 'valid' | 'warning' | 'error';
  errors: string[];
  warnings: string[];
};

export type StudioDslDiagnosticRecord = {
  severity: 'error' | 'warning';
  message: string;
  source: 'studio-save';
};

export function buildDslSaveDiagnostics(errors: string[], warnings: string[]): DslSaveDiagnostics {
  return {
    status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'valid',
    errors,
    warnings,
  };
}

export function formatDslParseError(error: { line?: number; message: string }): string {
  return `Line ${error.line ?? '?'}: ${error.message}`;
}

export function diagnosticsToStudioDslRecords(
  diagnostics: DslSaveDiagnostics,
): StudioDslDiagnosticRecord[] {
  return [
    ...diagnostics.errors.map((message) => ({
      severity: 'error' as const,
      message,
      source: 'studio-save' as const,
    })),
    ...diagnostics.warnings.map((message) => ({
      severity: 'warning' as const,
      message,
      source: 'studio-save' as const,
    })),
  ];
}

export async function validateDslDraft(params: {
  agentName: string;
  dslContent: string;
  projectId: string;
  tenantId: string;
}): Promise<DslSaveDiagnostics> {
  const parseResult = parseAgentBasedABL(params.dslContent);
  if (!parseResult.document?.name) {
    const errors = (parseResult.errors ?? []).map(formatDslParseError);
    if (errors.length === 0) {
      errors.push('Missing required agent name.');
    }
    return buildDslSaveDiagnostics(errors, []);
  }

  const warnings = collectRecoverableParseWarnings(parseResult);
  // Forward any parse errors that didn't prevent document production as warnings
  // so they surface in the UI without blocking saves.
  for (const entry of parseResult.errors ?? []) {
    warnings.push(formatDslParseError(entry));
  }
  const errors: string[] = [];
  const {
    allDocs,
    compilerOptions,
    errors: contextErrors,
    warnings: contextWarnings,
  } = await buildProjectCompileContext({
    agentName: params.agentName,
    mode: STUDIO_PROJECT_AWARE_COMPILE_MODE,
    projectId: params.projectId,
    targetDocument: parseResult.document,
    tenantId: params.tenantId,
  });
  warnings.push(...contextWarnings);
  errors.push(...contextErrors);

  if (contextErrors.length === 0) {
    const compilationOutput = compileABLtoIR(allDocs, compilerOptions);
    const targetAgentNames = [parseResult.document.name, params.agentName].filter(
      (value, index, values): value is string =>
        typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
    );
    const { errors: compileErrors, warnings: compileWarnings } = collectTargetCompilationMessages(
      compilationOutput,
      targetAgentNames,
    );
    errors.push(...compileErrors);
    warnings.push(...compileWarnings);
  }

  return buildDslSaveDiagnostics(errors, warnings);
}
