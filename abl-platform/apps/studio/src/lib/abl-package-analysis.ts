import {
  compileABLtoIR,
  validateABL,
  type AgentIR,
  type CompilationError,
} from '@abl/compiler/platform/ir';
import { parseAgentBasedABL } from '@abl/core/parser';
import type { AgentBasedDocument, AgentTool, FlowStep } from '@abl/core';
import {
  detectLayers,
  explainImportCompileDiagnostic,
  extractToolsFromFiles,
  readFolderV2,
  stripCommonPrefix,
  validateImport,
} from '@agent-platform/project-io';
import type { DependencyValidation, LayerName } from '@agent-platform/project-io';

export type NormalizedSeverity = 'error' | 'warning' | 'info';

export interface NormalizedIssue {
  code: string;
  severity: NormalizedSeverity;
  message: string;
  suggestedFix: string;
  file?: string;
  line?: number;
  agent?: string;
  source: 'folder' | 'syntax' | 'compiler' | 'lint' | 'dependency';
}

export interface PackageDiagnostics {
  valid: boolean;
  summary: {
    fileCount: number;
    formatVersion: '1.0' | '2.0';
    detectedLayers: LayerName[];
    agentFiles: number;
    toolFiles: number;
    behaviorProfileFiles: number;
    blockingIssues: number;
    warnings: number;
  };
  folder: {
    success: boolean;
    errors: string[];
    warnings: string[];
  };
  importValidation: {
    valid: boolean;
    dependencyValidation: DependencyValidation;
  };
  issues: NormalizedIssue[];
}

export interface CompilerModel {
  manifest: {
    formatVersion: '1.0' | '2.0';
    layersIncluded: string[];
    entryAgent: string | null;
    behaviorProfiles: Record<string, { path: string; priority: number; usedBy: string[] }>;
  };
  files: {
    agents: number;
    tools: number;
    behaviorProfiles: number;
    detectedLayers: LayerName[];
  };
  agents: Array<{
    name: string;
    file?: string;
    kind: string;
    usesBehaviorProfiles: string[];
    toolsDeclared: Array<{
      name: string;
      signature: string;
      type: string | null;
      sideEffects: boolean;
      confirmation: string | null;
      authProfile: string | null;
    }>;
    handoffs: Array<{ to: string; when: string; return: boolean }>;
    delegates: Array<{ agent: string; when: string; purpose: string }>;
    memory: { session: string[]; persistent: string[] };
    flow: {
      entryPoint: string | null;
      steps: Array<{
        name: string;
        call: string | null;
        respond: boolean;
        reasoning: boolean;
        then: string | null;
      }>;
    };
    completion: Array<{ when: string; respond: string | null }>;
    compiledBehaviorProfiles: string[];
  }>;
  projectTools: Array<{
    name: string;
    type: string;
    description: string | null;
    sourceFile: string;
  }>;
  behaviorProfiles: Array<{
    name: string;
    file?: string;
    priority: number;
    when: string;
    usedBy: string[];
  }>;
  unresolvedRefs: Array<{
    type: string;
    source: string;
    target: string;
    message: string;
  }>;
  compilerDiagnostics: NormalizedIssue[];
}

export interface TranscriptFailureDiagnosis {
  suspectedTranscriptSteps: string[];
  findings: Array<{
    agent: string;
    file?: string;
    step: string;
    thenLine?: number;
    completionLine?: number;
    message: string;
    suggestedFix: string;
  }>;
  notes: string[];
}

const KNOWN_CONDITION_ROOTS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  'true',
  'false',
  'null',
  'undefined',
  'input',
  'context',
  'session',
  'user',
  'customer',
  'contact',
  'anonymous',
  'channel',
  'event',
  'now',
  'today',
  'intent',
  'confidence',
  'last_user_message',
  'message',
]);

type CompiledFlowStep = NonNullable<AgentIR['flow']>['definitions'][string];

