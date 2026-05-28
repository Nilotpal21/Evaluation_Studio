import { beforeEach, describe, expect, test } from 'vitest';

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { buildExecutionOutcome } from '../../services/channel/outcome.js';
import { ServerMessages } from '../../websocket/events.js';

type RichContentAssertion = (richContent: Record<string, unknown> | undefined) => void;

interface RuntimeRichContentCase {
  agentName: string;
  responseText: string;
  contentBlock: string;
  assertRichContent: RichContentAssertion;
}

const RUNTIME_RICH_CONTENT_CASES: RuntimeRichContentCase[] = [
  {
    agentName: 'Markdown_Runtime',
    responseText: 'Weekly revenue watch',
    contentBlock: `
        MARKDOWN: |
          # Weekly Revenue Watch
          | Region | Pipeline |
          | --- | --- |
          | NA | $1.8M |
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        markdown: expect.stringContaining('| Region | Pipeline |'),
      });
    },
  },
  {
    agentName: 'Quick_Replies_Runtime',
    responseText: 'Choose a workflow',
    contentBlock: `
        QUICK_REPLIES:
          - id: launch
            label: "Launch readiness"
          - id: rollback
            label: "Rollback plan"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        quick_replies: [
          { id: 'launch', label: 'Launch readiness' },
          { id: 'rollback', label: 'Rollback plan' },
        ],
      });
    },
  },
  {
    agentName: 'List_Runtime',
    responseText: 'Top workstreams',
    contentBlock: `
        LIST:
          title: "Top workstreams"
          items:
            - title: "Identity migration"
              subtitle: "Blocked on staging certs"
              default_action_url: "https://example.com/runbook"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        list: {
          title: 'Top workstreams',
          items: [
            {
              title: 'Identity migration',
              subtitle: 'Blocked on staging certs',
              default_action_url: 'https://example.com/runbook',
            },
          ],
        },
      });
    },
  },
  {
    agentName: 'Image_Runtime',
    responseText: 'Snapshot attached',
    contentBlock: `
        IMAGE:
          url: "https://example.com/images/snapshot.png"
          alt: "Executive snapshot"
          caption: "Deployment health"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        image: {
          url: 'https://example.com/images/snapshot.png',
          alt: 'Executive snapshot',
          caption: 'Deployment health',
        },
      });
    },
  },
  {
    agentName: 'Video_Runtime',
    responseText: 'Briefing clip attached',
    contentBlock: `
        VIDEO:
          url: "https://example.com/videos/briefing.mp4"
          alt: "Briefing clip"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        video: {
          url: 'https://example.com/videos/briefing.mp4',
          alt: 'Briefing clip',
        },
      });
    },
  },
  {
    agentName: 'Audio_Runtime',
    responseText: 'Audio recap attached',
    contentBlock: `
        AUDIO:
          url: "https://example.com/audio/recap.mp3"
          caption: "Audio recap"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        audio: {
          url: 'https://example.com/audio/recap.mp3',
          caption: 'Audio recap',
        },
      });
    },
  },
  {
    agentName: 'File_Runtime',
    responseText: 'Runbook attached',
    contentBlock: `
        FILE:
          url: "https://example.com/files/runbook.pdf"
          filename: "runbook.pdf"
          mime_type: "application/pdf"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        file: {
          url: 'https://example.com/files/runbook.pdf',
          filename: 'runbook.pdf',
          mime_type: 'application/pdf',
        },
      });
    },
  },
  {
    agentName: 'Kpi_Runtime',
    responseText: 'Critical metrics',
    contentBlock: `
        KPI:
          label: "Blocked launches"
          value: 3
          trend: up
          unit: "programs"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        kpi: {
          label: 'Blocked launches',
          value: 3,
          trend: 'up',
          unit: 'programs',
        },
      });
    },
  },
  {
    agentName: 'Table_Runtime',
    responseText: 'Doctor availability',
    contentBlock: `
        TABLE:
          columns:
            - key: name
              header: "Doctor"
            - key: fee
              header: "Fee"
              align: right
          rows:
            - name: "Dr. Sharma"
              fee: 800
            - name: "Dr. Nair"
              fee: 1000
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        table: {
          columns: [
            { key: 'name', header: 'Doctor' },
            { key: 'fee', header: 'Fee', align: 'right' },
          ],
          rows: [
            { name: 'Dr. Sharma', fee: 800 },
            { name: 'Dr. Nair', fee: 1000 },
          ],
        },
      });
    },
  },
  {
    agentName: 'Chart_Runtime',
    responseText: 'Incident trend',
    contentBlock: `
        CHART:
          type: bar
          title: "Incident trend"
          data:
            - label: "P1"
              value: 12
            - label: "P2"
              value: 7
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        chart: {
          type: 'bar',
          title: 'Incident trend',
          data: [
            { label: 'P1', value: 12 },
            { label: 'P2', value: 7 },
          ],
        },
      });
    },
  },
  {
    agentName: 'Form_Runtime',
    responseText: 'Fill the handoff form',
    contentBlock: `
        FORM:
          title: "Escalation handoff"
          fields:
            - id: owner
              type: input
              label: "Owner"
              input_type: text
              required: true
            - id: severity
              type: select
              label: "Severity"
              options:
                - id: sev1
                  label: "SEV-1"
                - id: sev2
                  label: "SEV-2"
          submit_label: "Create handoff"
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        form: {
          title: 'Escalation handoff',
          submit_label: 'Create handoff',
          fields: [
            { id: 'owner', type: 'input', label: 'Owner', input_type: 'text', required: true },
            {
              id: 'severity',
              type: 'select',
              label: 'Severity',
              options: [
                { id: 'sev1', label: 'SEV-1' },
                { id: 'sev2', label: 'SEV-2' },
              ],
            },
          ],
        },
      });
    },
  },
  {
    agentName: 'Progress_Runtime',
    responseText: 'Migration progress',
    contentBlock: `
        PROGRESS:
          label: "Migration progress"
          value: 73
          max: 100
          variant: circle
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        progress: {
          label: 'Migration progress',
          value: 73,
          max: 100,
          variant: 'circle',
        },
      });
    },
  },
  {
    agentName: 'Feedback_Runtime',
    responseText: 'Rate this response',
    contentBlock: `
        FEEDBACK:
          prompt: "Rate this response"
          type: stars
          max: 5
`,
    assertRichContent: (richContent) => {
      expect(richContent).toMatchObject({
        feedback: {
          prompt: 'Rate this response',
          type: 'stars',
          max: 5,
        },
      });
    },
  },
];

