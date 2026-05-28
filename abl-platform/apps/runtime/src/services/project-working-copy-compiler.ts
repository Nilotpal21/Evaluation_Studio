import { compileABLtoIR, type ToolDefinition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import {
  loadAndBuildModuleAgentStubs,
  parseBehaviorProfileDocumentsFromConfigVariables,
  type ParsedBehaviorProfileDocuments,
} from '@agent-platform/project-io';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import type { ResolvedAgent } from './deployment-resolver.js';
import {
  findProjectLLMConfig,
  findProjectRuntimeConfig,
  loadConfigVariablesMap,
} from '../repos/project-repo.js';
import { resolveProjectToolsFromDocuments } from './execution/types.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
  type ProjectAgentDslDiagnostic,
} from './session/project-agent-dsl-readiness.js';

const log = createLogger('project-working-copy-compiler');

type WorkingCopyCompilationError = NonNullable<
  ReturnType<typeof compileABLtoIR>['compilation_errors']
>[number];

function formatWorkingCopyCompilationError(error: WorkingCopyCompilationError): string {
  const parts = [
    error.agent ? `${error.agent}` : null,
    error.code ? `[${error.code}]` : null,
    error.path ? `${error.path}` : null,
    error.message,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);

  return parts.join(' ');
}

export interface ProjectWorkingCopyAgentSource {
  name: string;
  dslContent: string;
  dslValidationStatus?: string | null;
  dslDiagnostics?: readonly ProjectAgentDslDiagnostic[] | null;
  systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
}

export function normalizeProjectWorkingCopyLibraryRef(agent: unknown): {
  promptId: string;
  versionId: string;
} | null {
  if (!agent || typeof agent !== 'object' || !('systemPromptLibraryRef' in agent)) {
    return null;
  }

  const libraryRef = agent.systemPromptLibraryRef;
  if (!libraryRef || typeof libraryRef !== 'object') {
    return null;
  }

  const promptId = 'promptId' in libraryRef ? libraryRef.promptId : undefined;
  const versionId = 'versionId' in libraryRef ? libraryRef.versionId : undefined;

  return typeof promptId === 'string' && typeof versionId === 'string'
    ? { promptId, versionId }
    : null;
}

export function buildProjectWorkingCopyAgentSources(
  agents: Array<{
    name?: unknown;
    dslContent?: unknown;
    dslValidationStatus?: unknown;
    dslDiagnostics?: unknown;
    systemPromptLibraryRef?: unknown;
  }>,
): ProjectWorkingCopyAgentSource[] {
  return agents
    .filter(
      (
        agent,
      ): agent is {
        name: string;
        dslContent: string;
        dslValidationStatus?: string | null;
        dslDiagnostics?: readonly ProjectAgentDslDiagnostic[] | null;
        systemPromptLibraryRef?: unknown;
      } => typeof agent.name === 'string' && typeof agent.dslContent === 'string',
    )
    .map((agent) => ({
      name: agent.name,
      dslContent: agent.dslContent,
      dslValidationStatus:
        typeof agent.dslValidationStatus === 'string' || agent.dslValidationStatus === null
          ? agent.dslValidationStatus
          : undefined,
      dslDiagnostics: Array.isArray(agent.dslDiagnostics)
        ? (agent.dslDiagnostics as ProjectAgentDslDiagnostic[])
        : null,
      systemPromptLibraryRef: normalizeProjectWorkingCopyLibraryRef(agent),
    }));
}

export interface ProjectWorkingCopyCompileParams {
  tenantId: string;
  projectId: string;
  entryAgentName: string;
  environment?: string;
  agents: ProjectWorkingCopyAgentSource[];
}

export interface ProjectWorkingCopyCompileResult {
  resolved: ResolvedAgent;
  configVariables: Record<string, string>;
  warnings: string[];
  documents: AgentBasedDocument[];
  profileDocuments: ParsedBehaviorProfileDocuments['documents'];
}

interface ResolvedLibraryRefMetadata extends InjectedPromptLibraryRef {
  resolvedHash: string;
}