export function fileRecordToMap(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

function normalizePackageFiles(files: Record<string, string>): {
  files: Record<string, string>;
  fileMap: Map<string, string>;
} {
  const { files: normalizedMap } = stripCommonPrefix(fileRecordToMap(files));
  return {
    files: Object.fromEntries(normalizedMap),
    fileMap: normalizedMap,
  };
}

export function buildPackageDiagnostics(files: Record<string, string>): PackageDiagnostics {
  const normalized = normalizePackageFiles(files);
  const fileMap = normalized.fileMap;
  const folder = readFolderV2(fileMap);
  const importValidation = validateImport(folder.agentFiles, folder.toolFiles, folder.profileFiles);
  const issues: NormalizedIssue[] = [];

  for (const issue of folder.validationIssues) {
    issues.push({
      code: issue.code,
      severity: 'error',
      file: issue.path,
      message: issue.message,
      suggestedFix: suggestFix(issue.message, issue.code),
      source: 'folder',
    });
  }

  for (const message of folder.errors) {
    if (folder.validationIssues.some((issue) => issue.message === message)) {
      continue;
    }
    issues.push({
      code: 'FOLDER_VALIDATION',
      severity: 'error',
      message,
      suggestedFix: suggestFix(message, 'FOLDER_VALIDATION'),
      source: 'folder',
    });
  }

  for (const syntaxError of importValidation.syntaxErrors) {
    for (const error of syntaxError.errors) {
      issues.push({
        code: 'ABL_SYNTAX',
        severity: 'error',
        file: syntaxError.file,
        line: error.line,
        message: error.message,
        suggestedFix: suggestFix(error.message, 'ABL_SYNTAX'),
        source: 'syntax',
      });
    }
  }

  for (const missing of importValidation.dependencyValidation.missing) {
    issues.push({
      code: `MISSING_${missing.type.toUpperCase()}`,
      severity: 'error',
      file: missing.sourcePath,
      agent: missing.from,
      message: `${missing.from} references missing ${missing.type} target "${missing.to}"`,
      suggestedFix:
        missing.type === 'profile_use'
          ? 'Add a standalone behavior_profiles/<name>.behavior_profile.abl file and declare it in project.json behavior_profiles, or remove the USE BEHAVIOR_PROFILE reference.'
          : 'Add the referenced target to the package or update the reference to an existing name.',
      source: 'dependency',
    });
  }

  const compilerDiagnostics = getCompilerDiagnostics(normalized.files);
  issues.push(...compilerDiagnostics);
  issues.push(...lintAblFiles(normalized.files));

  const blockingIssues = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    valid: folder.success && importValidation.valid && blockingIssues === 0,
    summary: {
      fileCount: fileMap.size,
      formatVersion: folder.formatVersion,
      detectedLayers: detectLayers(folder),
      agentFiles: folder.agentFiles.size,
      toolFiles: folder.toolFiles.size,
      behaviorProfileFiles: folder.profileFiles.size,
      blockingIssues,
      warnings,
    },
    folder: {
      success: folder.success,
      errors: folder.errors,
      warnings: folder.warnings,
    },
    importValidation: {
      valid: importValidation.valid,
      dependencyValidation: importValidation.dependencyValidation,
    },
    issues: sortIssues(issues),
  };
}

export function buildCompilerModel(files: Record<string, string>): CompilerModel {
  const normalized = normalizePackageFiles(files);
  const fileMap = normalized.fileMap;
  const folder = readFolderV2(fileMap);
  const parseRecords = parsePackageDocuments(normalized.files);
  const documents = parseRecords
    .map((record) => record.document)
    .filter((document): document is AgentBasedDocument => Boolean(document));
  const compiled = documents.length > 0 ? compileABLtoIR(documents) : null;
  const manifestProfiles =
    folder.manifestV2?.behavior_profiles ?? folder.manifest?.behavior_profiles ?? {};
  const profileUsedBy = new Map<string, string[]>();

  for (const record of parseRecords) {
    const doc = record.document;
    if (!doc || doc.meta.kind === 'behavior_profile') {
      continue;
    }
    for (const profile of doc.useBehaviorProfiles ?? []) {
      profileUsedBy.set(profile, [...(profileUsedBy.get(profile) ?? []), doc.name]);
    }
  }

  const projectToolResult = extractToolsFromFiles(folder.toolFiles);
  const projectTools = projectToolResult.tools.map((tool) => ({
    name: tool.name,
    type: tool.toolType,
    description: tool.description,
    sourceFile: tool.sourceFile,
  }));

  const agents = parseRecords
    .filter((record) => record.document && record.document.meta.kind !== 'behavior_profile')
    .map((record) =>
      summarizeAgent(record.document!, record.file, compiled?.agents[record.document!.name]),
    );

  const behaviorProfiles = parseRecords
    .filter((record) => record.document?.meta.kind === 'behavior_profile')
    .map((record) => {
      const profile = record.document!.behaviorProfile;
      return {
        name: record.document!.name,
        file: record.file,
        priority: profile?.priority ?? 0,
        when: profile?.when ?? '',
        usedBy: profileUsedBy.get(record.document!.name) ?? [],
      };
    });

  return {
    manifest: {
      formatVersion: folder.formatVersion,
      layersIncluded: folder.manifestV2?.layers_included ?? ['core'],
      entryAgent: folder.manifestV2?.entry_agent ?? folder.manifest?.entry_agent ?? null,
      behaviorProfiles: Object.fromEntries(
        Object.entries(manifestProfiles).map(([name, profile]) => [
          name,
          {
            path: profile.path,
            priority: profile.priority,
            usedBy: profile.used_by,
          },
        ]),
      ),
    },
    files: {
      agents: folder.agentFiles.size,
      tools: folder.toolFiles.size,
      behaviorProfiles: folder.profileFiles.size,
      detectedLayers: detectLayers(folder),
    },
    agents,
    projectTools,
    behaviorProfiles,
    unresolvedRefs: buildUnresolvedRefs(buildPackageDiagnostics(normalized.files)),
    compilerDiagnostics: getCompilerDiagnostics(normalized.files),
  };
}

