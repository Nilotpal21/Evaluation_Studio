/**
 * Worker runner — the entry point called from build-parallel-gen.ts when
 * FEATURE_SCAFFOLD_GENERATION is enabled.
 *
 * Replaces the free-form LLM generate_agent + compile_abl + compile-fix
 * loop with: scaffold → fill → assemble. Structural correctness is
 * guaranteed by construction (the LLM cannot emit HANDOFF TO: names or
 * the keyword; those come from the scaffold).
 */

import type { LanguageModel } from 'ai';
import {
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import { renderMissingGuardrailsWarning } from '@agent-platform/arch-ai/guardrails';
import { ARCH_AI_TIMEOUTS } from '../constants';
import {
  CompileWorkerTimeoutError,
  runIsolatedSingleAgentCompile,
} from '../helpers/isolated-build-compiler';
import { renderManagedBehaviorProfileDocumentsForTopology } from '../managed-behavior-profiles';
import type {
  AgentArchitecturePlan,
  AgentSpecInput,
  DomainContextInput,
  FillLoopResult,
  TopologyOutput,
} from './types';
import { scaffoldAblAgent } from './scaffold-generator';
import { fillSlots, type FillProgress } from './slot-fix-loop';
import { assembleAblAgent } from './assembler';
import { validateScaffoldConstructPlan } from './construct-plan';

/**
 * Progress events for the scaffold worker pipeline. Emitted at every stage
 * so the caller can surface state to the UI (via SSE) and to structured logs.
 */
export type ScaffoldProgress =
  | { kind: 'scaffolding'; archetype: string; slotCount: number; handoffCount: number }
  | { kind: 'filling'; slotCount: number }
  | { kind: 'retrying_slot'; slot: string; attempt: number; maxAttempts: number; error: string }
  | { kind: 'slot_passed'; slot: string; attempts: number }
  | { kind: 'slot_fallback'; slot: string; reason: string }
  | { kind: 'construct_validating'; issueCount: number }
  | { kind: 'validating'; failingSlots: number }
  | { kind: 'assembling'; yamlLines: number }
  | { kind: 'done'; fallbackSlotCount: number; elapsedMs: number }
  /**
   * Live heartbeat from the in-flight LLM call. Carries elapsed wall time
   * so the UI can show "Model thinking… 42s" and the SSE stream stays
   * alive through the browser's stall timer.
   */
  | { kind: 'llm_tick'; phase: 'initial' | 'retry'; slot?: string; elapsedMs: number };

export interface ScaffoldWorkerInput {
  plan: AgentArchitecturePlan;
  topology: TopologyOutput;
  spec: AgentSpecInput;
  domain: DomainContextInput;
  entryAgentName?: string;
  model: LanguageModel;
  maxRetriesPerSlot: number;
  /** Worker/request abort signal. Propagated into model calls. */
  abortSignal?: AbortSignal;
  /** Optional progress callback for UI events + structured logging. */
  onProgress?: (event: ScaffoldProgress) => void;
}

export async function runScaffoldWorker(input: ScaffoldWorkerInput): Promise<FillLoopResult> {
  const start = Date.now();
  const progress = input.onProgress ?? (() => {});

  const scaffold = scaffoldAblAgent(input.plan, input.topology, input.spec, input.domain);
  const slotCount = countSlots(scaffold.skeleton);
  progress({
    kind: 'scaffolding',
    archetype: input.plan.archetype,
    slotCount,
    handoffCount: scaffold.skeleton.handoffs.length,
  });

  progress({ kind: 'filling', slotCount });
  const fill = await fillSlots(scaffold, {
    model: input.model,
    maxRetriesPerSlot: input.maxRetriesPerSlot,
    abortSignal: input.abortSignal,
    onProgress: (fp: FillProgress) => {
      if (fp.kind === 'retrying_slot') {
        progress({
          kind: 'retrying_slot',
          slot: fp.slot,
          attempt: fp.attempt,
          maxAttempts: fp.maxAttempts,
          error: fp.error,
        });
      } else if (fp.kind === 'slot_passed') {
        progress({ kind: 'slot_passed', slot: fp.slot, attempts: fp.attempts });
      } else if (fp.kind === 'slot_fallback') {
        progress({ kind: 'slot_fallback', slot: fp.slot, reason: fp.reason });
      } else if (fp.kind === 'filling_complete') {
        progress({ kind: 'validating', failingSlots: fp.failingCount });
      } else if (fp.kind === 'llm_tick') {
        progress({
          kind: 'llm_tick',
          phase: fp.phase,
          ...(fp.slot !== undefined ? { slot: fp.slot } : {}),
          elapsedMs: fp.elapsedMs,
        });
      }
    },
  });

  const { yaml, slotMap } = assembleAblAgent(scaffold.skeleton, fill.creative);
  progress({ kind: 'assembling', yamlLines: yaml.split('\n').length });

  const constructValidation = validateScaffoldConstructPlan({
    skeleton: scaffold.skeleton,
    creative: fill.creative,
    executionMode: input.plan.complexity.selectedExecutionMode,
    agentNames: input.topology.agents.map((agent) => agent.name),
  });
  progress({ kind: 'construct_validating', issueCount: constructValidation.issues.length });

  if (!constructValidation.valid) {
    const constructErrors = constructValidation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`);

    return {
      yaml,
      slotMap,
      creative: fill.creative,
      slotAttempts: fill.slotAttempts,
      fallbackSlots: fill.fallbackSlots,
      compileStatus: 'error',
      compileErrors:
        constructErrors.length > 0
          ? constructErrors
          : ['Scaffold construct validation failed without a specific error.'],
      compileWarnings: constructValidation.issues
        .filter((issue) => issue.severity === 'warning')
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`),
    };
  }

  const validation = await validateAssembledAbl({
    agentName: input.plan.agentName,
    yaml,
    entryAgentName: input.entryAgentName,
    behaviorProfileDocuments: renderManagedBehaviorProfileDocumentsForTopology(
      input.topology,
      input.domain,
    ),
  });
  progress({
    kind: 'done',
    fallbackSlotCount: fill.fallbackSlots.length,
    elapsedMs: Date.now() - start,
  });

  return {
    yaml,
    slotMap,
    creative: fill.creative,
    slotAttempts: fill.slotAttempts,
    fallbackSlots: fill.fallbackSlots,
    compileStatus: validation.compileStatus,
    compileErrors: validation.compileErrors,
    compileWarnings: dedupeMessages([
      ...constructValidation.issues
        .filter((issue) => issue.severity === 'warning')
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`),
      ...validation.compileWarnings,
    ]),
  };
}

function countSlots(skeleton: import('./types').AblSkeleton): number {
  let count = 2; // goal + persona
  for (const h of skeleton.handoffs) if (h.whenSlot !== null) count += 1;
  count += skeleton.gatherFields.length;
  for (const pair of skeleton.completeSlots) {
    if (pair.whenSlot !== null) count += 1;
    if (pair.respondSlot !== null) count += 1;
  }
  return count;
}

function dedupeMessages(messages: string[]): string[] {
  return [
    ...new Set(messages.map((message) => message.trim()).filter((message) => message.length)),
  ];
}

function isPreBootstrapToolBindingDiagnostic(finding: {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}): boolean {
  return finding.code === 'T-04' && /\btool\b.*\bhas no binding\b/i.test(finding.message);
}

function formatDiagnosticMessages(
  diagnostics:
    | {
        topIssues: Array<{
          code: string;
          message: string;
          severity: 'error' | 'warning' | 'info';
          fix?: { description: string };
        }>;
      }
    | undefined,
  severities: ReadonlyArray<'error' | 'warning' | 'info'>,
  options: { includePreBootstrapToolBinding?: boolean } = {},
): string[] {
  return dedupeMessages(
    (diagnostics?.topIssues ?? [])
      .filter((finding) => severities.includes(finding.severity))
      .filter((finding) =>
        options.includePreBootstrapToolBinding
          ? true
          : !isPreBootstrapToolBindingDiagnostic(finding),
      )
      .map(
        (finding) =>
          `[${finding.code}] ${finding.message}${
            finding.fix ? ` Fix: ${finding.fix.description}` : ''
          }`,
      ),
  );
}

async function validateAssembledAbl(input: {
  agentName: string;
  yaml: string;
  entryAgentName?: string;
  behaviorProfileDocuments?: string[];
}): Promise<{
  compileStatus: 'pass' | 'warning' | 'error';
  compileErrors: string[];
  compileWarnings: string[];
}> {
  try {
    const compilePreview = await runIsolatedSingleAgentCompile(
      {
        code: input.yaml,
        additionalDocuments: input.behaviorProfileDocuments,
        compileOptions: {
          mode: 'preview',
          skipCrossAgentValidation: true,
        },
        diagnostics: {
          depth: 'deep',
          agentName: input.agentName,
          maxFindings: 20,
          ...(input.entryAgentName ? { entryAgent: input.entryAgentName } : {}),
        },
      },
      { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
    );

    const parseErrors = compilePreview.parseErrors.map((entry) =>
      entry.line ? `Line ${entry.line}: ${entry.message}` : entry.message,
    );
    const parseWarnings = compilePreview.parseWarnings.map((entry) =>
      entry.line ? `Line ${entry.line}: ${entry.message}` : entry.message,
    );

    if (parseErrors.length > 0 || !compilePreview.documentFound) {
      return {
        compileStatus: 'error',
        compileErrors:
          parseErrors.length > 0
            ? parseErrors
            : ['No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE keywords.'],
        compileWarnings: parseWarnings,
      };
    }

    const crossAgentPatterns = [
      /routing\.default_agent references .* which is not a known agent/,
      /not a known agent\. Available agents/,
    ];

    const compileErrors = compilePreview.compileErrors
      .filter((entry) => {
        if (entry.severity !== 'error' && entry.severity !== undefined) {
          return false;
        }
        return !crossAgentPatterns.some((pattern) => pattern.test(entry.message));
      })
      .map((entry) => (entry.line ? `Line ${entry.line}: ${entry.message}` : entry.message));
    const compileWarnings = compilePreview.compileWarnings.map((entry) =>
      entry.line ? `Line ${entry.line}: ${entry.message}` : entry.message,
    );
    const compileSoftWarnings = compilePreview.compileErrors
      .filter((entry) => entry.severity !== undefined && entry.severity !== 'error')
      .map((entry) => (entry.line ? `Line ${entry.line}: ${entry.message}` : entry.message));

    const qualityWarnings: string[] = [];
    const isSupervisorAgent = /^\s*SUPERVISOR\s*:/m.test(input.yaml);
    if (!/GUARDRAILS:/m.test(input.yaml)) {
      qualityWarnings.push(renderMissingGuardrailsWarning());
    }
    if (!/MEMORY:/m.test(input.yaml)) {
      qualityWarnings.push(renderMissingMemoryWarning());
    }
    if (isSupervisorAgent && !/WHEN:\s*(?:["']true["']|true)\b/m.test(input.yaml)) {
      qualityWarnings.push(renderSupervisorCatchAllHandoffWarning());
    }

    const diagnosticErrors = formatDiagnosticMessages(compilePreview.diagnostics, ['error']);
    const diagnosticWarnings = formatDiagnosticMessages(compilePreview.diagnostics, ['warning']);

    const allWarnings = dedupeMessages([
      ...parseWarnings,
      ...compileWarnings,
      ...compileSoftWarnings,
      ...qualityWarnings,
      ...diagnosticWarnings,
    ]);
    const allErrors = dedupeMessages([...compileErrors, ...diagnosticErrors]);

    return {
      compileStatus: allErrors.length > 0 ? 'error' : allWarnings.length > 0 ? 'warning' : 'pass',
      compileErrors: allErrors,
      compileWarnings: allWarnings,
    };
  } catch (err: unknown) {
    const timeoutWarning =
      err instanceof CompileWorkerTimeoutError
        ? `Scaffold sanity check timed out during ${err.phase} after ${err.timeoutMs}ms. Full BUILD reconciliation will recheck this agent.`
        : `Scaffold sanity check could not complete: ${err instanceof Error ? err.message : String(err)}`;

    return {
      compileStatus: 'warning',
      compileErrors: [],
      compileWarnings: [timeoutWarning],
    };
  }
}
