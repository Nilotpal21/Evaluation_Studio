/**
 * Formats a StageExecutionSummary into a one-line advisory digest used
 * when building failure-advisory prompts. Returns undefined when no
 * stream signals were observed.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type { StageExecutionSummary } from '../../types.js';

export function formatStageExecutionSummaryForAdvisory(
  summary?: StageExecutionSummary,
): string | undefined {
  if (!summary) {
    return undefined;
  }

  const signalCount =
    summary.progressEvents +
    summary.outputEvents +
    summary.toolUseEvents +
    summary.errorEvents +
    summary.shellCommandEvents;
  if (signalCount === 0) {
    return undefined;
  }

  const parts = [
    `Observed execution signals: progress=${summary.progressEvents}, output=${summary.outputEvents}, toolUse=${summary.toolUseEvents}, shellCommands=${summary.shellCommandEvents}.`,
  ];

  if (summary.recentMessages.length > 0) {
    parts.push(`Recent activity: ${summary.recentMessages.join(' | ')}`);
  }

  return parts.join(' ');
}
