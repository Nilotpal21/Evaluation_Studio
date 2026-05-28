/**
 * Build tools for the BUILD phase.
 * Also exports SPECIALIST_DISPLAY and IN_PROJECT_SPECIALIST_TOOL_MAP constants
 * used by the message processor.
 * Used by the v4 message flow under apps/studio/src/app/api/arch-ai/message/route.ts.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { askUserSchema, collectFileSchema } from '@/lib/arch-ai/tool-schemas';
import {
  sessionService,
  journalService,
  specDocumentService,
} from '@/lib/arch-ai/message-services';
import { truncate, journalAppendAndEmit } from '@/lib/arch-ai/helpers/stream-helpers';
import { ARCH_AI_TIMEOUTS } from '@/lib/arch-ai/constants';
import {
  CompileWorkerTimeoutError,
  runIsolatedSingleAgentCompile,
} from '@/lib/arch-ai/helpers/isolated-build-compiler';
import type { ArchSSEEvent } from '@agent-platform/arch-ai';
import {
  renderKnownConstructsHint,
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import { renderMissingGuardrailsWarning } from '@agent-platform/arch-ai/guardrails';

const log = createLogger('api:arch-ai:build-tools');

// ─── Specialist Display ─────────────────────────────────────────────────

export const SPECIALIST_DISPLAY: Record<string, { name: string; icon: string }> = {
  onboarding: { name: 'Onboarding Specialist', icon: 'clipboard' },
  'multi-agent-architect': { name: 'Multi-Agent Architect', icon: 'network' },
  'abl-construct-expert': { name: 'ABL Construct Expert', icon: 'code' },
  'channel-voice': { name: 'Channel & Voice Expert', icon: 'phone' },
  'entity-collection': { name: 'Entity Collection Expert', icon: 'database' },
  'integration-methodologist': { name: 'Integration Methodologist', icon: 'plug' },
  'testing-eval': { name: 'Testing & Eval Expert', icon: 'flask' },
  diagnostician: { name: 'Diagnostician', icon: 'stethoscope' },
  analyst: { name: 'Performance Analyst', icon: 'bar_chart' },
  observer: { name: 'Observer', icon: 'telescope' },
};

const KB_TOOL_NAMES = [
  'kb_manage',
  'kb_ingest',
  'kb_search',
  'kb_health',
  'kb_connector',
  'kb_documents',
];

const REFERENCE_TOOL_NAMES = [
  'find_memory_refs',
  'find_gather_field_refs',
  'find_tool_consumers',
  'find_agent_refs',
  'find_cel_var_refs',
];

const KNOWLEDGE_SPINE_TOOL_NAMES = [
  'get_construct_spec',
  'list_valid_combinations',
  'get_cel_grammar',
  'lookup_validation_code',
];

export const IN_PROJECT_SPECIALIST_TOOL_MAP: Partial<Record<string, string[]>> = {
  'in-project-architect': [
    'read_agent',
    'read_topology',
    'read_blueprint',
    'get_topology_patterns',
    'read_journal',
    ...KNOWLEDGE_SPINE_TOOL_NAMES,
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_blueprint_edit',
    'lock_blueprint_version',
    'fork_blueprint',
    'rebuild_agents_from_blueprint',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'dry_run_compile',
    'run_feasibility_check',
    'validate_agent',
    'diagnose_project',
    'explain_diagnostic',
    'analyze_constraints',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'run_simulation',
    'health_check',
    'ask_user',
    'collect_file',
    'collect_secret',
    'project_config',
    'platform_context',
    'configure_model',
    'recommend_model',
    'auth_ops',
    'tools_ops',
    'mcp_server_ops',
    'external_agent_ops',
    'variable_ops',
    'integration_ops',
    'connection_ops',
    'save_tool_dsl',
    'manage_memory',
    'agent_ops',
    'deployment_ops',
    'testing_ops',
    'analytics_ops',
    'read_insights',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  diagnostician: [
    'validate_agent',
    'diagnose_project',
    'explain_diagnostic',
    'analyze_constraints',
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'run_simulation',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'health_check',
    'ask_user',
    'collect_file',
    'project_config',
    'platform_context',
    'configure_model',
    'recommend_model',
    'agent_ops',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'abl-construct-expert': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'read_topology',
    'get_topology_patterns',
    'run_simulation',
    'health_check',
    'ask_user',
    'collect_file',
    'project_config',
    'tools_ops',
    'agent_ops',
    'platform_context',
    'configure_model',
    'recommend_model',
    'analyze_constraints',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'channel-voice': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
  ],
  'entity-collection': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
  ],
  analyst: [
    'read_insights',
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    'testing_ops',
    'run_simulation',
    'analytics_ops',
  ],
  observer: [
    'read_insights',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'read_agent',
    'read_journal',
    'read_topology',
    'validate_agent',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    'analytics_ops',
  ],
  'multi-agent-architect': [
    'read_agent',
    'read_topology',
    'get_topology_patterns',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'project_config',
    'agent_ops',
    'platform_context',
    'manage_memory',
    'search_docs',
    'deployment_ops',
  ],
  'testing-eval': [
    'testing_ops',
    'run_simulation',
    'session_ops',
    'trace_diagnosis',
    'query_traces',
    'read_agent',
    'read_journal',
    'compile_abl',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'integration-methodologist': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'project_config',
    'tools_ops',
    'mcp_server_ops',
    'external_agent_ops',
    'variable_ops',
    'auth_ops',
    'collect_secret',
    'integration_ops',
    'connection_ops',
    'platform_context',
    'manage_memory',
    'search_docs',
    'deployment_ops',
    'collect_file',
    ...KB_TOOL_NAMES,
  ],
};

// ─── Private helpers used only within build-tools ──────────────────────

/** Allowed agent-name shape: identifier-style. Matches ABL DSL parser expectations. */
const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extract the AGENT: name from ABL YAML code.
 * Returns null if no AGENT: declaration found.
 */
