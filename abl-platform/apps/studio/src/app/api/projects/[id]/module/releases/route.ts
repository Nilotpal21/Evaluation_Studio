/**
 * GET  /api/projects/:id/module/releases  — List releases with cursor pagination
 * POST /api/projects/:id/module/releases  — Publish a new module release
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import type { ProjectToolType } from '@agent-platform/database/models';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import {
  behaviorProfileConfigKeyToName,
  buildModuleRelease,
  extractModuleContract,
  getProjectExportReadinessIssues,
  validatePublishSafety,
  type CompileFn,
  type ProjectAgentExportReadinessRecord,
} from '@agent-platform/project-io';
import { buildStudioCompilerOptions } from '@/lib/abl/studio-compiler-options';

const log = createLogger('module-releases-route');

// ─── Schemas ──────────────────────────────────────────────────────────────

const PublishReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'Version must follow semver format'),
  releaseNotes: z.string().max(5000).optional(),
  promoteToEnvironment: z.enum(['dev', 'staging', 'production']).optional(),
});

type PublishReleaseInput = z.infer<typeof PublishReleaseSchema>;

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

// ─── GET — List releases ──────────────────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ request, params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;
    const { ModuleRelease } = await import('@agent-platform/database/models');

    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10)));
    const cursor = url.searchParams.get('cursor');

    const filter: Record<string, unknown> = { tenantId, moduleProjectId: projectId };
    if (cursor) {
      // Validate cursor is a non-empty string with reasonable length to prevent injection
      if (cursor.length > 100) {
        return errorJson('Invalid cursor format', 400, ErrorCode.VALIDATION_ERROR);
      }
      filter._id = { $lt: cursor };
    }

    const releases = await ModuleRelease.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = releases.length > limit;
    const results = hasMore ? releases.slice(0, limit) : releases;
    const nextCursor =
      hasMore && results.length > 0
        ? String((results[results.length - 1] as Record<string, unknown>)._id)
        : null;

    return NextResponse.json({
      success: true,
      data: results.map((r: Record<string, unknown>) => ({
        id: String(r._id),
        version: r.version,
        releaseNotes: r.releaseNotes,
        contract: r.contract,
        sourceHash: r.sourceHash,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        archivedAt: r.archivedAt,
      })),
      pagination: { nextCursor, hasMore },
    });
  },
);

// ─── POST — Publish release ───────────────────────────────────────────────

export const POST = withRouteHandler<PublishReleaseInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_PUBLISH,
    requireFeature: 'reusable_modules',
    bodySchema: PublishReleaseSchema,
  },
  async ({ body, user, params, tenantId, project, request }) => {
    const publishStartMs = Date.now();
    await ensureDb();
    const projectId = params.id;

    // Step 1: Validate project kind=module
    const {
      Project,
      ProjectAgent,
      ProjectConfigVariable,
      ProjectTool,
      AgentModelConfig,
      ModuleRelease,
      ModuleEnvironmentPointer,
      ProjectRuntimeConfig,
      ProjectLLMConfig,
    } = await import('@agent-platform/database/models');

    const proj = await Project.findOne({ _id: projectId, tenantId }).lean();
    if (!proj) {
      return errorJson('Project not found', 404, ErrorCode.NOT_FOUND);
    }
    if ((proj as Record<string, unknown>).kind !== 'module') {
      return errorJson(
        'Only module projects can publish releases',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Step 2: Version is already validated by Zod schema

    // Step 3: Build release artifact
    // Fetch all agents for the project
    const agents = await ProjectAgent.find({ projectId, tenantId }).lean();
    if (agents.length === 0) {
      return errorJson('Module must contain at least one agent', 400, ErrorCode.VALIDATION_ERROR);
    }

    const [runtimeConfig, llmConfig] = await Promise.all([
      ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean(),
      ProjectLLMConfig.findOne({ projectId, tenantId }).lean(),
    ]);
    const readinessIssues = await getProjectExportReadinessIssues({
      agents: agents as ProjectAgentExportReadinessRecord[],
      tenantId,
      projectId,
      runtimeConfig: runtimeConfig ?? null,
      llmConfig: llmConfig ?? null,
    });
    if (readinessIssues.length > 0) {
      log.warn('Refusing module release publish for project with readiness issues', {
        tenantId,
        projectId,
        issueKinds: readinessIssues.map((issue) => issue.kind),
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'MODULE_RELEASE_READINESS_FAILED',
            message:
              'Module release publish blocked because the project is not execution-ready. Fix the reported issues and retry.',
          },
          issues: readinessIssues,
        },
        { status: 422 },
      );
    }

    const agentsMap: Record<string, string> = {};
    for (const agent of agents) {
      const a = agent as Record<string, unknown>;
      if (a.dslContent) {
        agentsMap[a.name as string] = a.dslContent as string;
      }
    }

    // Fetch all tools for the project
    const tools = await ProjectTool.find({ projectId, tenantId }).lean();
    const toolsMap: Record<string, { dslContent: string; toolType: ProjectToolType }> = {};
    for (const tool of tools) {
      const t = tool as Record<string, unknown>;
      toolsMap[t.name as string] = {
        dslContent: t.dslContent as string,
        toolType: t.toolType as ProjectToolType,
      };
    }

    const configVarDocs = await ProjectConfigVariable.find({
      projectId,
      tenantId,
    })
      .select('key value')
      .lean();
    const profilesMap: Record<string, string> = {};
    const profileDocuments: import('@abl/core').AgentBasedDocument[] = [];
    for (const configVarDoc of configVarDocs) {
      const configVar = configVarDoc as Record<string, unknown>;
      if (typeof configVar.key !== 'string' || typeof configVar.value !== 'string') {
        continue;
      }

      const profileName = behaviorProfileConfigKeyToName(configVar.key);
      if (!profileName) {
        continue;
      }

      profilesMap[profileName] = configVar.value;
      const parseResult = parseAgentBasedABL(configVar.value);
      if (!parseResult.document || parseResult.errors.length > 0) {
        log.warn('Behavior profile DSL failed to parse during module release build', {
          projectId,
          profileName,
          parseErrors: parseResult.errors.map((e) => e.message ?? String(e)),
        });
        return NextResponse.json(
          {
            success: false,
            errors: [
              {
                msg: `Behavior profile '${profileName}' failed to parse`,
                code: ErrorCode.BUILD_ERROR,
                details: parseResult.errors.map((e) => e.message ?? String(e)),
              },
            ],
          },
          { status: 422 },
        );
      }
      profileDocuments.push(parseResult.document);
    }

    const agentDocuments: import('@abl/core').AgentBasedDocument[] = [];
    const parsedNameByStoredName = new Map<string, string>();
    const agentCompanions: Record<
      string,
      {
        systemPromptLibraryRef?: { promptId: string; versionId: string; resolvedHash?: string };
        resolvedSystemPrompt?: string;
      }
    > = {};

    for (const agent of agents) {
      const record = agent as Record<string, unknown>;
      const storedAgentName = record.name as string;
      const dslContent = record.dslContent as string | null | undefined;
      if (!storedAgentName || typeof dslContent !== 'string') {
        continue;
      }

      const parseResult = parseAgentBasedABL(dslContent);
      if (!parseResult.document || parseResult.errors.length > 0) {
        log.warn('Agent DSL failed to parse during module release build', {
          projectId,
          agentName: storedAgentName,
          parseErrors: parseResult.errors.map((e) => e.message ?? String(e)),
        });
        return NextResponse.json(
          {
            success: false,
            errors: [
              {
                msg: `Agent '${storedAgentName}' failed to parse`,
                code: ErrorCode.BUILD_ERROR,
                details: parseResult.errors.map((e) => e.message ?? String(e)),
              },
            ],
          },
          { status: 422 },
        );
      }

      const promptLibraryRef = normalizePromptLibraryRef(record.systemPromptLibraryRef);
      if (promptLibraryRef) {
        const documentWithPromptRef =
          parseResult.document as import('@abl/core').AgentBasedDocument & {
            systemPrompt?: string | null;
            systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
          };
        documentWithPromptRef.systemPromptLibraryRef = { ...promptLibraryRef };

        try {
          await resolvePromptLibraryRefOnDocument(documentWithPromptRef, {
            tenantId,
            projectId,
          });
        } catch (err: unknown) {
          log.warn('Prompt library resolution failed during module release build', {
            projectId,
            agentName: storedAgentName,
            error: err instanceof Error ? err.message : String(err),
          });
          return NextResponse.json(
            {
              success: false,
              errors: [
                {
                  msg: `Prompt library reference for agent '${storedAgentName}' could not be resolved: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  code: ErrorCode.BUILD_ERROR,
                },
              ],
            },
            { status: 422 },
          );
        }

        agentCompanions[storedAgentName] = {
          systemPromptLibraryRef: {
            promptId: documentWithPromptRef.systemPromptLibraryRef!.promptId,
            versionId: documentWithPromptRef.systemPromptLibraryRef!.versionId,
            ...(typeof documentWithPromptRef.systemPromptLibraryRef?.resolvedHash === 'string'
              ? { resolvedHash: documentWithPromptRef.systemPromptLibraryRef.resolvedHash }
              : {}),
          },
          ...(typeof documentWithPromptRef.systemPrompt === 'string'
            ? { resolvedSystemPrompt: documentWithPromptRef.systemPrompt }
            : {}),
        };
      }

      parsedNameByStoredName.set(storedAgentName, parseResult.document.name);
      agentDocuments.push(parseResult.document);
    }

    // Check if model configs exist (for warning)
    const modelConfigCount = await AgentModelConfig.countDocuments({ projectId, tenantId });

    const compilerOptionResult = await buildStudioCompilerOptions({
      documents: [...profileDocuments, ...agentDocuments],
      projectId,
      runtimeConfigReadinessMode: 'blocking',
      tenantId,
      toolResolutionMode: 'blocking',
    });
    if (compilerOptionResult.errors.length > 0) {
      log.warn('Compiler options produced blocking errors during module release build', {
        projectId,
        errorCount: compilerOptionResult.errors.length,
        errors: compilerOptionResult.errors,
      });
      return NextResponse.json(
        {
          success: false,
          errors: compilerOptionResult.errors.map((msg) => ({
            msg,
            code: ErrorCode.BUILD_ERROR,
          })),
        },
        { status: 422 },
      );
    }

    const batchCompilation = compileABLtoIR(
      [...profileDocuments, ...agentDocuments],
      Object.keys(compilerOptionResult.compilerOptions).length > 0
        ? compilerOptionResult.compilerOptions
        : undefined,
    );
    if ((batchCompilation.compilation_errors?.length ?? 0) > 0) {
      log.warn('ABL compilation produced errors during module release build', {
        projectId,
        errorCount: batchCompilation.compilation_errors?.length,
        errors: batchCompilation.compilation_errors?.map((e) => ({
          agent: e.agent,
          message: e.message,
          code: e.code,
        })),
      });
      return NextResponse.json(
        {
          success: false,
          errors: (batchCompilation.compilation_errors ?? []).map((entry) => ({
            msg: entry.message,
            code: ErrorCode.BUILD_ERROR,
          })),
        },
        { status: 422 },
      );
    }

    const precompiledIR: Record<string, Record<string, unknown>> = {};
    for (const [storedAgentName, parsedAgentName] of parsedNameByStoredName.entries()) {
      const compiledAgent = batchCompilation.agents?.[parsedAgentName];
      if (!compiledAgent) {
        log.warn('Compiled IR missing for agent during module release build', {
          projectId,
          storedAgentName,
          parsedAgentName,
          availableAgents: Object.keys(batchCompilation.agents ?? {}),
        });
        return NextResponse.json(
          {
            success: false,
            errors: [
              {
                msg: `Compiled IR for agent '${storedAgentName}' was not produced during module publish`,
                code: ErrorCode.BUILD_ERROR,
              },
            ],
          },
          { status: 422 },
        );
      }

      const companion = agentCompanions[storedAgentName];
      if (
        companion?.systemPromptLibraryRef &&
        typeof companion.systemPromptLibraryRef.resolvedHash === 'string' &&
        compiledAgent.identity?.system_prompt &&
        typeof compiledAgent.identity.system_prompt === 'object'
      ) {
        compiledAgent.identity.system_prompt.libraryRef = {
          promptId: companion.systemPromptLibraryRef.promptId,
          versionId: companion.systemPromptLibraryRef.versionId,
          resolvedHash: companion.systemPromptLibraryRef.resolvedHash,
        };
      }

      precompiledIR[storedAgentName] = compiledAgent as unknown as Record<string, unknown>;
    }

    // Create compile function
    const compileFn: CompileFn = (dsl: string) => {
      const parseResult = parseAgentBasedABL(dsl);
      if (!parseResult.document) {
        return null;
      }
      const output = compileABLtoIR(
        [...profileDocuments, parseResult.document],
        Object.keys(compilerOptionResult.compilerOptions).length > 0
          ? compilerOptionResult.compilerOptions
          : undefined,
      );
      if ((output.compilation_errors?.length ?? 0) > 0) {
        return null;
      }
      // Return the first agent IR (each DSL has one agent)
      const agentEntries = Object.entries(output.agents ?? {});
      if (agentEntries.length === 0) {
        return null;
      }
      return agentEntries[0][1] as unknown as Record<string, unknown>;
    };

    const buildResult = buildModuleRelease(
      {
        entryAgentName: (proj as Record<string, unknown>).entryAgentName as string | null,
        agents: agentsMap,
        agentCompanions,
        precompiledIR,
        profiles: profilesMap,
        tools: toolsMap,
        dslFormat: 'legacy',
        hasModelConfigs: modelConfigCount > 0,
      },
      compileFn,
      extractModuleContract,
      validatePublishSafety,
    );

    // Step 4: If build has blocking errors, return 422
    if (!buildResult.success) {
      return NextResponse.json(
        {
          success: false,
          // structured-diagnostics: allow legacy API response envelope expects { msg, code } entries here.
          errors: buildResult.errors.map((msg) => ({ msg, code: ErrorCode.BUILD_ERROR })),
          warnings: buildResult.warnings,
        },
        { status: 422 },
      );
    }

    // Step 5: Model.create (not check-then-write) + catch 11000 for dedup
    let release;
    try {
      release = await ModuleRelease.create({
        tenantId,
        moduleProjectId: projectId,
        version: body.version,
        releaseNotes: body.releaseNotes ?? null,
        artifact: buildResult.artifact,
        compiledIR: buildResult.compiledIR,
        contract: buildResult.contract,
        sourceHash: buildResult.sourceHash,
        createdBy: user.id,
      });
    } catch (err: unknown) {
      // Step 6: Catch MongoServerError code 11000 -> 409
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as Record<string, unknown>).code === 11000
      ) {
        return errorJson(
          `Version ${body.version} already exists for this module`,
          409,
          ErrorCode.NAME_CONFLICT,
        );
      }
      throw err;
    }

    const releaseId = String(release._id);

    // Step 7: If promoteToEnvironment specified, update pointer
    if (body.promoteToEnvironment) {
      try {
        await ModuleEnvironmentPointer.findOneAndUpdate(
          {
            tenantId,
            moduleProjectId: projectId,
            environment: body.promoteToEnvironment,
          },
          {
            tenantId,
            moduleProjectId: projectId,
            environment: body.promoteToEnvironment,
            moduleReleaseId: releaseId,
            updatedBy: user.id,
            $inc: { revision: 1 },
          },
          { upsert: true, new: true },
        );
      } catch (promoteErr: unknown) {
        const message = promoteErr instanceof Error ? promoteErr.message : String(promoteErr);
        log.error('Failed to promote release to environment', {
          releaseId,
          environment: body.promoteToEnvironment,
          error: message,
        });
        // Non-fatal: release was created, promotion failed
        buildResult.warnings.push(
          `Release created but promotion to ${body.promoteToEnvironment} failed: ${message}`,
        );
      }
    }

    // Step 8: Emit MODULE_PUBLISHED audit event
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const userAgent = request.headers.get('user-agent') ?? undefined;
    logAuditEvent({
      userId: user.id,
      tenantId,
      action: AuditActions.MODULE_PUBLISHED,
      ip: ip ?? undefined,
      userAgent,
      metadata: {
        projectId,
        releaseId,
        version: body.version,
        promoteToEnvironment: body.promoteToEnvironment ?? null,
      },
    }).catch((auditErr: unknown) => {
      const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
      log.error('Failed to log audit event for module publish', { error: message });
    });

    // Step 9: Log success metrics and return
    log.info('Module release published', {
      projectId,
      releaseId,
      version: body.version,
      agentCount: Object.keys(agentsMap).length,
      toolCount: Object.keys(toolsMap).length,
      warningCount: buildResult.warnings.length,
      promotedTo: body.promoteToEnvironment ?? null,
      durationMs: Date.now() - publishStartMs,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          releaseId,
          version: body.version,
          contract: buildResult.contract,
          warnings: buildResult.warnings,
        },
      },
      { status: 201 },
    );
  },
);
