/**
 * Internal Chat Agent Route
 *
 * POST /api/internal/chat/agent
 *
 * Called by the workflow-engine and pipeline-engine to invoke agents via
 * service-to-service auth. Reuses the same RuntimeExecutor, project resolution,
 * and session creation logic that the public /api/v1/chat/agent endpoint uses.
 *
 * Protected by service-to-service JWT auth — tenantId and projectId are
 * extracted from the verified token, never from raw request headers.
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { getRuntimeExecutor, type RuntimeSession } from '../services/runtime-executor.js';
import {
  findProjectRuntimeConfig,
  findProjectWithAgents,
  resolveProjectEntryAgentName,
} from '../repos/project-repo.js';
import {
  buildProjectWorkingCopyAgentSources,
  compileProjectWorkingCopy,
} from '../services/project-working-copy-compiler.js';
import { type InternalServiceRequest } from '../middleware/internal-service-auth.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import {
  buildSessionLocalizationCatalog,
  storeRuntimeSessionLocalizationCatalog,
} from '../services/execution/localized-messages.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
} from '../services/channel/response-provenance.js';
import { buildExecutionOutcome, toPublicChannelOutcome } from '../services/channel/outcome.js';
import { buildExecutionResultContentEnvelope } from '../services/execution/types.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../services/session/project-agent-dsl-readiness.js';
import { renderRuntimeTraceEventsForReadSurface } from '../services/pii/runtime-read-surface-renderer.js';

const log = createLogger('internal-chat');

const router: Router = Router();

const internalTestContextSchema = z
  .object({
    sessionVariables: z.record(z.unknown()).optional(),
    skipOnStart: z.boolean().optional(),
  })
  .strict();

const internalChatSchema = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  message: z.string().min(1),
  projectId: z.string().min(1),
  testContext: internalTestContextSchema.optional(),
  callerContext: z
    .object({
      source: z.string(),
      workflowExecutionId: z.string(),
    })
    .optional(),
  /** Session purpose tag — set by pipeline-engine ('eval') or cost-estimator ('synthetic'). */
  knownSource: z.enum(['production', 'eval', 'synthetic']).optional(),
});

type InternalTestContext = z.infer<typeof internalTestContextSchema>;

function applyInternalTestContext(
  session: RuntimeSession,
  context: InternalTestContext | undefined,
): void {
  if (!context) {
    return;
  }

  for (const [key, value] of Object.entries(context.sessionVariables ?? {})) {
    session.data.values[key] = value;
  }

  if (context.skipOnStart) {
    session.initialized = true;
  }
}