export function lintAblFiles(files: Record<string, string>): NormalizedIssue[] {
  const normalized = normalizePackageFiles(files);
  files = normalized.files;
  const issues: NormalizedIssue[] = [];
  const parsed = parsePackageDocuments(files);
  const compiledDocs = parsed
    .map((record) => record.document)
    .filter((document): document is AgentBasedDocument => Boolean(document));
  const compiled = compiledDocs.length > 0 ? compileABLtoIR(compiledDocs) : null;

  for (const [file, source] of Object.entries(files)) {
    if (!isAblLikeFile(file)) {
      continue;
    }
    issues.push(...lintRawSource(file, source));
  }

  for (const record of parsed) {
    if (!record.document || record.document.meta.kind === 'behavior_profile') {
      continue;
    }
    issues.push(...lintHandoffConditions(record.file, files[record.file], record.document));
  }

  if (compiled) {
    issues.push(...lintCompiledFlowChains(compiled.agents, parsed, files));
  }

  return sortIssues(issues);
}

export function diagnoseTranscriptFailure(
  transcript: unknown,
  files: Record<string, string>,
): TranscriptFailureDiagnosis {
  const normalized = normalizePackageFiles(files);
  files = normalized.files;
  const steps = collectSuspectedTranscriptSteps(transcript);
  const candidateSteps = steps.length > 0 ? steps : ['finalize', 'complete'];
  const model = buildCompilerModel(files);
  const findings: TranscriptFailureDiagnosis['findings'] = [];

  for (const agent of model.agents) {
    const source = agent.file ? files[agent.file] : undefined;
    for (const step of agent.flow.steps) {
      if (!candidateSteps.some((candidate) => namesMatch(candidate, step.name))) {
        continue;
      }

      const completes = step.then?.toLowerCase() === 'complete';
      const emptyCompletion = agent.completion.some((condition) => condition.respond === '');
      if (!completes || !emptyCompletion) {
        continue;
      }

      const thenLine = source ? findStepThenCompleteLine(source, step.name) : undefined;
      const completionLine = source ? findEmptyCompletionRespondLine(source) : undefined;

      findings.push({
        agent: agent.name,
        file: agent.file,
        step: step.name,
        thenLine,
        completionLine,
        message:
          `Transcript reached step "${step.name}", the compiled flow transitions with THEN: COMPLETE, ` +
          'and the COMPLETE block responds with an empty string. That produces a silent completion.',
        suggestedFix:
          'Change the final step to RESPOND with the customer-facing message before THEN: COMPLETE, or change COMPLETE.RESPOND to a non-empty closeout. Keep RESPOND: "" only for intentional silent return-to-parent flows.',
      });
    }
  }

  return {
    suspectedTranscriptSteps: candidateSteps,
    findings,
    notes:
      findings.length > 0
        ? []
        : [
            'No finalize -> complete -> empty-response chain was found. Inspect compilerDiagnostics and flow steps for a different failure mode.',
          ],
  };
}

