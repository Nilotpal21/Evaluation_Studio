import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchLLMResolution } from '../../arch-llm';
import type { CompileFixResult } from '../types';
import { ARCH_AI_TIMEOUTS } from '../constants';
import {
  CompileWorkerTimeoutError,
  runIsolatedSingleAgentCompile,
} from './isolated-build-compiler';

const log = createLogger('compile-and-fix');

/**
 * Iterative compile-fix loop for LLM-generated ABL.
 *
 * Round 0: Compile the LLM's output.
 * Round 1-N: If compilation fails, call the LLM with the errors and ask it to fix.
 * Final: If all rounds fail, return the last errors for the caller to handle.
 *
 * This is an INTERNAL helper called by generateSingleAgent().
 * It does NOT replace compile_abl (the specialist-visible tool for Monaco edits).
 */
export async function compileAndFix(input: {
  agentName: string;
  ablContent: string;
  maxRounds: number;
  constructContext: string;
  resolution: ArchLLMResolution;
}): Promise<CompileFixResult> {
  const { agentName, maxRounds, constructContext, resolution } = input;
  let currentAbl = input.ablContent;
  let lastErrors: Array<{ line?: number; message: string; severity: string }> = [];
  let lastWarnings: Array<{ line?: number; message: string }> = [];

  for (let round = 0; round < maxRounds; round++) {
    const result = await compileAbl(currentAbl);

    if (result.valid) {
      return {
        success: true,
        rounds: round + 1,
        finalAbl: currentAbl,
        warnings: result.warnings,
        constructsUsed: extractConstructs(currentAbl),
      };
    }

    lastErrors = result.errors;
    lastWarnings = result.warnings;

    // Last round — don't try to fix, just return the failure
    if (round === maxRounds - 1) {
      break;
    }

    // Ask the LLM to fix the errors
    const fixed = await llmFix(agentName, currentAbl, result.errors, constructContext, resolution);

    if (fixed) {
      currentAbl = fixed;
    } else {
      // LLM fix failed — stop trying
      break;
    }
  }

  return {
    success: false,
    rounds: maxRounds,
    finalAbl: currentAbl,
    errors: lastErrors,
    warnings: lastWarnings,
    constructsUsed: extractConstructs(currentAbl),
  };
}

/**
 * Compile-fix loop variant using ai SDK LanguageModel.
 * Used by parallel BUILD workers (which have LanguageModel, not LLMClient).
 */
export interface CompileFixProgress {
  stage: 'fixing' | 'recompiling';
  round: number;
  maxRounds: number;
  errorCount: number;
}

export interface CompileFixCompilerFeedback {
  warnings?: string[];
  hint?: string;
}

/**
 * Topology facts the LLM needs while fixing HANDOFF errors. When provided,
 * the fix-loop system prompt is augmented with strict rules that prevent the
 * "delete HANDOFFs to resolve self-reference" failure mode observed in
 * production builds (diagnostics 1228a16b and 3dd30d8e).
 */
export interface FixLoopTopologyContext {
  agentName: string;
  archetype: 'supervisor' | 'specialist' | 'pipeline_stage' | 'worker';
  isEntry: boolean;
  keyword: 'SUPERVISOR' | 'AGENT';
  outgoingTargets: Array<{
    name: string;
    edgeType: 'delegate' | 'escalate' | 'transfer';
    expectReturn: boolean;
    whenHint: string;
  }>;
  catchAllTarget?: string;
}

function renderTopologyContextBlock(ctx: FixLoopTopologyContext): string {
  const lines: string[] = [];
  lines.push('TOPOLOGY CONTEXT — read carefully, these rules are strict:');
  lines.push('');
  lines.push(
    `You are fixing agent "${ctx.agentName}" (archetype: ${ctx.archetype}${ctx.isEntry ? ', entry point' : ''}).`,
  );
  lines.push(`Required keyword: ${ctx.keyword}:  (do NOT change this).`);
  lines.push('');

  if (ctx.outgoingTargets.length > 0) {
    lines.push('This agent MUST route to the following topology targets:');
    for (const t of ctx.outgoingTargets) {
      const whenPart = t.whenHint ? ` — WHEN hint: "${t.whenHint}"` : '';
      lines.push(`  - ${t.name} (${t.edgeType}, RETURN: ${t.expectReturn})${whenPart}`);
    }
    if (ctx.catchAllTarget) {
      lines.push(
        `Catch-all target for HANDOFF WHEN: true must be: ${ctx.catchAllTarget} (NOT "${ctx.agentName}" — never route to self).`,
      );
    }
    lines.push('');
    lines.push('HANDOFF rules you MUST follow while fixing:');
    lines.push(
      `1. NEVER delete a HANDOFF rule. If a TO: field is invalid, CORRECT the TO: name using the topology list above — do not drop the rule.`,
    );
    lines.push(
      `2. NEVER set any TO: to "${ctx.agentName}". Self-reference is always an error, even in the catch-all.`,
    );
    lines.push(
      '3. Every TO: name must appear in the topology list above or be the catch-all target. Do not invent new names.',
    );
    lines.push(
      '4. Each target in the list must appear at least once in the HANDOFF block. Missing targets leave specialists unreachable.',
    );
    if (ctx.catchAllTarget) {
      lines.push(
        `5. The final HANDOFF (WHEN: true) must route to "${ctx.catchAllTarget}", NOT to "${ctx.agentName}".`,
      );
    }
  } else {
    lines.push('This agent has NO outgoing HANDOFF targets in its topology contract.');
    lines.push(
      'If you see HANDOFF errors, do NOT add or synthesize HANDOFF rules — the file should have none.',
    );
  }

  return lines.join('\n');
}

