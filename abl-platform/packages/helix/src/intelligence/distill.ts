/**
 * Quality-gate output distillers.
 *
 * Deterministic, regex-based extractors that condense raw stdout/stderr from
 * typecheck/test/lint commands into the signal that the next implementation
 * iteration actually needs (failed test names + first assertion error,
 * tsc error lines, eslint/prettier violations) — no LLM round-trip, no
 * hallucination risk.
 *
 * Why this exists: pipeline-engine concatenates `gateResult.feedback` into the
 * next-iteration prompt. Today that feedback is `output.slice(0, 1000)` per
 * failed check, which routinely drops the assertion error itself when the
 * preamble is large. Distill keeps the signal compact and ordered.
 *
 * Each distiller returns a `DistilledOutput` with byte counts so callers can
 * decide when to fall back to head+tail slicing. The `signal` field lets
 * callers cross-check ("we know the check failed; does the summary contain
 * any failure marker? if not, fall back").
 */
export type DistillKind = 'typecheck' | 'test' | 'lint' | 'generic';

export interface DistilledOutput {
  summary: string;
  signal: 'pass' | 'fail' | 'unknown';
  originalBytes: number;
  distilledBytes: number;
}

const MAX_SUMMARY_BYTES_DEFAULT = 4_000;
const MAX_LINES_DEFAULT = 60;
const MAX_PER_FAILURE_BYTES = 600;

export function distill(
  output: string,
  kind: DistillKind,
  opts: { maxBytes?: number } = {},
): DistilledOutput {
  const original = output ?? '';
  const maxBytes = opts.maxBytes ?? MAX_SUMMARY_BYTES_DEFAULT;

  let result: DistilledOutput;
  switch (kind) {
    case 'typecheck':
      result = distillTypecheck(original);
      break;
    case 'test':
      result = distillTest(original);
      break;
    case 'lint':
      result = distillLint(original);
      break;
    case 'generic':
    default:
      result = distillGeneric(original);
      break;
  }

  if (result.distilledBytes > maxBytes) {
    const clipped = result.summary.slice(0, maxBytes - 32).trimEnd();
    result = {
      ...result,
      summary: `${clipped}\n…[distilled summary clipped at ${maxBytes} bytes]`,
      distilledBytes: maxBytes,
    };
  }

  // Signal-preservation guard: if we know this is a failure but the distilled
  // summary contains no failure markers, fall back to a head+tail slice so we
  // don't strip the only diagnostic the next iteration has.
  if (result.signal === 'fail' && !containsFailureMarker(result.summary) && original.length > 0) {
    const fallback = headTailSlice(original, maxBytes);
    return {
      summary: `[distill: regex extractor produced no failure markers; head+tail slice follows]\n${fallback}`,
      signal: 'fail',
      originalBytes: original.length,
      distilledBytes: fallback.length,
    };
  }

  return result;
}

function distillTypecheck(output: string): DistilledOutput {
  const lines = output.split('\n');
  const errorLines: string[] = [];
  let totalErrors = 0;

  for (const line of lines) {
    if (TS_ERROR_PATTERN.test(line)) {
      totalErrors += 1;
      if (errorLines.length < MAX_LINES_DEFAULT) {
        errorLines.push(line.trim());
      }
    }
  }

  const passed = totalErrors === 0 && !/error/i.test(output);

  if (passed) {
    return {
      summary: 'typecheck: passed',
      signal: 'pass',
      originalBytes: output.length,
      distilledBytes: 'typecheck: passed'.length,
    };
  }

  const summaryLines = [
    `typecheck: ${totalErrors} error${totalErrors === 1 ? '' : 's'}`,
    ...errorLines,
  ];
  if (totalErrors > errorLines.length) {
    summaryLines.push(`…and ${totalErrors - errorLines.length} more`);
  }
  const summary = summaryLines.join('\n');

  return {
    summary,
    signal: totalErrors > 0 ? 'fail' : 'unknown',
    originalBytes: output.length,
    distilledBytes: summary.length,
  };
}

function distillTest(output: string): DistilledOutput {
  const failureBlocks = extractVitestFailureBlocks(output);
  const failedListLine = output.match(/Tests\s+(\d+)\s+failed/i);
  const failedCount = failedListLine
    ? Number.parseInt(failedListLine[1], 10)
    : failureBlocks.length;

  const passedHint = /Tests\s+\d+\s+passed/i.test(output) && failedCount === 0;
  if (passedHint) {
    return {
      summary: extractPassSummary(output) ?? 'tests: passed',
      signal: 'pass',
      originalBytes: output.length,
      distilledBytes: 0,
    };
  }

  if (failureBlocks.length === 0 && failedCount === 0) {
    // Could be a build error before tests ran, or an unfamiliar runner
    return distillGeneric(output);
  }

  const lines = [`tests: ${failedCount} failed`];
  for (const block of failureBlocks.slice(0, 12)) {
    lines.push('');
    lines.push(`✗ ${block.testName}`);
    if (block.location) lines.push(`  at ${block.location}`);
    if (block.assertion) {
      const trimmed =
        block.assertion.length > MAX_PER_FAILURE_BYTES
          ? `${block.assertion.slice(0, MAX_PER_FAILURE_BYTES)}…`
          : block.assertion;
      lines.push(...trimmed.split('\n').map((l) => `  ${l}`));
    }
  }
  if (failureBlocks.length > 12) {
    lines.push(`…and ${failureBlocks.length - 12} more failed tests`);
  }

  const summary = lines.join('\n');
  return {
    summary,
    signal: 'fail',
    originalBytes: output.length,
    distilledBytes: summary.length,
  };
}