function parsePackageDocuments(files: Record<string, string>): Array<{
  file: string;
  document: AgentBasedDocument | null;
}> {
  return Object.entries(files)
    .filter(([file]) => isAgentOrProfileFile(file))
    .map(([file, source]) => {
      const result = parseAgentBasedABL(source);
      return {
        file,
        document: result.document,
      };
    });
}

function summarizeAgent(
  document: AgentBasedDocument,
  file: string,
  compiledAgent: AgentIR | undefined,
): CompilerModel['agents'][number] {
  const flowDefinitions = document.flow?.definitions ?? {};
  const compiledFlowDefinitions = compiledAgent?.flow?.definitions ?? {};

  return {
    name: document.name,
    file,
    kind: document.meta.kind,
    usesBehaviorProfiles: document.useBehaviorProfiles ?? [],
    toolsDeclared: (document.tools ?? []).map(summarizeAstTool),
    handoffs: (document.handoff ?? []).map((handoff) => ({
      to: handoff.to,
      when: handoff.when,
      return: handoff.return,
    })),
    delegates: (document.delegate ?? []).map((delegate) => ({
      agent: delegate.agent,
      when: delegate.when,
      purpose: delegate.purpose,
    })),
    memory: {
      session: (document.memory?.session ?? []).map((entry) => entry.name),
      persistent: (document.memory?.persistent ?? []).map((entry) => entry.path),
    },
    flow: {
      entryPoint: document.flow?.entryPoint ?? compiledAgent?.flow?.entry_point ?? null,
      steps: Object.entries(flowDefinitions).map(([name, step]) =>
        summarizeFlowStep(name, step, compiledFlowDefinitions[name]),
      ),
    },
    completion: (document.complete ?? []).map((condition) => ({
      when: condition.when,
      respond: condition.respond ?? null,
    })),
    compiledBehaviorProfiles: (compiledAgent?.behavior_profiles ?? []).map(
      (profile) => profile.name,
    ),
  };
}