async function parseWorkingCopyDocuments(
  params: Pick<ProjectWorkingCopyCompileParams, 'agents' | 'tenantId' | 'projectId'>,
): Promise<{
  documents: AgentBasedDocument[];
  warnings: string[];
  libraryRefsByName: Map<string, ResolvedLibraryRefMetadata>;
}> {
  const documents: AgentBasedDocument[] = [];
  const warnings: string[] = [];
  const libraryRefsByName = new Map<string, ResolvedLibraryRefMetadata>();

  for (const agent of params.agents) {
    const parseResult = parseAgentBasedABL(agent.dslContent);
    if (parseResult.errors.length > 0) {
      warnings.push(
        `${agent.name}: ${parseResult.errors.map((error) => error.message).join(', ')}`,
      );
    }

    if (!parseResult.document) {
      continue;
    }

    if (agent.systemPromptLibraryRef) {
      const documentWithRef = parseResult.document as AgentBasedDocument & {
        systemPrompt?: string | null;
        systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
      };
      documentWithRef.systemPromptLibraryRef = { ...agent.systemPromptLibraryRef };
      await resolvePromptLibraryRefOnDocument(documentWithRef, {
        tenantId: params.tenantId,
        projectId: params.projectId,
      });

      if (documentWithRef.systemPromptLibraryRef?.resolvedHash) {
        libraryRefsByName.set(parseResult.document.name, {
          promptId: documentWithRef.systemPromptLibraryRef.promptId,
          versionId: documentWithRef.systemPromptLibraryRef.versionId,
          resolvedHash: documentWithRef.systemPromptLibraryRef.resolvedHash,
        });
      }
    }

    documents.push(parseResult.document);
  }

  return { documents, warnings, libraryRefsByName };
}

function attachResolvedLibraryRefs(
  resolved: ResolvedAgent,
  libraryRefsByName: Map<string, ResolvedLibraryRefMetadata>,
): void {
  for (const [agentName, libraryRef] of libraryRefsByName.entries()) {
    const targetIR = resolved.agents[agentName];
    if (!targetIR?.identity?.system_prompt) {
      continue;
    }

    targetIR.identity.system_prompt.libraryRef = {
      promptId: libraryRef.promptId,
      versionId: libraryRef.versionId,
      resolvedHash: libraryRef.resolvedHash,
    };
  }
}

async function assertProjectWorkingCopyExecutionReady(
  params: ProjectWorkingCopyCompileParams,
): Promise<ProjectWorkingCopyAgentSource[]> {
  const [runtimeConfig, llmConfig] = await Promise.all([
    findProjectRuntimeConfig(params.projectId, params.tenantId),
    findProjectLLMConfig(params.projectId, params.tenantId),
  ]);
  const readiness = await evaluateProjectExecutionReadiness({
    agents: params.agents,
    tenantId: params.tenantId,
    projectId: params.projectId,
    runtimeConfig,
    llmConfig,
    lazyBackfill: true,
  });

  if (!readiness.hasBlockingErrors) {
    return readiness.executableAgents;
  }

  log.warn('Refusing working-copy compile for project with readiness errors', {
    tenantId: params.tenantId,
    projectId: params.projectId,
    issueKinds: readiness.issues.map((issue) => issue.kind),
    blockedAgents: readiness.blockedAgents,
  });
  throw new AppError(buildProjectDslReadinessError(), {
    ...ErrorCodes.UNPROCESSABLE_ENTITY,
    messages: readiness.issues.flatMap((issue) =>
      issue.diagnostics.map((diagnostic) => diagnostic.message),
    ),
  });
}

/**
 * Extract per-tool search_instructions pipe blocks from an agent's raw DSL.
 *
 * Agent DSL format:
 *   TOOLS:
 *     discovery(query: string) -> object
 *       type: searchai
 *       search_instructions: |
 *         Detect language and add filter...
 *
 * Returns a map of toolName → search_instructions content.
 */
