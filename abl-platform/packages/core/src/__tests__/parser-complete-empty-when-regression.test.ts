import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

const parserModulePath = fileURLToPath(
  new URL('../../dist/parser/agent-based-parser.js', import.meta.url),
);

const SUBPROCESS_TIMEOUT_MS = 1500;
const TEST_TIMEOUT_MS = 5000;
const SUBPROCESS_MAX_BUFFER_BYTES = 1024 * 1024;
const ABLP_817_EMPTY_COMPLETE_WHEN_DSL = `
AGENT: Regression_Agent
GOAL: "Reproduce empty COMPLETE WHEN validation failure"

COMPLETE:
  - WHEN:
    RESPOND: "I found the relevant HR policy information."
`;

type ParserProcessResult = {
  errorMessages: string[];
};

function isProcessTimeout(
  error: unknown,
): error is NodeJS.ErrnoException & { killed?: boolean; signal?: string | null } {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('code' in error || 'signal' in error) &&
    ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
      (error as { signal?: string | null }).signal === 'SIGTERM')
  );
}

async function parseDslInSubprocess(dsl: string): Promise<ParserProcessResult> {
  const evalScript = `
    import { parseAgentBasedABL } from ${JSON.stringify(parserModulePath)};

    const result = parseAgentBasedABL(${JSON.stringify(dsl)});

    process.stdout.write(
      JSON.stringify({
        errorMessages: result.errors.map((error) => error.message),
      }),
    );
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', evalScript],
    {
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES,
    },
  );

  return JSON.parse(stdout) as ParserProcessResult;
}

describe('parseAgentBasedABL COMPLETE empty WHEN regression', () => {
  test(
    'ABLP-817: returns a parse error instead of hanging on an empty COMPLETE WHEN expression',
    async () => {
      try {
        const result = await parseDslInSubprocess(ABLP_817_EMPTY_COMPLETE_WHEN_DSL);

        expect(result.errorMessages).toEqual(
          expect.arrayContaining([expect.stringMatching(/when/i)]),
        );
      } catch (error) {
        if (isProcessTimeout(error)) {
          throw new Error(
            'parseAgentBasedABL hung on `COMPLETE: - WHEN:` instead of returning a validation error',
          );
        }

        throw error;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