function extractAgentNameFromABL(code: string): string | null {
  const match = code.match(/^\s*AGENT\s*:\s*(\S+)/m);
  return match ? match[1] : null;
}

/** Escape all regex metacharacters so `str` matches literally inside a `RegExp`. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape `$` so the string is literal inside `String.prototype.replace` replacement. */
function escapeReplacement(str: string): string {
  return str.replace(/\$/g, '$$$$');
}

function inferBootstrapRequestedTypeFromDsl(
  dslContent: string,
): 'http' | 'mcp' | 'sandbox' | 'workflow' | 'searchai' | 'unknown' {
  if (/\btype:\s*http\b/i.test(dslContent) || /\bendpoint\s*:/i.test(dslContent)) return 'http';
  if (/\btype:\s*mcp\b/i.test(dslContent) || /\bserver\s*:/i.test(dslContent)) return 'mcp';
  if (/\btype:\s*(sandbox|lambda)\b/i.test(dslContent) || /\bruntime\s*:/i.test(dslContent))
    return 'sandbox';
  if (/\btype:\s*workflow\b/i.test(dslContent) || /\bworkflow_id\s*:/i.test(dslContent))
    return 'workflow';
  if (/\btype:\s*searchai\b/i.test(dslContent) || /\bindex_id\s*:/i.test(dslContent))
    return 'searchai';
  return 'unknown';
}

/** Build the handoff-rename regex with proper escaping of the literal agent name. */
function buildHandoffRenamePattern(agentName: string): RegExp {
  return new RegExp(`(\\bTO\\s*:\\s*)${escapeRegex(agentName)}\\b`, 'gm');
}

/**
 * Cascade an agent rename through all other agents' HANDOFF references.
 * Updates `TO: OldName` → `TO: NewName` in all sibling agent files.
 * Returns the list of agents that were updated.
 */
