/**
 * Compaction Policy Resolution
 *
 * Resolves the effective CompactionPolicy for a session via 3-level merge:
 *   Platform defaults → Project config (DB) → Agent IR (compile-time)
 *
 * Tool-level essential_fields annotations are collected into the policy
 * from ToolDefinition.compaction entries.
 */

import type {
  CompactionPolicy,
  CompactionPolicyOverride,
  ToolResultCompactionConfig,
  PriorTurnCompactionConfig,
} from '@abl/compiler/platform/ir/schema.js';

import type { RuntimeSession } from './types.js';

/** Platform-wide default compaction policy (matches previous hardcoded values) */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  tool_results: {
    strategy: 'summarize',
    max_chars: 102_400,
    structured_threshold: 10_000,
    keep_recent: 2,
    max_description_length: 200,
  },
  prior_turns: {
    strategy: 'compact',
    assistant_preview_chars: 200,
  },
};

/**
 * Resolve the effective CompactionPolicy for a session.
 * Uses lazy caching on session._compactionPolicy.
 */
export function resolveCompactionPolicy(
  session: Pick<RuntimeSession, 'agentIR' | '_projectRuntimeConfig' | '_compactionPolicy'>,
): CompactionPolicy {
  if (session._compactionPolicy) return session._compactionPolicy;

  const defaults = DEFAULT_COMPACTION_POLICY;
  const project = (session._projectRuntimeConfig as unknown as Record<string, unknown>)
    ?.compaction as CompactionPolicyOverride | undefined;
  const agent = session.agentIR?.execution?.compaction;

  // Deep merge: defaults ← project ← agent
  const resolved = deepMergeCompaction(defaults, project, agent);

  // Collect tool-level essential_fields into the policy
  const tools = session.agentIR?.tools ?? [];
  for (const tool of tools) {
    if (tool.compaction?.essential_fields) {
      resolved.tool_results.essential_fields ??= {};
      resolved.tool_results.essential_fields[tool.name] = tool.compaction.essential_fields;
    }
  }

  (session as { _compactionPolicy?: CompactionPolicy })._compactionPolicy = resolved;
  return resolved;
}

/** Deep-merge compaction configs with right-side winning per leaf field */
function deepMergeCompaction(
  defaults: CompactionPolicy,
  project?: CompactionPolicyOverride,
  agent?: CompactionPolicyOverride,
): CompactionPolicy {
  return {
    model: agent?.model ?? project?.model ?? defaults.model,
    tool_results: mergeToolResults(
      defaults.tool_results,
      project?.tool_results,
      agent?.tool_results,
    ),
    prior_turns: mergePriorTurns(defaults.prior_turns, project?.prior_turns, agent?.prior_turns),
  };
}

function mergeToolResults(
  defaults: ToolResultCompactionConfig,
  project?: Partial<ToolResultCompactionConfig>,
  agent?: Partial<ToolResultCompactionConfig>,
): ToolResultCompactionConfig {
  return {
    strategy: agent?.strategy ?? project?.strategy ?? defaults.strategy,
    max_chars: agent?.max_chars ?? project?.max_chars ?? defaults.max_chars,
    structured_threshold:
      agent?.structured_threshold ?? project?.structured_threshold ?? defaults.structured_threshold,
    keep_recent: agent?.keep_recent ?? project?.keep_recent ?? defaults.keep_recent,
    essential_fields: mergeEssentialFields(
      defaults.essential_fields,
      project?.essential_fields,
      agent?.essential_fields,
    ),
    max_description_length:
      agent?.max_description_length ??
      project?.max_description_length ??
      defaults.max_description_length,
    summarize_prompt:
      agent?.summarize_prompt ?? project?.summarize_prompt ?? defaults.summarize_prompt,
  };
}

function mergePriorTurns(
  defaults: PriorTurnCompactionConfig,
  project?: Partial<PriorTurnCompactionConfig>,
  agent?: Partial<PriorTurnCompactionConfig>,
): PriorTurnCompactionConfig {
  return {
    strategy: agent?.strategy ?? project?.strategy ?? defaults.strategy,
    assistant_preview_chars:
      agent?.assistant_preview_chars ??
      project?.assistant_preview_chars ??
      defaults.assistant_preview_chars,
  };
}

function mergeEssentialFields(
  ...sources: Array<Record<string, string[]> | undefined>
): Record<string, string[]> | undefined {
  let merged: Record<string, string[]> | undefined;
  for (const source of sources) {
    if (!source) continue;
    merged ??= {};
    Object.assign(merged, source);
  }
  return merged;
}
