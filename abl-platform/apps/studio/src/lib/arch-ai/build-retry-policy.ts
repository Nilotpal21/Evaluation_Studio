const DIAGNOSTIC_CODE_PATTERN = /\[([A-Z]{1,4}-\d{2})\]/g;

export const DEFAULT_BUILD_FIX_MAX_ROUNDS = 3;
export const STRUCTURAL_DIAGNOSTIC_FIX_MAX_ROUNDS = 2;

const NON_RETRYABLE_STRUCTURAL_CODES = new Set(['CO-02', 'CO-03', 'H-05']);

export interface BuildRetryPolicy {
  diagnosticCodes: string[];
  structuralCodes: string[];
  retryable: boolean;
  fixMaxRounds: number;
  reason?: string;
}

function dedupeCodes(codes: string[]): string[] {
  return [...new Set(codes.map((code) => code.trim()).filter((code) => code.length > 0))];
}

export function extractDiagnosticCodes(messages: string[]): string[] {
  const codes: string[] = [];

  for (const message of messages) {
    for (const match of message.matchAll(DIAGNOSTIC_CODE_PATTERN)) {
      const code = match[1]?.trim();
      if (code) {
        codes.push(code);
      }
    }
  }

  return dedupeCodes(codes);
}

export function classifyBuildRetryPolicy(input: {
  diagnosticCodes?: string[];
  messages?: string[];
}): BuildRetryPolicy {
  const diagnosticCodes = dedupeCodes([
    ...(input.diagnosticCodes ?? []),
    ...extractDiagnosticCodes(input.messages ?? []),
  ]);
  const structuralCodes = diagnosticCodes.filter((code) =>
    NON_RETRYABLE_STRUCTURAL_CODES.has(code),
  );

  if (structuralCodes.length === 0) {
    return {
      diagnosticCodes,
      structuralCodes: [],
      retryable: true,
      fixMaxRounds: DEFAULT_BUILD_FIX_MAX_ROUNDS,
    };
  }

  return {
    diagnosticCodes,
    structuralCodes,
    retryable: false,
    fixMaxRounds: STRUCTURAL_DIAGNOSTIC_FIX_MAX_ROUNDS,
    reason: `Blocking structural diagnostics (${structuralCodes.join(', ')}) need an explicit gather/completion or handoff state-source fix; stop blind regeneration.`,
  };
}
