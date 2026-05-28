export type FeasibilitySeverity = 'warning';

export interface FeasibilityFinding {
  checkName:
    | 'empty-response'
    | 'tool-binding'
    | 'voice-model-feasibility'
    | 'provider-allowlist'
    | 'memory-scope-identity';
  severity: FeasibilitySeverity;
  message: string;
}

export interface FeasibilityAnalysisInput {
  code: string;
  declaredToolNames?: readonly string[];
  resolvedToolNames?: readonly string[];
}

function hasSection(code: string, section: string): boolean {
  return new RegExp(`^\\s*${section}\\s*:`, 'im').test(code);
}

function hasField(code: string, field: string): boolean {
  return new RegExp(`^\\s*${field}\\s*:`, 'im').test(code);
}

function hasVoiceSurface(code: string): boolean {
  return (
    hasSection(code, 'VOICE') ||
    /^\s*CHANNELS\s*:[\s\S]*\bvoice\b/im.test(code) ||
    /^\s*channels\s*:[\s\S]*\bvoice\b/im.test(code)
  );
}

function hasPersistentMemory(code: string): boolean {
  return /^\s*MEMORY\s*:[\s\S]*\bpersistent\s*:/im.test(code);
}

function sectionBody(code: string, section: string): string | null {
  const match = new RegExp(
    `^\\s*${section}\\s*:\\s*\\n?([\\s\\S]*?)(?=^\\s*[A-Z_]+\\s*:|(?![\\s\\S]))`,
    'im',
  ).exec(code);
  return match?.[1] ?? null;
}

function hasExecutionModelOverride(code: string): boolean {
  const execution = sectionBody(code, 'EXECUTION');
  return execution !== null && /^\s*(model|provider)\s*:/im.test(execution);
}

export function runFeasibilityChecks(input: FeasibilityAnalysisInput): FeasibilityFinding[] {
  const findings: FeasibilityFinding[] = [];
  const { code } = input;
  const declaredToolNames = input.declaredToolNames ?? [];
  const resolvedToolNames = new Set(input.resolvedToolNames ?? []);

  if (
    hasSection(code, 'FLOW') &&
    !hasField(code, 'RESPOND') &&
    !hasSection(code, 'COMPLETE') &&
    !hasSection(code, 'HANDOFF') &&
    !hasSection(code, 'DELEGATE')
  ) {
    findings.push({
      checkName: 'empty-response',
      severity: 'warning',
      message:
        'FLOW agent has no visible response, completion, handoff, or delegate path. Verify it cannot produce an empty user response.',
    });
  }

  const unresolvedTools = declaredToolNames.filter((toolName) => !resolvedToolNames.has(toolName));
  if (unresolvedTools.length > 0) {
    findings.push({
      checkName: 'tool-binding',
      severity: 'warning',
      message: `Tool binding feasibility is incomplete for: ${unresolvedTools.join(', ')}.`,
    });
  }

  if (hasVoiceSurface(code) && !hasSection(code, 'EXECUTION')) {
    findings.push({
      checkName: 'voice-model-feasibility',
      severity: 'warning',
      message:
        'Voice-capable agent does not declare EXECUTION model settings. Verify the configured model supports the voice channel before shipping.',
    });
  }

  if (hasExecutionModelOverride(code)) {
    findings.push({
      checkName: 'provider-allowlist',
      severity: 'warning',
      message:
        'Model/provider feasibility depends on tenant policy. Verify the selected provider is allowed for this tenant before applying.',
    });
  }

  if (hasPersistentMemory(code)) {
    findings.push({
      checkName: 'memory-scope-identity',
      severity: 'warning',
      message:
        'Persistent memory requires a stable runtime identity source. Verify the channel/session provides user identity before relying on this memory.',
    });
  }

  return findings;
}
