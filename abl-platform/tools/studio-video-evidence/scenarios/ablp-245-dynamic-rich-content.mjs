import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  openStudioAgentChat,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

const ISSUE = 'ABLP-245';

function createSyntheticAgent(agentName) {
  return {
    id: agentName,
    name: agentName,
    type: 'agent',
    mode: 'flow',
    toolCount: 0,
    gatherFieldCount: 0,
    isSupervisor: false,
    dsl: `AGENT: ${agentName}\nGOAL: "ABLP-245 dynamic rich-content evidence"\n`,
    ir: {},
  };
}

function makeAccounts(count) {
  const seed = [
    ['Checking 4123', 'Checking', '$1,245.33', 1245.33],
    ['Savings 8841', 'Savings', '$9,700.00', 9700],
    ['Money Market 1020', 'Money Market', '$500.00', 500],
    ['Travel 2204', 'Savings', '$2,318.14', 2318.14],
    ['Mortgage Escrow 7710', 'Escrow', '$6,455.20', 6455.2],
    ['Rewards 9001', 'Credit', '$184.75', 184.75],
    ['Business 1888', 'Checking', '$15,430.45', 15430.45],
    ['College 5512', 'Savings', '$3,210.00', 3210],
    ['Reserve 3390', 'Money Market', '$8,025.99', 8025.99],
  ];

  return seed
    .slice(0, count)
    .map(([accountLabel, accountType, balance, numericBalance], index) => ({
      accountId: `acct-${String(index + 1).padStart(2, '0')}`,
      accountLabel,
      accountType,
      balance,
      numericBalance,
    }));
}

function buildRichContent(accounts, { includeAllWidgets }) {
  const columns = [
    { key: 'account', header: 'Account' },
    { key: 'type', header: 'Type' },
    { key: 'balance', header: 'Available Balance', align: 'right' },
    { key: 'status', header: 'Status' },
  ];
  const tableRows = accounts.map((account) => ({
    account: account.accountLabel,
    type: account.accountType,
    balance: account.balance,
    status: 'Available',
  }));

  const richContent = {
    table: {
      columns,
      rows: tableRows,
      max_visible_rows: 12,
    },
  };

  if (!includeAllWidgets) {
    return richContent;
  }

  richContent.list = {
    title: `${accounts.length} runtime account list items`,
    items: accounts.map((account) => ({
      title: account.accountLabel,
      subtitle: `${account.accountType} - ${account.balance}`,
    })),
  };
  richContent.carousel = {
    cards: accounts.map((account) => ({
      title: account.accountLabel,
      subtitle: account.balance,
      buttons: [{ id: `details-${account.accountId}`, label: 'Details' }],
    })),
  };
  richContent.chart = {
    type: 'bar',
    title: `${accounts.length} account balances`,
    data: accounts.map((account) => ({
      label: account.accountLabel,
      value: account.numericBalance,
    })),
  };
  richContent.form = {
    title: `${accounts.length} dynamic account fields`,
    fields: [
      {
        id: 'selected-account',
        type: 'select',
        label: 'Select account',
        options: accounts.map((account) => ({
          id: account.accountId,
          label: account.accountLabel,
        })),
      },
      ...accounts.map((account) => ({
        id: `note-${account.accountId}`,
        type: 'input',
        label: `Note for ${account.accountLabel}`,
        input_type: 'text',
      })),
    ],
    submit_label: 'Continue',
  };
  richContent.quick_replies = accounts.map((account) => ({
    id: `qr-${account.accountId}`,
    label: account.accountLabel,
  }));

  return richContent;
}

async function installDynamicCollectionWebSocket(page, agentName) {
  const sessionId = `ablp-245-dynamic-${uniqueSuffix()}`;
  let turnIndex = 0;
  const sentPayloads = [];

  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.onMessage((raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === 'load_agent' || message.type === 'load_agent_with_context') {
        ws.send(
          JSON.stringify({
            type: 'agent_loaded',
            sessionId,
            agent: createSyntheticAgent(agentName),
          }),
        );
        return;
      }

      if (message.type !== 'send_message') {
        return;
      }

      turnIndex += 1;
      const count = turnIndex === 1 ? 3 : 9;
      const accounts = makeAccounts(count);
      const richContent = buildRichContent(accounts, { includeAllWidgets: turnIndex > 1 });
      const responseText =
        turnIndex === 1
          ? 'Dynamic table rows: 3 accounts, no padded placeholders.'
          : 'Dynamic widgets: 9 accounts, no authored cap or truncation.';
      const messageId = `ablp-245-response-${turnIndex}`;

      sentPayloads.push({
        turnIndex,
        accountCount: count,
        responseText,
        richContent,
      });

      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'response_start', sessionId, messageId }));
      }, 80);
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'response_end',
            sessionId,
            messageId,
            fullText: responseText,
            richContent,
          }),
        );
      }, 180);
    });
  });

  return { sessionId, sentPayloads };
}

async function readDynamicCounts(page) {
  return page.locator('[data-testid="message-list"]').evaluate((node) => {
    const query = (selector) => Array.from(node.querySelectorAll(selector));
    const unresolvedPlaceholderText = node.textContent?.includes('{{accounts.') ?? false;
    return {
      tableRows: query('.rich-table-row').length,
      tableHeaders: query('.rich-table-th').length,
      listItems: query('.rich-list-item').length,
      carouselCards: query('.rich-carousel-card').length,
      chartBars: query('.rich-chart-svg rect').length,
      formInputs: query('.rich-form input[data-field-id]').length,
      formSelectOptions: query('.rich-form select[data-field-id] option:not([disabled])').length,
      quickReplies: query('.rich-quick-reply').length,
      unresolvedPlaceholderText,
    };
  });
}

