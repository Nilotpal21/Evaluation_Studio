import type { CompilerOptions } from '@abl/compiler';
import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import { createLogger } from '@abl/compiler/platform';
import {
  ProjectAgent,
  ProjectConfigVariable,
  type IProjectAgent,
} from '@agent-platform/database/models';
import {
  evaluateProjectAgentDraftMetadata,
  loadAndBuildModuleAgentStubs,
  parseBehaviorProfileDocumentsFromConfigVariables,
  type ProjectAgentDraftMetadata,
  type ProjectAgentDraftState,
} from '@agent-platform/project-io';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import { resolveProjectToolsFromDocuments } from '../execution/types.js';

const log = createLogger('project-agent-draft-metadata');

interface RuntimeProjectAgentDraftRecordDiagnostics {
  errors?: readonly string[];
  warnings?: readonly string[];
}

export interface RuntimeProjectAgentDraftMetadataBackfillRecord {
  name?: string | null;
  dslContent?: string | null;
  dslValidationStatus?: string | null;
  dslDiagnostics?:
    | readonly {
        severity?: string | null;
        message?: string | null;
        source?: string | null;
      }[]
    | null;
  sourceHash?: string | null;
  systemPromptLibraryRef?: ProjectAgentDraftState['systemPromptLibraryRef'];
}

export interface RuntimeProjectAgentDraftMetadataBackfillResult<
  T extends RuntimeProjectAgentDraftMetadataBackfillRecord,
> {
  agents: T[];
  backfilledAgentNames: string[];
}