function buildFlowAgentDsl(agentName: string, responseText: string, contentBlock: string): string {
  return `
AGENT: ${agentName}
GOAL: "Exercise rich content"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "${responseText}"
      FORMATS:
${contentBlock}
    THEN: COMPLETE
`;
}

describe('flow rich content templates', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  for (const scenario of RUNTIME_RICH_CONTENT_CASES) {
    test(`returns ${scenario.agentName} rich content from an actual FLOW agent`, async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [buildFlowAgentDsl(scenario.agentName, scenario.responseText, scenario.contentBlock)],
          scenario.agentName,
        ),
      );

      const chunks: string[] = [];
      const result = await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

      expect(chunks.join('')).toContain(scenario.responseText);
      scenario.assertRichContent(result?.richContent as Record<string, unknown> | undefined);
    });
  }

  test('preserves first child FLOW actions and markdown through a supervisor handoff outcome', async () => {
    const supervisorDsl = `
AGENT: Rich_Handoff_Supervisor
GOAL: "Route to child"
PERSONA: "Supervisor"

HANDOFF:
  - TO: Rich_Handoff_Child
    WHEN: needs_child == true
    RETURN: false

FLOW:
  entry_point: wait
  steps:
    - wait

wait:
    REASONING: false
    GATHER:
      - request: required
        prompt: "How can I help?"
        type: string
    THEN: COMPLETE
`;
    const childDsl = `
AGENT: Rich_Handoff_Child
GOAL: "Return rich first response"
PERSONA: "Child"

FLOW:
  start:
    REASONING: false
    RESPOND: "Child plan ready"
      FORMATS:
        MARKDOWN: |
          **Child** plan ready
      ACTIONS:
        - BUTTON: "Approve" -> approve_plan
        - BUTTON: "Revise" -> revise_plan
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, childDsl], 'Rich_Handoff_Supervisor'),
    );
    await executor.initializeSession(session.id);
    session.data.values.needs_child = true;
    session.handoffReturnInfo = { Rich_Handoff_Child: false };

    const result = await executor.executeMessage(session.id, 'please route this to the child');
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: result!,
      session,
    });

    expect(result?.response).toBe('Child plan ready');
    expect(outcome).toMatchObject({
      status: 'ok',
      responseText: 'Child plan ready',
      action: { type: 'handoff', target: 'Rich_Handoff_Child' },
      richContent: {
        markdown: expect.stringContaining('**Child** plan ready'),
      },
      actions: {
        elements: [
          { type: 'button', id: 'approve_plan', label: 'Approve' },
          { type: 'button', id: 'revise_plan', label: 'Revise' },
        ],
      },
    });
  });

  test('does not synthesize handoff rich content when the first child FLOW response is plain text', async () => {
    const supervisorDsl = `
AGENT: Plain_Handoff_Supervisor
GOAL: "Route to child"
PERSONA: "Supervisor"

HANDOFF:
  - TO: Plain_Handoff_Child
    WHEN: needs_child == true
    RETURN: false

FLOW:
  entry_point: wait
  steps:
    - wait

wait:
    REASONING: false
    GATHER:
      - request: required
        prompt: "How can I help?"
        type: string
    THEN: COMPLETE
`;
    const childDsl = `
AGENT: Plain_Handoff_Child
GOAL: "Return plain first response"
PERSONA: "Child"

FLOW:
  start:
    REASONING: false
    RESPOND: "Plain child response"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, childDsl], 'Plain_Handoff_Supervisor'),
    );
    await executor.initializeSession(session.id);
    session.data.values.needs_child = true;
    session.handoffReturnInfo = { Plain_Handoff_Child: false };

    const result = await executor.executeMessage(session.id, 'please route this to the child');
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: result!,
      session,
    });

    expect(outcome).toMatchObject({
      status: 'ok',
      responseText: 'Plain child response',
      action: { type: 'handoff', target: 'Plain_Handoff_Child' },
    });
    expect(outcome.richContent).toBeUndefined();
    expect(outcome.actions).toBeUndefined();
  });

  test('returns TABLE rich content for the shorthand doctor availability authoring style', async () => {
    const dsl = `
AGENT: Doctor_Table_Short
GOAL: "Exercise shorthand table formats"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "Doctor availability"
      FORMATS:
        TABLE:
          columns: [name, fee, rating]
          rows: ["Dr. Sharma/800/4.8", "Dr. Nair/1000/4.9"]
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Doctor_Table_Short'),
    );

    const result = await executor.initializeSession(session.id);

    expect(result?.richContent).toMatchObject({
      table: {
        columns: [
          { key: 'name', header: 'name' },
          { key: 'fee', header: 'fee' },
          { key: 'rating', header: 'rating' },
        ],
        rows: [
          { name: 'Dr. Sharma', fee: 800, rating: 4.8 },
          { name: 'Dr. Nair', fee: 1000, rating: 4.9 },
        ],
      },
    });
  });

  test('serializes FLOW-authored table content into the websocket response_end payload', async () => {
    const dsl = `
AGENT: Doctor_Table_Response_End
GOAL: "Exercise response_end serialization"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "Doctor availability"
      FORMATS:
        TABLE:
          columns: [name, fee, rating]
          rows: ["Dr. Sharma/800/4.8", "Dr. Nair/1000/4.9"]
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Doctor_Table_Response_End'),
    );

    const result = await executor.initializeSession(session.id);
    const message = ServerMessages.responseEnd(
      session.id,
      'msg_doctor_table',
      result?.response ?? '',
      undefined,
      result?.richContent,
    ) as Record<string, unknown>;

    expect(message).toMatchObject({
      type: 'response_end',
      fullText: 'Doctor availability',
      richContent: {
        table: {
          columns: [
            { key: 'name', header: 'name' },
            { key: 'fee', header: 'fee' },
            { key: 'rating', header: 'rating' },
          ],
          rows: [
            { name: 'Dr. Sharma', fee: 800, rating: 4.8 },
            { name: 'Dr. Nair', fee: 1000, rating: 4.9 },
          ],
        },
      },
    });
  });

  test('expands FLOW-authored dynamic table rows from runtime session data', async () => {
    const dsl = `
AGENT: Dynamic_Account_Table
GOAL: "Exercise dynamic table content"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "Your BankNexus accounts"
      FORMATS:
        TABLE:
          columns:
            - key: account
              header: "Account"
            - key: type
              header: "Type"
            - key: balance
              header: "Available Balance"
              align: right
          rows:
            from: "{{accounts}}"
            template:
              account: "{{account_label}}"
              type: "{{account_type}}"
              balance: "{{balance}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Dynamic_Account_Table'),
    );
    session.data.values.accounts = [
      { account_label: 'Checking 4123', account_type: 'Checking', balance: '$1,245.33' },
      { account_label: 'Savings 8841', account_type: 'Savings', balance: '$9,700.00' },
      { account_label: 'Money Market 1020', account_type: 'Money Market', balance: '$500.00' },
    ];

    const result = await executor.initializeSession(session.id);
    const message = ServerMessages.responseEnd(
      session.id,
      'msg_dynamic_accounts',
      result?.response ?? '',
      undefined,
      result?.richContent,
    ) as Record<string, unknown>;

    expect(message).toMatchObject({
      type: 'response_end',
      richContent: {
        table: {
          rows: [
            { account: 'Checking 4123', type: 'Checking', balance: '$1,245.33' },
            { account: 'Savings 8841', type: 'Savings', balance: '$9,700.00' },
            { account: 'Money Market 1020', type: 'Money Market', balance: '$500.00' },
          ],
        },
      },
    });
  });

  test('returns carousel rich content from an actual FLOW agent', async () => {
    const dsl = `
AGENT: Carousel_Runtime
GOAL: "Exercise carousel rich content"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "Top plans"
      CAROUSEL:
        - TITLE: "Basic"
          SUBTITLE: "$19/month"
          IMAGE: "https://example.com/basic.png"
          BUTTONS:
            - BUTTON: "Select Basic" -> basic
        - TITLE: "Pro"
          SUBTITLE: "$49/month"
          IMAGE: "https://example.com/pro.png"
          BUTTONS:
            - BUTTON: "Select Pro" -> pro
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Carousel_Runtime'),
    );

    const result = await executor.initializeSession(session.id);

    expect(result?.response).toContain('Top plans');
    expect(result?.richContent).toMatchObject({
      carousel: {
        cards: [
          {
            title: 'Basic',
            subtitle: '$19/month',
            image_url: 'https://example.com/basic.png',
          },
          {
            title: 'Pro',
            subtitle: '$49/month',
            image_url: 'https://example.com/pro.png',
          },
        ],
      },
    });
  });
});
