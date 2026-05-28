/**
 * POST /api/arch-ai/projects/:projectId/spec-document/sync
 *
 * Reads the current project state (agents, tools, guardrails) and updates
 * the spec document's architecture + implementation sections.
 *
 * Pure data read + transform — no LLM involved. Idempotent.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { successJson, errorJson, handleApiError } from '@/lib/api-response';
import { ArchSpecDocument, ProjectAgent, ProjectTool } from '@agent-platform/database/models';
import { SpecDocumentService } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import { findProjectByIdAndTenant } from '@/repos/project-repo';
import mongoose from 'mongoose';

// Inline spec sub-document shapes (not exported from database barrel)
interface SpecAgent {
  name: string;
  role: string;
  executionMode: string;
  model: string;
  description: string;
  compileStatus: string;
}

interface SpecEdge {
  from: string;
  to: string;
  type: string;
  condition: string;
}

interface SpecTool {
  name: string;
  agent: string;
  type: string;
  description: string;
}

interface Guardrail {
  rule: string;
  agent: string;
  severity: string;
  onFail: string;
}

const log = createLogger('arch-ai:spec-document-sync');

const specDocumentService = new SpecDocumentService(
  ArchSpecDocument,
  ArchSessionModel,
  mongoose.connection,
);

// ─── Parsed DSL extraction helpers ──────────────────────────────────────

interface ParsedAgentData {
  toolNames: string[];
  handoffTargets: Array<{ to: string; when: string }>;
  guardrails: Array<{ name: string; kind: string; action: string; message?: string }>;
  constraints: Array<{ name: string; requirements: string[] }>;
  hasFlow: boolean;
}

/**
 * Parse an agent's DSL content and extract structured data.
 * Returns null on parse failure — caller should handle gracefully.
 */
async function extractFromDSL(dslContent: string): Promise<ParsedAgentData | null> {
  try {
    const { parseAgentBasedABL } = await import('@abl/core');
    const result = parseAgentBasedABL(dslContent);

    if (result.errors.length > 0 || !result.document) {
      return null;
    }

    const doc = result.document;

    const toolNames = (doc.tools ?? []).map((t) => t.name).filter(Boolean);

    const handoffTargets = (doc.handoff ?? []).map((h) => ({
      to: h.to,
      when: h.when ?? '',
    }));

    const guardrails = (doc.guardrails ?? []).map((g) => ({
      name: g.name,
      kind: g.kind,
      action: g.action,
      message: g.message,
    }));

    const constraints = (doc.constraints ?? []).map((c) => ({
      name: c.name,
      requirements: c.requirements.map((r) => {
        if (typeof r === 'string') return r;
        if (typeof r === 'object' && r !== null && 'text' in r) {
          return String((r as { text: string }).text);
        }
        return String(r);
      }),
    }));

    const hasFlow = doc.flow != null;

    return { toolNames, handoffTargets, guardrails, constraints, hasFlow };
  } catch {
    return null;
  }
}

