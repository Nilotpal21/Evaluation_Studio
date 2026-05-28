/**
 * Architecture Analysis
 *
 * Analyzes a use case description and optional API specifications
 * to produce an architecture spec using the Claude API.
 */

import type { AnalyzeInput, ArchitectureSpec } from './types.js';
import { buildArchitectPrompt } from './prompts.js';
import { detectGapsFromUseCase, mergeGapReports } from './gaps.js';

// =============================================================================
// ANALYZE USE CASE
// =============================================================================

/**
 * Analyze a use case and produce an architecture specification.
 * Requires ANTHROPIC_API_KEY environment variable.
 */
export async function analyzeUseCase(input: AnalyzeInput): Promise<ArchitectureSpec> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required for architecture analysis. ' +
        'Set it with: export ANTHROPIC_API_KEY=your-key',
    );
  }

  // Build the architect prompt
  const prompt = buildArchitectPrompt(input.useCase, input.existingApis, input.constraints);

  // Call Claude API
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorBody}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textContent = result.content.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error('No text content in Claude API response');
  }

  // Parse the JSON response
  let spec: ArchitectureSpec;
  try {
    // Strip any markdown fencing if present
    let jsonText = textContent.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    spec = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse architecture spec from LLM response: ${err instanceof Error ? err.message : String(err)}\n` +
        `Response was: ${textContent.text.substring(0, 500)}...`,
    );
  }

  // Run local gap detection and merge with LLM-detected gaps
  const localGaps = detectGapsFromUseCase(input.useCase);
  if (spec.gapReport) {
    spec.gapReport = mergeGapReports(spec.gapReport, localGaps);
  } else {
    spec.gapReport = localGaps;
  }

  // Validate the spec structure
  validateSpec(spec);

  return spec;
}

// =============================================================================
// VALIDATION
// =============================================================================

function validateSpec(spec: ArchitectureSpec): void {
  if (!spec.projectName) {
    throw new Error('Architecture spec missing projectName');
  }
  if (!spec.topology) {
    throw new Error('Architecture spec missing topology');
  }
  if (!['single-agent', 'supervisor', 'adaptive-network'].includes(spec.topology)) {
    throw new Error(`Invalid topology: ${spec.topology}`);
  }

  if (spec.topology === 'single-agent' && !spec.agent) {
    throw new Error('Single-agent topology requires an agent spec');
  }
  if (spec.topology === 'supervisor' && !spec.supervisor) {
    throw new Error('Supervisor topology requires a supervisor spec');
  }
  if (
    spec.topology === 'adaptive-network' &&
    (!spec.networkAgents || spec.networkAgents.length === 0)
  ) {
    throw new Error('Adaptive-network topology requires networkAgents');
  }
}
