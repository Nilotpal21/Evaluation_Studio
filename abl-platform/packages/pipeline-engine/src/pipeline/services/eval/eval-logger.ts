/**
 * Eval Structured Loggers
 *
 * Pre-configured logger instances for each eval pipeline component.
 * Uses the platform createLogger for structured JSON output with
 * consistent naming across the eval subsystem.
 */

import { createLogger } from '@abl/compiler/platform';

export const evalRunLog = createLogger('eval-run');
export const evalPersonaSimLog = createLogger('eval-persona-sim');
export const evalJudgeLog = createLogger('eval-judge');
export const evalTrajectoryLog = createLogger('eval-trajectory');
export const evalAggregateLog = createLogger('eval-aggregate');
export const evalWriterLog = createLogger('eval-writer');