export function extractSearchInstructionsFromDsl(dslContent: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = dslContent.split('\n');
  let inTools = false;
  let toolsIndent = -1;
  let currentToolName: string | null = null;
  let currentToolIndent = -1;
  let capturingInstructions = false;
  let instructionsBaseIndent = -1;
  const instructionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect TOOLS: section
    if (trimmed === 'TOOLS:' || trimmed === 'TOOLS :') {
      inTools = true;
      toolsIndent = indent;
      continue;
    }

    if (!inTools) continue;

    // Detect tool signature: name(params) -> returnType
    // Check BEFORE exit-condition so tools at same indent as TOOLS: (indent 0) are accepted.
    const sigMatch = trimmed.match(/^(\w+)\s*\(/);
    if (sigMatch && indent >= toolsIndent) {
      // Flush any pending pipe-block instructions from previous tool
      if (capturingInstructions && currentToolName && instructionLines.length > 0) {
        result.set(currentToolName, instructionLines.join('\n').trimEnd());
        instructionLines.length = 0;
        capturingInstructions = false;
      }
      // Flush non-pipe instructions
      if (!capturingInstructions && currentToolName && instructionLines.length > 0) {
        result.set(currentToolName, instructionLines.join('\n').trimEnd());
        instructionLines.length = 0;
      }
      currentToolName = sigMatch[1];
      currentToolIndent = indent;
      capturingInstructions = false;
      continue;
    }

    // Exit TOOLS section when we hit a non-empty, non-tool line at same or lower indent
    // (e.g., another top-level section like FLOWS:, CONSTRAINTS:, etc.)
    if (trimmed && indent <= toolsIndent && trimmed !== 'TOOLS:') {
      // Flush any pending instructions
      if (capturingInstructions && currentToolName && instructionLines.length > 0) {
        result.set(currentToolName, instructionLines.join('\n').trimEnd());
      }
      break;
    }

    // If capturing search_instructions pipe block
    if (capturingInstructions) {
      if (!trimmed) {
        instructionLines.push('');
        continue;
      }
      // Detect base indent from first non-empty content line
      if (instructionsBaseIndent === -1) {
        instructionsBaseIndent = indent;
      }
      if (indent >= instructionsBaseIndent) {
        // Strip the base indentation
        instructionLines.push(line.slice(instructionsBaseIndent));
        continue;
      }
      // End of pipe block — flush
      if (currentToolName && instructionLines.length > 0) {
        result.set(currentToolName, instructionLines.join('\n').trimEnd());
      }
      capturingInstructions = false;
      instructionLines.length = 0;
      // Fall through to process this line normally
    }

    // Detect search_instructions: | under current tool
    // Properties can be at same indent as tool sig or deeper
    if (currentToolName && indent >= currentToolIndent) {
      const instrMatch = trimmed.match(/^search_instructions\s*:\s*\|$/);
      if (instrMatch) {
        capturingInstructions = true;
        instructionsBaseIndent = -1; // will be set to first content line's indent
        instructionLines.length = 0;
        continue;
      }
      // Also handle single-line or multiline quoted search_instructions: "value"
      const inlinMatch = trimmed.match(/^search_instructions\s*:\s*(.+)$/);
      if (inlinMatch && !inlinMatch[1].trim().endsWith('|')) {
        let rawValue = inlinMatch[1];
        // Check if this is a quoted multiline value (starts with " but doesn't end with ")
        const startsWithQuote = rawValue.startsWith('"') || rawValue.startsWith("'");
        const quoteChar = startsWithQuote ? rawValue[0] : null;
        if (startsWithQuote && !rawValue.trimEnd().endsWith(quoteChar!)) {
          // Accumulate continuation lines until we find the closing quote
          const valueParts = [rawValue.slice(1)]; // strip opening quote
          for (let j = i + 1; j < lines.length; j++) {
            const contLine = lines[j];
            const contTrimmed = contLine.trimEnd();
            if (contTrimmed.endsWith(quoteChar!)) {
              valueParts.push(contTrimmed.slice(0, -1)); // strip closing quote
              i = j; // advance outer loop past consumed lines
              break;
            }
            valueParts.push(contLine);
          }
          const value = valueParts.join('\n').trim();
          if (value) {
            result.set(currentToolName, value);
          }
        } else {
          // Single-line value — strip surrounding quotes
          const value = rawValue.replace(/^["']|["']$/g, '').trim();
          if (value) {
            result.set(currentToolName, value);
          }
        }
        continue;
      }
    }
  }

  // Flush trailing instructions
  if (capturingInstructions && currentToolName && instructionLines.length > 0) {
    result.set(currentToolName, instructionLines.join('\n').trimEnd());
  }

  return result;
}

/**
 * Inject search_instructions from agent DSLs into resolved searchai tool bindings.
 *
 * search_instructions is a per-agent behavioral property: different agents can use
 * the same KB tool with different instructions. The project_tools dslContent may not
 * contain it, so we extract from the agent DSL and inject at compile time.
 */
function injectSearchInstructionsIntoResolvedTools(
  resolvedTools: Map<string, ToolDefinition[]>,
  agents: ProjectWorkingCopyAgentSource[],
  documents: AgentBasedDocument[],
): void {
  for (const agent of agents) {
    const doc = documents.find((d) => d.name === agent.name);
    if (!doc) continue;

    const agentTools = resolvedTools.get(doc.name);
    if (!agentTools || agentTools.length === 0) continue;

    const instructionsMap = extractSearchInstructionsFromDsl(agent.dslContent);
    if (instructionsMap.size === 0) continue;

    log.info('Injecting search_instructions from agent DSL', {
      agentName: doc.name,
      toolsWithInstructions: [...instructionsMap.keys()],
    });

    for (const tool of agentTools) {
      if (tool.tool_type !== 'searchai') continue;
      const instructions = instructionsMap.get(tool.name);
      if (!instructions) continue;

      // Inject into existing binding or create one if it exists but lacks instructions
      if (tool.searchai_binding) {
        if (!tool.searchai_binding.searchInstructions) {
          tool.searchai_binding.searchInstructions = instructions;
        }
      } else {
        // If the tool has no binding yet (shouldn't happen for resolved tools),
        // we can't create one without tenantId/indexId — log and skip
        log.warn('SearchAI tool has search_instructions in DSL but no binding', {
          toolName: tool.name,
          agentName: doc.name,
        });
      }
    }
  }
}

export async function compileProjectWorkingCopy(
  params: ProjectWorkingCopyCompileParams,
): Promise<ProjectWorkingCopyCompileResult> {
  const readyAgents = await assertProjectWorkingCopyExecutionReady(params);
  const { documents, warnings, libraryRefsByName } = await parseWorkingCopyDocuments({
    ...params,
    agents: readyAgents,
  });

  if (documents.length === 0) {
    throw new AppError('No valid agent documents parsed', { ...ErrorCodes.BAD_REQUEST });
  }

  let configVariables: Record<string, string> = {};
  try {
    configVariables = await loadConfigVariablesMap(params.projectId, params.tenantId);
  } catch (err) {
    log.warn('Failed to load config variables for project working-copy compile', {
      projectId: params.projectId,
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const profileDocuments = parseBehaviorProfileDocumentsFromConfigVariables(configVariables);
  if (profileDocuments.errors.length > 0) {
    warnings.push(...profileDocuments.errors);
  }

  const allDocuments = [...documents, ...profileDocuments.documents];

  // Load imported module agent stubs so the compiler recognizes them as valid
  // handoff/delegate targets (e.g. benefits__coverage_agent).
  try {
    const moduleStubs = await loadAndBuildModuleAgentStubs(
      params.projectId,
      params.tenantId,
      allDocuments.map((d) => d.name),
    );
    allDocuments.push(...moduleStubs);
  } catch (err) {
    log.warn('Failed to load module agent stubs for working-copy compile', {
      projectId: params.projectId,
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const compilerOptions: Record<string, unknown> = {};
  if (Object.keys(configVariables).length > 0) {
    compilerOptions.config_variables = configVariables;
  }

  const resolvedTools = await resolveProjectToolsFromDocuments(
    params.tenantId,
    params.projectId,
    allDocuments,
    { failOnErrors: false },
  );
  if (resolvedTools.size > 0) {
    // Inject search_instructions from agent DSLs into resolved searchai bindings.
    // search_instructions is agent-level (different agents can override), so it
    // may not be stored in project_tools.dslContent — extract from agent DSL.
    injectSearchInstructionsIntoResolvedTools(resolvedTools, readyAgents, documents);
    compilerOptions.resolvedToolImplementations = resolvedTools;
  }

  const compilationOutput = compileABLtoIR(
    allDocuments,
    Object.keys(compilerOptions).length > 0 ? compilerOptions : undefined,
  );

  const compilationErrors = compilationOutput.compilation_errors ?? [];
  if (compilationErrors.length > 0) {
    const messages = compilationErrors.map(formatWorkingCopyCompilationError);
    log.warn('Working-copy compilation completed with errors', {
      projectId: params.projectId,
      tenantId: params.tenantId,
      errorCount: compilationErrors.length,
      errors: messages.join('; '),
    });
    throw new AppError('Working-copy compilation failed. Fix project DSL errors before runtime.', {
      ...ErrorCodes.UNPROCESSABLE_ENTITY,
      messages,
    });
  }

  const resolved: ResolvedAgent = {
    agents: compilationOutput.agents,
    entryAgent: compilationOutput.agents[params.entryAgentName]
      ? params.entryAgentName
      : compilationOutput.entry_agent || params.entryAgentName,
    compilationOutput,
    sourceHash: 'working-copy',
    versionInfo: {
      environment: params.environment || 'dev',
      versions: {},
    },
  };
  attachResolvedLibraryRefs(resolved, libraryRefsByName);

  return {
    resolved,
    configVariables,
    warnings,
    documents,
    profileDocuments: profileDocuments.documents,
  };
}
