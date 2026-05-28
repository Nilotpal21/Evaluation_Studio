import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAgentBasedABL } from '@abl/core';
import { describe, expect, test } from 'vitest';

import { compileABLtoIR } from '../../platform/ir/compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BANKNEXUS_DIR = path.resolve(__dirname, '../../../../../examples/banknexus/agents');
const BANKNEXUS_README = path.resolve(BANKNEXUS_DIR, '../README.md');

function readExample(fileName: string) {
  return readFileSync(path.join(BANKNEXUS_DIR, fileName), 'utf8');
}

describe('BankNexus example smoke', () => {
  test('parses and compiles the full example bundle without diagnostics', () => {
    const files = readdirSync(BANKNEXUS_DIR)
      .filter((file) => file.endsWith('.abl'))
      .sort();
    const parsed = files.map((file) => ({
      file,
      result: parseAgentBasedABL(readExample(file)),
    }));

    for (const { file, result } of parsed) {
      expect(result.errors, `${file} should parse cleanly`).toHaveLength(0);
      expect(result.document, `${file} should produce a document`).toBeTruthy();
    }

    const output = compileABLtoIR(parsed.map(({ result }) => result.document!));

    expect(output.diagnostics ?? []).toEqual([]);
    expect(Object.keys(output.agents).sort()).toEqual([
      'BankNexus_Supervisor',
      'Fund_Transfer',
      'Get_Balance',
      'Transaction_History',
    ]);
  });

  test('supervisor now routes only to local machine agents and uses named return handlers', () => {
    const parsed = parseAgentBasedABL(readExample('BankNexus_Supervisor.agent.abl'));
    expect(parsed.errors).toHaveLength(0);

    const targets = parsed.document!.handoff.map((handoff) => handoff.to).sort();
    expect(targets).toEqual(['Fund_Transfer', 'Get_Balance', 'Transaction_History']);
    expect(targets).not.toContain('Live_Agent_Transfer');
    expect(targets).not.toContain('Farewell_Agent');
    expect(targets).not.toContain('Fallback_Handler');

    expect(parsed.document!.returnHandlers).toEqual(
      expect.objectContaining({
        await_next_request: expect.objectContaining({
          respond: expect.stringContaining('What else can I help'),
          continue: true,
        }),
        reclassify_intent: expect.objectContaining({
          clear: ['current_intent'],
          resumeIntent: true,
        }),
      }),
    );

    expect(parsed.document!.memory.recall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'session:start',
        }),
      ]),
    );
  });

  test('specialists establish account context before balance, transfer, and transaction actions', () => {
    const getBalance = readExample('get_balance.agent.abl');
    const fundTransfer = readExample('fund_transfer.agent.abl');
    const transactionHistory = readExample('transaction_history.agent.abl');
    const transactionHistoryParsed = parseAgentBasedABL(transactionHistory);
    const readme = readFileSync(BANKNEXUS_README, 'utf8');

    expect(transactionHistoryParsed.errors).toHaveLength(0);
    expect(transactionHistoryParsed.document!.flow.steps).toContain('apply_filter_choice');
    expect(readme).not.toContain('\n  tools/\n');

    expect(getBalance).toContain('selected_account_id');
    expect(getBalance).toContain('ARRAY_FIND(accountsResult.accounts, "id", selected_account_id)');

    expect(fundTransfer).toContain('get_accounts(customer_id: string)');
    expect(fundTransfer).toContain('fetch_source_accounts');
    expect(fundTransfer).toContain('choose_source_account');
    expect(fundTransfer).toContain('THEN: ESCALATE');

    expect(transactionHistory).toContain('get_accounts(customer_id: string)');
    expect(transactionHistory).toContain('choose_account');
    expect(transactionHistory).toContain('selected_transaction_id = user_choice');
  });
});
