/**
 * ABL Architect Refine Tool
 *
 * Accepts existing DSL + instruction, calls LLM to produce modified DSL.
 */

export interface RefineTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const refineTool: RefineTool = {
  name: 'kore_architect_refine',
  description:
    'Refine existing ABL DSL based on a natural language instruction. Takes the current DSL and a modification instruction, returns the modified YAML ABL.',
  inputSchema: {
    type: 'object',
    properties: {
      dsl: { type: 'string', description: 'Current ABL DSL content' },
      instruction: {
        type: 'string',
        description: 'Natural language instruction for how to modify the DSL',
      },
    },
    required: ['dsl', 'instruction'],
  },
};

/** Handle the refine tool call */
export async function handleRefineTool(args: Record<string, unknown>): Promise<unknown> {
  const dsl = args.dsl as string;
  const instruction = args.instruction as string;

  if (!dsl) throw new Error('dsl is required');
  if (!instruction) throw new Error('instruction is required');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required for architect refine');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are an ABL (Agent Blueprint Language) expert. You modify ABL DSL code based on instructions.

Rules:
- Output ONLY the modified ABL YAML. No explanations, no markdown code fences.
- Preserve all existing sections unless the instruction explicitly asks to change them.
- Use YAML format for all output.
- Maintain valid ABL syntax.`,
      messages: [
        {
          role: 'user',
          content: `Here is the current ABL DSL:\n\n${dsl}\n\nInstruction: ${instruction}\n\nOutput ONLY the modified ABL YAML:`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM call failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const modifiedDsl = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');

  return { modifiedDsl };
}
