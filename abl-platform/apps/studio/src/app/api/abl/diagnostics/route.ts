/**
 * POST /api/abl/diagnostics - Tiered ABL diagnostics via language service
 *
 * Tiers:
 *   1/2 — Parse + structural validation (no compile)
 *   3   — Full compilation diagnostics via injected compileFn
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getDiagnostics } from '@abl/language-service';
import type { CompileFn, Diagnostic } from '@abl/language-service';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import {
  buildProjectCompileContext,
  collectTargetCompilationMessages,
  STUDIO_PROJECT_AWARE_COMPILE_MODE,
} from '@/lib/abl/project-aware-compile';

const log = createLogger('api:abl:diagnostics');

/**
 * Build a CompileFn that wraps the real compiler for Tier 3 diagnostics.
 */
function makeCompileFn(): CompileFn {
  return (source: string): Diagnostic[] => {
    const parseResult = parseAgentBasedABL(source);
    if (!parseResult.document) {
      return parseResult.errors.map((e: { line: number; column?: number; message: string }) => ({
        severity: 'error' as const,
        message: e.message,
        line: e.line ?? 1,
        column: e.column ?? 1,
        source: 'compile',
      }));
    }

    try {
      const output = compileABLtoIR([parseResult.document]);
      const diagnostics: Diagnostic[] = [];

      if (output.compilation_errors?.length) {
        for (const ce of output.compilation_errors) {
          diagnostics.push({
            severity: 'error',
            message: `${ce.agent}: ${ce.message}`,
            line: 1,
            column: 1,
            source: 'compile',
          });
        }
      }

      return diagnostics;
    } catch (err) {
      return [
        {
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
          line: 1,
          column: 1,
          source: 'compile',
        },
      ];
    }
  };
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  try {
    const body = await request.json();
    const { dsl, tier, projectId, agentName } = body;

    if (!dsl || typeof dsl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid ABL content' },
        { status: 400 },
      );
    }

    const resolvedTier = typeof tier === 'number' ? tier : 2;
    const projectAwareTier3 =
      resolvedTier >= 3 &&
      typeof projectId === 'string' &&
      projectId.length > 0 &&
      typeof agentName === 'string' &&
      agentName.length > 0;

    let diagnostics: Diagnostic[];

    if (!projectAwareTier3) {
      const options = resolvedTier >= 3 ? { compileFn: makeCompileFn() } : undefined;
      diagnostics = getDiagnostics(dsl, options);
    } else {
      const access = await requireProjectAccess(projectId, authResult);
      if (isAccessError(access)) return access;

      diagnostics = getDiagnostics(dsl);
      const parseResult = parseAgentBasedABL(dsl);

      if (parseResult.document) {
        const {
          allDocs,
          compilerOptions,
          errors: contextErrors,
          warnings,
        } = await buildProjectCompileContext({
          agentName,
          mode: STUDIO_PROJECT_AWARE_COMPILE_MODE,
          projectId,
          targetDocument: parseResult.document,
          tenantId: access.project.tenantId,
        });

        diagnostics.push(
          ...warnings.map((message) => ({
            severity: 'warning' as const,
            message,
            line: 1,
            column: 1,
            source: 'compile' as const,
          })),
          ...contextErrors.map((message) => ({
            severity: 'error' as const,
            message,
            line: 1,
            column: 1,
            source: 'compile' as const,
          })),
        );

        if (contextErrors.length === 0) {
          const compilationOutput = compileABLtoIR(allDocs, compilerOptions);
          const targetAgentNames = [parseResult.document.name, agentName].filter(
            (value, index, values) => value.length > 0 && values.indexOf(value) === index,
          );
          const { errors, warnings: compileWarnings } = collectTargetCompilationMessages(
            compilationOutput,
            targetAgentNames,
          );

          diagnostics.push(
            ...compileWarnings.map((message) => ({
              severity: 'warning' as const,
              message,
              line: 1,
              column: 1,
              source: 'compile' as const,
            })),
            ...errors.map((message) => ({
              severity: 'error' as const,
              message,
              line: 1,
              column: 1,
              source: 'compile' as const,
            })),
          );
        }
      }
    }

    return NextResponse.json({
      success: diagnostics.filter((d) => d.severity === 'error').length === 0,
      diagnostics,
    });
  } catch (error) {
    log.error('Diagnostics route failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown diagnostics error',
      },
      { status: 500 },
    );
  }
}