// ─── Route Handler ──────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { projectId } = await params;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const tenantId = auth.tenantId;

    // 1. Read project to get entryAgentName
    const project = await findProjectByIdAndTenant(projectId, tenantId);
    if (!project) {
      return errorJson('Project not found', 404, 'NOT_FOUND');
    }

    // 2. Read all agents (same pattern as health-check.ts)
    const agents = await ProjectAgent.find({ projectId, tenantId }).lean();

    // 3. Read all tools
    const tools = await ProjectTool.find({ projectId, tenantId }).lean();

    // 4. Parse each agent's DSL to extract tools, handoffs, guardrails
    const parsedByAgent = new Map<string, ParsedAgentData>();
    for (const agent of agents) {
      const a = agent as Record<string, unknown>;
      const dslContent = a.dslContent as string | null;
      if (!dslContent) continue;
      const parsed = await extractFromDSL(dslContent);
      if (parsed) {
        parsedByAgent.set(a.name as string, parsed);
      }
    }

    // 5. Build agent summaries
    const agentSummaries: SpecAgent[] = agents.map((a: Record<string, unknown>) => {
      const name = a.name as string;
      const description = (a.description as string | null) ?? '';
      const dslContent = a.dslContent as string | null;
      const parsed = parsedByAgent.get(name);
      const executionMode = parsed?.hasFlow ? 'flow' : 'reasoning';
      const compileStatus = dslContent ? (parsed ? 'ok' : 'error') : 'missing';

      return {
        name,
        role: description,
        executionMode,
        model: '',
        description,
        compileStatus,
      };
    });

    // 6. Build edges from parsed handoff data
    const edges: SpecEdge[] = [];
    for (const [agentName, parsed] of parsedByAgent) {
      for (const handoff of parsed.handoffTargets) {
        edges.push({
          from: agentName,
          to: handoff.to,
          type: 'handoff',
          condition: handoff.when,
        });
      }
    }

    // 7. Build tool summaries from ProjectTool records
    //    Link tools to agents via DSL-declared tool names
    const agentByTool = new Map<string, string>();
    for (const [agentName, parsed] of parsedByAgent) {
      for (const toolName of parsed.toolNames) {
        agentByTool.set(toolName.toLowerCase(), agentName);
      }
    }

    const toolSummaries: SpecTool[] = tools.map((t: Record<string, unknown>) => {
      const name = t.name as string;
      const toolType = (t.toolType as string) ?? 'function';
      const description = (t.description as string | null) ?? '';
      return {
        name,
        agent: agentByTool.get(name.toLowerCase()) ?? 'unassigned',
        type: toolType,
        description,
      };
    });

    // 8. Build guardrail summaries from parsed DSL
    const guardrailSummaries: Guardrail[] = [];
    for (const [agentName, parsed] of parsedByAgent) {
      for (const g of parsed.guardrails) {
        guardrailSummaries.push({
          rule: g.name,
          agent: agentName,
          severity: g.kind,
          onFail: g.action,
        });
      }
      // Also include constraint phases as guardrails
      for (const c of parsed.constraints) {
        for (const req of c.requirements) {
          guardrailSummaries.push({
            rule: `${c.name}: ${req}`,
            agent: agentName,
            severity: 'constraint',
            onFail: 'block',
          });
        }
      }
    }

    // 9. Get spec doc (project-scoped)
    const ctx = { tenantId, userId: auth.id };
    const spec = await specDocumentService.getByProject(ctx, projectId, {
      unsafeProjectScope: true,
    });

    if (!spec) {
      return errorJson('Spec document not found for this project', 404, 'SPEC_DOCUMENT_NOT_FOUND');
    }

    // 10. Apply updates directly (project-scoped — no userId filter, matching PUT pattern)
    const entryPoint = typeof project.entryAgentName === 'string' ? project.entryAgentName : null;

    const specSet: Record<string, unknown> = {
      'architecture.agents': agentSummaries,
      'architecture.edges': edges,
      'architecture.entryPoint': entryPoint,
      'architecture.agentCount': agents.length,
      'implementation.tools': toolSummaries,
      'implementation.guardrails': guardrailSummaries,
      'implementation.buildStatus': 'synced',
    };

    const updatedDoc = await ArchSpecDocument.findOneAndUpdate(
      { _id: spec._id, tenantId, projectId },
      { $set: specSet, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );

    if (!updatedDoc) {
      return errorJson('Spec document not found', 404, 'SPEC_DOCUMENT_NOT_FOUND');
    }

    log.info('Spec document synced from project', {
      projectId,
      agentCount: agents.length,
      toolCount: tools.length,
      edgeCount: edges.length,
      guardrailCount: guardrailSummaries.length,
    });

    return successJson('data', updatedDoc);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Spec document sync failed', { error: message });
    return handleApiError(err, 'arch-ai:spec-document-sync');
  }
}
