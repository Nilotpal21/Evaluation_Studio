/**
 * Build Worker Tools — minimal tool set for parallel BUILD workers.
 *
 * Only `generate_agent` + `compile_abl`. No `ask_user`, no `proceed_to_next_phase`.
 * Workers write directly to MongoDB (metadata.files.<agentName> and
 * metadata.buildProgress.agentStatuses.<agentName>) but do NOT emit journal entries.
 */

import { z } from 'zod';
import { tool } from 'ai';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { processGeneratedABL, type ABLAgentContext } from '@agent-platform/arch-ai';
import {
  renderConstructCompileHint,
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import {
  renderGuardrailCompileHint,
  renderMissingGuardrailsWarning,
} from '@agent-platform/arch-ai/guardrails';
import { ARCH_AI_TIMEOUTS } from './constants';
import {
  CompileWorkerTimeoutError,
  runIsolatedSingleAgentCompile,
} from './helpers/isolated-build-compiler';

const log = createLogger('arch-ai:build-worker-tools');

/** Agent name validation — prevents NoSQL field-path injection in $set keys */
const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BuildWorkerToolContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  buildRunId?: string;
  workerAttempt?: number;
  /** Agent context for the ABL generation pipeline (pre/post processing) */
  agentPipelineContext?: ABLAgentContext;
  /** Managed behavior profile documents needed to compile generated references. */
  managedBehaviorProfileDocuments?: string[];
  /** Entry agent name from topology (for QG-05 validation) */
  entryAgentName?: string;
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length;
}

function createToolLogger(ctx: BuildWorkerToolContext, agentName: string) {
  return log.child({
    sessionId: ctx.sessionId,
    buildRunId: ctx.buildRunId,
    workerAttempt: ctx.workerAttempt,
    agentName,
  });
}

