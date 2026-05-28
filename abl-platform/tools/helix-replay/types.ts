export type ReplayHelixCommand = 'audit' | 'fix';

export interface ReplayScenario {
  version: 1;
  id: string;
  jiraKey: string;
  summary: string;
  description: string;
  helixCommand: ReplayHelixCommand;
  scope: string[];
  featureSpec?: string;
  testSpec?: string;
  hldSpec?: string;
  lldPlan?: string;
  targetCommit: string;
  baseCommit: string;
  changedFiles: string[];
  historicalFileHints?: Record<string, string[]>;
  avoidPaths?: string[];
  tags?: string[];
  notes?: string[];
}

export interface ReplayComparison {
  targetPatchId: string | null;
  actualPatchId: string | null;
  exactPatchMatch: boolean;
  targetChangedFiles: string[];
  actualChangedFiles: string[];
  commonFiles: string[];
  filePrecision: number;
  fileRecall: number;
  fileJaccard: number;
}

export interface ReplaySessionSummary {
  id: string;
  state: string;
  pipelineName: string;
  currentStageIndex: number;
  currentSliceIndex: number;
  totalSlices: number;
  commits: number;
  findings: number;
  decisions: number;
  updatedAt: string;
  error?: string;
}

export interface ReplayRunRecord {
  version: 1;
  runId: string;
  scenarioId: string;
  startedAt: string;
  completedAt: string;
  sourceRepo: string;
  worktreeDir: string;
  runDir: string;
  helixCommand: ReplayHelixCommand;
  helixArgs: string[];
  exitCode: number | null;
  preflightError?: string;
  session?: ReplaySessionSummary;
  comparison: ReplayComparison;
}
