/**
 * POST /api/projects/:id/agents/:agentId/compile
 *
 * Compile a specific agent within the full project context.
 * agentId in the URL is the agent **name** (matches all other agent sub-routes).
 *
 * Loads all sibling agents from the project so that cross-agent references
 * (handoffs, delegates) are validated against the real project graph.
 * Cross-agent validation is filtered to the requested agent, but ambiguous
 * project context such as duplicate agent names fails the compile up front.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findProjectAgent } from '@/repos/project-repo';
import { validateProjectAgentDraftDeclaredName } from '@agent-platform/project-io/project-agent-draft-metadata';
import {
  buildProjectCompileContext,
  collectRecoverableParseWarnings,
  collectTargetCompilationMessages,
  pickTargetIR,
  STUDIO_PROJECT_AWARE_COMPILE_MODE,
} from '@/lib/abl/project-aware-compile';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };
const log = createLogger('api:projects:agent-compile');

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId: agentName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const decodedName = decodeURIComponent(agentName);
    const agent = await findProjectAgent(projectId, decodedName, access.project.tenantId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (!agent.dslContent) {
      return NextResponse.json(
        { success: false, errors: ['Agent has no ABL content'], warnings: [] },
        { status: 400 },
      );
    }

    let requestedDsl: unknown;
    try {
      const body = await request.json();
      requestedDsl = body?.dsl;
    } catch {
      requestedDsl = undefined;
    }

    const dsl = typeof requestedDsl === 'string' ? requestedDsl : agent.dslContent;

    // Validate agent name matches DSL declared name
    const nameValidation = validateProjectAgentDraftDeclaredName({
      recordName: decodedName,
      dslContent: dsl,
    });
    if (!nameValidation.ok) {
      return NextResponse.json({
        success: false,
        errors: [
          nameValidation.message ??
            `Agent DSL declares "${nameValidation.declaredName}" but this record is "${decodedName}".`,
        ],
        warnings: [],
      });
    }

    // Parse the target agent's DSL
    const parseResult = parseAgentBasedABL(dsl);

    if (!parseResult.document) {
      return NextResponse.json({
        success: false,
        errors: parseResult.errors.map((e: any) => `Line ${e.line}: ${e.message}`),
        warnings: [],
      });
    }

    const parseWarnings = collectRecoverableParseWarnings(parseResult);
    // Forward parse errors that didn't prevent document production so they
    // still surface to the user (e.g. non-fatal structural issues).
    for (const entry of parseResult.errors ?? []) {
      parseWarnings.push(`Line ${entry.line ?? '?'}: ${entry.message}`);
    }
    const {
      allDocs,
      compilerOptions,
      errors: contextErrors,
      warnings,
    } = await buildProjectCompileContext({
      agentName: decodedName,
      mode: STUDIO_PROJECT_AWARE_COMPILE_MODE,
      projectId,
      targetDocument: parseResult.document,
      tenantId: access.project.tenantId,
    });
    parseWarnings.push(...warnings);
    if (contextErrors.length > 0) {
      return NextResponse.json({
        success: false,
        ir: null,
        errors: contextErrors,
        warnings: parseWarnings,
      });
    }

    // Compile all agents together so cross-agent references are validated
    const compilationOutput = compileABLtoIR(allDocs, compilerOptions);
    const targetAgentNames = [parseResult.document.name, decodedName].filter(
      (value, index, values) => value.length > 0 && values.indexOf(value) === index,
    );
    const { errors: compileErrors, warnings: compileWarnings } = collectTargetCompilationMessages(
      compilationOutput,
      targetAgentNames,
    );
    const allWarnings = [...parseWarnings, ...compileWarnings];
    const resolvedIR =
      compileErrors.length === 0 ? pickTargetIR(compilationOutput, targetAgentNames) : null;
    const targetResolutionErrors =
      compileErrors.length === 0 && !resolvedIR
        ? [`Compiled project output did not include agent "${decodedName}".`]
        : [];
    const errors = [...compileErrors, ...targetResolutionErrors];
    const success = errors.length === 0;

    return NextResponse.json({
      success,
      ir: success ? resolvedIR : null,
      errors,
      warnings: allWarnings,
    });
  } catch (error) {
    log.error('Agent compile failed', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      agentName,
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown compile error',
      },
      { status: 500 },
    );
  }
}
