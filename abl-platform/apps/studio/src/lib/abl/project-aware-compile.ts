import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import type { CompilationError, CompilationOutput, CompilerOptions } from '@abl/compiler';
import {
  loadAndBuildModuleAgentStubs,
  parseBehaviorProfileDocumentsFromConfigVariables,
} from '@agent-platform/project-io';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import { findConfigVariablesByProject } from '@/repos/config-variable-repo';
import { getProjectAgents } from '@/services/project-service';
import { buildStudioCompilerOptions } from './studio-compiler-options';
import { createLogger } from '@abl/compiler/platform/logger.js';

export { buildStudioCompilerOptions } from './studio-compiler-options';

export type ProjectAwareCompileMode = 'best_effort' | 'strict';

interface BuildProjectCompileContextInput {
  agentName: string;
  mode?: ProjectAwareCompileMode;
  projectId: string;
  targetDocument: AgentBasedDocument;
  tenantId: string;
}

interface BuildProjectCompileContextResult {
  allDocs: AgentBasedDocument[];
  compilerOptions: CompilerOptions;
  errors: string[];
  warnings: string[];
}

interface ProjectAwareStoredAgentLike {
  name?: string | null;
  dslContent?: string | null;
  systemPromptLibraryRef?: unknown;
}

export interface ProjectAwareParseErrorsByAgent {
  agent: string;
  errors: Array<{ line?: number; message: string }>;
}

export interface ProjectAwareDiagnosticCompilationResult {
  compiled: CompilationOutput | null;
  errors: string[];
  warnings: string[];
  parseErrors: ProjectAwareParseErrorsByAgent[];
}

export interface TargetedCompilationMessages {
  errors: string[];
  warnings: string[];
}

export const STUDIO_PROJECT_AWARE_COMPILE_MODE: ProjectAwareCompileMode = 'best_effort';

const log = createLogger('project-aware-compile');

function describeEditedAgent(agentName: string): string {
  return `edited agent "${agentName}"`;
}

function describeProjectAgent(agentName: string): string {
  return `project agent "${agentName}"`;
}

function formatDuplicateAgentNameError(
  duplicateName: string,
  firstSource: string,
  secondSource: string,
): string {
  return `Agent name "${duplicateName}" is already used by ${firstSource} and ${secondSource}. Rename one of the agents before compiling.`;
}

function shouldIncludeTargetedMessage(entry: CompilationError, names: Set<string>): boolean {
  if (!entry.agent || names.has(entry.agent)) {
    return true;
  }

  // When the edited agent is renamed, sibling cross-agent validation errors
  // are attributed to the sibling that still references the old name.
  return typeof entry.referenced_agent === 'string' && names.has(entry.referenced_agent);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizePromptLibraryRef(ref: unknown): InjectedPromptLibraryRef | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const promptId = 'promptId' in ref ? ref.promptId : undefined;
  const versionId = 'versionId' in ref ? ref.versionId : undefined;

  return typeof promptId === 'string' && typeof versionId === 'string'
    ? { promptId, versionId }
    : null;
}

async function resolveDocumentPromptLibraryRef(params: {
  document: AgentBasedDocument;
  projectId: string;
  sourceLabel: string;
  systemPromptLibraryRef: InjectedPromptLibraryRef | null;
  tenantId: string;
}): Promise<string | null> {
  if (!params.systemPromptLibraryRef) {
    return null;
  }

  const documentWithRef = params.document as AgentBasedDocument & {
    systemPrompt?: string | null;
    systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
  };
  documentWithRef.systemPromptLibraryRef = { ...params.systemPromptLibraryRef };

  try {
    await resolvePromptLibraryRefOnDocument(documentWithRef, {
      tenantId: params.tenantId,
      projectId: params.projectId,
    });
    return null;
  } catch (err) {
    return `Project-aware compile could not resolve ${params.sourceLabel} prompt library reference: ${toErrorMessage(err)}`;
  }
}

function recordProjectAwareContextFailure(params: {
  errors: string[];
  mode: ProjectAwareCompileMode;
  strictMessage: string;
  warnings: string[];
  warningMessage: string;
}): void {
  if (params.mode === 'strict') {
    params.errors.push(params.strictMessage);
    return;
  }

  params.warnings.push(params.warningMessage);
}

export function collectRecoverableParseWarnings(parseResult: {
  errors?: Array<{ line?: number; message: string }>;
  warnings?: Array<{ line?: number; message: string }>;
}): string[] {
  const warnings: string[] = [];

  // Collect parser warnings (e.g. E720 implementation property hints).
  // Parser errors are NOT converted to warnings — they indicate real parse
  // failures and must be handled separately by the caller.
  for (const entry of parseResult.warnings ?? []) {
    warnings.push(`Line ${entry.line ?? '?'}: ${entry.message}`);
  }

  return warnings;
}

