import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import OpenAI from 'openai';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'o3-mini';

function normalizeModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function modelDisallowsTemperature(model: string): boolean {
  const normalized = normalizeModelName(model);
  return /^(?:gpt-5|o[134])(?:[.-]|$)/.test(normalized);
}

function modelDisallowsSystemRole(model: string): boolean {
  return /^(?:o[134](?:[.-]|$))/.test(normalizeModelName(model));
}

const SYSTEM_PROMPT = `You are a senior code reviewer performing an independent review.
You are reviewing code changes against a design document (HLD).

Focus on:
1. Correctness — does the code do what the design says?
2. Security — injection, auth bypass, data leaks, secrets in code
3. Edge cases — missing null checks, race conditions, boundary values
4. Performance — N+1 queries, unbounded loops, missing indexes
5. Error handling — swallowed errors, missing validation, unhelpful messages
6. Design compliance — does implementation match the agreed architecture?

You MUST return your review as JSON with this schema:
{
  "verdict": "APPROVED" | "NEEDS_FIXES",
  "issues": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "security" | "correctness" | "performance" | "edge-case" | "error-handling" | "design-compliance",
      "description": "what's wrong",
      "file": "path/to/file.ts (if identifiable)",
      "suggestion": "how to fix"
    }
  ],
  "summary": "one paragraph overall assessment"
}`;

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'OPENAI_API_KEY not set. Set it in ~/.claude/settings.json under env.OPENAI_API_KEY',
    );
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });

  const server = new McpServer({
    name: 'openai-reviewer',
    version: '0.1.0',
  });

  server.tool(
    'review_code',
    'Get an independent code review from OpenAI. Send a diff and HLD, receive structured review findings.',
    {
      diff: z.string().describe('The git diff of all changes to review'),
      hld: z
        .string()
        .describe('The High-Level Design document that the implementation should conform to'),
      context: z
        .string()
        .optional()
        .describe('Additional context about the codebase or specific concerns to check'),
    },
    async ({ diff, hld, context }) => {
      const userMessage = [
        '## Design Document (HLD)',
        hld,
        '',
        '## Code Changes (diff)',
        diff.length > 50000 ? diff.substring(0, 50000) + '\n\n[diff truncated at 50K chars]' : diff,
        context ? `\n## Additional Context\n${context}` : '',
      ].join('\n');

      try {
        // Reasoning models reject sampling controls like temperature.
        const disallowsTemperature = modelDisallowsTemperature(OPENAI_MODEL);
        // o3-mini and o-series models don't support system role in the same way.
        const disallowsSystemRole = modelDisallowsSystemRole(OPENAI_MODEL);

        const response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: disallowsSystemRole
            ? [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n${userMessage}` }]
            : [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
              ],
          ...(disallowsTemperature ? {} : { temperature: 0.1 }),
          response_format: { type: 'json_object' },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  verdict: 'ERROR',
                  issues: [],
                  summary: 'OpenAI returned empty response',
                }),
              },
            ],
          };
        }

        return {
          content: [{ type: 'text' as const, text: content }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                verdict: 'ERROR',
                issues: [],
                summary: `OpenAI API error: ${message}`,
              }),
            },
          ],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