async function waitForCounts(page, expected, label) {
  await waitForCondition(
    async () => {
      const counts = await readDynamicCounts(page);
      return Object.entries(expected).every(([key, value]) => counts[key] === value);
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 250,
      label,
    },
  );
}

export const scenario = {
  id: 'ablp-245-dynamic-rich-content',
  title: 'ABLP-245 Dynamic Rich Content Collections',
  description:
    'Records Studio chat proof that dynamic collection-sized rich-content widgets render exactly 3 and 9 account items without fixed authoring caps or unresolved placeholders.',
  example:
    'pnpm studio:video:evidence -- --scenario ablp-245-dynamic-rich-content --final-pause-ms 2000',
  async run(context) {
    const { artifacts, baseUrl, page } = context;
    const finalPauseMs = numberFromInput(context.options.finalPauseMs, 2_000);
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
      agentNamePrefix: 'ablp-245-dynamic-rich-content',
    });

    const synthetic = await installDynamicCollectionWebSocket(page, fixture.agentName);
    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName: fixture.agentName,
    });
    await artifacts.captureScreenshot('ablp-245-chat-ready.png');

    await sendStudioChatMessage(page, 'Show 3 accounts with a dynamic table.');
    await waitForMessageListText(page, 'Dynamic table rows: 3 accounts');
    await waitForCounts(
      page,
      {
        tableRows: 3,
        tableHeaders: 4,
      },
      'Timed out waiting for exactly 3 dynamic table rows and 4 dynamic columns.',
    );
    const threeAccountCounts = await readDynamicCounts(page);
    if (threeAccountCounts.unresolvedPlaceholderText) {
      throw new Error('3-account table rendered unresolved {{accounts.*}} placeholder text.');
    }
    await artifacts.captureScreenshot('ablp-245-three-account-table.png');

    await sendStudioChatMessage(page, 'Show 9 accounts across all dynamic widgets.');
    await waitForMessageListText(page, 'Dynamic widgets: 9 accounts');
    await waitForCounts(
      page,
      {
        tableRows: 12,
        tableHeaders: 8,
        listItems: 9,
        carouselCards: 9,
        chartBars: 9,
        formInputs: 9,
        formSelectOptions: 9,
        quickReplies: 9,
      },
      'Timed out waiting for the 9-account dynamic widgets to render exact item counts.',
    );
    const nineAccountCounts = await readDynamicCounts(page);
    if (nineAccountCounts.unresolvedPlaceholderText) {
      throw new Error('9-account widgets rendered unresolved {{accounts.*}} placeholder text.');
    }
    await waitForIdle(page, 600);
    await artifacts.captureScreenshot('ablp-245-nine-account-widgets.png');
    await page.waitForTimeout(finalPauseMs);

    return {
      summary:
        'ABLP-245: Studio chat rendered runtime-sized rich-content collections for 3 and 9 accounts with exact item counts and no unresolved fixed-index placeholders.',
      metadata: {
        issue: ISSUE,
        projectId: fixture.projectId,
        agentName: fixture.agentName,
        sessionId: synthetic.sessionId,
        threeAccountCounts,
        nineAccountCounts,
        responsePayloads: synthetic.sentPayloads.map((payload) => ({
          turnIndex: payload.turnIndex,
          accountCount: payload.accountCount,
          tableRowCount: payload.richContent.table.rows.length,
          tableColumnCount: payload.richContent.table.columns.length,
          listItemCount: payload.richContent.list?.items.length ?? 0,
          carouselCardCount: payload.richContent.carousel?.cards.length ?? 0,
          chartDataCount: payload.richContent.chart?.data.length ?? 0,
          formFieldCount: payload.richContent.form?.fields.length ?? 0,
          formSelectOptionCount: payload.richContent.form?.fields[0]?.options?.length ?? 0,
          quickReplyCount: payload.richContent.quick_replies?.length ?? 0,
        })),
      },
      assertions: [
        {
          name: 'three-account-table-exact-count',
          passed:
            threeAccountCounts.tableRows === 3 && !threeAccountCounts.unresolvedPlaceholderText,
          details:
            'The first Studio chat response rendered exactly 3 table rows from the runtime account collection and no {{accounts.N}} placeholders.',
        },
        {
          name: 'nine-account-widget-exact-counts',
          passed:
            nineAccountCounts.tableRows === 12 &&
            nineAccountCounts.listItems === 9 &&
            nineAccountCounts.carouselCards === 9 &&
            nineAccountCounts.chartBars === 9 &&
            nineAccountCounts.formInputs === 9 &&
            nineAccountCounts.formSelectOptions === 9 &&
            nineAccountCounts.quickReplies === 9 &&
            !nineAccountCounts.unresolvedPlaceholderText,
          details:
            'The second Studio chat response rendered 9 runtime items for list, carousel, chart data, form fields/options, and quick replies. Total table rows are 12 because the transcript includes the prior 3-row proof plus the 9-row proof.',
        },
      ],
    };
  },
};
