/**
 * POST /api/abl/compile - Compile ABL to IR
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { parseBehaviorProfileDocumentsFromConfigVariables } from '@agent-platform/project-io';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { checkRateLimit } from '@/lib/rate-limit';
import { findConfigVariablesByProject } from '@/repos/config-variable-repo';
import {
  buildProjectCompileContext,
  buildStudioCompilerOptions,
  collectRecoverableParseWarnings,
  collectTargetCompilationMessages,
  pickTargetIR,
  STUDIO_PROJECT_AWARE_COMPILE_MODE,
} from '@/lib/abl/project-aware-compile';

/** Maximum DSL input size (500KB) */
const MAX_DSL_SIZE = 512_000;
const log = createLogger('api:abl:compile');

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const rl = await checkRateLimit(`compile:${authResult.id}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const { dsl, projectId, agentName } = await request.json();

    if (!dsl || typeof dsl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid ABL content' },
        { status: 400 },
      );
    }

    if (dsl.length > MAX_DSL_SIZE) {
      return NextResponse.json(
        { success: false, error: `ABL content exceeds maximum size of ${MAX_DSL_SIZE} bytes` },
        { status: 400 },
      );
    }

    const parseResult = parseAgentBasedABL(dsl);

    // If parse failed entirely (no document), return errors immediately
    if (!parseResult.document) {
      return NextResponse.json({
        success: false,
        errors: parseResult.errors.map((e: any) => `Line ${e.line}: ${e.message}`),
        ir: null,
      });
    }

    // Collect parse warnings — the parser may produce a usable document
    // even with unknown sections (DOMAIN:, ROUTING:, etc.)
    const parseWarnings = collectRecoverableParseWarnings(parseResult);
    // Forward parse errors that didn't prevent document production so they
    // still surface to the user (e.g. non-fatal structural issues).
    for (const entry of parseResult.errors ?? []) {
      parseWarnings.push(`Line ${entry.line ?? '?'}: ${entry.message}`);
    }
    const hasProjectId = typeof projectId === 'string' && projectId.length > 0;
    const projectAccess = hasProjectId ? await requireProjectAccess(projectId, authResult) : null;
    if (projectAccess && isAccessError(projectAccess)) return projectAccess;

    const projectTenantId = projectAccess?.project.tenantId;
    const projectAwareCompile =
      hasProjectId && typeof agentName === 'string' && agentName.length > 0 && !!projectTenantId;

    let allDocs = [parseResult.document];
    const compilerOptions: Record<string, unknown> = {};

    if (projectAwareCompile) {
      const {
        allDocs: projectDocs,
        compilerOptions: projectCompilerOptions,
        errors: contextErrors,
        warnings,
      } = await buildProjectCompileContext({
        agentName,
        mode: STUDIO_PROJECT_AWARE_COMPILE_MODE,
        projectId,
        targetDocument: parseResult.document,
        tenantId: projectTenantId!,
      });
      allDocs = projectDocs;
      Object.assign(compilerOptions, projectCompilerOptions);
      parseWarnings.push(...warnings);

      if (contextErrors.length > 0) {
        return NextResponse.json({
          success: false,
          ir: null,
          errors: contextErrors,
          warnings: parseWarnings,
        });
      }
    } else {
      // Load config variables from project if projectId is provided
      let configVariables: Record<string, string> | undefined;
      if (hasProjectId && projectTenantId) {
        const vars = await findConfigVariablesByProject(projectId, projectTenantId);
        if (vars.length > 0) {
          configVariables = {};
          for (const v of vars) {
            configVariables[v.key] = v.value;
          }
        }
      }

      if (configVariables) {
        const profileDocuments = parseBehaviorProfileDocumentsFromConfigVariables(configVariables);
        allDocs.push(...profileDocuments.documents);
        parseWarnings.push(...profileDocuments.errors);
      }

      if (hasProjectId && projectTenantId) {
        const studioCompilerOptions = await buildStudioCompilerOptions({
          documents: allDocs,
          projectId,
          tenantId: projectTenantId,
          configVariables,
        });
        Object.assign(compilerOptions, studioCompilerOptions.compilerOptions);
        parseWarnings.push(...studioCompilerOptions.warnings);
        if (studioCompilerOptions.errors.length > 0) {
          return NextResponse.json({
            success: false,
            ir: null,
            errors: studioCompilerOptions.errors,
            warnings: parseWarnings,
          });
        }
      }
    }

    const compilationOutput = compileABLtoIR(
      allDocs,
      Object.keys(compilerOptions).length > 0 ? compilerOptions : undefined,
    );

    if (projectAwareCompile) {
      const targetAgentNames = [parseResult.document.name, agentName].filter(
        (value, index, values) => value.length > 0 && values.indexOf(value) === index,
      );
      const { errors: compileErrors, warnings } = collectTargetCompilationMessages(
        compilationOutput,
        targetAgentNames,
      );
      const ir =
        compileErrors.length === 0 ? pickTargetIR(compilationOutput, targetAgentNames) : null;
      const targetResolutionErrors =
        compileErrors.length === 0 && !ir
          ? [`Compiled project output did not include agent "${agentName}".`]
          : [];
      const errors = [...compileErrors, ...targetResolutionErrors];

      return NextResponse.json({
        success: errors.length === 0,
        ir: errors.length === 0 ? ir : null,
        errors,
        warnings: [...parseWarnings, ...warnings],
        resolved_config_variables: compilationOutput.resolved_config_variables,
      });
    }

    const targetName = parseResult.document.name;
    const ir =
      compilationOutput.agents[targetName] ||
      (compilationOutput.entry_agent
        ? compilationOutput.agents[compilationOutput.entry_agent]
        : null) ||
      Object.values(compilationOutput.agents)[0];

    const compileErrors =
      compilationOutput.compilation_errors?.map((ce) => `${ce.agent}: ${ce.message}`) ?? [];

    return NextResponse.json({
      success: compileErrors.length === 0,
      ir,
      errors: [...compileErrors, ...parseWarnings],
      warnings: parseWarnings,
      resolved_config_variables: compilationOutput.resolved_config_variables,
    });
  } catch (error) {
    log.error('Compile route failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown compile error',
        ir: null,
      },
      { status: 500 },
    );
  }
}
