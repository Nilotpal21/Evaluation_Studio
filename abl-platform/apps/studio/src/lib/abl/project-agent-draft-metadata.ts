import type { CompilerOptions } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import type { ClientSession } from 'mongoose';
import {
  evaluateProjectAgentDraftMetadata,
  loadAndBuildModuleAgentStubs,
  parseBehaviorProfileDocumentsFromConfigVariables,
  type ProjectAgentDraftMetadata,
  type ProjectAgentDraftState,
} from '@agent-platform/project-io';
import {
  ProjectAgent,
  ProjectConfigVariable,
  type IProjectAgent,
} from '@agent-platform/database/models';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import { buildStudioCompilerOptions } from './studio-compiler-options';

const log = createLogger('studio:project-agent-draft-metadata');

interface StudioProjectAgentDraftRecordDiagnostics {
  errors?: readonly string[];
  warnings?: readonly string[];
}

export function toProjectAgentDraftState(record: {
  name?: string | null;
  dslContent?: string | null;
  systemPromptLibraryRef?: ProjectAgentDraftState['systemPromptLibraryRef'];
}): ProjectAgentDraftState | null {
  if (typeof record.name !== 'string' || record.name.length === 0) {
    return null;
  }

  return {
    recordName: record.name,
    dslContent: typeof record.dslContent === 'string' ? record.dslContent : null,
    systemPromptLibraryRef: record.systemPromptLibraryRef ?? null,
  };
}

export function mergeProjectAgentDraftStates(
  currentAgents: ReadonlyArray<{
    name?: string | null;
    dslContent?: string | null;
    systemPromptLibraryRef?: ProjectAgentDraftState['systemPromptLibraryRef'];
  }>,
  overrides: ReadonlyArray<ProjectAgentDraftState>,
): ProjectAgentDraftState[] {
  const projected = new Map<string, ProjectAgentDraftState>();

  for (const agent of currentAgents) {
    const state = toProjectAgentDraftState(agent);
    if (state) {
      projected.set(state.recordName, state);
    }
  }

  for (const override of overrides) {
    projected.set(override.recordName, override);
  }

  return [...projected.values()];
}

async function loadProjectConfigVariablesMap(
  projectId: string,
  tenantId: string,
  session?: ClientSession,
): Promise<Record<string, string> | undefined> {
  const docs = (await ProjectConfigVariable.find(
    { projectId, tenantId },
    { key: 1, value: 1 },
    session ? { session } : undefined,
  )
    .select('key value')
    .lean()) as Array<{ key?: string; value?: string }>;

  if (docs.length === 0) {
    return undefined;
  }

  const configVariables: Record<string, string> = {};
  for (const doc of docs) {
    if (typeof doc.key === 'string' && typeof doc.value === 'string') {
      configVariables[doc.key] = doc.value;
    }
  }

  return Object.keys(configVariables).length > 0 ? configVariables : undefined;
}

