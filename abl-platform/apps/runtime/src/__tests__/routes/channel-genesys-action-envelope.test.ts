import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('Genesys channel action envelope forwarding', () => {
  test('forwards the canonical ActionEvent without narrowing route fields', () => {
    const source = readFileSync(resolve(__dirname, '../../routes/channel-genesys.ts'), 'utf-8');

    expect(source).toContain('actionEvent: normalizedMsg.actionEvent');
    expect(source).not.toContain('actionId: normalizedMsg.actionEvent.actionId');
    expect(source).not.toContain('value: normalizedMsg.actionEvent.value');
  });
});