/** Reusable helper — updates a single agent's build status in MongoDB. */
async function updateAgentStatus(
  ctx: BuildWorkerToolContext,
  agentName: string,
  status: string,
): Promise<void> {
  if (!AGENT_NAME_PATTERN.test(agentName)) return;
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) return;
    await db.collection('arch_sessions').updateOne(
      {
        _id: ctx.sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      } as Record<string, unknown>,
      {
        $set: {
          [`metadata.buildProgress.agentStatuses.${agentName}`]: status,
        },
      },
    );
  } catch (dbErr: unknown) {
    log.warn('Failed to update agent status', {
      sessionId: ctx.sessionId,
      agentName,
      status,
      error: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
  }
}

/**
 * Creates the tool set for a single parallel BUILD worker.
 * Each worker gets its own tool instances scoped to a specific session/context.
 */
export function createBuildWorkerTools(ctx: BuildWorkerToolContext) {
  return {
    generate_agent: tool({
      description:
        'Generate a complete ABL YAML agent definition. Call with agentName and full YAML code.',
      inputSchema: z.object({
        agentName: z.string().describe('Name of the agent'),
        code: z.string().describe('Complete ABL YAML code'),
      }),
      execute: async (input) => {
        if (!AGENT_NAME_PATTERN.test(input.agentName)) {
          return `Error: invalid agent name "${input.agentName}". Must match [A-Za-z_][A-Za-z0-9_]*.`;
        }

        const toolLog = createToolLogger(ctx, input.agentName);
        toolLog.info('Parallel build generate_agent invoked', {
          codeChars: input.code.length,
          codeLines: countLines(input.code),
        });

        try {
          const mongoose = (await import('mongoose')).default;
          const db = mongoose.connection.db;
          if (!db) {
            toolLog.error('Parallel build generate_agent missing database connection');
            return 'Error: database not connected';
          }

          const filePath = `agents/${input.agentName}.abl.yaml`;

          // --- ABL Generation Pipeline: validate + autofix before persisting ---
          let finalCode = input.code;
          if (ctx.agentPipelineContext) {
            const pipelineResult = processGeneratedABL(input.code, ctx.agentPipelineContext);
            finalCode = pipelineResult.yaml;

            if (pipelineResult.autoFixed.length > 0) {
              toolLog.info('ABL pipeline auto-fixed before persist', {
                fixes: pipelineResult.autoFixed,
                skipped: pipelineResult.skipped,
              });
            }
          }

          // Fix 2: Each worker ONLY writes to its own per-agent field path.
          // Previously, a blanket `$set: { 'metadata.files': {} }` could race
          // with concurrent workers and overwrite their already-written files.
          // Using per-agent dot-notation paths avoids this entirely — MongoDB
          // creates the parent `metadata.files` object implicitly if needed.
          await db
            .collection('arch_sessions')
            .updateOne(
              { _id: ctx.sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                string,
                unknown
              >,
              {
                $set: {
                  [`metadata.files.${input.agentName}`]: { path: filePath, content: finalCode },
                  [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'generated',
                },
              },
            );

          toolLog.info('Parallel build generate_agent persisted', {
            filePath,
            codeChars: finalCode.length,
            codeLines: countLines(finalCode),
          });

          return `Agent ${input.agentName} generated: ${finalCode.split('\n').length} lines written to ${filePath}`;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.warn('Parallel build generate_agent failed', {
            error: message,
          });
          return `Error: ${message}`;
        }
      },
    }),

    compile_abl: tool({
      description:
        'Parse and compile ABL YAML code against the real ABL compiler (parse + compileABLtoIR). Call after generate_agent. Returns errors if syntax or structure is invalid.',
      inputSchema: z.object({
        code: z.string().describe('ABL YAML code to validate'),
        agentName: z.string().describe('Agent name for error context'),
      }),
      execute: async (input) => {
        const toolLog = createToolLogger(ctx, input.agentName);
        toolLog.info('Parallel build compile_abl invoked', {
          codeChars: input.code.length,
          codeLines: countLines(input.code),
          timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS,
        });

        try {
          const compilePreview = await runIsolatedSingleAgentCompile(
            {
              code: input.code,
              additionalDocuments: ctx.managedBehaviorProfileDocuments,
              compileOptions: {
                mode: 'preview',
                skipCrossAgentValidation: true,
              },
              diagnostics: {
                depth: 'deep',
                agentName: input.agentName,
                maxFindings: 20,
                entryAgent: ctx.entryAgentName,
              },
            },
            { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
          );

          const parseErrors = compilePreview.parseErrors.map(
            (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
          );
          const parseWarnings = compilePreview.parseWarnings.map(
            (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
          );

          if (parseErrors.length > 0) {
            toolLog.warn('Parallel build compile_abl parse failed', {
              parseErrorCount: parseErrors.length,
              parseWarningCount: parseWarnings.length,
              parseDurationMs: compilePreview.phaseDurationsMs.parse,
              totalDurationMs: compilePreview.phaseDurationsMs.total,
            });
            await updateAgentStatus(ctx, input.agentName, 'error');
            return {
              status: 'fail',
              errors: parseErrors,
              warnings: parseWarnings,
              failureCode: 'parse_error',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: `ABL Compilation Failed. Common fixes:
${renderGuardrailCompileHint()}
${renderConstructCompileHint()}
- REMEMBER syntax? Nest it under MEMORY: as remember: — never emit top-level REMEMBER:
- Flow error? Every name in FLOW: steps: MUST have a matching step definition block`,
            };
          }

          if (!compilePreview.documentFound) {
            toolLog.warn('Parallel build compile_abl missing document', {
              parseWarningCount: parseWarnings.length,
              parseDurationMs: compilePreview.phaseDurationsMs.parse,
              totalDurationMs: compilePreview.phaseDurationsMs.total,
            });
            await updateAgentStatus(ctx, input.agentName, 'error');
            return {
              status: 'fail',
              errors: [
                'No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE construct keywords.',
              ],
              warnings: parseWarnings,
              failureCode: 'missing_document',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: 'Use AGENT: AgentName (not agent: name: AgentName)',
            };
          }

          // Filter cross-agent routing errors — preflight validation runs unconditionally
          // even with skipCrossAgentValidation. These are false positives in single-agent compilation.
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
          // Compilation errors with severity !== 'error' are warnings
          const compileSoftWarnings = compilePreview.compileErrors
            .filter((entry) => entry.severity !== undefined && entry.severity !== 'error')
            .map((entry) => `Line ${entry.line ?? '?'}: ${entry.message}`);

          const allWarnings = [...parseWarnings, ...compileWarnings, ...compileSoftWarnings];

          if (compileErrors.length > 0) {
            toolLog.warn('Parallel build compile_abl failed', {
              compileErrorCount: compileErrors.length,
              parseWarningCount: parseWarnings.length,
              compileWarningCount: compileWarnings.length + compileSoftWarnings.length,
              compileDurationMs: compilePreview.phaseDurationsMs.compile,
              totalDurationMs: compilePreview.phaseDurationsMs.total,
            });
            toolLog.warn('Parallel build compile_abl failed with errors', {
              failureCode: 'compile_error',
              errors: compileErrors.slice(0, 5),
              warnings: allWarnings.slice(0, 5),
              codeLines: countLines(input.code),
            });
            await updateAgentStatus(ctx, input.agentName, 'error');
            return {
              status: 'fail',
              errors: compileErrors,
              warnings: allWarnings,
              failureCode: 'compile_error',
              phaseDurationsMs: compilePreview.phaseDurationsMs,
              hint: `ABL Compilation Failed. Common fixes:
${renderGuardrailCompileHint()}
${renderConstructCompileHint()}
- REMEMBER syntax? Nest it under MEMORY: as remember: — never emit top-level REMEMBER:
- Flow error? Every name in FLOW: steps: MUST have a matching step definition block`,
            };
          }

          // ----- Phase 3: Quality floor checks -----
          const qualityWarnings: string[] = [];
          const isSupervisorAgent = /^\s*SUPERVISOR\s*:/m.test(input.code);

          if (!/GUARDRAILS:/m.test(input.code)) {
            qualityWarnings.push(renderMissingGuardrailsWarning());
          }
          if (!/MEMORY:/m.test(input.code)) {
            qualityWarnings.push(renderMissingMemoryWarning());
          }
          if (isSupervisorAgent && !/WHEN:\s*(?:true|["']true["'])/m.test(input.code)) {
            qualityWarnings.push(renderSupervisorCatchAllHandoffWarning());
          }

          const diagnosticWarnings: string[] = [];
          let diagnosticSummary:
            | {
                overallSeverity: string;
                errors: number;
                warnings: number;
                infos: number;
                total: number;
                errorCodes: string[];
                warningCodes: string[];
                topFindings: Array<{
                  code: string;
                  message: string;
                  severity: string;
                  category: string;
                  fix?: { description: string; effort: string };
                }>;
                architecturePattern?: string;
                antiPatterns?: Array<{
                  name: string;
                  description: string;
                  agents: string[];
                  severity: string;
                }>;
              }
            | undefined;
          if (compilePreview.diagnostics) {
            const actionable = compilePreview.diagnostics.topIssues.filter(
              (finding) => finding.severity === 'error' || finding.severity === 'warning',
            );
            for (const finding of actionable) {
              const fixHint = finding.fix ? ` Fix: ${finding.fix.description}` : '';
              diagnosticWarnings.push(`[${finding.code}] ${finding.message}${fixHint}`);
            }

            diagnosticSummary = {
              overallSeverity: compilePreview.diagnostics.overallSeverity,
              errors: compilePreview.diagnostics.summary.errors,
              warnings: compilePreview.diagnostics.summary.warnings,
              infos: compilePreview.diagnostics.summary.infos,
              total: compilePreview.diagnostics.summary.total,
              errorCodes: compilePreview.diagnostics.errorCodes,
              warningCodes: compilePreview.diagnostics.warningCodes,
              topFindings: compilePreview.diagnostics.topIssues.slice(0, 10).map((finding) => ({
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
            };

            toolLog.info('Parallel build compile_abl diagnostics completed', {
              overallSeverity: compilePreview.diagnostics.overallSeverity,
              findingCount: compilePreview.diagnostics.summary.total,
              errorCount: compilePreview.diagnostics.summary.errors,
              warningCount: compilePreview.diagnostics.summary.warnings,
              actionableCount: actionable.length,
              architecturePattern: compilePreview.diagnostics.architecturePattern,
              antiPatternCount: compilePreview.diagnostics.antiPatterns.length,
              diagnosticsDurationMs: compilePreview.phaseDurationsMs.diagnostics,
            });
          }

          // ----- Status resolution -----
          // 'validated' = single-agent parse+compile pass (cross-agent validation pending)
          // 'warning'   = pass with quality issues the LLM should fix
          const allQualityIssues = [...qualityWarnings, ...diagnosticWarnings];
          const finalStatus = allQualityIssues.length > 0 ? 'warning' : 'validated';
          await updateAgentStatus(ctx, input.agentName, finalStatus);

          toolLog.info('Parallel build compile_abl completed', {
            finalStatus,
            parseWarningCount: parseWarnings.length,
            compileWarningCount: compileWarnings.length + compileSoftWarnings.length,
            qualityWarningCount: qualityWarnings.length,
            diagnosticWarningCount: diagnosticWarnings.length,
            phaseDurationsMs: compilePreview.phaseDurationsMs,
          });

          return {
            status: 'pass',
            errors: [],
            warnings: allWarnings,
            qualityWarnings: allQualityIssues,
            phaseDurationsMs: compilePreview.phaseDurationsMs,
            ...(diagnosticSummary && { diagnostics: diagnosticSummary }),
            ...(allQualityIssues.length > 0 && {
              hint: `Quality: ${allQualityIssues.length} issue(s) found. Fix these and recompile.`,
            }),
          };
        } catch (err: unknown) {
          const message =
            err instanceof CompileWorkerTimeoutError
              ? `ABL validation timed out during ${err.phase} after ${err.timeoutMs}ms.`
              : err instanceof Error
                ? err.message
                : String(err);
          toolLog.warn('Parallel build compile_abl threw', {
            error: message,
            ...(err instanceof CompileWorkerTimeoutError
              ? { timedOutPhase: err.phase, timeoutMs: err.timeoutMs }
              : {}),
          });
          await updateAgentStatus(ctx, input.agentName, 'error');
          return {
            status: 'fail',
            errors: [message],
            warnings: [],
            ...(err instanceof CompileWorkerTimeoutError
              ? {
                  failureCode: 'timeout',
                  timedOutPhase: err.phase,
                  hint: 'Compilation infrastructure timed out before validation completed. Retry the agent build; if it repeats, inspect compiler and diagnostic worker spans.',
                }
              : {}),
          };
        }
      },
    }),
  };
}
