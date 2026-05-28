/**
 * GET /api/compiler/builtin-guardrails
 *
 * Returns all built-in guardrail templates from the compiler package.
 * These templates provide out-of-the-box protection against common
 * prompt injection patterns and credential leaks.
 */

import { NextResponse } from 'next/server';
import { getBuiltinGuardrailTemplates } from '@abl/compiler/platform/guardrails/builtin-templates';

export async function GET() {
  try {
    const guardrails = getBuiltinGuardrailTemplates();

    return NextResponse.json({
      success: true,
      guardrails,
    });
  } catch (error) {
    console.error('Failed to fetch builtin guardrails:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch builtin guardrails',
      },
      { status: 500 },
    );
  }
}