interface CompileAblOptions {
  agentName?: string;
  treatDiagnosticErrorsAsBlocking?: boolean;
}

function formatCompileErrors(
  errors: Array<{ line?: number; message: string; severity: string }>,
): string[] {
  return errors.map((error) =>
    error.line ? `Line ${error.line}: ${error.message}` : error.message,
  );
}

function formatCompileWarnings(warnings: Array<{ line?: number; message: string }>): string[] {
  return warnings.map((warning) =>
    warning.line ? `Line ${warning.line}: ${warning.message}` : warning.message,
  );
}

function dedupeMessages(messages: string[]): string[] {
  return [
    ...new Set(messages.map((message) => message.trim()).filter((message) => message.length > 0)),
  ];
}

export async function compileAndFixWithModel(input: {
  agentName: string;
  ablContent: string;
  maxRounds: number;
  constructContext: string;
  model: LanguageModel;
  compilerFeedback?: CompileFixCompilerFeedback;
  treatDiagnosticErrorsAsBlocking?: boolean;
  onProgress?: (progress: CompileFixProgress) => void;
  /**
   * Topology facts to inject into the fix-loop system prompt. When provided,
   * prevents the LLM from deleting required HANDOFF rules or setting TO: to
   * the agent's own name. See FixLoopTopologyContext.
   */
  topologyContext?: FixLoopTopologyContext;
}): Promise<CompileFixResult> {
  const {
    agentName,
    maxRounds,
    constructContext,
    model: llmModel,
    compilerFeedback,
    treatDiagnosticErrorsAsBlocking,
    onProgress,
    topologyContext,
  } = input;
  let currentAbl = input.ablContent;
  let lastErrors: Array<{ line?: number; message: string; severity: string }> = [];
  let lastWarnings: Array<{ line?: number; message: string }> = [];

  for (let round = 0; round < maxRounds; round++) {
    // Emit recompiling progress for rounds after the first (round 0 is the initial compile)
    if (round > 0) {
      onProgress?.({
        stage: 'recompiling',
        round,
        maxRounds,
        errorCount: lastErrors.length,
      });
    }

    const result = await compileAbl(currentAbl, {
      agentName: treatDiagnosticErrorsAsBlocking ? agentName : undefined,
      treatDiagnosticErrorsAsBlocking,
    });

    if (result.valid) {
      return {
        success: true,
        rounds: round + 1,
        finalAbl: currentAbl,
        warnings: result.warnings,
        constructsUsed: extractConstructs(currentAbl),
      };
    }

    lastErrors = result.errors;
    lastWarnings = result.warnings;

    // Last round — don't try to fix, just return the failure
    if (round === maxRounds - 1) break;

    // Emit fixing progress before calling LLM
    onProgress?.({
      stage: 'fixing',
      round: round + 1,
      maxRounds,
      errorCount: result.errors.length,
    });

    const errorList = formatCompileErrors(result.errors).join('\n');
    const warningList = dedupeMessages([
      ...formatCompileWarnings(result.warnings),
      ...(compilerFeedback?.warnings ?? []),
    ]);
    const promptSections = [
      `Fix this ABL agent "${agentName}":`,
      `\`\`\`\n${currentAbl}\n\`\`\``,
      `Compilation errors:\n${errorList}`,
    ];

    if (warningList.length > 0) {
      promptSections.push(`Compiler warnings:\n${warningList.join('\n')}`);
    }

    if (compilerFeedback?.hint) {
      promptSections.push(`Compiler hint:\n${compilerFeedback.hint}`);
    }

    promptSections.push('Output the fixed ABL code only:');

    const systemPromptParts = [
      `You are an expert ABL developer. Fix the compilation errors in the ABL code below.`,
      `Preserve all valid constructs and only change what the compiler feedback requires.`,
      `Prefer the compiler-aligned syntax reference below over legacy habits or guesswork.`,
      `Output ONLY the fixed ABL code, no explanations, no markdown fences.`,
    ];
    if (topologyContext) {
      systemPromptParts.push('', renderTopologyContextBlock(topologyContext));
    }
    systemPromptParts.push('', constructContext);

    try {
      const fixResponse = await generateText({
        model: llmModel,
        system: systemPromptParts.join('\n'),
        prompt: promptSections.join('\n\n'),
        maxOutputTokens: 4096,
      });

      const fixed = fixResponse.text
        ?.replace(/^```(?:yaml|abl)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();

      if (fixed && fixed.length >= 20) {
        currentAbl = fixed;
      } else {
        break;
      }
    } catch (err) {
      log.warn('LLM fix attempt failed (ai SDK)', {
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return {
    success: false,
    rounds: maxRounds,
    finalAbl: currentAbl,
    errors: lastErrors,
    warnings: lastWarnings,
    constructsUsed: extractConstructs(currentAbl),
  };
}

function formatDiagnosticMessage(finding: {
  code: string;
  message: string;
  fix?: { description: string };
}): string {
  return `[${finding.code}] ${finding.message}${
    finding.fix ? ` Fix: ${finding.fix.description}` : ''
  }`;
}

async function compileAbl(
  ablContent: string,
  options: CompileAblOptions = {},
): Promise<{
  valid: boolean;
  errors: Array<{ line?: number; message: string; severity: string }>;
  warnings: Array<{ line?: number; message: string }>;
}> {
  try {
    const compileResult = await runIsolatedSingleAgentCompile(
      {
        code: ablContent,
        compileOptions: {
          mode: 'preview',
          skipCrossAgentValidation: true,
        },
        ...(options.agentName && options.treatDiagnosticErrorsAsBlocking
          ? {
              diagnostics: {
                depth: 'deep',
                agentName: options.agentName,
                maxFindings: 20,
                skipCrossAgentPatterns: true,
              },
            }
          : {}),
      },
      { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
    );

    const parseErrors = compileResult.parseErrors.map((entry) => ({
      line: entry.line,
      message: entry.message,
      severity: 'error',
    }));

    if (parseErrors.length > 0 || !compileResult.documentFound) {
      return { valid: false, errors: parseErrors, warnings: [] };
    }

    const compileErrors = compileResult.compileErrors.map((entry) => ({
      line: entry.line,
      message: entry.message,
      severity: entry.severity ?? 'error',
    }));
    const compileWarnings = compileResult.compileWarnings.map((entry) => ({
      line: entry.line,
      message: entry.message,
    }));

    const hasErrors = compileErrors.some((e: { severity: string }) => e.severity === 'error');
    const diagnosticErrors: Array<{ line?: number; message: string; severity: string }> = [];

    if (!hasErrors && compileResult.diagnostics) {
      for (const finding of compileResult.diagnostics.topIssues) {
        if (finding.severity !== 'error') continue;
        diagnosticErrors.push({
          message: formatDiagnosticMessage(finding),
          severity: 'error',
        });
      }
    }

    return {
      valid: !hasErrors && diagnosticErrors.length === 0,
      errors: [
        ...compileErrors.filter((e: { severity: string }) => e.severity === 'error'),
        ...diagnosticErrors,
      ],
      warnings: [
        ...compileWarnings,
        ...compileErrors.filter((e: { severity: string }) => e.severity !== 'error'),
      ],
    };
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          message:
            err instanceof CompileWorkerTimeoutError
              ? `Compilation timed out during ${err.phase} after ${err.timeoutMs}ms.`
              : `Compilation crashed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
      warnings: [],
    };
  }
}

async function llmFix(
  agentName: string,
  abl: string,
  errors: Array<{ line?: number; message: string; severity: string }>,
  constructContext: string,
  resolution: ArchLLMResolution,
): Promise<string | null> {
  if (!resolution.client) return null;

  const errorList = errors
    .map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message))
    .join('\n');

  const systemPrompt = `You are an expert ABL developer. Fix the compilation errors in the ABL code below.
Preserve all construct usage — only change what the error messages indicate.
Output ONLY the fixed ABL code, no explanations, no markdown fences.

${constructContext}`;

  const userPrompt = `Fix this ABL agent "${agentName}":

\`\`\`
${abl}
\`\`\`

Compilation errors:
${errorList}

Output the fixed ABL code only:`;

  try {
    // LLMClient.chat() signature:
    //   chat(systemPrompt, messages, options): Promise<string>
    const response = await resolution.client.chat(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      {
        model: resolution.model,
        maxTokens: 4096,
      },
    );

    if (!response || response.trim().length < 20) return null;

    // Strip markdown fences if present
    return response
      .replace(/^```(?:yaml|abl)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
  } catch (err) {
    log.warn('LLM fix attempt failed', {
      agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function extractConstructs(abl: string): string[] {
  const keywords = [
    'AGENT',
    'SUPERVISOR',
    'GOAL',
    'PERSONA',
    'LIMITATIONS',
    'TOOLS',
    'GATHER',
    'MEMORY',
    'CONSTRAINTS',
    'GUARDRAILS',
    'FLOW',
    'STEPS',
    'HANDOFF',
    'DELEGATE',
    'ESCALATE',
    'COMPLETE',
    'ON_ERROR',
    'ON_START',
    'EXECUTION',
    'NLU',
    'TEMPLATES',
    'HOOKS',
    'ATTACHMENTS',
    'DESTINATIONS',
    'LOOKUP_TABLES',
    'ACTION_HANDLERS',
    'MESSAGES',
    'BEHAVIOR_PROFILE',
    'MULTI_INTENT',
  ];

  return keywords.filter((k) => {
    const regex = new RegExp(`^${k}:`, 'm');
    return regex.test(abl);
  });
}
