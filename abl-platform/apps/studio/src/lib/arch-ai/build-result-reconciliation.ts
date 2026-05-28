import { createLogger } from '@abl/compiler/platform/logger.js';
import { extractAllTools } from '@agent-platform/arch-ai/mock-server';
import type { BuildAgentStatus, PendingWidgetPayload } from '@agent-platform/arch-ai/types';
import {
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import { renderMissingGuardrailsWarning } from '@agent-platform/arch-ai/guardrails';
import type { AgentGenResult as BuildAgentGenResult } from './build-completion';
import { classifyWarnings } from './build-completion';
import { validateGeneratedBuildSession } from './build-orchestrator';
import { collectGeneratedAgentReadinessErrors } from './build-readiness-gates';
import { CompileWorkerTimeoutError } from './helpers/isolated-build-compiler';

const log = createLogger('arch-ai:build-result-reconciliation');

export interface BuildTopologyAgentDescriptor {
  name: string;
  role?: string;
  executionMode?: string;
}

export interface BuildTopologyEdgeDescriptor {
  from: string;
  to: string;
  type?: string;
  experienceMode?: string;
}

export interface ReconcileBuildResultsInput {
  topologyAgents: BuildTopologyAgentDescriptor[];
  topologyEdges?: BuildTopologyEdgeDescriptor[];
  rawResults: Array<{
    agentName: string;
    status: 'compiled' | 'warning' | 'error';
    warnings: string[];
    errors: string[];
  }>;
  persistedStatuses?: Record<string, BuildAgentStatus>;
  agentFiles: Record<string, { content?: string }>;
  behaviorProfileFiles?: Record<string, { content?: string }>;
}

export interface ReconcileBuildResultsOutput {
  results: BuildAgentGenResult[];
  agentStatuses: Record<string, BuildAgentStatus>;
  recoveredCount: number;
}

const DEFAULT_QUALITY: BuildAgentGenResult['quality'] = {
  guardrails: false,
  memory: false,
  errorHandlers: false,
  constraints: false,
  catchAllHandoff: false,
};

const GENERIC_MISSING_FILE_ERROR = 'No agent file was generated for this topology node.';
const INCOMPLETE_COMPILE_WARNING = 'Compilation step may not have completed';

export interface DerivedBuildResultMetadata {
  toolCount: number;
  handoffCount: number;
  quality: BuildAgentGenResult['quality'];
}

function dedupeMessages(messages: string[]): string[] {
  return [
    ...new Set(messages.map((message) => message.trim()).filter((message) => message.length)),
  ];
}

function deriveServerQualityWarnings(
  content: string | undefined,
  metadata: DerivedBuildResultMetadata | undefined,
): string[] {
  if (!content) {
    return [];
  }

  const warnings: string[] = [];
  const isSupervisor = /^\s*SUPERVISOR\s*:/m.test(content);

  if (!metadata?.quality.guardrails) {
    warnings.push(renderMissingGuardrailsWarning());
  }

  if (!metadata?.quality.memory) {
    warnings.push(renderMissingMemoryWarning());
  }

  if (isSupervisor && !metadata?.quality.catchAllHandoff) {
    warnings.push(renderSupervisorCatchAllHandoffWarning());
  }

  return warnings;
}

function deriveBuildBlockingErrors(content: string | undefined): string[] {
  if (!content) return [];

  const errors: string[] = [];
  if (/WHEN:\s*(?:""|''|\s*$)/m.test(content)) {
    errors.push('Generated agent contains an empty HANDOFF WHEN condition.');
  }
  if (/\bgathered_detail\b/.test(content)) {
    errors.push(
      'Generated agent still contains the generic auto-fix gather field "gathered_detail".',
    );
  }
  if (/\{\{question_to_collect_this_field\}\}/.test(content)) {
    errors.push('Generated agent still contains a placeholder gather prompt.');
  }
  if (
    /^\s*-\s*(?:greet|greeting)\s*$/im.test(content) &&
    /^\s*-\s*(?:process|collect_info)\s*$/im.test(content)
  ) {
    errors.push('Generated agent contains a generic placeholder FLOW outline.');
  }
  errors.push(
    ...collectGeneratedAgentReadinessErrors({
      content,
    }),
  );

  return errors;
}

export function deriveBuildResultMetadata(
  topologyAgents: BuildTopologyAgentDescriptor[],
  topologyEdges: BuildTopologyEdgeDescriptor[] | undefined,
  agentFiles: Record<string, { content?: string }>,
): Record<string, DerivedBuildResultMetadata> {
  const byAgent = Object.fromEntries(
    topologyAgents.map((agent) => [
      agent.name,
      {
        toolCount: 0,
        handoffCount: 0,
        quality: DEFAULT_QUALITY,
      },
    ]),
  ) as Record<string, DerivedBuildResultMetadata>;

  const extractableFiles = Object.fromEntries(
    Object.entries(agentFiles)
      .filter(([, file]) => typeof file.content === 'string' && file.content.trim().length > 0)
      .map(([agentName, file]) => [
        agentName,
        {
          path: `agents/${agentName}.abl.yaml`,
          content: file.content as string,
        },
      ]),
  );

  const tools = extractAllTools(extractableFiles);
  for (const tool of tools) {
    const metadata = byAgent[tool.agentName];
    if (metadata) {
      metadata.toolCount += 1;
    }
  }

  for (const edge of topologyEdges ?? []) {
    const metadata = byAgent[edge.from];
    if (metadata) {
      metadata.handoffCount += 1;
    }
  }

  for (const [agentName, file] of Object.entries(agentFiles)) {
    if (!file.content || !byAgent[agentName]) {
      continue;
    }

    const isSupervisor = /^\s*SUPERVISOR\s*:/m.test(file.content);
    byAgent[agentName] = {
      ...byAgent[agentName],
      quality: {
        guardrails: /GUARDRAILS:/m.test(file.content),
        memory: /MEMORY:/m.test(file.content),
        errorHandlers: /(ON_ERROR:|ON_FAIL:|ON_FAILURE:)/m.test(file.content),
        constraints: /CONSTRAINTS:/m.test(file.content),
        catchAllHandoff: isSupervisor ? /WHEN:\s*(?:true|["']true["'])/m.test(file.content) : false,
      },
    };
  }

  return byAgent;
}

function buildResultForAgent(
  agent: BuildTopologyAgentDescriptor,
  status: 'compiled' | 'warning' | 'error',
  warnings: string[],
  errors: string[],
  metadata: DerivedBuildResultMetadata,
): BuildAgentGenResult {
  return {
    agentName: agent.name,
    status,
    warnings,
    errors,
    mode: agent.executionMode ?? 'reasoning',
    agentType: agent.role ?? 'agent',
    toolCount: metadata.toolCount,
    handoffCount: metadata.handoffCount,
    quality: metadata.quality,
  };
}

function terminalStatusFromPersisted(
  status: BuildAgentStatus | undefined,
): 'compiled' | 'warning' | 'error' | null {
  if (status === 'compiled' || status === 'validated') return 'compiled';
  if (status === 'warning') return 'warning';
  if (status === 'error') return 'error';
  return null;
}

export async function reconcileBuildResults(
  input: ReconcileBuildResultsInput,
): Promise<ReconcileBuildResultsOutput> {
  const metadataByAgent = deriveBuildResultMetadata(
    input.topologyAgents,
    input.topologyEdges,
    input.agentFiles,
  );
  const rawByName = new Map(input.rawResults.map((result) => [result.agentName, result]));
  const serverQualityWarningsByAgent = Object.fromEntries(
    input.topologyAgents.map((agent) => [
      agent.name,
      deriveServerQualityWarnings(
        input.agentFiles[agent.name]?.content,
        metadataByAgent[agent.name],
      ),
    ]),
  ) as Record<string, string[]>;
  const blockingErrorsByAgent = Object.fromEntries(
    input.topologyAgents.map((agent) => [
      agent.name,
      deriveBuildBlockingErrors(input.agentFiles[agent.name]?.content),
    ]),
  ) as Record<string, string[]>;

  const preliminary = input.topologyAgents.map((agent) => {
    const metadata = metadataByAgent[agent.name] ?? {
      toolCount: 0,
      handoffCount: 0,
      quality: DEFAULT_QUALITY,
    };
    const raw = rawByName.get(agent.name);
    if (raw) {
      return buildResultForAgent(agent, raw.status, raw.warnings, raw.errors, metadata);
    }

    const persistedTerminal = terminalStatusFromPersisted(input.persistedStatuses?.[agent.name]);
    if (persistedTerminal === 'compiled' || persistedTerminal === 'warning') {
      return buildResultForAgent(agent, persistedTerminal, [], [], metadata);
    }

    if (input.agentFiles[agent.name]?.content) {
      return buildResultForAgent(
        agent,
        'error',
        [],
        ['Compilation result was not emitted for the generated agent file.'],
        metadata,
      );
    }

    return buildResultForAgent(agent, 'error', [], [GENERIC_MISSING_FILE_ERROR], metadata);
  });

  let validatedByName = new Map<
    string,
    {
      agentName: string;
      status: 'compiled' | 'warning' | 'error';
      warnings: string[];
      errors: string[];
    }
  >();
  try {
    const validatedSession = await validateGeneratedBuildSession({
      topology: {
        agents: input.topologyAgents.map((agent) => ({
          name: agent.name,
          role: agent.role ?? 'agent',
          executionMode: agent.executionMode,
        })),
        edges: (input.topologyEdges ?? []).map((edge) => ({
          from: edge.from,
          to: edge.to,
          type: edge.type ?? 'delegate',
          ...(edge.experienceMode ? { experienceMode: edge.experienceMode } : {}),
        })),
      },
      agentFiles: input.agentFiles,
      behaviorProfileFiles: input.behaviorProfileFiles,
    });

    validatedByName = new Map(validatedSession.results.map((result) => [result.agentName, result]));
  } catch (err: unknown) {
    log.warn('Full BUILD session validation skipped after isolated compile failure', {
      agentCount: input.topologyAgents.length,
      error:
        err instanceof CompileWorkerTimeoutError
          ? `timed out during ${err.phase} after ${err.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
    });
  }

  const results: BuildAgentGenResult[] = preliminary.map((result) => {
    const validated = validatedByName.get(result.agentName);
    const blockingErrors = blockingErrorsByAgent[result.agentName] ?? [];
    if (!validated) {
      if (blockingErrors.length > 0) {
        return {
          ...result,
          status: 'error',
          errors: blockingErrors,
        };
      }
      return result;
    }

    const mergedWarnings = dedupeMessages([
      ...result.warnings.filter((warning) => warning !== INCOMPLETE_COMPILE_WARNING),
      ...(serverQualityWarningsByAgent[result.agentName] ?? []),
      ...validated.warnings,
    ]);

    if (validated.status === 'compiled' || validated.status === 'warning') {
      if (blockingErrors.length > 0) {
        return {
          ...result,
          status: 'error',
          warnings: mergedWarnings,
          errors: blockingErrors,
        };
      }

      // Re-classify: if the only warnings are info-level (W801, W823, etc.),
      // upgrade status to 'compiled' — these don't affect runtime execution.
      const { actionable } = classifyWarnings(mergedWarnings);
      const effectiveStatus = actionable.length > 0 ? 'warning' : 'compiled';
      return {
        ...result,
        status: effectiveStatus,
        warnings: mergedWarnings,
        errors: [],
      };
    }

    const preferPreliminaryErrors =
      result.status === 'error' &&
      result.errors.length > 0 &&
      validated.errors.length === 1 &&
      validated.errors[0] === GENERIC_MISSING_FILE_ERROR;

    return {
      ...result,
      status: 'error',
      warnings: mergedWarnings,
      errors: dedupeMessages([
        ...blockingErrors,
        ...(preferPreliminaryErrors
          ? result.errors
          : validated.errors.length > 0
            ? validated.errors
            : result.errors),
      ]),
    };
  });

  const agentStatuses = Object.fromEntries(
    results.map((result) => [
      result.agentName,
      result.status === 'compiled' ? 'compiled' : result.status === 'warning' ? 'warning' : 'error',
    ]),
  ) as Record<string, BuildAgentStatus>;

  return {
    results,
    agentStatuses,
    recoveredCount: preliminary
      .filter((result) => result.status === 'error')
      .filter((result) => {
        const final = results.find((entry) => entry.agentName === result.agentName);
        return final?.status === 'compiled' || final?.status === 'warning';
      }).length,
  };
}

export function extractBuildResultsFromPendingWidgetPayload(
  payload: PendingWidgetPayload | null | undefined,
): BuildAgentGenResult[] {
  const agents = payload?.agents;
  if (!Array.isArray(agents)) {
    return [];
  }

  return agents
    .filter(
      (agent): agent is Record<string, unknown> => typeof agent === 'object' && agent !== null,
    )
    .map((agent) => ({
      agentName: typeof agent.name === 'string' ? agent.name : 'UnknownAgent',
      status:
        agent.status === 'compiled' || agent.status === 'warning' || agent.status === 'error'
          ? agent.status
          : 'error',
      warnings: Array.isArray(agent.warnings)
        ? agent.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [],
      errors: typeof agent.error === 'string' && agent.error.length > 0 ? [agent.error] : [],
      mode: typeof agent.mode === 'string' ? agent.mode : 'reasoning',
      agentType: typeof agent.agentType === 'string' ? agent.agentType : 'agent',
      toolCount: typeof agent.toolCount === 'number' ? agent.toolCount : 0,
      handoffCount: typeof agent.handoffCount === 'number' ? agent.handoffCount : 0,
      quality:
        typeof agent.quality === 'object' && agent.quality !== null
          ? ({
              guardrails: Boolean((agent.quality as Record<string, unknown>).guardrails),
              memory: Boolean((agent.quality as Record<string, unknown>).memory),
              errorHandlers: Boolean((agent.quality as Record<string, unknown>).errorHandlers),
              constraints: Boolean((agent.quality as Record<string, unknown>).constraints),
              catchAllHandoff: Boolean((agent.quality as Record<string, unknown>).catchAllHandoff),
            } satisfies BuildAgentGenResult['quality'])
          : DEFAULT_QUALITY,
    }));
}