interface RuntimeProjectAgentDraftMetadataBackfillDeps {
  evaluateDrafts?: typeof evaluateRuntimeProjectAgentDrafts;
  loadConfigVariables?: typeof loadRuntimeProjectConfigVariablesMap;
  persistMetadata?: (input: {
    projectId: string;
    tenantId: string;
    agents: readonly RuntimeProjectAgentDraftMetadataBackfillRecord[];
    metadataByAgent: ReadonlyMap<string, ProjectAgentDraftMetadata>;
  }) => Promise<void>;
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

export async function evaluateRuntimeProjectAgentDrafts(input: {
  projectId: string;
  tenantId: string;
  agents: ProjectAgentDraftState[];
  diagnosticSource: string;
  configVariables?: Record<string, string>;
}): Promise<Map<string, ProjectAgentDraftMetadata>> {
  const { compilerOptions, contextDocuments, contextWarnings, recordDiagnostics } =
    await buildRuntimeCompilerContext(input);

  return evaluateProjectAgentDraftMetadata({
    agents: input.agents,
    diagnosticSource: input.diagnosticSource,
    compilerOptions,
    contextDocuments,
    contextWarnings,
    recordDiagnostics,
  });
}

async function buildRuntimeCompilerContext(input: {
  projectId: string;
  tenantId: string;
  agents: ProjectAgentDraftState[];
  configVariables?: Record<string, string>;
}): Promise<{
  compilerOptions: CompilerOptions;
  contextDocuments: AgentBasedDocument[];
  contextWarnings: string[];
  recordDiagnostics: Map<string, RuntimeProjectAgentDraftRecordDiagnostics>;
}> {
  const compilerOptions: CompilerOptions = { mode: 'preview' };
  if (input.configVariables && Object.keys(input.configVariables).length > 0) {
    compilerOptions.config_variables = input.configVariables;
  }

  const contextWarnings: string[] = [];
  const recordDiagnostics = new Map<string, RuntimeProjectAgentDraftRecordDiagnostics>();
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

  const profileDocuments = input.configVariables
    ? parseBehaviorProfileDocumentsFromConfigVariables(input.configVariables)
    : { documents: [], errors: [] };
  contextWarnings.push(...profileDocuments.errors);

  const contextDocuments = [...profileDocuments.documents];
  const allDocuments = [...parsedDocuments, ...contextDocuments];

  // Load imported module agent stubs so cross-agent validation recognizes
  // module handoff/delegate targets (e.g. benefits__coverage_agent).
  try {
    const moduleStubs = await loadAndBuildModuleAgentStubs(
      input.projectId,
      input.tenantId,
      allDocuments.map((d) => d.name),
    );
    allDocuments.push(...moduleStubs);
    contextDocuments.push(...moduleStubs);
  } catch (err) {
    log.warn('Failed to load module agent stubs for draft validation', {
      projectId: input.projectId,
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (allDocuments.length > 0) {
    const resolvedToolImplementations = await resolveProjectToolsFromDocuments(
      input.tenantId,
      input.projectId,
      allDocuments,
    );
    if (resolvedToolImplementations.size > 0) {
      compilerOptions.resolvedToolImplementations = resolvedToolImplementations;
    }
  }

  return {
    compilerOptions,
    contextDocuments,
    contextWarnings,
    recordDiagnostics,
  };
}

function normalizePromptLibraryRef(ref: unknown): InjectedPromptLibraryRef | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const promptId = 'promptId' in ref ? ref.promptId : undefined;
  const versionId = 'versionId' in ref ? ref.versionId : undefined;
  const resolvedHash = 'resolvedHash' in ref ? ref.resolvedHash : undefined;

  if (typeof promptId !== 'string' || typeof versionId !== 'string') {
    return null;
  }

  return {
    promptId,
    versionId,
    ...(typeof resolvedHash === 'string' ? { resolvedHash } : {}),
  };
}

function formatPromptLibraryResolutionError(recordName: string, error: unknown): string {
  return `Runtime draft validation could not resolve project agent "${recordName}" prompt library reference: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

async function loadRuntimeProjectConfigVariablesMap(
  projectId: string,
  tenantId: string,
): Promise<Record<string, string> | undefined> {
  const docs = (await ProjectConfigVariable.find({ projectId, tenantId }, { key: 1, value: 1 })
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

export async function refreshPersistedRuntimeProjectAgentDraftMetadata(input: {
  projectId: string;
  tenantId: string;
  diagnosticSource?: string;
}): Promise<Map<string, ProjectAgentDraftMetadata>> {
  const existingAgents = (await ProjectAgent.find({
    projectId: input.projectId,
    tenantId: input.tenantId,
  }).lean()) as IProjectAgent[];

  if (existingAgents.length === 0) {
    return new Map();
  }

  const metadataByAgent = await evaluateRuntimeProjectAgentDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: existingAgents
      .map((agent) => toProjectAgentDraftState(agent))
      .filter((agent): agent is ProjectAgentDraftState => agent !== null),
    diagnosticSource: input.diagnosticSource ?? 'runtime-draft-refresh',
    configVariables: await loadRuntimeProjectConfigVariablesMap(input.projectId, input.tenantId),
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
            $inc: { _v: 1 },
          },
        },
      };
    }),
  );

  return metadataByAgent;
}

export async function backfillMissingRuntimeProjectAgentDraftMetadata<
  T extends RuntimeProjectAgentDraftMetadataBackfillRecord,
>(input: {
  projectId: string;
  tenantId: string;
  agents: readonly T[];
  diagnosticSource?: string;
  deps?: RuntimeProjectAgentDraftMetadataBackfillDeps;
}): Promise<RuntimeProjectAgentDraftMetadataBackfillResult<T>> {
  const agentsNeedingBackfill = input.agents.filter(needsRuntimeDraftMetadataBackfill);
  if (agentsNeedingBackfill.length === 0) {
    return { agents: [...input.agents], backfilledAgentNames: [] };
  }

  const evaluateDrafts = input.deps?.evaluateDrafts ?? evaluateRuntimeProjectAgentDrafts;
  const loadConfigVariables =
    input.deps?.loadConfigVariables ?? loadRuntimeProjectConfigVariablesMap;
  const persistMetadata =
    input.deps?.persistMetadata ?? persistRuntimeProjectAgentDraftMetadataBackfill;

  const metadataByAgent = await evaluateDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: input.agents
      .map((agent) => toProjectAgentDraftState(agent))
      .filter((agent): agent is ProjectAgentDraftState => agent !== null),
    diagnosticSource: input.diagnosticSource ?? 'runtime-draft-lazy-backfill',
    configVariables: await loadConfigVariables(input.projectId, input.tenantId),
  });

  const backfilledNames = new Set(
    agentsNeedingBackfill
      .map((agent) => agent.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  await persistMetadata({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: agentsNeedingBackfill,
    metadataByAgent,
  });

  return {
    agents: input.agents.map((agent) => {
      if (!agent.name || !backfilledNames.has(agent.name)) {
        return agent;
      }

      const metadata = metadataByAgent.get(agent.name);
      if (!metadata) {
        return agent;
      }

      return {
        ...agent,
        sourceHash: metadata.sourceHash ?? null,
        dslValidationStatus: metadata.dslValidationStatus ?? null,
        dslDiagnostics: metadata.dslDiagnostics ?? [],
      };
    }),
    backfilledAgentNames: [...backfilledNames],
  };
}

function needsRuntimeDraftMetadataBackfill(
  agent: RuntimeProjectAgentDraftMetadataBackfillRecord,
): boolean {
  return (
    typeof agent.name === 'string' &&
    agent.name.length > 0 &&
    typeof agent.dslContent === 'string' &&
    agent.dslContent.trim().length > 0 &&
    agent.dslValidationStatus == null
  );
}

async function persistRuntimeProjectAgentDraftMetadataBackfill(input: {
  projectId: string;
  tenantId: string;
  agents: readonly RuntimeProjectAgentDraftMetadataBackfillRecord[];
  metadataByAgent: ReadonlyMap<string, ProjectAgentDraftMetadata>;
}): Promise<void> {
  const operations = input.agents
    .map((agent) => {
      if (typeof agent.name !== 'string' || agent.name.length === 0) {
        return null;
      }

      const metadata = input.metadataByAgent.get(agent.name);
      if (!metadata) {
        return null;
      }

      return {
        updateOne: {
          filter: {
            projectId: input.projectId,
            tenantId: input.tenantId,
            name: agent.name,
            $or: [{ dslValidationStatus: null }, { dslValidationStatus: { $exists: false } }],
          },
          update: {
            $set: {
              sourceHash: metadata.sourceHash ?? null,
              dslValidationStatus: metadata.dslValidationStatus ?? null,
              dslDiagnostics: metadata.dslDiagnostics ?? [],
            },
            $inc: { _v: 1 },
          },
        },
      };
    })
    .filter((operation): operation is NonNullable<typeof operation> => operation !== null);

  if (operations.length === 0) {
    return;
  }

  await ProjectAgent.bulkWrite(operations);
}
