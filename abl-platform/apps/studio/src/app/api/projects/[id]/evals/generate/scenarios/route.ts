/**
 * POST /api/projects/:id/evals/generate/scenarios
 *
 * AI-generates eval scenario suggestions using project topology + optional persona context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { resolveArchLLMClient, ARCH_GENERATE_MAX_TOKENS, ARCH_TIMEOUT_MS } from '@/lib/arch-llm';
import { normalizeGeneratedScenario } from '@/lib/eval-generation-normalizers';

const inputSchema = z.object({
  count: z.number().int().min(1).max(10).optional().default(3),
  personaIds: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are an expert at designing test scenarios for AI agent evaluation.

Given an agent system topology and optionally personas, generate conversation scenarios that would thoroughly test the system.

Each scenario should have:
- name: A descriptive name (e.g., "Multi-Agent Billing Dispute", "Simple FAQ Query")
- description: 1-2 sentence description of what happens in this scenario
- category: One of "happy_path", "edge_case", "error_handling", "multi_turn", "handoff", "adversarial"
- difficulty: One of "easy", "medium", "hard"
- entryAgent: The agent name (from the topology) where the conversation starts
- initialMessage: A realistic first user message that starts this scenario
- expectedOutcome: A concrete success condition the evaluator can verify
- maxTurns: Number between 3-20
- expectedMilestones: Array of 2-5 milestones (e.g., ["User greeted", "Problem identified", "Solution proposed"])
- agentPath: Expected agent path if handoffs occur (e.g., ["triage_agent", "billing_agent"])
- tags: Array of 1-3 tags (e.g., ["billing", "escalation"])

IMPORTANT: entryAgent and agentPath values MUST use exact agent names from the provided topology.

Respond with ONLY a JSON array of scenario objects. No markdown, no explanation.`;

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

  const { count, personaIds } = parsed.data;

  try {
    // Fetch project topology
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, user.tenantId);

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agents found in project. Create agents first.' },
        { status: 400 },
      );
    }

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

    const validAgentNames = agentSummaries.map((a) => a.name);

    // Optionally fetch persona context
    let personaContext = '';
    if (personaIds && personaIds.length > 0) {
      const { findPersonaById } = await import('@/repos/eval-repo');
      const personas = await Promise.all(
        personaIds.map((id) => findPersonaById(id, user.tenantId, projectId)),
      );
      const validPersonas = personas.filter(Boolean);
      if (validPersonas.length > 0) {
        personaContext = `\n\nPersonas that will use these scenarios:\n${JSON.stringify(
          validPersonas.map((p: Record<string, unknown>) => ({
            name: p.name,
            communicationStyle: p.communicationStyle,
            domainKnowledge: p.domainKnowledge,
            isAdversarial: p.isAdversarial,
          })),
          null,
          2,
        )}`;
      }
    }

    const userMessage = `Agent system topology:

${JSON.stringify(agentSummaries, null, 2)}

Valid agent names: ${JSON.stringify(validAgentNames)}
${personaContext}
Generate exactly ${count} diverse eval scenarios as a JSON array.`;

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

    let scenarios: unknown[];
    try {
      const cleaned = result
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      scenarios = JSON.parse(cleaned);
      if (!Array.isArray(scenarios)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to parse AI response. Please try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      scenarios: scenarios.map((scenario) => normalizeGeneratedScenario(scenario, validAgentNames)),
    });
  } catch (error) {
    return handleApiError(error, 'EvalGenerate.scenarios');
  }
}