function summarizeAstTool(
  tool: AgentTool,
): CompilerModel['agents'][number]['toolsDeclared'][number] {
  const parameters = tool.parameters
    .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.type}`)
    .join(', ');
  return {
    name: tool.name,
    signature: `${tool.name}(${parameters}) -> ${formatReturnType(tool.returns)}`,
    type: tool.type ?? null,
    sideEffects: tool.hints?.side_effects ?? false,
    confirmation: tool.confirmation?.require ?? null,
    authProfile: tool.authProfile ?? null,
  };
}

function summarizeFlowStep(
  name: string,
  astStep: FlowStep,
  irStep: CompiledFlowStep | undefined,
): CompilerModel['agents'][number]['flow']['steps'][number] {
  const irRecord: Record<string, unknown> = isRecord(irStep) ? irStep : {};
  return {
    name,
    call: astStep.callSpec?.tool ?? astStep.call ?? readString(irRecord.call),
    respond: astStep.respond !== undefined || typeof irRecord.respond === 'string',
    reasoning: Boolean(astStep.reasoning ?? irRecord.reasoning_zone),
    then: astStep.then ?? readString(irRecord.then),
  };
}

function getCompilerDiagnostics(files: Record<string, string>): NormalizedIssue[] {
  const documents = Object.entries(files)
    .filter(([file]) => isAgentOrProfileFile(file))
    .map(([filename, source]) => ({ filename, source }));
  const result = validateABL(documents);

  return sortIssues([
    ...result.errors.map((diagnostic) => normalizeCompilerDiagnostic(diagnostic, 'error')),
    ...result.warnings.map((diagnostic) => normalizeCompilerDiagnostic(diagnostic, 'warning')),
  ]);
}

function normalizeCompilerDiagnostic(
  diagnostic: CompilationError,
  fallbackSeverity: NormalizedSeverity,
): NormalizedIssue {
  const severity = diagnostic.severity ?? fallbackSeverity;
  return {
    code: diagnostic.code ?? `ABL_${diagnostic.type.toUpperCase()}`,
    severity,
    agent: diagnostic.agent,
    message: explainImportCompileDiagnostic(diagnostic.message),
    suggestedFix: suggestFix(diagnostic.message, diagnostic.code),
    source: 'compiler',
  };
}

function lintRawSource(file: string, source: string): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    if (/^\s*RESPOND:\s*(['"])\s*\1\s*$/.test(lines[index])) {
      issues.push({
        code: 'ABL_EMPTY_RESPOND',
        severity: 'warning',
        file,
        line: index + 1,
        message: 'RESPOND is an empty string; this will produce a silent customer-facing turn.',
        suggestedFix:
          'Use a non-empty customer-facing response, or reserve RESPOND: "" for intentional silent completion/return paths.',
        source: 'lint',
      });
    }
  }

  issues.push(...lintEmptyFinalizeSteps(file, source));
  issues.push(...lintReasoningToolAndText(file, source));
  return issues;
}

function lintEmptyFinalizeSteps(file: string, source: string): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const stepMatch = lines[index].match(/^(\s+)([A-Za-z_][\w-]*):\s*$/);
    if (!stepMatch || !/finali[sz]e|complete|done/i.test(stepMatch[2])) {
      continue;
    }

    const block = lines.slice(
      index + 1,
      findNextHeaderAtOrBelowIndent(lines, index + 1, stepMatch[1].length),
    );
    const hasAction = block.some((line) =>
      /^\s*(REASONING|GATHER|RESPOND|CALL|SET|TRANSFORM|HANDOFF|DELEGATE|THEN|ON_SUCCESS|ON_FAIL|ON_INPUT|ON_RESULT):/.test(
        line,
      ),
    );
    if (!hasAction) {
      issues.push({
        code: 'ABL_EMPTY_FINALIZE_STEP',
        severity: 'error',
        file,
        line: index + 1,
        message: `Flow step "${stepMatch[2]}" has no executable action.`,
        suggestedFix:
          'Add RESPOND/CALL/SET/THEN logic to the step, or remove the step and route directly to the intended target.',
        source: 'lint',
      });
    }
  }
  return issues;
}

function lintReasoningToolAndText(file: string, source: string): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const stepMatch = lines[index].match(/^(\s+)([A-Za-z_][\w-]*):\s*$/);
    if (!stepMatch) continue;

    const blockEnd = findNextHeaderAtOrBelowIndent(lines, index + 1, stepMatch[1].length);
    const block = lines.slice(index + 1, blockEnd);
    const hasReasoning = block.some((line) => /^\s*REASONING:\s*true\b/i.test(line));
    const hasCall = block.some((line) => /^\s*CALL:\s*/.test(line));
    const hasRespond = block.some((line) => /^\s*RESPOND:\s*/.test(line));
    if (hasReasoning && hasCall && hasRespond) {
      issues.push({
        code: 'ABL_REASONING_TOOL_AND_TEXT_RISK',
        severity: 'warning',
        file,
        line: index + 1,
        message: `Reasoning step "${stepMatch[2]}" combines tool execution and customer text in one turn.`,
        suggestedFix:
          'Split tool execution and final customer response into separate steps, or make the step deterministic with REASONING: false.',
        source: 'lint',
      });
    }
  }
  return issues;
}

function lintHandoffConditions(
  file: string,
  source: string,
  document: AgentBasedDocument,
): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  const declared = collectDeclaredVariables(document);

  for (const handoff of document.handoff ?? []) {
    for (const variable of extractConditionVariables(handoff.when)) {
      if (declared.has(variable) || KNOWN_CONDITION_ROOTS.has(variable)) {
        continue;
      }
      issues.push({
        code: 'ABL_HANDOFF_UNDECLARED_CONDITION_VAR',
        severity: 'warning',
        file,
        line: findLineContaining(source, handoff.when),
        agent: document.name,
        message: `Handoff to "${handoff.to}" checks undeclared variable "${variable}" in WHEN condition.`,
        suggestedFix:
          'Declare/populate the variable in GATHER, MEMORY, SET, CALL AS, or PASS it from the parent before using it in handoff conditions.',
        source: 'lint',
      });
    }
  }

  return issues;
}

function lintCompiledFlowChains(
  agents: Record<string, AgentIR>,
  parsed: Array<{ file: string; document: AgentBasedDocument | null }>,
  files: Record<string, string>,
): NormalizedIssue[] {
  const fileByAgent = new Map(
    parsed
      .filter((record) => record.document)
      .map((record) => [record.document!.name, record.file] as const),
  );
  const issues: NormalizedIssue[] = [];

  for (const agent of Object.values(agents)) {
    const sideEffectTools = new Set(
      agent.tools.filter((tool) => tool.hints.side_effects).map((tool) => tool.name),
    );
    if (sideEffectTools.size === 0 || !agent.flow?.definitions) {
      continue;
    }

    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      const toolName = step.call_spec?.tool ?? step.call;
      const nextStep = step.then;
      if (!toolName || !nextStep || !sideEffectTools.has(toolName)) {
        continue;
      }
      const next = agent.flow.definitions[nextStep];
      const nextTool = next?.call_spec?.tool ?? next?.call;
      if (!nextTool || !sideEffectTools.has(nextTool)) {
        continue;
      }

      const file = fileByAgent.get(agent.metadata.name);
      issues.push({
        code: 'ABL_SIDE_EFFECT_TOOL_CHAIN',
        severity: 'warning',
        file,
        line: file ? findLineContaining(files[file] ?? '', `${stepName}:`) : undefined,
        agent: agent.metadata.name,
        message: `Side-effecting tool "${toolName}" flows directly into side-effecting tool "${nextTool}".`,
        suggestedFix:
          'Insert explicit confirmation, state checks, or a customer-facing review step between side-effecting tool calls.',
        source: 'lint',
      });
    }
  }

  return issues;
}

function collectDeclaredVariables(document: AgentBasedDocument): Set<string> {
  const declared = new Set<string>();
  for (const field of document.gather ?? []) {
    declared.add(field.name);
  }
  for (const entry of document.memory?.session ?? []) {
    declared.add(entry.name);
  }
  for (const entry of document.memory?.persistent ?? []) {
    declared.add(entry.path.split('.')[0]);
    declared.add(entry.path);
  }
  for (const [stepName, step] of Object.entries(document.flow?.definitions ?? {})) {
    declared.add(stepName);
    if (step.callAs) declared.add(step.callAs);
    for (const assignment of step.set ?? []) {
      declared.add(assignment.variable.split('.')[0]);
      declared.add(assignment.variable);
    }
    for (const field of step.gather?.fields ?? []) {
      declared.add(field.name);
    }
  }
  for (const condition of document.complete ?? []) {
    if (condition.store) declared.add(condition.store);
  }
  return declared;
}

function extractConditionVariables(condition: string): string[] {
  const withoutStrings = condition.replace(/(['"]).*?\1/g, '');
  const variables = new Set<string>();
  for (const match of withoutStrings.matchAll(/\b[A-Za-z_][\w.]*\b/g)) {
    const token = match[0];
    const root = token.split('.')[0];
    if (/^\d/.test(token) || KNOWN_CONDITION_ROOTS.has(token) || KNOWN_CONDITION_ROOTS.has(root)) {
      continue;
    }
    variables.add(root);
  }
  return [...variables];
}

function buildUnresolvedRefs(diagnostics: PackageDiagnostics): CompilerModel['unresolvedRefs'] {
  return diagnostics.issues
    .filter((issue) => issue.code.startsWith('MISSING_'))
    .map((issue) => ({
      type: issue.code.replace(/^MISSING_/, '').toLowerCase(),
      source: issue.agent ?? issue.file ?? '(unknown)',
      target: issue.message.match(/"([^"]+)"/)?.[1] ?? '(unknown)',
      message: issue.message,
    }));
}

function collectSuspectedTranscriptSteps(transcript: unknown): string[] {
  const steps = new Set<string>();

  function visit(value: unknown, keyHint = ''): void {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (
        normalized &&
        (/step|state|node|phase/i.test(keyHint) || /finali[sz]e|complete/i.test(normalized))
      ) {
        const match = normalized.match(/\b(finali[sz]e|complete|done|closeout)\b/i);
        if (match) steps.add(match[1].toLowerCase());
        if (/^[A-Za-z_][\w-]*$/.test(normalized) && /finali[sz]e|complete|done/i.test(normalized)) {
          steps.add(normalized);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }

    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, key);
      }
    }
  }

  visit(transcript);
  return [...steps];
}

function findStepThenCompleteLine(source: string, stepName: string): number | undefined {
  const lines = source.split(/\r?\n/);
  const stepLine = lines.findIndex((line) => line.trim() === `${stepName}:`);
  if (stepLine < 0) return undefined;
  const indent = lines[stepLine].match(/^(\s*)/)?.[1].length ?? 0;
  const end = findNextHeaderAtOrBelowIndent(lines, stepLine + 1, indent);
  for (let index = stepLine + 1; index < end; index++) {
    if (/^\s*THEN:\s*COMPLETE\s*$/i.test(lines[index])) {
      return index + 1;
    }
  }
  return undefined;
}

function findEmptyCompletionRespondLine(source: string): number | undefined {
  const lines = source.split(/\r?\n/);
  const completeLine = lines.findIndex((line) => line.trim() === 'COMPLETE:');
  if (completeLine < 0) return undefined;
  const end = findNextTopLevelHeader(lines, completeLine + 1);
  for (let index = completeLine + 1; index < end; index++) {
    if (/^\s*RESPOND:\s*(['"])\s*\1\s*$/.test(lines[index])) {
      return index + 1;
    }
  }
  return undefined;
}

function findNextTopLevelHeader(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index++) {
    if (/^[A-Za-z_][\w-]*:\s*$/.test(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function findNextHeaderAtOrBelowIndent(lines: string[], start: number, indent: number): number {
  for (let index = start; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)[A-Za-z_][\w-]*:\s*$/);
    if (match && match[1].length <= indent) {
      return index;
    }
  }
  return lines.length;
}

function findLineContaining(source: string, needle: string): number | undefined {
  const index = source.split(/\r?\n/).findIndex((line) => line.includes(needle));
  return index >= 0 ? index + 1 : undefined;
}

function namesMatch(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(left) === normalize(right);
}

function isAgentOrProfileFile(file: string): boolean {
  return (
    file.endsWith('.agent.abl') ||
    file.endsWith('.agent.yaml') ||
    file.endsWith('.behavior_profile.abl') ||
    file.endsWith('.profile.abl')
  );
}

function isAblLikeFile(file: string): boolean {
  return isAgentOrProfileFile(file) || file.endsWith('.tools.abl');
}

function formatReturnType(ret: AgentTool['returns']): string {
  if (ret.items) {
    return `${formatReturnType(ret.items)}[]`;
  }
  if (ret.fields && Object.keys(ret.fields).length > 0) {
    return `{${Object.entries(ret.fields)
      .map(([key, value]) => `${key}${value.optional ? '?' : ''}: ${formatReturnType(value)}`)
      .join(', ')}}`;
  }
  return ret.type;
}

function suggestFix(message: string, code?: string): string {
  const explained = explainImportCompileDiagnostic(message);
  if (explained !== message) {
    return explained;
  }

  if (code === 'E_BEHAVIOR_PROFILE_INVALID_PATH') {
    return 'Move behavior profile files under behavior_profiles/<name>.behavior_profile.abl and update project.json behavior_profiles.<name>.path.';
  }

  if (code === 'E_BEHAVIOR_PROFILE_MISSING_PATH') {
    return 'Add the referenced behavior_profiles/<name>.behavior_profile.abl file to the package, or remove the project.json behavior_profiles entry and any USE BEHAVIOR_PROFILE references.';
  }

  if (message.includes('Unknown layer') && message.includes('layers_included')) {
    return 'Use only canonical layers in layers_included: core, connections, prompts, guardrails, workflows, evals, search, channels, vocabulary. Behavior profiles are part of core, not a layers_included value.';
  }

  if (message.includes('BEHAVIOR_PROFILE')) {
    return 'Keep behavior profiles as standalone BEHAVIOR_PROFILE files, include PRIORITY and WHEN, and attach them from agents with USE BEHAVIOR_PROFILE: <name>.';
  }

  if (message.includes('No agent files')) {
    return 'Add at least one agents/<name>.agent.abl file, or include another supported importable layer with matching project.json metadata.';
  }

  return 'Review the referenced file and align it with the ABL import contract.';
}

function sortIssues(issues: NormalizedIssue[]): NormalizedIssue[] {
  const severityRank: Record<NormalizedSeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...issues].sort((left, right) => {
    const severityDiff = severityRank[left.severity] - severityRank[right.severity];
    if (severityDiff !== 0) return severityDiff;
    return `${left.file ?? ''}:${left.line ?? 0}:${left.code}`.localeCompare(
      `${right.file ?? ''}:${right.line ?? 0}:${right.code}`,
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
