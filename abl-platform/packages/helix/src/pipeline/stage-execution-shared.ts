import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  Decision,
  Finding,
  LegacyPathPlan,
  OracleDefinition,
  ProgressEvent,
  QualityGateResult,
  SessionState,
  StageExecutionSummary,
  StageDefinition,
  StageResult,
  StreamEvent,
  TimeoutEvent,
} from '../types.js';

export function now(): string {
  return new Date().toISOString();
}

export function makeResult(
  stage: StageDefinition,
  status: StageResult['status'],
  output: string,
  findings: Finding[],
  decisions: Decision[],
  startTime: number,
  iterations: number,
  error?: string,
  costUsd?: number,
  options: {
    qualityGate?: QualityGateResult;
    timeoutEvents?: TimeoutEvent[];
    executionSummary?: StageExecutionSummary;
  } = {},
): StageResult {
  return {
    stageName: stage.name,
    stageType: stage.type,
    status,
    output,
    findings,
    decisions,
    durationMs: Date.now() - startTime,
    iterations,
    model: stage.model.primary.model ?? stage.model.primary.engine,
    costUsd,
    error,
    qualityGate: options.qualityGate,
    executionSummary: options.executionSummary,
    timeoutEvents:
      options.timeoutEvents && options.timeoutEvents.length > 0 ? options.timeoutEvents : undefined,
  };
}

export function createStageExecutionSummary(): StageExecutionSummary {
  return {
    progressEvents: 0,
    outputEvents: 0,
    toolUseEvents: 0,
    errorEvents: 0,
    shellCommandEvents: 0,
    recentMessages: [],
  };
}

export function recordStageExecutionStreamEvent(
  summary: StageExecutionSummary,
  event: StreamEvent,
): void {
  switch (event.type) {
    case 'progress':
      summary.progressEvents += 1;
      break;
    case 'output':
      summary.outputEvents += 1;
      break;
    case 'tool-use':
      summary.toolUseEvents += 1;
      break;
    case 'error':
      summary.errorEvents += 1;
      break;
    default:
      break;
  }

  if (event.message.startsWith('Bash: ')) {
    summary.shellCommandEvents += 1;
  }

  if (event.message.trim()) {
    summary.recentMessages.push(event.message.trim());
    if (summary.recentMessages.length > 18) {
      summary.recentMessages.shift();
    }
  }
}

export function parseLegacyPaths(output: string, currentSliceIndex: number): LegacyPathPlan[] {
  const paths: LegacyPathPlan[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/LEGACY:\s*(\S+)\s*[—–-]\s*(.+)/i);
    if (match) {
      paths.push({
        path: match[1],
        reason: match[2].trim(),
        removableAfter: currentSliceIndex,
        status: 'identified',
      });
    }
  }
  return paths;
}

export function buildOracleDefinitionsFromStage(stage: StageDefinition): OracleDefinition[] {
  return (stage.substages ?? []).map((substage) => ({
    id: substage.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: substage.name,
    description: substage.description,
    model: substage.model.primary,
    promptFile: substage.promptFile ?? '',
    reviewInstructions: substage.prompt,
    respectConfiguredLimits: true,
    focusAreas: [substage.description],
    tools: substage.tools,
  }));
}

export function resolveSessionStateForStage(stage: Pick<StageDefinition, 'type'>): SessionState {
  switch (stage.type) {
    case 'bootstrap':
      return 'initializing';
    case 'deep-scan':
    case 'reproduce':
    case 'regression':
    case 'concerns-audit':
      return 'scanning';
    case 'oracle-analysis':
    case 'root-cause':
    case 'manifest-compilation':
      return 'analyzing';
    case 'plan-generation':
      return 'planning';
    case 'review':
    case 'bulk-review':
      return 'reviewing';
    case 'commit-checkpoint':
      return 'committing';
    default:
      return 'executing';
  }
}

export function resolveStageDeadlineAt(
  stage: StageDefinition,
  inheritedDeadlineAt?: number,
  referenceTimeMs: number = Date.now(),
): number | undefined {
  const stageDeadlineAt = stage.timeoutMs ? referenceTimeMs + stage.timeoutMs : undefined;

  if (inheritedDeadlineAt == null) {
    return stageDeadlineAt;
  }

  if (stageDeadlineAt == null) {
    return inheritedDeadlineAt;
  }

  return Math.min(inheritedDeadlineAt, stageDeadlineAt);
}

export function getRemainingTimeoutMs(deadlineAt?: number): number | undefined {
  if (deadlineAt == null) {
    return undefined;
  }

  return Math.max(deadlineAt - Date.now(), 0);
}

export function hasDeadlineExpired(deadlineAt?: number): boolean {
  const remainingTimeoutMs = getRemainingTimeoutMs(deadlineAt);
  return remainingTimeoutMs != null && remainingTimeoutMs <= 0;
}

export function isTimeoutError(error: string): boolean {
  return /\btimed out\b/i.test(error) || /\bdeadline\b/i.test(error) || /\bstalled\b/i.test(error);
}

/**
 * State held per stream-checkpoint file path. Tracks whether the parent
 * directory has been ensured and serializes append writes so concurrent
 * model-stream events arrive on disk in the order the model emitted them.
 */
const streamCheckpointState = new Map<string, { dirReady: boolean; writeChain: Promise<void> }>();

function appendToStreamCheckpoint(filePath: string, chunk: string): void {
  let state = streamCheckpointState.get(filePath);
  if (!state) {
    state = { dirReady: false, writeChain: Promise.resolve() };
    streamCheckpointState.set(filePath, state);
  }

  const ensureDir = state.dirReady
    ? Promise.resolve()
    : mkdir(dirname(filePath), { recursive: true }).then(() => {
        const current = streamCheckpointState.get(filePath);
        if (current) current.dirReady = true;
      });

  state.writeChain = state.writeChain
    .then(() => ensureDir)
    .then(() => appendFile(filePath, chunk))
    .catch((err: unknown) => {
      // Stream checkpointing is best-effort recovery context; never block the
      // pipeline on disk failures, but surface the error so silent data loss
      // is detectable in logs.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[stream-checkpoint] failed to append to ${filePath}: ${msg}\n`);
    });
}

/** Test-only helper to clear the checkpoint state map between unit tests. */
export function __resetStreamCheckpointStateForTests(): void {
  streamCheckpointState.clear();
}

export function createStageStreamHandler(
  emitProgress: (event: ProgressEvent) => void,
  stageName: string,
  sliceIndex?: number,
  streamFilePath?: string,
): (event: StreamEvent) => void {
  return (event: StreamEvent) => {
    const progressType =
      event.type === 'error'
        ? 'error'
        : event.type === 'progress'
          ? 'stage-progress'
          : 'model-stream';
    emitProgress({
      type: progressType as ProgressEvent['type'],
      timestamp: event.timestamp,
      stage: stageName,
      slice: sliceIndex,
      message: event.message,
      details: event.details,
    });

    if (streamFilePath && event.message && (event.type === 'output' || event.type === 'tool-use')) {
      // Persist model output and tool-use events as they arrive so a mid-turn
      // crash or maxTurns cutoff leaves a recovery context on disk for the
      // next attempt. Skip 'progress' (model thinking) and 'complete' (final
      // result, already in stage history).
      appendToStreamCheckpoint(streamFilePath, `[${event.type}] ${event.message}\n`);
    }
  };
}
