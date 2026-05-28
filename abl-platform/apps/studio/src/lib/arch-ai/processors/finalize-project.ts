/**
 * finalizeProject — CREATE phase handler for v4.
 *
 * When the user sends a `type: 'create'` MessageRequest, this module runs the
 * full project-finalization flow:
 *   1. Read session metadata (specification, topology, agent files, toolDsls)
 *   2. Create project doc (with duplicate-name guard)
 *   3. Save each compiled agent to ProjectAgent
 *   4. Persist tools (toolDsls first, inline extraction gap-fills)
 *   5. Detect and set entry agent
 *   6. Link session metadata.projectId to new project
 *   7. Transition ACTIVE → COMPLETE → ARCHIVED
 *   8. Link journal entries + archive journal
 *   9. Extract project memories (non-blocking)
 *  10. Emit success events + done + close
 *
 * On failure: roll back partial project + agent writes, clear projectId from
 * session, emit error event, transition session back to IDLE.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchSSEEvent, ArchSession, SessionService } from '@agent-platform/arch-ai';
import type { JournalService, SpecDocumentService } from '@agent-platform/arch-ai';
import type { ProjectMemoryService } from '@agent-platform/arch-ai';
import { getSourceArchitectureContractFromMetadata } from '@agent-platform/arch-ai/blueprint';
import {
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import { renderMissingGuardrailsWarning } from '@agent-platform/arch-ai/guardrails';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import { logArchTimeline, type ArchRequestTiming } from '../request-timing';
import { journalAppendAndEmit } from '../helpers/stream-helpers';
import {
  renderManagedBehaviorProfileFilesForReferences,
  renderManagedBehaviorProfileFilesForTopology,
  renderSourceBehaviorProfileFiles,
} from '../managed-behavior-profiles';
import { extractBuildTopology } from '../build-requirement-inference';
import { validateGeneratedBuildSession } from '../build-orchestrator';

const log = createLogger('arch-ai:v4:finalize-project');
const ARCH_ONBOARDING_HTTP_ASYNC_CHANNEL_TYPE = 'http_async';

export interface FinalizeProjectContext {
  tenantId: string;
  userId: string;
}

export interface FinalizeProjectDeps {
  sessionService: SessionService;
  journalService: JournalService;
  specDocumentService: SpecDocumentService;
  projectMemoryService: ProjectMemoryService;
}

async function ensureArchOnboardingIngress(input: {
  tenantId: string;
  projectId: string;
  projectName: string;
  entryAgentName: string;
  declaredChannels: string[];
}): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const { ensureDb } = await import('@/lib/ensure-db');
  const { Project } = await import('@agent-platform/database/models');
  await ensureDb();
  const db = Project.db.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready');
  }

  const externalIdentifier = `${ARCH_ONBOARDING_HTTP_ASYNC_CHANNEL_TYPE}:${input.tenantId}:${input.projectId}`;
  const now = new Date();
  await db.collection('channel_connections').updateOne(
    {
      tenantId: input.tenantId,
      projectId: input.projectId,
      channelType: ARCH_ONBOARDING_HTTP_ASYNC_CHANNEL_TYPE,
      externalIdentifier,
    },
    {
      $setOnInsert: {
        _id: randomUUID(),
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentId: null,
        deploymentId: null,
        environment: null,
        channelType: ARCH_ONBOARDING_HTTP_ASYNC_CHANNEL_TYPE,
        externalIdentifier,
        connectionId: null,
        displayName: 'Arch Web Chat',
        encryptedCredentials: null,
        authProfileId: null,
        verifyTokenHash: null,
        config: {
          source: 'arch_ai_onboarding',
          purpose: 'default_runtime_ingress',
          projectName: input.projectName,
          entryAgentName: input.entryAgentName,
          declaredChannels: input.declaredChannels,
        },
        _v: 1,
        createdAt: now,
      },
      $set: {
        status: 'active',
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}

/**
 * Execute the full project-finalization flow.
 *
 * Mirrors the current CREATE handler at process-message.ts:527-986 but is
 * structured as a clean, standalone function that reads from the v4 session
 * model (same MongoDB collection as current — ArchSession is platform-level).
 */