export async function buildProjectCompileContext({
  agentName,
  mode = STUDIO_PROJECT_AWARE_COMPILE_MODE,
  projectId,
  targetDocument,
  tenantId,
}: BuildProjectCompileContextInput): Promise<BuildProjectCompileContextResult> {
  const allDocs: AgentBasedDocument[] = [targetDocument];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenAgentNames = new Map<string, string>([
    [targetDocument.name, describeEditedAgent(agentName)],
  ]);

  let allAgents: Awaited<ReturnType<typeof getProjectAgents>> = [];
  try {
    allAgents = await getProjectAgents(projectId, tenantId);
  } catch (err) {
    const message = toErrorMessage(err);
    recordProjectAwareContextFailure({
      errors,
      mode,
      strictMessage: `Project-aware compile requires sibling agent context, but it could not be loaded: ${message}`,
      warnings,
      warningMessage: `Project-aware compile continued without sibling agent context: ${message}`,
    });
  }

  const targetPromptError = await resolveDocumentPromptLibraryRef({
    document: targetDocument,
    projectId,
    sourceLabel: `edited agent "${agentName}"`,
    systemPromptLibraryRef: normalizePromptLibraryRef(
      allAgents.find((agent) => String(agent.name) === agentName)?.systemPromptLibraryRef,
    ),
    tenantId,
  });
  if (targetPromptError) {
    errors.push(targetPromptError);
  }

  for (const sibling of allAgents) {
    if (String(sibling.name) === agentName || !sibling.dslContent) {
      continue;
    }

    const siblingParse = parseAgentBasedABL(sibling.dslContent);
    if (siblingParse.document) {
      const existingSource = seenAgentNames.get(siblingParse.document.name);
      if (existingSource) {
        errors.push(
          formatDuplicateAgentNameError(
            siblingParse.document.name,
            existingSource,
            describeProjectAgent(String(sibling.name)),
          ),
        );
        continue;
      }

      seenAgentNames.set(siblingParse.document.name, describeProjectAgent(String(sibling.name)));
      const siblingPromptError = await resolveDocumentPromptLibraryRef({
        document: siblingParse.document,
        projectId,
        sourceLabel: `project agent "${String(sibling.name)}"`,
        systemPromptLibraryRef: normalizePromptLibraryRef(sibling.systemPromptLibraryRef),
        tenantId,
      });
      if (siblingPromptError) {
        errors.push(siblingPromptError);
        continue;
      }
      allDocs.push(siblingParse.document);
    }
  }

  // Load imported module dependencies and create stub documents so the
  // cross-agent validator treats mounted agent names as known targets.
  try {
    const stubDocs = await loadAndBuildModuleAgentStubs(projectId, tenantId, seenAgentNames.keys());
    for (const stubDoc of stubDocs) {
      seenAgentNames.set(stubDoc.name, `imported module agent "${stubDoc.name}"`);
      allDocs.push(stubDoc);
    }
  } catch (err) {
    const message = toErrorMessage(err);
    recordProjectAwareContextFailure({
      errors,
      mode,
      strictMessage: `Project-aware compile requires module dependency context, but it could not be loaded: ${message}`,
      warnings,
      warningMessage: `Project-aware compile continued without module dependency context: ${message}`,
    });
  }

  let configVariables: Record<string, string> | undefined;
  try {
    const vars = await findConfigVariablesByProject(projectId, tenantId);
    if (vars.length > 0) {
      configVariables = {};
      for (const v of vars) {
        configVariables[v.key] = v.value;
      }
    }
  } catch (err) {
    const message = toErrorMessage(err);
    recordProjectAwareContextFailure({
      errors,
      mode,
      strictMessage: `Project-aware compile requires project config variables, but they could not be loaded: ${message}`,
      warnings,
      warningMessage: `Project-aware compile continued without project config variables: ${message}`,
    });
  }
  if (configVariables) {
    const profileDocuments = parseBehaviorProfileDocumentsFromConfigVariables(configVariables);
    allDocs.push(...profileDocuments.documents);
    warnings.push(...profileDocuments.errors);
  }

  const {
    compilerOptions,
    errors: compilerOptionErrors,
    warnings: toolWarnings,
  } = await buildStudioCompilerOptions({
    documents: allDocs,
    projectId,
    tenantId,
    configVariables,
  });
  errors.push(...compilerOptionErrors);
  warnings.push(...toolWarnings);

  return { allDocs, compilerOptions, errors, warnings };
}