function distillLint(output: string): DistilledOutput {
  const eslintErrors: string[] = [];
  const prettierFiles: string[] = [];
  let totalEslint = 0;

  const lines = output.split('\n');
  let currentFile: string | undefined;

  for (const line of lines) {
    const fileHeader = line.match(
      /^(\/[^\s]+|[a-zA-Z]:[\\/][^\s]+|[^\s/]+\.(?:ts|tsx|js|jsx|cjs|mjs))$/,
    );
    if (fileHeader) {
      currentFile = fileHeader[1];
      continue;
    }
    const eslintLine = line.match(
      /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([a-z][a-z0-9-/]*)\s*$/i,
    );
    if (eslintLine) {
      totalEslint += 1;
      if (eslintErrors.length < MAX_LINES_DEFAULT) {
        const [, ln, col, sev, msg, rule] = eslintLine;
        eslintErrors.push(
          `${currentFile ?? '<unknown>'}:${ln}:${col} ${sev} ${msg.trim()} (${rule})`,
        );
      }
      continue;
    }
    const prettierWarn = line.match(
      /^\[warn\]\s+(.+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html))\s*$/,
    );
    if (prettierWarn) {
      prettierFiles.push(prettierWarn[1]);
    }
  }

  if (totalEslint === 0 && prettierFiles.length === 0) {
    return {
      summary: 'lint: passed',
      signal: 'pass',
      originalBytes: output.length,
      distilledBytes: 'lint: passed'.length,
    };
  }

  const summaryLines: string[] = [];
  if (totalEslint > 0) {
    summaryLines.push(`eslint: ${totalEslint} problem${totalEslint === 1 ? '' : 's'}`);
    summaryLines.push(...eslintErrors);
    if (totalEslint > eslintErrors.length) {
      summaryLines.push(`…and ${totalEslint - eslintErrors.length} more eslint problems`);
    }
  }
  if (prettierFiles.length > 0) {
    summaryLines.push(
      `prettier: ${prettierFiles.length} unformatted file${prettierFiles.length === 1 ? '' : 's'}`,
    );
    summaryLines.push(...prettierFiles.slice(0, 20).map((f) => `  ${f}`));
    if (prettierFiles.length > 20) {
      summaryLines.push(`  …and ${prettierFiles.length - 20} more`);
    }
  }

  const summary = summaryLines.join('\n');
  return {
    summary,
    signal: 'fail',
    originalBytes: output.length,
    distilledBytes: summary.length,
  };
}

function distillGeneric(output: string): DistilledOutput {
  const trimmed = output.trim();
  if (!trimmed) {
    return { summary: '(no output)', signal: 'unknown', originalBytes: 0, distilledBytes: 10 };
  }
  const sliced = headTailSlice(trimmed, MAX_SUMMARY_BYTES_DEFAULT);
  const looksFailed = /\b(error|failed|exception|exit code [1-9])\b/i.test(trimmed);
  return {
    summary: sliced,
    signal: looksFailed ? 'fail' : 'unknown',
    originalBytes: output.length,
    distilledBytes: sliced.length,
  };
}

interface VitestFailureBlock {
  testName: string;
  location?: string;
  assertion?: string;
}

function extractVitestFailureBlocks(output: string): VitestFailureBlock[] {
  const blocks: VitestFailureBlock[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const failHeader = lines[i].match(/^\s*(?:FAIL|×)\s+(.+?)\s*$/);
    const arrowFail = lines[i].match(/^\s*(?:×|✗|✘)\s+(.+?)\s*$/);
    const headerMatch = failHeader ?? arrowFail;
    if (!headerMatch) continue;

    const testName = headerMatch[1].trim();
    if (!testName || testName === 'FAIL') continue;

    let assertion: string | undefined;
    let location: string | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j += 1) {
      const ln = lines[j];
      if (!assertion) {
        const arrow = ln.match(/^\s*(?:→|>|❯)\s+(.+)$/);
        const explicitAssertion = ln.match(
          /^\s*(AssertionError|Error|TypeError|RangeError):\s*(.+)$/,
        );
        if (explicitAssertion) {
          assertion = `${explicitAssertion[1]}: ${explicitAssertion[2]}`;
        } else if (arrow) {
          assertion = arrow[1].trim();
        }
      }
      if (!location) {
        const loc = ln.match(/(?:at\s+|❯\s+)?([^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::(\d+))?/);
        if (loc) {
          location = `${loc[1]}:${loc[2]}${loc[3] ? `:${loc[3]}` : ''}`;
        }
      }
      if (assertion && location) break;
      if (/^\s*(?:FAIL|×|✗|✘)\s+/.test(ln)) break;
    }

    blocks.push({ testName, location, assertion });
  }
  return dedupeBlocks(blocks);
}

function dedupeBlocks(blocks: VitestFailureBlock[]): VitestFailureBlock[] {
  const seen = new Set<string>();
  const result: VitestFailureBlock[] = [];
  for (const block of blocks) {
    const key = `${block.testName}|${block.location ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(block);
  }
  return result;
}

function extractPassSummary(output: string): string | undefined {
  const m = output.match(/Tests\s+\d+\s+passed[^\n]*/);
  return m?.[0];
}

function containsFailureMarker(summary: string): boolean {
  return /(error|fail|✗|×|✘|✖|unformatted|problems?|warning)/i.test(summary);
}

function headTailSlice(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const headBudget = Math.floor(maxBytes * 0.6) - 24;
  const tailBudget = maxBytes - headBudget - 24;
  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  return `${head}\n…[${text.length - headBudget - tailBudget} bytes elided]…\n${tail}`;
}

const TS_ERROR_PATTERN = /\b(?:error\s+TS\d+|TS\d+):/i;
