import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { runDiagnostics } from '@agent-platform/arch-ai/diagnostics';

const log = createLogger('arch-ai:isolated-build-compiler');

export type CompileWorkerPhase = 'boot' | 'parse' | 'compile' | 'diagnostics';
export type SerializableSeverity = 'error' | 'warning' | 'info';
export type SerializableEffort = 'S' | 'M' | 'L';

export interface CompileWorkerPhaseDurations {
  parse?: number;
  compile?: number;
  diagnostics?: number;
  total: number;
}

export interface SerializableCompileMessage {
  line?: number;
  message: string;
  severity?: SerializableSeverity;
}

export interface SerializableDiagnosticFinding {
  code: string;
  message: string;
  severity: SerializableSeverity;
  category: string;
  fix?: { description: string; effort: SerializableEffort };
}

export interface SerializableDiagnosticAntiPattern {
  name: string;
  description: string;
  agents: string[];
  severity: SerializableSeverity;
}

export interface SerializableDiagnosticSummary {
  overallSeverity: SerializableSeverity;
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    total: number;
  };
  topIssues: SerializableDiagnosticFinding[];
  errorCodes: string[];
  warningCodes: string[];
  architecturePattern?: string;
  antiPatterns: SerializableDiagnosticAntiPattern[];
}

export interface IsolatedSingleAgentCompileInput {
  code: string;
  additionalDocuments?: string[];
  compileOptions?: {
    mode?: 'preview';
    skipCrossAgentValidation?: boolean;
  };
  diagnostics?: {
    depth?: 'quick' | 'deep';
    agentName?: string;
    maxFindings?: number;
    skipCrossAgentPatterns?: boolean;
    /** Entry agent name from topology (for QG-05 validation) */
    entryAgent?: string;
  };
}

export interface IsolatedSingleAgentCompileResult {
  documentFound: boolean;
  parseErrors: SerializableCompileMessage[];
  parseWarnings: SerializableCompileMessage[];
  compileErrors: SerializableCompileMessage[];
  compileWarnings: SerializableCompileMessage[];
  diagnostics?: SerializableDiagnosticSummary;
  phaseDurationsMs: CompileWorkerPhaseDurations;
}

export interface BuildSessionValidationAgentInput {
  name: string;
  role: string;
}

export interface IsolatedBuildSessionValidationInput {
  topologyAgents: BuildSessionValidationAgentInput[];
  agentFiles: Record<string, { content?: string }>;
  behaviorProfileFiles?: Record<string, { content?: string }>;
}

export interface IsolatedBuildSessionValidationResult {
  parseErrorsByAgent: Record<string, string[]>;
  warningsByAgent: Record<string, string[]>;
  errorsByAgent: Record<string, string[]>;
  phaseDurationsMs: CompileWorkerPhaseDurations;
}

export interface IsolatedCompileRunnerOptions {
  timeoutMs: number;
  /**
   * Internal test seam. Invoked at every phase boundary so tests can simulate
   * a slow phase and exercise the timeout path. Not for production use.
   * @internal
   */
  __phaseHook?: (phase: CompileWorkerPhase) => Promise<void> | void;
}

export class CompileWorkerTimeoutError extends Error {
  readonly phase: CompileWorkerPhase;
  readonly timeoutMs: number;