export async function finalizeProject(
  ctx: FinalizeProjectContext,
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  close: () => void,
  deps: FinalizeProjectDeps,
  timing?: ArchRequestTiming,
): Promise<void> {
  const { sessionService, journalService, specDocumentService, projectMemoryService } = deps;

  const spec = session.metadata.specification;
  const meta = session.metadata as unknown as Record<string, unknown>;
  const agentFiles = (meta.files ?? {}) as Record<string, { path: string; content: string }>;
  const agentNames = Object.keys(agentFiles);
  const phase = session.metadata.phase;
  const sourceContract = getSourceArchitectureContractFromMetadata(meta);

  const logTimeline = (
    step: string,
    data?: Record<string, unknown>,
    level: 'info' | 'warn' | 'error' = 'info',
  ) => {
    const logFn =
      level === 'error'
        ? log.error.bind(log)
        : level === 'warn'
          ? log.warn.bind(log)
          : log.info.bind(log);
    logArchTimeline({
      timing,
      log: logFn,
      step,
      data: {
        sessionId: session.id,
        phase,
        ...(data ?? {}),
      },
    });
  };

  emit({ type: 'specialist', name: 'Onboarding Specialist', icon: 'clipboard' });

  // ─── Pre-creation Quality Scan (non-blocking) ─────────────────────
  {
    const qualityIssues: Array<{ agent: string; issue: string }> = [];
    const supervisorAgentName = agentNames.find((name) => {
      const content = agentFiles[name]?.content ?? '';
      return /^\s*SUPERVISOR\s*:/m.test(content);
    });

    for (const agentName of agentNames) {
      const dsl = agentFiles[agentName]?.content ?? '';
      const isSupervisor = /^\s*SUPERVISOR\s*:/m.test(dsl);

      if (!supervisorAgentName && agentName === agentNames[0] && !isSupervisor) {
        qualityIssues.push({
          agent: agentName,
          issue: 'Entry agent should use SUPERVISOR: keyword for routing',
        });
      }
      if (!/GUARDRAILS:/m.test(dsl)) {
        qualityIssues.push({ agent: agentName, issue: renderMissingGuardrailsWarning() });
      }
      if (!isSupervisor && /\bCALL\s*:/m.test(dsl) && !/^\s*TOOLS\s*:/m.test(dsl)) {
        qualityIssues.push({
          agent: agentName,
          issue: 'Agent uses CALL but has no TOOLS section',
        });
      }
      if (!/MEMORY:/m.test(dsl)) {
        qualityIssues.push({ agent: agentName, issue: renderMissingMemoryWarning() });
      }
      if (isSupervisor && !/WHEN:\s*(?:["']true["']|true)\b/m.test(dsl)) {
        qualityIssues.push({
          agent: agentName,
          issue: renderSupervisorCatchAllHandoffWarning(),
        });
      }
    }

    if (qualityIssues.length > 0) {
      log.warn('Quality scan: issues found (non-blocking)', {
        issues: qualityIssues,
        projectName: (spec.projectName as string) ?? 'Untitled',
      });
      emit({
        type: 'text_delta',
        delta:
          `⚠️ Quality scan found ${qualityIssues.length} suggestion(s):\n\n` +
          qualityIssues.map((qi) => `- **${qi.agent}**: ${qi.issue}`).join('\n') +
          '\n\nProceeding with project creation...\n\n',
      });
    }
  }

  // ─── Pre-export compiler/topology gate (blocking) ─────────────────
  {
    const topology = extractBuildTopology(session);
    if (topology.agents.length > 0) {
      const validation = await validateGeneratedBuildSession({
        topology: {
          agents: topology.agents.map((agent) => ({
            name: agent.name,
            role: agent.role ?? 'agent',
            ...(agent.executionMode ? { executionMode: agent.executionMode } : {}),
            ...(agent.description ? { description: agent.description } : {}),
          })),
          edges: topology.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            type: edge.type ?? 'delegate',
            ...(edge.condition ? { condition: edge.condition } : {}),
            ...(edge.experienceMode ? { experienceMode: edge.experienceMode } : {}),
          })),
        },
        agentFiles,
        behaviorProfileFiles: renderSourceBehaviorProfileFiles(sourceContract),
      });
      const blocking = validation.results.filter((entry) => entry.status === 'error');
      if (blocking.length > 0) {
        const diagnosticSummary = blocking
          .map((entry) => `- **${entry.agentName}**: ${entry.errors.join('; ')}`)
          .join('\n');
        log.error('Pre-export validation blocked Arch project creation', {
          sessionId: session.id,
          projectName: (spec.projectName as string) ?? 'Untitled',
          blocking,
        });
        emit({
          type: 'text_delta',
          delta:
            `❌ Arch pre-export validation blocked project creation.\n\n` +
            `${diagnosticSummary}\n\nFix the generated project view and retry creation.`,
        });
        throw new Error('Arch pre-export validation failed. Fix generated agent diagnostics.');
      }
    }
  }

  emit({ type: 'progress', step: 1, total: 3, label: 'Creating project...' });

  let project: { id: string; name?: string } | undefined;
  let projectName = (spec.projectName as string) ?? 'Untitled';
  logTimeline('create_project_started', {
    agentCount: agentNames.length,
    projectName,
  });

  try {
    const { createProject, projectExistsByName, addAgentToProject, updateProject } =
      await import('@/services/project-service');

    // Prevent duplicate display names within the tenant
    if (await projectExistsByName(projectName, ctx.tenantId)) {
      let suffix = 2;
      while (await projectExistsByName(`${projectName} (${suffix})`, ctx.tenantId)) {
        suffix++;
      }
      projectName = `${projectName} (${suffix})`;
    }

    const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
    const channels = normalizeChannels(spec.channels);
    const language = typeof spec.language === 'string' ? spec.language.trim() : undefined;

    // Handle race condition on project name uniqueness with retry
    try {
      project = await createProject({
        name: projectName,
        description: (spec.description as string) ?? '',
        tenantId: ctx.tenantId,
        ownerId: ctx.userId,
        channels: channels.length > 0 ? channels : undefined,
        language: language || undefined,
      });
    } catch (createErr: unknown) {
      const isDuplicate =
        createErr instanceof Error &&
        'code' in createErr &&
        (createErr as { code: number }).code === 11000;
      if (isDuplicate) {
        const suffixed = `${projectName} (${Date.now() % 10000})`;
        log.info('Project name collision, retrying with suffix', {
          original: projectName,
          suffixed,
        });
        project = await createProject({
          name: suffixed,
          description: (spec.description as string) ?? '',
          tenantId: ctx.tenantId,
          ownerId: ctx.userId,
          channels: channels.length > 0 ? channels : undefined,
          language: language || undefined,
        });
      } else {
        throw createErr;
      }
    }

    if (!project) {
      throw new Error('Project creation failed unexpectedly');
    }

    logTimeline('create_project_record_created', {
      projectId: String(project.id),
      projectName: project.name ?? projectName,
    });

    // Link arch session to created project (metadata.projectId)
    await ArchSessionModel.updateOne(
      { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: { 'metadata.projectId': String(project.id) } },
    );

    emit({ type: 'progress', step: 2, total: 3, label: 'Saving project files...' });

    const managedProfileDomain = {
      channels,
      universalRules: sourceContract?.universalRules ?? [],
      channelRules: sourceContract?.channelRules?.map((rule) => ({
        channel: rule.channel,
        ...(rule.responseMaxWords !== undefined ? { responseMaxWords: rule.responseMaxWords } : {}),
        ...(rule.abbreviationPolicy ? { abbreviationPolicy: rule.abbreviationPolicy } : {}),
        ...(rule.toolLatencyBridge !== undefined
          ? { toolLatencyBridge: rule.toolLatencyBridge }
          : {}),
        rules: [...rule.rules],
      })),
    };
    const managedBehaviorProfiles = {
      ...renderManagedBehaviorProfileFilesForTopology(
        (meta.topology ?? null) as Parameters<
          typeof renderManagedBehaviorProfileFilesForTopology
        >[0],
        managedProfileDomain,
      ),
      ...renderManagedBehaviorProfileFilesForReferences(agentFiles, managedProfileDomain),
      ...renderSourceBehaviorProfileFiles(sourceContract),
    };
    if (Object.keys(managedBehaviorProfiles).length > 0) {
      const { ProjectConfigVariable } = await import('@agent-platform/database/models');
      const { behaviorProfileNameToConfigKey } = await import('@agent-platform/project-io');
      for (const [profileName, file] of Object.entries(managedBehaviorProfiles)) {
        await ProjectConfigVariable.findOneAndUpdate(
          {
            tenantId: ctx.tenantId,
            projectId: project.id,
            key: behaviorProfileNameToConfigKey(profileName),
          },
          {
            $set: {
              value: file.content,
              updatedBy: ctx.userId,
            },
            $setOnInsert: {
              tenantId: ctx.tenantId,
              projectId: project.id,
              key: behaviorProfileNameToConfigKey(profileName),
              description: null,
              createdBy: ctx.userId,
            },
          },
          { upsert: true },
        );
      }
      log.info('Persisted managed behavior profiles for onboarding project', {
        projectId: project.id,
        profileCount: Object.keys(managedBehaviorProfiles).length,
      });
    }

    // Step 2: Save behavior profiles before agent definitions. Agent saves can
    // trigger project-aware compilation, and referenced profiles must already
    // be available as project config variables for that compilation context.
    for (const agentName of agentNames) {
      const file = agentFiles[agentName];
      if (!file) {
        log.warn('Expected agent file missing during project creation', {
          agentName,
          projectId: project.id,
        });
        continue;
      }
      const goalMatch =
        file.content.match(/^GOAL:\s*"([^"]+)"/m) ||
        file.content.match(/^GOAL:\s*'([^']+)'/m) ||
        file.content.match(/^GOAL:\s*\|\s*\n\s+(.+)/m);
      const description = goalMatch?.[1]?.trim() ?? null;

      await addAgentToProject({
        projectId: project.id,
        tenantId: ctx.tenantId,
        name: agentName,
        dslContent: file.content,
        description: description ?? undefined,
        ownerId: ctx.userId,
      });
    }

    const { detectEntryAgent } = await import('@/lib/arch-ai/project-entry-agent');
    const entryAgent = detectEntryAgent(
      agentNames.map((name) => ({
        name,
        ablContent: agentFiles[name]?.content,
      })),
    );
    await updateProject(project.id, { entryAgentName: entryAgent }, ctx.tenantId);
    try {
      await ensureArchOnboardingIngress({
        tenantId: ctx.tenantId,
        projectId: String(project.id),
        projectName: project.name ?? projectName,
        entryAgentName: entryAgent,
        declaredChannels: channels,
      });
    } catch (channelErr: unknown) {
      log.warn('Failed to provision default onboarding channel connection', {
        projectId: project.id,
        entryAgent,
        error: channelErr instanceof Error ? channelErr.message : String(channelErr),
      });
    }
    logTimeline('create_agents_saved', {
      projectId: String(project.id),
      agentCount: agentNames.length,
      entryAgent,
    });

    // ─── Persist tools: synthesize bootstrap-ready HTTP tools once ────────────
    try {
      const { synthesizeOnboardingBootstrapTools } =
        await import('@/lib/arch-ai/tool-bootstrap-synthesizer');
      const { upsertBootstrapHttpTool } = await import('@/lib/tool-creation-service');

      const freshForTools = await sessionService.getById(ctx, session.id);
      const freshMetadata = freshForTools?.metadata as unknown as Record<string, unknown>;
      const toolDsls = freshMetadata?.toolDsls as Record<string, string> | undefined;
      const sourceContract = getSourceArchitectureContractFromMetadata(freshMetadata);
      const synthesis = synthesizeOnboardingBootstrapTools({
        toolDsls,
        agentFiles,
        sourceContract,
      });
      let createdCount = 0;
      let updatedCount = 0;

      for (const bootstrapTool of synthesis.tools) {
        try {
          const persisted = await upsertBootstrapHttpTool({
            tenantId: ctx.tenantId,
            projectId: project.id,
            contract: bootstrapTool.contract,
            staticResponse: bootstrapTool.staticResponse,
            sampleInput: bootstrapTool.sampleInput,
            actorId: ctx.userId,
          });

          if (persisted.created) {
            createdCount++;
          } else {
            updatedCount++;
          }
        } catch (toolErr: unknown) {
          log.warn('Failed to bootstrap onboarding tool', {
            projectId: project.id,
            tool: bootstrapTool.contract.name,
            error: toolErr instanceof Error ? toolErr.message : String(toolErr),
          });
        }
      }

      if (createdCount > 0 || updatedCount > 0) {
        log.info('Bootstrapped onboarding project tools', {
          projectId: project.id,
          total: synthesis.tools.length,
          created: createdCount,
          updated: updatedCount,
        });
      }

      if (synthesis.extractionErrors.length > 0) {
        log.warn('Tool contract extraction completed with errors', {
          projectId: project.id,
          errorCount: synthesis.extractionErrors.length,
          errors: synthesis.extractionErrors,
        });
      }

      if (synthesis.unsupported.length > 0) {
        const unsupportedSummary = synthesis.unsupported
          .map((gap) => `- ${gap.name} (${gap.requestedType})`)
          .join('\n');

        log.info('Onboarding tool bootstrap found unsupported gaps', {
          projectId: project.id,
          unsupported: synthesis.unsupported,
        });

        emit({
          type: 'text_delta',
          delta:
            '⚠️ Some tool contracts were not bootstrapped because onboarding currently supports only HTTP project tools:\n\n' +
            `${unsupportedSummary}\n\n` +
            'You can revisit these later in the project with Arch.\n\n',
        });
      }
    } catch (extractErr: unknown) {
      log.warn('Tool bootstrap failed — project created without tool records', {
        projectId: project.id,
        error: extractErr instanceof Error ? extractErr.message : String(extractErr),
      });
    }

    emit({ type: 'progress', step: 3, total: 3, label: 'Finalizing...' });

    // Step 3: Journal + session state transitions
    const finalProjectName = project.name ?? projectName;
    await journalAppendAndEmit(
      journalService,
      ctx,
      {
        sessionId: session.id,
        type: 'decision',
        content: {
          type: 'decision',
          summary: `Project created: ${finalProjectName} with ${agentNames.length} agents`,
          rationale: 'User clicked Create Project',
          specialist: 'coordinator',
          source: 'user_input' as const,
        },
        specialist: 'onboarding',
        phase,
      },
      emit,
    );

    // ACTIVE → COMPLETE → ARCHIVED
    await sessionService.transitionState(ctx, session.id, 'ACTIVE', 'COMPLETE');
    await sessionService.transitionState(ctx, session.id, 'COMPLETE', 'ARCHIVED');

    await journalService.linkToProject(ctx, session.id, String(project.id), {
      unsafeProjectScope: true,
    });

    try {
      await specDocumentService.linkToProject(ctx, session.id, String(project.id));
    } catch (err: unknown) {
      log.warn('Failed to link spec document to project', {
        sessionId: session.id,
        projectId: String(project.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const journalEntries = await journalService.query(ctx, {
        sessionId: session.id,
      });
      const freshSessionForMemory = await sessionService.getById(ctx, session.id);
      if (freshSessionForMemory) {
        await projectMemoryService.extractMemoriesFromSession(
          ctx,
          String(project.id),
          freshSessionForMemory,
          journalEntries,
        );
      }
    } catch (memErr: unknown) {
      log.warn('Failed to extract project memories from onboarding session', {
        sessionId: session.id,
        projectId: String(project.id),
        error: memErr instanceof Error ? memErr.message : String(memErr),
      });
    }

    await journalService.archiveSession(ctx, session.id);
    logTimeline('create_project_finalized', {
      projectId: String(project.id),
      archivedSession: true,
    });

    emit({
      type: 'text_delta',
      delta:
        `✅ **Project "${finalProjectName}" created successfully!**\n\n` +
        `- ${agentNames.length} agents saved\n` +
        `- Project ID: ${project.id}\n\n` +
        `Redirecting to your new project...`,
    });

    emit({
      type: 'tool_result',
      toolCallId: 'create_project',
      result: {
        success: true,
        projectId: project.id,
        projectName: finalProjectName,
        results: agentNames.map((agentName) => ({ agentName, status: 'saved' as const })),
        stats: { total: agentNames.length, saved: agentNames.length, failed: 0 },
      },
    });
    logTimeline('create_project_success_emitted', {
      projectId: String(project.id),
      savedAgents: agentNames.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Project creation failed', { error: message, sessionId: session.id });
    logTimeline(
      'create_project_failed',
      {
        error: message,
        projectId: project?.id ?? null,
      },
      'error',
    );

    // Roll back partial project creation
    if (project?.id) {
      try {
        const { Project, ProjectAgent, ProjectConfigVariable } =
          await import('@agent-platform/database/models');
        await Project.deleteOne({ _id: project.id, tenantId: ctx.tenantId });
        await ProjectAgent.deleteMany({ projectId: project.id, tenantId: ctx.tenantId });
        await ProjectConfigVariable.deleteMany({
          projectId: project.id,
          tenantId: ctx.tenantId,
          key: /^profile:/,
        });
        log.info('Rolled back partial project', { projectId: project.id });
      } catch (cleanupErr: unknown) {
        log.warn('Failed to cleanup partial project', {
          projectId: project.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    // Clear rolled-back projectId from session
    try {
      await ArchSessionModel.updateOne(
        { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
        { $unset: { 'metadata.projectId': '' } },
      );
    } catch (sessionCleanupErr: unknown) {
      log.warn('Failed to clear rolled-back project from session metadata', {
        sessionId: session.id,
        error:
          sessionCleanupErr instanceof Error
            ? sessionCleanupErr.message
            : String(sessionCleanupErr),
      });
    }

    emit({
      type: 'tool_result',
      toolCallId: 'create_project',
      result: {
        success: false,
        projectId: null,
        projectName,
        results: [],
        stats: { total: agentNames.length, saved: 0, failed: agentNames.length },
      },
    });

    emit({
      type: 'error',
      code: 'CREATE_FAILED',
      message: 'Project creation failed. Please try again.',
      retryable: true,
    });

    // Transition back to IDLE so user can retry
    try {
      await sessionService.transitionState(ctx, session.id, 'ACTIVE', 'IDLE');
    } catch (transitionErr: unknown) {
      log.warn('Failed to transition session to IDLE after create failure', {
        sessionId: session.id,
        error: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
      });
    }
  }

  emit({ type: 'done' });
  close();
}