router.post('/agent', async (req: Request, res: Response) => {
  const serviceToken = (req as InternalServiceRequest).serviceToken;
  const { tenantId } = serviceToken;
  const result = internalChatSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: result.error.issues },
    });
    return;
  }

  const {
    agentId,
    sessionId: existingSessionId,
    message,
    projectId: bodyProjectId,
    testContext,
    callerContext,
    knownSource,
  } = result.data;

  // Use token's projectId as authoritative source; fall back to body if token doesn't include one
  let projectId: string;
  if (serviceToken.projectId) {
    if (bodyProjectId && serviceToken.projectId !== bodyProjectId) {
      res.status(403).json({
        success: false,
        error: {
          code: 'PROJECT_SCOPE_MISMATCH',
          message: 'Service token projectId does not match requested projectId',
        },
      });
      return;
    }
    projectId = serviceToken.projectId;
  } else {
    log.warn('Service token missing projectId, falling back to request body', {
      tenantId,
      bodyProjectId,
    });
    projectId = bodyProjectId;
  }

  try {
    const executor = getRuntimeExecutor();

    if (!executor.isConfigured()) {
      res.status(503).json({
        success: false,
        error: {
          code: 'RUNTIME_NOT_CONFIGURED',
          message:
            'Runtime not configured. Ensure model resolution is set up with tenant credentials.',
        },
      });
      return;
    }

    let sessionId = existingSessionId;

    // Resume existing session if provided
    if (sessionId) {
      let session = executor.getSession(sessionId);
      if (!session) {
        const sessionLocator = buildProductionSessionLocator({
          tenantId,
          projectId,
          sessionId,
        });
        session =
          (await executor.rehydrateSession(
            sessionId,
            sessionLocator ? { locator: sessionLocator } : undefined,
          )) ?? undefined;
      }
      if (session && (session.tenantId !== tenantId || session.projectId !== projectId)) {
        log.warn('Internal chat session scope mismatch', {
          sessionId,
          tokenTenantId: tenantId,
          tokenProjectId: projectId,
          sessionTenantId: session.tenantId,
          sessionProjectId: session.projectId,
        });
        res.status(404).json({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        });
        return;
      }
      if (!session) {
        res.status(404).json({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        });
        return;
      }
    }

    // Create new session if needed
    if (!sessionId) {
      const project = await findProjectWithAgents(projectId, tenantId);

      if (!project || project.agents.length === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found or has no agents' },
        });
        return;
      }

      const readiness = await evaluateProjectExecutionReadiness({
        agents: project.agents,
        tenantId,
        projectId,
        runtimeConfig: await findProjectRuntimeConfig(projectId, tenantId),
        lazyBackfill: true,
      });
      if (readiness.hasBlockingErrors) {
        log.warn('Refusing internal working-copy chat for project with readiness errors', {
          tenantId,
          projectId,
          issueKinds: readiness.issues.map((issue) => issue.kind),
          blockedAgents: readiness.blockedAgents,
        });
        res.status(422).json({
          success: false,
          error: {
            code: 'PROJECT_DSL_NOT_READY',
            message: buildProjectDslReadinessError(),
          },
          issues: readiness.issues,
        });
        return;
      }

      const workingCopyAgents = buildProjectWorkingCopyAgentSources(
        (readiness.executableAgents ?? []) as Array<{
          name?: unknown;
          dslContent?: unknown;
          systemPromptLibraryRef?: unknown;
        }>,
      );

      if (workingCopyAgents.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_DSL_CONTENT', message: 'No agent DSL content found' },
        });
        return;
      }

      // Determine entry agent within the projectId-scoped `project.agents` set:
      // accept agentId as `_id`, `id`, or `name`. Name-based match keeps the contract
      // consistent with the WS handler and pipeline-engine eval scenarios, which
      // identify the entry agent by name.
      let entryAgent: string;
      if (agentId) {
        const matched = project.agents.find(
          (a: any) => String(a._id) === agentId || a.id === agentId || a.name === agentId,
        );
        if (!matched) {
          res.status(404).json({
            success: false,
            error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found.' },
          });
          return;
        }
        entryAgent = (matched as any).name;
      } else {
        entryAgent = resolveProjectEntryAgentName(project as any);
      }

      const compileResult = await compileProjectWorkingCopy({
        tenantId,
        projectId,
        entryAgentName: entryAgent,
        agents: workingCopyAgents,
      });
      const configVariables =
        Object.keys(compileResult.configVariables).length > 0
          ? compileResult.configVariables
          : undefined;

      const serviceName = serviceToken.serviceName ?? 'internal-service';
      const session = executor.createSessionFromResolved(compileResult.resolved, {
        sessionId: crypto.randomUUID(),
        channelType: 'api',
        projectId,
        tenantId,
        userId: `service:${serviceName}`,
        ...(knownSource ? { knownSource } : {}),
        // Thread callerContext into the isolated _metadata namespace so
        // workflowExecutionId is available for tracing without leaking into
        // session.data.values.session (which DSL CALL expressions can read).
        ...(callerContext ? { metadata: { internalCallerContext: callerContext } } : {}),
      });
      storeRuntimeSessionLocalizationCatalog(
        session,
        buildSessionLocalizationCatalog(configVariables),
      );
      applyInternalTestContext(session, testContext);
      sessionId = session.id;
    }

    // Execute message — collect trace events for rich response
    const chunks: string[] = [];
    const onChunk = (chunk: string) => {
      chunks.push(chunk);
    };
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const responseProvenance = createResponseProvenanceAccumulator();
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
      accumulateResponseProvenance(responseProvenance, event);
    };

    const execResult = await executor.executeMessage(sessionId!, message, onChunk, onTraceEvent, {
      channelMetadata: {
        channel: 'internal',
        contentLength: message.length,
        hasAttachments: false,
        attachmentCount: 0,
      },
    });

    const session = executor.getSession(sessionId!);
    const outcome = buildExecutionOutcome({
      channelType: 'api',
      result: execResult,
      streamedText: chunks.length > 0 ? chunks.join('') : undefined,
      session: session ?? undefined,
    });
    const response = outcome.responseText;
    const responseMetadata =
      outcome.responseMetadata ??
      execResult.responseMetadata ??
      buildResponseMessageMetadata(responseProvenance);
    const contentEnvelope = buildExecutionResultContentEnvelope({
      response,
      richContent: outcome.richContent,
      actions: outcome.actions,
      voiceConfig: outcome.voiceConfig,
      localization: outcome.localization,
    });

    const actionType = execResult.action?.type;
    // agent_exit is emitted for every runtime turn, including continued handoff
    // questions, so only terminal runtime actions should end the session here.
    const sessionEnded = actionType === 'complete' || actionType === 'escalate';

    res.json({
      success: true,
      data: {
        sessionId,
        agentResponse: response,
        response,
        action: actionType,
        traceEvents:
          traceEvents.length > 0
            ? await renderRuntimeTraceEventsForReadSurface(traceEvents, session)
            : undefined,
        responseMetadata,
        richContent: outcome.richContent || undefined,
        actions: outcome.actions || undefined,
        voiceConfig: outcome.voiceConfig || undefined,
        localization: outcome.localization || undefined,
        contentEnvelope,
        outcome: toPublicChannelOutcome(outcome),
        sessionEnded,
        state: session?.state,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('Internal chat agent execution failed', {
      projectId,
      agentId,
      tenantId,
      error: errorMessage,
    });
    res.status(500).json({
      success: false,
      error: { code: 'AGENT_EXECUTION_FAILED', message: errorMessage },
    });
  }
});

export default router;