export async function compileProjectAgentsForDiagnostics(input: {
  agents: ProjectAwareStoredAgentLike[];
  mode?: ProjectAwareCompileMode;
  projectId: string;
  tenantId: string;
}): Promise<ProjectAwareDiagnosticCompilationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parseErrors: ProjectAwareParseErrorsByAgent[] = [];
  const allDocs: AgentBasedDocument[] = [];
  const seenAgentNames = new Map<string, string>();

  for (const agent of input.agents) {
    const storedAgentName = typeof agent.name === 'string' ? agent.name : 'unknown';
    const dslContent = typeof agent.dslContent === 'string' ? agent.dslContent : null;
    if (!dslContent) {
      continue;
    }

    const parseResult = parseAgentBasedABL(dslContent);
    if (parseResult.errors.length > 0) {
      parseErrors.push({
        agent: storedAgentName,
        errors: parseResult.errors.map((entry) => ({
          line: entry.line,
          message: entry.message,
        })),
      });
    }

    if (!parseResult.document) {
      continue;
    }

    warnings.push(...collectRecoverableParseWarnings(parseResult));

    const existingSource = seenAgentNames.get(parseResult.document.name);
    if (existingSource) {
      errors.push(
        formatDuplicateAgentNameError(
          parseResult.document.name,
          existingSource,
          describeProjectAgent(storedAgentName),
        ),
      );
      continue;
    }

    seenAgentNames.set(parseResult.document.name, describeProjectAgent(storedAgentName));

    const promptError = await resolveDocumentPromptLibraryRef({
      document: parseResult.document,
      projectId: input.projectId,
      sourceLabel: `project agent "${storedAgentName}"`,
      systemPromptLibraryRef: normalizePromptLibraryRef(agent.systemPromptLibraryRef),
      tenantId: input.tenantId,
    });
    if (promptError) {
      errors.push(promptError);
    }

    allDocs.push(parseResult.document);
  }

  // Load imported module dependencies and create stub documents so the
  // cross-agent validator treats mounted agent names as known targets.
  try {
    const stubDocs = await loadAndBuildModuleAgentStubs(
      input.projectId,
      input.tenantId,
      seenAgentNames.keys(),
    );
    for (const stubDoc of stubDocs) {
      seenAgentNames.set(stubDoc.name, `imported module agent "${stubDoc.name}"`);
      allDocs.push(stubDoc);
    }
  } catch (err) {
    const message = toErrorMessage(err);
    recordProjectAwareContextFailure({
      errors,
      mode: input.mode ?? STUDIO_PROJECT_AWARE_COMPILE_MODE,
      strictMessage: `Project-aware diagnostics require module dependency context, but it could not be loaded: ${message}`,
      warnings,
      warningMessage: `Project-aware diagnostics continued without module dependency context: ${message}`,
    });
  }

  let configVariables: Record<string, string> | undefined;
  try {
    const vars = await findConfigVariablesByProject(input.projectId, input.tenantId);
    if (vars.length > 0) {
      configVariables = {};
      for (const variable of vars) {
        configVariables[variable.key] = variable.value;
      }
    }
  } catch (err) {
    const message = toErrorMessage(err);
    recordProjectAwareContextFailure({
      errors,
      mode: input.mode ?? STUDIO_PROJECT_AWARE_COMPILE_MODE,
      strictMessage: `Project-aware diagnostics require project config variables, but they could not be loaded: ${message}`,
      warnings,
      warningMessage: `Project-aware diagnostics continued without project config variables: ${message}`,
    });
  }

  if (configVariables) {
    const profileDocuments = parseBehaviorProfileDocumentsFromConfigVariables(configVariables);
    allDocs.push(...profileDocuments.documents);
    warnings.push(...profileDocuments.errors);
  }

  const {
    compilerOptions,
    errors: compilerOptionErrors,
    warnings: toolWarnings,
  } = await buildStudioCompilerOptions({
    documents: allDocs,
    projectId: input.projectId,
    tenantId: input.tenantId,
    configVariables,
  });
  errors.push(...compilerOptionErrors);
  warnings.push(...toolWarnings);

  if (allDocs.length === 0) {
    return { compiled: null, errors, warnings, parseErrors };
  }

  try {
    const { compileABLtoIR } = await import('@abl/compiler');
    return {
      compiled: compileABLtoIR(allDocs, compilerOptions),
      errors,
      warnings,
      parseErrors,
    };
  } catch (err) {
    errors.push(`Project-aware diagnostic compile failed: ${toErrorMessage(err)}`);
    return {
      compiled: null,
      errors,
      warnings,
      parseErrors,
    };
  }
}

export function collectTargetCompilationMessages(
  compilationOutput: CompilationOutput,
  targetAgentNames: Iterable<string>,
): TargetedCompilationMessages {
  const names = new Set(targetAgentNames);
  const defaultAgentName = [...names][0] ?? 'unknown';
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const entry of compilationOutput.compilation_errors ?? []) {
    if (shouldIncludeTargetedMessage(entry, names)) {
      errors.push(`${entry.agent ?? defaultAgentName}: ${entry.message}`);
    }
  }

  for (const entry of compilationOutput.compilation_warnings ?? []) {
    if (shouldIncludeTargetedMessage(entry, names)) {
      warnings.push(`${entry.agent ?? defaultAgentName}: ${entry.message}`);
    }
  }

  return { errors, warnings };
}

export function pickTargetIR(
  compilationOutput: CompilationOutput,
  targetAgentNames: Iterable<string>,
): Record<string, unknown> | null {
  for (const name of targetAgentNames) {
    const ir = compilationOutput.agents[name];
    if (ir) {
      return ir as unknown as Record<string, unknown>;
    }
  }
  return null;
}
