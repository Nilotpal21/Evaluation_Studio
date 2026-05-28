/**
 * Migration unit test — `add-agent-name-to-messages` (ABLP-1068).
 *
 * Verifies that the standalone migration helper:
 *  - issues the expected `ALTER TABLE … ADD COLUMN IF NOT EXISTS agent_name` DDL
 *  - is idempotent (re-running issues the same DDL; ClickHouse swallows it via
 *    `IF NOT EXISTS`).
 *
 * No real ClickHouse needed — we inject a fake client. The migration helper is
 * pure DDL-issuing logic.
 */

import { describe, it, expect } from 'vitest';
import { migrateAddAgentNameToMessages } from '../clickhouse-schemas/migrations/add-agent-name-to-messages.js';

interface CapturedCommand {
  query: string;
}

function makeFakeClient(): {
  client: { command: (cmd: CapturedCommand) => Promise<void> };
  commands: CapturedCommand[];
} {
  const commands: CapturedCommand[] = [];
  return {
    commands,
    client: {
      async command(cmd: CapturedCommand) {
        commands.push(cmd);
      },
    },
  };
}

describe('migrateAddAgentNameToMessages', () => {
  it('issues the expected ALTER TABLE statement against the canonical database', async () => {
    const { client, commands } = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateAddAgentNameToMessages(client as any);
    expect(commands).toHaveLength(1);
    const q = commands[0]?.query ?? '';
    expect(q).toMatch(/ALTER TABLE\s+abl_platform\.messages/);
    expect(q).toMatch(/ADD COLUMN IF NOT EXISTS agent_name/);
    expect(q).toMatch(/LowCardinality\(String\)/);
    expect(q).toMatch(/DEFAULT ''/);
  });

  it('is idempotent — applying twice produces two identical DDLs (ADD COLUMN IF NOT EXISTS is a no-op when applied to a converged table)', async () => {
    const { client, commands } = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateAddAgentNameToMessages(client as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateAddAgentNameToMessages(client as any);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.query).toBe(commands[1]?.query);
  });
});