function cascadeHandoffRename(
  files: Record<string, { path: string; content: string }>,
  oldName: string,
  newName: string,
): string[] {
  const updated: string[] = [];
  const pattern = buildHandoffRenamePattern(oldName);
  const safeNewName = escapeReplacement(newName);

  for (const [key, file] of Object.entries(files)) {
    if (key === oldName || key === newName) continue;
    if (pattern.test(file.content)) {
      file.content = file.content.replace(pattern, `$1${safeNewName}`);
      updated.push(key);
    }
    // Reset lastIndex since we used the same regex with `g` flag
    pattern.lastIndex = 0;
  }
  return updated;
}

// ─── BUILD phase tool builder ──────────────────────────────────────────

/** Build tools for BUILD phase */
export function buildBuildTools(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  jEmit?: (event: ArchSSEEvent) => void,
  buildSubPhaseParam?: string,
  options?: { includeCollectFile?: boolean },
) {
  const includeCollectFile = options?.includeCollectFile ?? true;

  return {
    ask_user: tool({
      description: 'Ask the user a clarifying question.',
      inputSchema: askUserSchema,
    }),
    ...(includeCollectFile
      ? {
          collect_file: tool({
            description: 'Request file upload.',
            inputSchema: collectFileSchema,
          }),
        }
      : {}),
    generate_agent: tool({
      description:
        'Generate a complete ABL YAML agent definition. Call with agentName and full YAML code.',
      inputSchema: z.object({
        agentName: z.string().describe('Name of the agent'),
        code: z.string().describe('Complete ABL YAML code'),
      }),
      execute: async (input) => {
        // Validate agent name to prevent NoSQL field-path injection in $set keys
        if (!AGENT_NAME_PATTERN.test(input.agentName)) {
          return `Error: invalid agent name "${input.agentName}". Must match [A-Za-z_][A-Za-z0-9_]*.`;
        }
        // Store in session's virtual filesystem
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (!db) return 'Error: database not connected';
        const filePath = `agents/${input.agentName}.abl.yaml`;

        // First ensure metadata.files exists as an object (may be null)
        await db.collection('arch_sessions').updateOne(
          {
            _id: sessionId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            'metadata.files': null,
          } as Record<string, unknown>,
          { $set: { 'metadata.files': {} } },
        );

        // Then set the specific agent file
        await db
          .collection('arch_sessions')
          .updateOne(
            { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
              string,
              unknown
            >,
            {
              $set: {
                [`metadata.files.${input.agentName}`]: { path: filePath, content: input.code },
                [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'generated',
              },
            },
          );
        const genSummary = `Agent ${input.agentName} generated: ${input.code.split('\n').length} lines written to ${filePath}`;
        await journalAppendAndEmit(
          journalService,
          ctx,
          {
            sessionId,
            type: 'mutation',
            content: {
              type: 'mutation',
              what: `Generated agent: ${input.agentName}`,
              to: `${input.code.split('\n').length} lines → ${filePath}`,
              reason: 'Agent code generated from blueprint',
              specialist: 'abl-construct-expert',
              requestedBy: 'specialist' as const,
            },
            specialist: 'abl-construct-expert',
            phase: 'BUILD',
          },
          jEmit,
        );

        // Spec document parallel write for generate_agent (non-blocking)
        try {
          const specDocForGen = await specDocumentService.getBySession(ctx, sessionId);
          if (specDocForGen) {
            await specDocumentService.upsertAgentSummary(
              ctx,
              String(specDocForGen._id),
              input.agentName,
              { compileStatus: 'generated' },
            );
          }
        } catch {
          /* non-blocking */
        }

        return genSummary;
      },
    }),
    compile_abl: tool({
      description:
        'Validate ABL YAML code against the real ABL compiler. Call after generate_agent. Returns errors if syntax is invalid.',
      inputSchema: z.object({
        code: z.string().describe('ABL YAML code to validate'),
        agentName: z.string().describe('Agent name for error context'),
      }),
      execute: async (input) => {
        try {
          const compilePreview = await runIsolatedSingleAgentCompile(
            {
              code: input.code,
              compileOptions: {
                mode: 'preview',
                skipCrossAgentValidation: true,
              },
              diagnostics: {
                depth: 'deep',
                agentName: input.agentName,
                maxFindings: 20,
              },
            },
            { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
          );

          const errors = compilePreview.parseErrors.map(
            (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
          );
          const warnings = compilePreview.parseWarnings.map(
            (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
          );

          if (errors.length > 0) {
            // Update buildProgress — compilation failed
            {
              const mongooseBp = (await import('mongoose')).default;
              const dbBp = mongooseBp.connection.db;
              if (dbBp && AGENT_NAME_PATTERN.test(input.agentName)) {
                await dbBp
                  .collection('arch_sessions')
                  .updateOne(
                    { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                      string,
                      unknown
                    >,
                    {
                      $set: {
                        [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'error',
                      },
                    },
                  );
              }
            }

            // Spec document parallel write for compile_abl parse error (non-blocking)
            try {
              const specDocParseErr = await specDocumentService.getBySession(ctx, sessionId);
              if (specDocParseErr) {
                await specDocumentService.upsertAgentSummary(
                  ctx,
                  String(specDocParseErr._id),
                  input.agentName,
                  { compileStatus: 'error' },
                );
              }
            } catch {
              /* non-blocking */
            }

            return {
              status: 'fail',
              errors,
              warnings,
              failureCode: 'parse_error',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: `${renderKnownConstructsHint()} Check your syntax.`,
            };
          }

          // Additional check: ensure the document was parsed successfully
          if (!compilePreview.documentFound) {
            return {
              status: 'fail',
              errors: [
                'No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE construct keywords.',
              ],
              warnings,
              failureCode: 'missing_document',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: 'Use AGENT: AgentName (not agent: name: AgentName)',
            };
          }

          const CROSS_AGENT_PATTERNS = [
            /routing\.default_agent references .* which is not a known agent/,
            /not a known agent\. Available agents/,
          ];
          const compileErrors = compilePreview.compileErrors
            .filter((entry) => {
              if (entry.severity !== 'error' && entry.severity !== undefined) return false;
              return !CROSS_AGENT_PATTERNS.some((pattern) => pattern.test(entry.message));
            })
            .map((entry) => `Line ${entry.line ?? '?'}: ${entry.message}`);
          const compileWarnings = compilePreview.compileWarnings.map(
            (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
          );
          const compileSoftWarnings = compilePreview.compileErrors
            .filter((entry) => entry.severity !== undefined && entry.severity !== 'error')
            .map((entry) => `Line ${entry.line ?? '?'}: ${entry.message}`);
          const compilerWarnings = [...warnings, ...compileWarnings, ...compileSoftWarnings];

          if (compileErrors.length > 0) {
            // Update buildProgress — compilation failed
            {
              const mongooseBp = (await import('mongoose')).default;
              const dbBp = mongooseBp.connection.db;
              if (dbBp && AGENT_NAME_PATTERN.test(input.agentName)) {
                await dbBp
                  .collection('arch_sessions')
                  .updateOne(
                    { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                      string,
                      unknown
                    >,
                    {
                      $set: {
                        [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'error',
                      },
                    },
                  );
              }
            }

            try {
              const specDocCompileErr = await specDocumentService.getBySession(ctx, sessionId);
              if (specDocCompileErr) {
                await specDocumentService.upsertAgentSummary(
                  ctx,
                  String(specDocCompileErr._id),
                  input.agentName,
                  { compileStatus: 'error' },
                );
              }
            } catch {
              /* non-blocking */
            }

            return {
              status: 'fail',
              errors: compileErrors,
              warnings: compilerWarnings,
              failureCode: 'compile_error',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: 'ABL compilation failed. Check HANDOFF targets, TOOLS signatures, FLOW steps, and construct syntax.',
            };
          }

          // Quality floor checks — returned to LLM for self-correction
          const qualityWarnings: string[] = [];
          const isSupervisorAgent = /^\s*SUPERVISOR\s*:/m.test(input.code);

          if (!/GUARDRAILS:/m.test(input.code)) {
            qualityWarnings.push(renderMissingGuardrailsWarning());
          }
          if (!/MEMORY:/m.test(input.code)) {
            qualityWarnings.push(renderMissingMemoryWarning());
          }
          if (isSupervisorAgent && !/WHEN:\s*["']true["']/m.test(input.code)) {
            qualityWarnings.push(renderSupervisorCatchAllHandoffWarning());
          }

          // Run full diagnostic engine on compiled IR — all findings fed to LLM
          const diagnosticWarnings: string[] = [];
          if (compilePreview.diagnostics) {
            const actionable = compilePreview.diagnostics.topIssues.filter(
              (finding) => finding.severity === 'error' || finding.severity === 'warning',
            );
            for (const finding of actionable) {
              const fixHint = finding.fix ? ` Fix: ${finding.fix.description}` : '';
              diagnosticWarnings.push(`[${finding.code}] ${finding.message}${fixHint}`);
            }

            // Emit diagnostic findings as SSE event so the user sees them
            if (jEmit && compilePreview.diagnostics.summary.total > 0) {
              jEmit({
                type: 'build_agent_diagnostics',
                agent: input.agentName,
                overallSeverity: compilePreview.diagnostics.overallSeverity,
                summary: compilePreview.diagnostics.summary,
                findings: compilePreview.diagnostics.topIssues.slice(0, 10).map((finding) => ({
                  code: finding.code,
                  message: finding.message,
                  severity: finding.severity,
                  category: finding.category,
                  ...(finding.fix && {
                    fix: { description: finding.fix.description, effort: finding.fix.effort },
                  }),
                })),
                architecturePattern: compilePreview.diagnostics.architecturePattern,
                antiPatterns: compilePreview.diagnostics.antiPatterns.map((antiPattern) => ({
                  name: antiPattern.name,
                  description: antiPattern.description,
                  agents: antiPattern.agents,
                  severity: antiPattern.severity,
                })),
              });
            }

            log.info('Diagnostic engine completed for compile_abl', {
              agentName: input.agentName,
              overallSeverity: compilePreview.diagnostics.overallSeverity,
              findingCount: compilePreview.diagnostics.summary.total,
              errorCount: compilePreview.diagnostics.summary.errors,
              warningCount: compilePreview.diagnostics.summary.warnings,
              actionableCount: actionable.length,
              architecturePattern: compilePreview.diagnostics.architecturePattern,
              antiPatternCount: compilePreview.diagnostics.antiPatterns.length,
              phaseDurationsMs: compilePreview.phaseDurationsMs,
            });
          }

          const allWarnings = [...qualityWarnings, ...diagnosticWarnings];

          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'validation',
              content: {
                type: 'validation',
                target: input.agentName,
                result: 'pass' as const,
                warnings: [...compilerWarnings, ...allWarnings],
                triggeredBy: 'abl-construct-expert',
              },
              specialist: 'abl-construct-expert',
              phase: 'BUILD',
            },
            jEmit,
          );

          // Update buildProgress — compilation passed
          {
            const mongooseBp = (await import('mongoose')).default;
            const dbBp = mongooseBp.connection.db;
            if (dbBp && AGENT_NAME_PATTERN.test(input.agentName)) {
              const compileStatus = allWarnings.length > 0 ? 'warning' : 'compiled';
              await dbBp
                .collection('arch_sessions')
                .updateOne(
                  { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                    string,
                    unknown
                  >,
                  {
                    $set: {
                      [`metadata.buildProgress.agentStatuses.${input.agentName}`]: compileStatus,
                    },
                  },
                );
            }
          }

          // Spec document parallel write for compile_abl pass (non-blocking)
          try {
            const specDocForCompile = await specDocumentService.getBySession(ctx, sessionId);
            if (specDocForCompile) {
              const compileSpecStatus = allWarnings.length > 0 ? 'warning' : 'compiled';
              await specDocumentService.upsertAgentSummary(
                ctx,
                String(specDocForCompile._id),
                input.agentName,
                { compileStatus: compileSpecStatus },
              );
            }
          } catch {
            /* non-blocking */
          }

          return {
            status: 'pass',
            errors: [],
            warnings: compilerWarnings,
            qualityWarnings: allWarnings,
            phaseDurationsMs: compilePreview.phaseDurationsMs,
            ...(allWarnings.length > 0 && {
              hint: `Quality: ${allWarnings.length} issue(s) found. Fix these and recompile.`,
            }),
          };
        } catch (err: unknown) {
          const message =
            err instanceof CompileWorkerTimeoutError
              ? `ABL validation timed out during ${err.phase} after ${err.timeoutMs}ms.`
              : err instanceof Error
                ? err.message
                : String(err);
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'validation',
              content: {
                type: 'validation',
                target: input.agentName,
                result: 'fail' as const,
                errors: [message],
                triggeredBy: 'abl-construct-expert',
              },
              specialist: 'abl-construct-expert',
              phase: 'BUILD',
            },
            jEmit,
          );

          // Spec document parallel write for compile_abl fail (non-blocking)
          try {
            const specDocForFail = await specDocumentService.getBySession(ctx, sessionId);
            if (specDocForFail) {
              await specDocumentService.upsertAgentSummary(
                ctx,
                String(specDocForFail._id),
                input.agentName,
                { compileStatus: 'error' },
              );
            }
          } catch {
            /* non-blocking */
          }

          return {
            status: 'fail',
            errors: [message],
            warnings: [],
            ...(err instanceof CompileWorkerTimeoutError
              ? {
                  failureCode: 'timeout',
                  timedOutPhase: err.phase,
                  hint: 'Compilation infrastructure timed out before validation completed. Retry the build; if it repeats, inspect compiler and diagnostic worker spans.',
                }
              : {}),
          };
        }
      },
    }),
    propose_modification: tool({
      description:
        'Propose and apply a change to an existing agent definition. Provide the full updated ABL YAML code.',
      inputSchema: z.object({
        agentName: z.string().describe('Name of the agent to modify'),
        change: z.string().describe('Description of the change'),
        updatedCode: z.string().describe('The full updated ABL YAML code for the agent'),
      }),
      execute: async (input) => {
        // Validate agent name to prevent NoSQL field-path injection in $set keys
        if (!AGENT_NAME_PATTERN.test(input.agentName)) {
          return `Error: invalid agent name "${input.agentName}". Must match [A-Za-z_][A-Za-z0-9_]*.`;
        }
        // Verify agent file exists
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (!db) return 'Error: database not connected';

        const session = await db.collection('arch_sessions').findOne({
          _id: sessionId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        } as Record<string, unknown>);
        const files = (session?.metadata?.files ?? {}) as Record<string, unknown>;
        if (!files[input.agentName]) {
          return `Error: agent '${input.agentName}' not found in generated files. Available: ${Object.keys(files).join(', ')}`;
        }

        // Detect rename: compare AGENT: name in updated code to the file key
        const newAgentName = extractAgentNameFromABL(input.updatedCode);
        const isRename = newAgentName && newAgentName !== input.agentName;
        const effectiveName = isRename ? newAgentName : input.agentName;
        const filePath = `agents/${effectiveName}.abl.yaml`;

        // Build the $set and $unset operations
        const $set: Record<string, unknown> = {
          [`metadata.files.${effectiveName}`]: {
            path: filePath,
            content: input.updatedCode,
          },
        };
        const $unset: Record<string, unknown> = {};

        // If renamed, remove old key and cascade HANDOFF references
        const cascadedAgents: string[] = [];
        if (isRename) {
          $unset[`metadata.files.${input.agentName}`] = '';

          // Cascade TO: references in sibling agent files
          const allFiles = { ...files } as Record<string, { path: string; content: string }>;
          const updated = cascadeHandoffRename(allFiles, input.agentName, newAgentName);
          for (const siblingName of updated) {
            $set[`metadata.files.${siblingName}`] = allFiles[siblingName];
            cascadedAgents.push(siblingName);
          }

          // Update topology agent name if present
          const topology = session?.metadata?.topology as
            | { agents?: Array<{ name: string }>; edges?: Array<{ from: string; to: string }> }
            | undefined;
          if (topology?.agents) {
            const updatedAgents = topology.agents.map((a) =>
              a.name === input.agentName ? { ...a, name: newAgentName } : a,
            );
            $set['metadata.topology.agents'] = updatedAgents;
          }
          if (topology?.edges) {
            const updatedEdges = topology.edges.map((e) => ({
              from: e.from === input.agentName ? newAgentName : e.from,
              to: e.to === input.agentName ? newAgentName : e.to,
            }));
            $set['metadata.topology.edges'] = updatedEdges;
          }
        }

        const updateOp: Record<string, unknown> = { $set };
        if (Object.keys($unset).length > 0) updateOp.$unset = $unset;

        await db
          .collection('arch_sessions')
          .updateOne(
            { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
              string,
              unknown
            >,
            updateOp,
          );

        const renamePart = isRename ? ` (renamed from ${input.agentName})` : '';
        const cascadePart =
          cascadedAgents.length > 0
            ? ` Updated HANDOFF references in: ${cascadedAgents.join(', ')}.`
            : '';
        const modSummary = `Agent ${effectiveName} modified${renamePart}: ${input.change}. File updated at ${filePath}.${cascadePart}`;
        await journalAppendAndEmit(
          journalService,
          ctx,
          {
            sessionId,
            type: 'mutation',
            content: {
              type: 'mutation',
              what: isRename
                ? `Renamed ${input.agentName} → ${effectiveName}`
                : `Modified ${input.agentName}`,
              to: truncate(input.change, 120),
              reason: input.change,
              specialist: 'abl-construct-expert',
              requestedBy: 'user' as const,
            },
            specialist: 'abl-construct-expert',
            phase: 'BUILD',
          },
          jEmit,
        );
        return modSummary;
      },
    }),
    proceed_to_next_phase: tool({
      description:
        'Advance from BUILD to CREATE phase when the user confirms they are ready to create ' +
        'the project (e.g., "create my project", "looks good, create it"). Only call this ' +
        'after ALL topology agents have been generated and compiled. Do NOT call if the user ' +
        'is requesting changes — handle those first.',
      inputSchema: z.object({
        reason: z.string().describe('Brief explanation of why the user is ready to proceed'),
      }),
      execute: async () => {
        const { executePhaseTransition } = await import('@/lib/arch-ai/phase-transition');

        // Re-read session to get latest build state
        const freshSession = await sessionService.getById(ctx, sessionId);
        if (!freshSession) {
          return { error: 'Session not found' };
        }

        const meta = freshSession.metadata as unknown as Record<string, unknown>;
        const topology = meta.topology as { agents?: Array<{ name: string }> } | undefined;
        const files = (meta.files ?? {}) as Record<string, unknown>;
        const topologyAgents = topology?.agents ?? [];
        const generatedNames = new Set(Object.keys(files));
        const missingAgents = topologyAgents
          .map((a) => a.name)
          .filter((n) => !generatedNames.has(n));

        if (missingAgents.length > 0) {
          return {
            error: `Cannot proceed — ${missingAgents.length} agent(s) not yet generated: ${missingAgents.join(', ')}. Generate them first.`,
          };
        }

        // Ensure buildProgress reflects actual state so exit criteria pass.
        // generate_agent/compile_abl update buildProgress individually, but
        // this is the safety net if any update was missed.
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (db && topologyAgents.length > 0) {
          const agentStatuses: Record<string, string> = {};
          for (const agent of topologyAgents) {
            agentStatuses[agent.name] = 'compiled';
          }
          await db
            .collection('arch_sessions')
            .updateOne(
              { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                string,
                unknown
              >,
              {
                $set: {
                  'metadata.buildProgress.stage': 'complete',
                  'metadata.buildProgress.agentStatuses': agentStatuses,
                },
              },
            );
        }

        // Re-read after buildProgress update
        const readySession = (await sessionService.getById(ctx, sessionId)) ?? freshSession;

        const emitFn = jEmit ?? (() => {});
        const journalFn = async (summary: string, rationale: string, spec: string, ph: string) => {
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'decision',
              content: {
                type: 'decision',
                summary,
                rationale,
                specialist: spec,
                source: 'specialist_recommendation' as const,
              },
              specialist: spec,
              phase: ph,
            },
            jEmit,
          );
        };

        return executePhaseTransition(ctx, readySession, sessionService, emitFn, journalFn);
      },
    }),

    // ─── save_tool_dsl — only available in BUILD:TOOLS sub-phase ──────
    ...(buildSubPhaseParam === 'TOOLS'
      ? {
          save_tool_dsl: tool({
            description:
              'Save a generated tool DSL configuration. Call this after producing the DSL ' +
              'for a tool. The DSL should be a complete tool definition with signature, ' +
              'description, type, and binding. toolName must be lowercase snake_case (e.g. check_order).',
            inputSchema: z.object({
              toolName: z
                .string()
                .min(1)
                .describe('Tool name — lowercase snake_case (e.g. check_order)'),
              dslContent: z.string().min(1).describe('Complete tool DSL content'),
            }),
            execute: async (input) => {
              // Validate tool name: lowercase snake_case, 2+ chars (matches runtime tool-name regex)
              const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
              if (!TOOL_NAME_PATTERN.test(input.toolName)) {
                return `Error: invalid tool name "${input.toolName}". Must be lowercase snake_case (e.g. check_order), 2-64 chars, matching [a-z][a-z0-9_]*[a-z0-9].`;
              }

              // Validate DSL has a parseable signature line
              const firstLine = input.dslContent.split('\n')[0]?.trim() ?? '';
              const sigMatch = firstLine.match(/^(\w+)\(([^)]*)\)\s*->\s*(.+)$/);
              if (!sigMatch) {
                return `Error: DSL must start with a signature line like "tool_name(param: type) -> return_type". Got: "${firstLine.slice(0, 80)}"`;
              }

              // Validate signature name matches toolName
              const sigName = sigMatch[1];
              if (sigName !== input.toolName) {
                return `Error: signature name "${sigName}" does not match toolName "${input.toolName}". They must be identical.`;
              }

              const mongoose = (await import('mongoose')).default;
              const db = mongoose.connection.db;
              if (!db) return 'Error: database not connected';
              const requestedType = inferBootstrapRequestedTypeFromDsl(input.dslContent);
              const supportedInOnboarding = requestedType === 'http';

              await db.collection('arch_sessions').updateOne(
                {
                  _id: sessionId,
                  tenantId: ctx.tenantId,
                  userId: ctx.userId,
                } as Record<string, unknown>,
                {
                  $set: {
                    [`metadata.toolDsls.${input.toolName}`]: input.dslContent,
                    [`metadata.toolBootstrapStatus.${input.toolName}`]: {
                      requestedType,
                      supportedInOnboarding,
                      status: supportedInOnboarding ? 'ready' : 'unsupported',
                    },
                  },
                },
              );

              return supportedInOnboarding
                ? `Tool DSL saved: ${input.toolName} (${input.dslContent.split('\n').length} lines)`
                : `Tool DSL saved: ${input.toolName} (${input.toolName} is marked unsupported for onboarding because it is ${requestedType}, not HTTP)`;
            },
          }),
        }
      : {}),
  };
}
