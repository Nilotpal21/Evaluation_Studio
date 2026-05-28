/**
 * POST /api/projects/:id/evals/generate/personas
 *
 * AI-generates eval persona suggestions using project topology context.
 * Returns persona definitions for the user to review and selectively save.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { resolveArchLLMClient, ARCH_GENERATE_MAX_TOKENS, ARCH_TIMEOUT_MS } from '@/lib/arch-llm';
import { normalizeGeneratedPersona } from '@/lib/eval-generation-normalizers';

const inputSchema = z.object({
  count: z.number().int().min(1).max(10).optional().default(3),
  focusAreas: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are an expert at designing test personas for AI agent evaluation.

Given a description of an agent system (its agents, tools, handoffs, and goals), generate diverse eval personas that would exercise the system thoroughly.

Each persona should have:
- name: A descriptive name (e.g., "Impatient Tech Expert", "Confused First-Timer")
- communicationStyle: One of "formal", "casual", "terse", "verbose", "technical"
- domainKnowledge: One of "expert", "intermediate", "beginner"
- behaviorTraits: Array of 2-4 traits (e.g., ["impatient", "detail-oriented", "skeptical"])
- goals: What this persona is trying to accomplish
- constraints: Limitations or quirks (e.g., "Only speaks in short sentences", "Gets frustrated after 3 turns")
- isAdversarial: boolean — true for personas designed to test edge cases or break the system
- adversarialType: If adversarial, one of "prompt_injection", "social_engineering", "off_topic", "abusive", "edge_case"

Generate diverse personas covering:
1. Happy path users with varying communication styles
2. Edge case users (domain novices, very verbose/terse users)
3. Adversarial users when requested

Respond with ONLY a JSON array of persona objects. No markdown, no explanation.`;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { count, focusAreas } = parsed.data;

  try {
    // Fetch project topology for context
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, user.tenantId);

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agents found in project. Create agents first.' },
        { status: 400 },
      );
    }

    // Build agent summaries for LLM context
    const agentSummaries = agents.map((a: Record<string, unknown>) => ({
      name: a.name as string,
      type: (a.agentType as string) ?? 'agent',
      description: (a.description as string) ?? '',
      goal: (a.goal as string) ?? '',
      tools: ((a.tools as Array<Record<string, unknown>>) ?? [])
        .map((t) => (t.name as string) ?? String(t))
        .slice(0, 10),
      executionMode: (a.executionMode as string) ?? 'reasoning',
      handoffTargets: (a.handoffTargets as string[]) ?? [],
    }));

    // Build user message
    const focusStr = focusAreas?.length ? `\nFocus areas: ${focusAreas.join(', ')}` : '';

    const userMessage = `Here is the agent system topology:

${JSON.stringify(agentSummaries, null, 2)}
${focusStr}
Generate exactly ${count} diverse eval personas as a JSON array.`;

    // Call LLM
    const resolution = await resolveArchLLMClient(user.tenantId);
    if (!resolution.client) {
      return NextResponse.json(
        { success: false, error: resolution.error ?? 'LLM not configured' },
        { status: 503 },
      );
    }

    const result = await resolution.client.chat(
      SYSTEM_PROMPT,
      [{ role: 'user', content: userMessage }],
      {
        model: resolution.model,
        maxTokens: ARCH_GENERATE_MAX_TOKENS,
        timeoutMs: ARCH_TIMEOUT_MS,
      },
    );

    // Parse LLM response
    let personas: unknown[];
    try {
      const cleaned = result
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      personas = JSON.parse(cleaned);
      if (!Array.isArray(personas)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to parse AI response. Please try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      personas: personas.map((persona) => normalizeGeneratedPersona(persona)),
    });
  } catch (error) {
    return handleApiError(error, 'EvalGenerate.personas');
  }
}
