/**
 * ABL Analysis API Route
 *
 * POST /api/abl/analysis
 *
 * Proxies analysis tool calls to the CLI package's handleAnalysisTool.
 * Accepts { tool: string, dsl: string } and returns the analysis result.
 *
 * Supported tools:
 *   - kore_explain_dsl: Parse and explain agent structure
 *   - kore_suggest_improvements: Diagnostics + rule-based improvement suggestions
 *   - kore_test_agent: Compilation/diagnostic summary with counts
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Valid tool names (whitelist)
// ---------------------------------------------------------------------------

const VALID_TOOLS = new Set(['kore_explain_dsl', 'kore_suggest_improvements', 'kore_test_agent']);

// ---------------------------------------------------------------------------
// Lazy-load the analysis handler from the CLI package (compiled output).
// Uses dynamic import to avoid bundling the entire CLI package.
// ---------------------------------------------------------------------------

let handlerCache: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

async function loadHandler(): Promise<
  (name: string, args: Record<string, unknown>) => Promise<unknown>
> {
  if (handlerCache) return handlerCache;

  const mod = await import(
    /* webpackIgnore: true */
    '@agent-platform/cli/mcp/analysis'
  );
  handlerCache = mod.handleAnalysisTool as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  return handlerCache;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const body = await request.json();
    const { tool, dsl } = body as { tool?: string; dsl?: string };

    // Validate required fields
    if (!tool || typeof tool !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing required field: tool' },
        { status: 400 },
      );
    }

    if (!dsl || typeof dsl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing required field: dsl' },
        { status: 400 },
      );
    }

    // Validate tool name against whitelist
    if (!VALID_TOOLS.has(tool)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid tool name: ${tool}. Must be one of: ${[...VALID_TOOLS].join(', ')}`,
        },
        { status: 400 },
      );
    }

    // Lazy-load the handler and execute
    const handleAnalysisTool = await loadHandler();
    const result = await handleAnalysisTool(tool, { dsl });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[abl-analysis] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Analysis failed',
      },
      { status: 500 },
    );
  }
}
