import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ARCH_EMITTER_AGENT_IR_FIELDS = [
  'ir_version',
  'metadata',
  'execution',
  'identity',
  'tools',
  'gather',
  'attachments',
  'memory',
  'constraints',
  'coordination',
  'completion',
  'error_handling',
  'flow',
  'on_start',
  'messages',
  'hooks',
  'nlu',
  'entities',
  'intent_handling',
  'templates',
  'routing',
  'available_agents',
  'project_runtime_config',
  'lookup_tables',
  'behavior_profiles',
  'conversation_behavior',
  'destinations',
  'omnichannel',
  'action_handlers',
] as const;

describe('Arch emitter to runtime IR drift guard', () => {
  it('keeps AgentIR top-level fields explicit in Arch emitter tests', async () => {
    const schemaUrl = new URL('../../../compiler/src/platform/ir/schema.ts', import.meta.url);
    const schema = await readFile(schemaUrl, 'utf8');
    const actualFields = extractAgentIrFields(schema);

    expect(actualFields).toEqual(ARCH_EMITTER_AGENT_IR_FIELDS);
  });
});

function extractAgentIrFields(schema: string): string[] {
  const interfaceStart = schema.indexOf('export interface AgentIR {');
  expect(interfaceStart).toBeGreaterThanOrEqual(0);

  const bodyStart = schema.indexOf('{', interfaceStart);
  const bodyEnd = schema.indexOf('\n}', bodyStart);
  expect(bodyStart).toBeGreaterThanOrEqual(0);
  expect(bodyEnd).toBeGreaterThan(bodyStart);

  return schema
    .slice(bodyStart + 1, bodyEnd)
    .split('\n')
    .map((line) => line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\?)?:/)?.[1])
    .filter((field): field is string => Boolean(field));
}