  constructor(phase: CompileWorkerPhase, timeoutMs: number) {
    super(`Compile timed out during ${phase} after ${timeoutMs}ms.`);
    this.name = 'CompileWorkerTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

interface PhaseTracker {
  current: CompileWorkerPhase;
  setPhase: (phase: CompileWorkerPhase) => void;
}

function createPhaseTracker(): PhaseTracker {
  const tracker: PhaseTracker = {
    current: 'boot',
    setPhase(phase) {
      tracker.current = phase;
    },
  };
  return tracker;
}

function formatParseMessages(
  messages: ReadonlyArray<{ line?: number; message?: string }> | undefined,
): SerializableCompileMessage[] {
  return (messages ?? []).map((entry) => ({
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
    message: entry.message ?? String(entry),
  }));
}

function formatCompileMessages(
  messages: ReadonlyArray<{ line?: number; message?: string; severity?: string }> | undefined,
  includeSeverity: boolean,
): SerializableCompileMessage[] {
  return (messages ?? []).map((entry) => ({
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
    message: entry.message ?? String(entry),
    ...(includeSeverity
      ? {
          severity:
            entry.severity === 'error' || entry.severity === 'warning' || entry.severity === 'info'
              ? entry.severity
              : 'error',
        }
      : {}),
  }));
}

function pushRecordValue(target: Record<string, string[]>, key: string, value: string): void {
  if (!target[key]) {
    target[key] = [];
  }
  target[key].push(value);
}

function isSupervisorRole(role: string | undefined): boolean {
  const lower = String(role ?? '').toLowerCase();
  return lower.includes('supervisor') || lower.includes('triage') || lower.includes('router');
}

function buildPlaceholderAbl(agent: BuildSessionValidationAgentInput): string {
  const header = isSupervisorRole(agent.role) ? 'SUPERVISOR' : 'AGENT';
  return (
    header +
    ': ' +
    agent.name +
    '\n' +
    'GOAL: "Placeholder agent used for BUILD validation context"\n' +
    'PERSONA: |\n' +
    '  Placeholder build artifact for cross-agent validation.\n'
  );
}

function describeSingleAgentTask(input: IsolatedSingleAgentCompileInput): Record<string, unknown> {
  return {
    taskKind: 'single-agent-preview' as const,
    codeChars: input.code.length,
    codeLines: input.code.length === 0 ? 0 : input.code.split('\n').length,
    diagnosticsDepth: input.diagnostics?.depth,
    diagnosticsAgentName: input.diagnostics?.agentName,
    skipCrossAgentValidation: input.compileOptions?.skipCrossAgentValidation ?? false,
  };
}

function describeBuildSessionTask(
  input: IsolatedBuildSessionValidationInput,
): Record<string, unknown> {
  return {
    taskKind: 'build-session-validation' as const,
    topologyAgentCount: input.topologyAgents.length,
    fileCount: Object.keys(input.agentFiles ?? {}).length,
    behaviorProfileFileCount: Object.keys(input.behaviorProfileFiles ?? {}).length,
    generatedFileCount: Object.values(input.agentFiles ?? {}).filter(
      (file) => typeof file.content === 'string' && (file.content as string).trim().length > 0,
    ).length,
  };
}

function buildPhaseDurations(
  start: number,
  partial: Partial<Record<Exclude<CompileWorkerPhase, 'boot'>, number>>,
): CompileWorkerPhaseDurations {
  return {
    ...(typeof partial.parse === 'number' ? { parse: partial.parse } : {}),
    ...(typeof partial.compile === 'number' ? { compile: partial.compile } : {}),
    ...(typeof partial.diagnostics === 'number' ? { diagnostics: partial.diagnostics } : {}),
    total: Date.now() - start,
  };
}

async function runWithTimeout<T>(
  work: (tracker: PhaseTracker) => Promise<T>,
  options: IsolatedCompileRunnerOptions,
  taskContext: Record<string, unknown>,
): Promise<T> {
  const tracker = createPhaseTracker();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const timeoutError = new CompileWorkerTimeoutError(tracker.current, options.timeoutMs);
      log.warn('Compile timed out', {
        ...taskContext,
        phase: tracker.current,
        timeoutMs: options.timeoutMs,
      });
      reject(timeoutError);
    }, options.timeoutMs);
  });

  const workPromise = (async () => {
    try {
      return await work(tracker);
    } catch (error) {
      if (timedOut) {
        // The timeout already rejected; surface that instead of the underlying error.
        throw new CompileWorkerTimeoutError(tracker.current, options.timeoutMs);
      }
      throw error;
    }
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function executeSingleAgentPreview(
  input: IsolatedSingleAgentCompileInput,
  tracker: PhaseTracker,
  options: IsolatedCompileRunnerOptions,
  partialDurations: Partial<Record<Exclude<CompileWorkerPhase, 'boot'>, number>>,
): Promise<Omit<IsolatedSingleAgentCompileResult, 'phaseDurationsMs'>> {
  tracker.setPhase('parse');
  if (options.__phaseHook) {
    await options.__phaseHook('parse');
  }
  const parseStart = Date.now();
  const parseResult = parseAgentBasedABL(input.code);
  partialDurations.parse = Date.now() - parseStart;

  const parseErrors = formatParseMessages(parseResult.errors);
  const parseWarnings = formatParseMessages(parseResult.warnings);
  if (parseErrors.length > 0 || !parseResult.document) {
    return {
      documentFound: Boolean(parseResult.document),
      parseErrors,
      parseWarnings,
      compileErrors: [],
      compileWarnings: [],
      diagnostics: undefined,
    };
  }

  const documents = [parseResult.document];
  for (const additionalDocument of input.additionalDocuments ?? []) {
    const additionalParseResult = parseAgentBasedABL(additionalDocument);
    const additionalParseErrors = formatParseMessages(additionalParseResult.errors);
    parseWarnings.push(...formatParseMessages(additionalParseResult.warnings));
    if (additionalParseErrors.length > 0 || !additionalParseResult.document) {
      return {
        documentFound: true,
        parseErrors: additionalParseErrors,
        parseWarnings,
        compileErrors: [],
        compileWarnings: [],
        diagnostics: undefined,
      };
    }
    documents.push(additionalParseResult.document);
  }

  tracker.setPhase('compile');
  if (options.__phaseHook) {
    await options.__phaseHook('compile');
  }
  const compileStart = Date.now();
  const compileResult = compileABLtoIR(documents, {
    mode: input.compileOptions?.mode ?? 'preview',
    skipCrossAgentValidation: input.compileOptions?.skipCrossAgentValidation ?? false,
  });
  partialDurations.compile = Date.now() - compileStart;

  let diagnostics: SerializableDiagnosticSummary | undefined;
  if (input.diagnostics) {
    tracker.setPhase('diagnostics');
    if (options.__phaseHook) {
      await options.__phaseHook('diagnostics');
    }
    const diagnosticsStart = Date.now();
    const report = runDiagnostics(compileResult, {
      depth: input.diagnostics.depth ?? 'deep',
      ...(typeof input.diagnostics.agentName === 'string'
        ? { agentName: input.diagnostics.agentName }
        : {}),
      ...(typeof input.diagnostics.maxFindings === 'number'
        ? { maxFindings: input.diagnostics.maxFindings }
        : {}),
      ...(input.diagnostics.skipCrossAgentPatterns === true
        ? { skipCrossAgentPatterns: true }
        : {}),
      ...(typeof input.diagnostics.entryAgent === 'string'
        ? { entryAgent: input.diagnostics.entryAgent }
        : {}),
    });
    partialDurations.diagnostics = Date.now() - diagnosticsStart;

    diagnostics = {
      overallSeverity: report.overallSeverity,
      summary: {
        errors: report.summary.errors,
        warnings: report.summary.warnings,
        infos: report.summary.infos,
        total: report.summary.total,
      },
      topIssues: report.topIssues.map((finding) => ({
        code: finding.code,
        message: finding.message,
        severity: finding.severity,
        category: finding.category,
        ...(finding.fix
          ? {
              fix: {
                description: finding.fix.description,
                effort: finding.fix.effort,
              },
            }
          : {}),
      })),
      errorCodes: report.errorCodes,
      warningCodes: report.warningCodes,
      ...(typeof report.architecturePattern === 'string'
        ? { architecturePattern: report.architecturePattern }
        : {}),
      antiPatterns: report.antiPatterns.map((antiPattern) => ({
        name: antiPattern.name,
        description: antiPattern.description,
        agents: antiPattern.agents,
        severity: antiPattern.severity,
      })),
    };
  }

  return {
    documentFound: true,
    parseErrors,
    parseWarnings,
    compileErrors: formatCompileMessages(compileResult.compilation_errors, true),
    compileWarnings: formatCompileMessages(compileResult.compilation_warnings, false),
    diagnostics,
  };
}

async function executeBuildSessionValidation(
  input: IsolatedBuildSessionValidationInput,
  tracker: PhaseTracker,
  options: IsolatedCompileRunnerOptions,
  partialDurations: Partial<Record<Exclude<CompileWorkerPhase, 'boot'>, number>>,
): Promise<Omit<IsolatedBuildSessionValidationResult, 'phaseDurationsMs'>> {
  tracker.setPhase('parse');
  if (options.__phaseHook) {
    await options.__phaseHook('parse');
  }
  const parseStart = Date.now();
  const documents: ReturnType<typeof parseAgentBasedABL>['document'][] = [];
  const parseErrorsByAgent: Record<string, string[]> = {};

  for (const agent of input.topologyAgents) {
    const storedContent = input.agentFiles?.[agent.name]?.content;
    if (!storedContent) {
      parseErrorsByAgent[agent.name] = ['No agent file was generated for this topology node.'];
      const placeholderResult = parseAgentBasedABL(buildPlaceholderAbl(agent));
      if (placeholderResult.document) {
        documents.push(placeholderResult.document);
      }
      continue;
    }

    const parseResult = parseAgentBasedABL(storedContent);
    if ((parseResult.errors?.length ?? 0) > 0 || !parseResult.document) {
      parseErrorsByAgent[agent.name] = formatParseMessages(parseResult.errors).map(
        (entry) =>
          (typeof entry.line === 'number' ? 'Line ' + entry.line + ': ' : '') + entry.message,
      );
      const placeholderResult = parseAgentBasedABL(buildPlaceholderAbl(agent));
      if (placeholderResult.document) {
        documents.push(placeholderResult.document);
      }
      continue;
    }

    documents.push(parseResult.document);
  }
  for (const [profileName, file] of Object.entries(input.behaviorProfileFiles ?? {})) {
    if (!file.content) {
      continue;
    }
    const parseResult = parseAgentBasedABL(file.content);
    if ((parseResult.errors?.length ?? 0) > 0 || !parseResult.document) {
      parseErrorsByAgent[`behavior_profile:${profileName}`] = formatParseMessages(
        parseResult.errors,
      ).map(
        (entry) =>
          (typeof entry.line === 'number' ? 'Line ' + entry.line + ': ' : '') + entry.message,
      );
      continue;
    }

    documents.push(parseResult.document);
  }
  partialDurations.parse = Date.now() - parseStart;

  tracker.setPhase('compile');
  if (options.__phaseHook) {
    await options.__phaseHook('compile');
  }
  const compileStart = Date.now();
  const compileResult = compileABLtoIR(
    documents.filter((doc): doc is NonNullable<typeof doc> => Boolean(doc)),
    { mode: 'preview' },
  );
  partialDurations.compile = Date.now() - compileStart;

  const errorsByAgent: Record<string, string[]> = {};
  const warningsByAgent: Record<string, string[]> = {};
  for (const error of compileResult.compilation_errors ?? []) {
    const agentName = typeof error.agent === 'string' ? error.agent : null;
    if (!agentName) continue;
    pushRecordValue(warningsByAgent, agentName, error.message ?? String(error));
    if (typeof error.severity !== 'string' || error.severity === 'error') {
      pushRecordValue(errorsByAgent, agentName, error.message ?? String(error));
    }
  }

  for (const warning of compileResult.compilation_warnings ?? []) {
    const agentName = typeof warning.agent === 'string' ? warning.agent : null;
    if (!agentName) continue;
    pushRecordValue(warningsByAgent, agentName, warning.message ?? String(warning));
  }

  return { parseErrorsByAgent, warningsByAgent, errorsByAgent };
}

export async function runIsolatedSingleAgentCompile(
  input: IsolatedSingleAgentCompileInput,
  options: IsolatedCompileRunnerOptions,
): Promise<IsolatedSingleAgentCompileResult> {
  const start = Date.now();
  const partialDurations: Partial<Record<Exclude<CompileWorkerPhase, 'boot'>, number>> = {};
  const taskContext = describeSingleAgentTask(input);
  log.info('Compile starting', { ...taskContext, timeoutMs: options.timeoutMs });

  const result = await runWithTimeout(
    (tracker) => executeSingleAgentPreview(input, tracker, options, partialDurations),
    options,
    taskContext,
  );

  const phaseDurationsMs = buildPhaseDurations(start, partialDurations);
  log.info('Compile completed', {
    ...taskContext,
    phaseDurationsMs,
  });

  return { ...result, phaseDurationsMs };
}

export async function runIsolatedBuildSessionValidation(
  input: IsolatedBuildSessionValidationInput,
  options: IsolatedCompileRunnerOptions,
): Promise<IsolatedBuildSessionValidationResult> {
  const start = Date.now();
  const partialDurations: Partial<Record<Exclude<CompileWorkerPhase, 'boot'>, number>> = {};
  const taskContext = describeBuildSessionTask(input);
  log.info('Compile starting', { ...taskContext, timeoutMs: options.timeoutMs });

  const result = await runWithTimeout(
    (tracker) => executeBuildSessionValidation(input, tracker, options, partialDurations),
    options,
    taskContext,
  );

  const phaseDurationsMs = buildPhaseDurations(start, partialDurations);
  log.info('Compile completed', {
    ...taskContext,
    phaseDurationsMs,
  });

  return { ...result, phaseDurationsMs };
}
