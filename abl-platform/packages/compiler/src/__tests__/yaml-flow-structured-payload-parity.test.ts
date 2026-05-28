import { describe, expect, test } from 'vitest';
import { parseYamlABL } from '../../../core/src/parser/yaml-parser.js';
import { compileABLtoIR } from '../platform/ir/compiler.js';

describe('YAML flow structured payload parity', () => {
  test('compiles flow step and gather prompt rich payloads into the same IR surface as ABL', () => {
    const parsed = parseYamlABL(`
agent: yaml_structured_agent
goal: Preserve structured flow payloads

flow:
  steps:
    collect_details:
      reasoning: false
      respond: Choose a destination
      voice_config:
        plain_text: Choose a destination.
      rich_content:
        markdown: "### Choose a destination"
      gather:
        fields:
          - name: destination
            type: string
            prompt: Where are you going?
            rich_content:
              markdown: "**Destination**"
`);

    expect(parsed.errors).toHaveLength(0);

    const output = compileABLtoIR([parsed.document!]);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    const step = output.agents.yaml_structured_agent.flow?.definitions.collect_details;
    expect(step?.voice_config).toEqual({ plain_text: 'Choose a destination.' });
    expect(step?.rich_content).toEqual({ markdown: '### Choose a destination' });
    expect(step?.gather?.fields[0]?.rich_content).toEqual({ markdown: '**Destination**' });
  });
});