async function buildStudioCompilerContext(input: {
  projectId: string;
  tenantId: string;
  agents: ProjectAgentDraftState[];
  session?: ClientSession;
}): Promise<{
  compilerOptions: CompilerOptions;
  contextErrors: string[];
  contextDocuments: AgentBasedDocument[];
  contextWarnings: string[];
  recordDiagnostics: Map<string, StudioProjectAgentDraftRecordDiagnostics>;
}> {
  const contextErrors: string[] = [];
  const contextWarnings: string[] = [];
  const contextDocuments: AgentBasedDocument[] = [];
  const recordDiagnostics = new Map<string, StudioProjectAgentDraftRecordDiagnostics>();

  const configVariables = await loadProjectConfigVariablesMap(
    input.projectId,
    input.tenantId,
    input.session,
  );

  const parsedDocuments: AgentBasedDocument[] = [];
  for (const agent of input.agents) {
    if (typeof agent.dslContent !== 'string' || agent.dslContent.trim().length === 0) {
      continue;
    }

    const parseResult = parseAgentBasedABL(agent.dslContent);
    if (!parseResult.document) {
      continue;
    }

    const promptLibraryRef = normalizePromptLibraryRef(agent.systemPromptLibraryRef);
    if (promptLibraryRef) {
      const documentWithRef = parseResult.document as AgentBasedDocument & {
        systemPrompt?: string | null;
        systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
      };
      documentWithRef.systemPromptLibraryRef = { ...promptLibraryRef };

      try {
        await resolvePromptLibraryRefOnDocument(documentWithRef, {
          tenantId: input.tenantId,
          projectId: input.projectId,
        });
      } catch (error) {
        recordDiagnostics.set(agent.recordName, {
          ...(recordDiagnostics.get(agent.recordName) ?? {}),
          errors: [
            ...((recordDiagnostics.get(agent.recordName)?.errors ?? []) as string[]),
            formatPromptLibraryResolutionError(agent.recordName, error),
          ],
        });
      }
    }

    parsedDocuments.push(parseResult.document);
  }

  const profileDocuments = configVariables
    ? parseBehaviorProfileDocumentsFromConfigVariables(configVariables)
    : { documents: [], errors: [] };
  contextDocuments.push(...profileDocuments.documents);
  contextWarnings.push(...profileDocuments.errors);

  // Load imported module agent stubs so cross-agent validation recognizes
  // module handoff/delegate targets (e.g. benefits_ai__Benefits_Agent).
  try {
    const moduleStubs = await loadAndBuildModuleAgentStubs(input.projectId, input.tenantId, [
      ...parsedDocuments.map((d) => d.name),
      ...contextDocuments.map((d) => d.name),
    ]);
    contextDocuments.push(...moduleStubs);
  } catch (err) {
    log.warn('Failed to load module agent stubs for studio draft validation', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const toolAwareOptions = await buildStudioCompilerOptions({
    configVariables,
    documents: [...parsedDocuments, ...contextDocuments],
    projectId: input.projectId,
    tenantId: input.tenantId,
  });

  return {
    compilerOptions: { ...toolAwareOptions.compilerOptions, mode: 'preview' },
    contextErrors: [...contextErrors, ...toolAwareOptions.errors],
    contextWarnings: [...contextWarnings, ...toolAwareOptions.warnings],
    contextDocuments,
    recordDiagnostics,
  };
}

export async function evaluateStudioProjectAgentDrafts(input: {
  projectId: string;
  tenantId: string;
  agents: ProjectAgentDraftState[];
  diagnosticSource: string;
  session?: ClientSession;
}): Promise<Map<string, ProjectAgentDraftMetadata>> {
  const { compilerOptions, contextErrors, contextDocuments, contextWarnings, recordDiagnostics } =
    await buildStudioCompilerContext(input);
  const evaluationInput = {
    agents: input.agents,
    diagnosticSource: input.diagnosticSource,
    compilerOptions,
    contextDocuments,
    contextErrors,
    contextWarnings,
    recordDiagnostics,
  } as Parameters<typeof evaluateProjectAgentDraftMetadata>[0] & {
    contextDocuments: AgentBasedDocument[];
    recordDiagnostics: Map<string, StudioProjectAgentDraftRecordDiagnostics>;
  };

  return evaluateProjectAgentDraftMetadata(evaluationInput);
}

export async function refreshPersistedStudioProjectAgentDraftMetadata(input: {
  projectId: string;
  tenantId: string;
  session?: ClientSession;
}): Promise<Map<string, ProjectAgentDraftMetadata>> {
  const queryOptions = input.session ? { session: input.session } : undefined;
  const existingAgents = (await ProjectAgent.find(
    { projectId: input.projectId, tenantId: input.tenantId },
    null,
    queryOptions,
  ).lean()) as IProjectAgent[];

  if (existingAgents.length === 0) {
    return new Map();
  }

  const metadataByAgent = await evaluateStudioProjectAgentDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: existingAgents
      .map((agent) => toProjectAgentDraftState(agent))
      .filter((agent): agent is ProjectAgentDraftState => agent !== null),
    diagnosticSource: 'studio-repo',
    session: input.session,
  });

  await ProjectAgent.bulkWrite(
    existingAgents.map((agent) => {
      const metadata = metadataByAgent.get(agent.name);
      return {
        updateOne: {
          filter: {
            _id: agent._id,
            projectId: input.projectId,
            tenantId: input.tenantId,
          },
          update: {
            $set: {
              sourceHash: metadata?.sourceHash ?? null,
              dslValidationStatus: metadata?.dslValidationStatus ?? null,
              dslDiagnostics: metadata?.dslDiagnostics ?? [],
            },
          },
        },
      };
    }),
    queryOptions,
  );

  return metadataByAgent;
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

function formatPromptLibraryResolutionError(recordName: string, error: unknown): string {
  return `Project-aware compile could not resolve project agent "${recordName}" prompt library reference: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
