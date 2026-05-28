import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { mapProjectRuntimeConfigDocumentToIR } from '../platform/ir/project-runtime-config.js';
import type { ProjectRuntimeConfigIR } from '../platform/ir/schema.js';

function parseDocument(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).not.toBeNull();
  return result.document!;
}

describe('project runtime config compiler options', () => {
  it('maps project compaction essential fields into runtime config IR', () => {
    expect(
      mapProjectRuntimeConfigDocumentToIR({
        compaction: {
          tool_results: {
            strategy: 'structured',
            essential_fields: {
              search_hotels: ['name', 'price'],
            },
          },
        },
      }).compaction?.tool_results?.essential_fields,
    ).toEqual({
      search_hotels: ['name', 'price'],
    });
  });

  it('writes project_runtime_config into compiled agent IR', () => {
    const projectRuntimeConfig: ProjectRuntimeConfigIR = {
      extraction_strategy: 'hybrid',
      nlu_provider: 'standard',
      correction_detection: 'llm',
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: {
        currency_mode: 'static',
      },
      lookup_tables: [],
      compaction: {
        tool_results: {
          max_chars: 4096,
        },
      },
    };

    const output = compileABLtoIR(
      [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      { project_runtime_config: projectRuntimeConfig },
    );

    expect(output.agents.booking_agent.project_runtime_config).toEqual(projectRuntimeConfig);
  });

  it('wires DSL compaction policy and tool hints into agent IR', () => {
    const doc = parseDocument(`
AGENT: compaction_agent
GOAL: "Handle compact tool results"

EXECUTION:
  compaction:
    model: gpt-4o-mini
    tool_results:
      strategy: structured
      max_chars: 4096
      structured_threshold: 1024
      keep_recent: 1
      essential_fields:
        search_hotels: [name, price]
      max_description_length: 120
      summarize_prompt: "Keep IDs and prices."
    prior_turns:
      strategy: compact
      assistant_preview_chars: 80

TOOLS:
  search_hotels(destination: string) -> object
    description: "Search hotels"
    compaction:
      essential_fields: [name, price, availability]
      max_description_length: 90
`);

    const output = compileABLtoIR([doc]);
    const agent = output.agents.compaction_agent;

    expect(agent.execution.compaction).toEqual({
      model: 'gpt-4o-mini',
      tool_results: {
        strategy: 'structured',
        max_chars: 4096,
        structured_threshold: 1024,
        keep_recent: 1,
        essential_fields: {
          search_hotels: ['name', 'price'],
        },
        max_description_length: 120,
        summarize_prompt: 'Keep IDs and prices.',
      },
      prior_turns: {
        strategy: 'compact',
        assistant_preview_chars: 80,
      },
    });
    expect(agent.tools.find((tool) => tool.name === 'search_hotels')?.compaction).toEqual({
      essential_fields: ['name', 'price', 'availability'],
      max_description_length: 90,
    });
  });
});
