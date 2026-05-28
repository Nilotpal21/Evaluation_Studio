/**
 * Rich Content Parser Tests
 *
 * Tests for FORMATS block parsing, multi-format template parsing,
 * and rich content on respond-capable AST nodes.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// Helper: parse and assert no errors
function parse(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).not.toBeNull();
  return result.document!;
}

describe('Rich Content Parser — FORMATS block', () => {
  test('parses FORMATS block with MARKDOWN on a flow step RESPOND', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello"
      FORMATS:
        MARKDOWN: "**Hello**"
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step).toBeDefined();
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.markdown).toBe('**Hello**');
  });

  test('parses FORMATS block with all 6 format keys', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hi"
      FORMATS:
        MARKDOWN: "**Hi**"
        ADAPTIVE_CARD: "card_json"
        HTML: "<b>Hi</b>"
        SLACK: "slack_json"
        AG_UI: "agui_json"
        WHATSAPP: "whatsapp_json"
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step).toBeDefined();
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.markdown).toBe('**Hi**');
    expect(step.richContent!.adaptiveCard).toBe('card_json');
    expect(step.richContent!.html).toBe('<b>Hi</b>');
    expect(step.richContent!.slack).toBe('slack_json');
    expect(step.richContent!.agUi).toBe('agui_json');
    expect(step.richContent!.whatsapp).toBe('whatsapp_json');
  });

  test('parses FORMATS block with multi-line MARKDOWN using |', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello user"
      FORMATS:
        MARKDOWN: |
          ## Welcome
          Hello **user**
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.markdown).toContain('## Welcome');
    expect(step.richContent!.markdown).toContain('Hello **user**');
  });

  test('parses FORMATS alongside VOICE block', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello"
      VOICE:
        INSTRUCTIONS: "Speak warmly"
      FORMATS:
        MARKDOWN: "**Hello**"
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step.voiceConfig).toBeDefined();
    expect(step.voiceConfig!.instructions).toBe('Speak warmly');
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.markdown).toBe('**Hello**');
  });

  test('RESPOND without FORMATS has undefined richContent', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello"
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step.richContent).toBeUndefined();
  });

  test('parses collection bindings for dynamic structured widgets', () => {
    const doc = parse(`
AGENT: Dynamic_Template_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  accounts:
    REASONING: false
    RESPOND: "Your accounts"
      FORMATS:
        TABLE:
          columns:
            from: "{{account_columns}}"
            template:
              key: "{{key}}"
              header: "{{header}}"
          rows:
            from: "{{accounts}}"
            template:
              account: "{{account_label}}"
              balance: "{{balance}}"
        LIST:
          title: "Accounts"
          items: "{{accounts}}"
        QUICK_REPLIES:
          from: "{{actions}}"
          template:
            id: "{{id}}"
            label: "{{label}}"
`);

    const step = doc.flow!.definitions['accounts'];
    expect(step.richContent?.table?.columns).toEqual({
      from: '{{account_columns}}',
      template: {
        key: '{{key}}',
        header: '{{header}}',
      },
    });
    expect(step.richContent?.table?.rows).toEqual({
      from: '{{accounts}}',
      template: {
        account: '{{account_label}}',
        balance: '{{balance}}',
      },
    });
    expect(step.richContent?.list?.items).toBe('{{accounts}}');
    expect(step.richContent?.quickReplies).toEqual({
      from: '{{actions}}',
      template: {
        id: '{{id}}',
        label: '{{label}}',
      },
    });
  });

  test('parses FORMATS on ON_START respond', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

ON_START:
  RESPOND: "Welcome!"
    FORMATS:
      MARKDOWN: "# Welcome!"
`);
    expect(doc.onStart).toBeDefined();
    expect(doc.onStart!.richContent).toBeDefined();
    expect(doc.onStart!.richContent!.markdown).toBe('# Welcome!');
  });

  test('parses FORMATS on COMPLETE conditions', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

COMPLETE:
  - WHEN: "task done"
    RESPOND: "Done!"
      FORMATS:
        MARKDOWN: "## Task Complete"
`);
    expect(doc.complete.length).toBeGreaterThan(0);
    expect(doc.complete[0].richContent).toBeDefined();
    expect(doc.complete[0].richContent!.markdown).toBe('## Task Complete');
  });

  test('parses FORMATS on ON_ERROR handler', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

ON_ERROR:
  tool_error:
    RESPOND: "Something went wrong"
      FORMATS:
        MARKDOWN: "**Error:** Something went wrong"
`);
    expect(doc.onError.length).toBeGreaterThan(0);
    expect(doc.onError[0].richContent).toBeDefined();
    expect(doc.onError[0].richContent!.markdown).toBe('**Error:** Something went wrong');
  });

  test('parses FORMATS with only partial format keys', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Info"
      FORMATS:
        MARKDOWN: "**Info**"
        HTML: "<em>Info</em>"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.markdown).toBe('**Info**');
    expect(step.richContent!.html).toBe('<em>Info</em>');
    expect(step.richContent!.adaptiveCard).toBeUndefined();
    expect(step.richContent!.slack).toBeUndefined();
    expect(step.richContent!.agUi).toBeUndefined();
    expect(step.richContent!.whatsapp).toBeUndefined();
  });
});

describe('Rich Content Parser — Multi-Format Templates', () => {
  test('parses multi-format template with DEFAULT and MARKDOWN', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  greeting:
    DEFAULT: "Hello, welcome!"
    MARKDOWN: "# Hello, welcome!"
`);
    const tpl = doc.templates.find((t) => t.name === 'greeting');
    expect(tpl).toBeDefined();
    expect(tpl!.content).toBe('Hello, welcome!');
    expect(tpl!.formats).toBeDefined();
    expect(tpl!.formats!.markdown).toBe('# Hello, welcome!');
  });

  test('parses template voice instructions and nested VOICE block', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  greeting:
    DEFAULT: "Hello, welcome!"
    VOICE INSTRUCTIONS: "Speak warmly."
  farewell:
    DEFAULT: "Goodbye."
    VOICE:
      INSTRUCTIONS: "Slow down on the final word."
      PLAIN_TEXT: "Goodbye for now."
`);
    const greeting = doc.templates.find((t) => t.name === 'greeting');
    const farewell = doc.templates.find((t) => t.name === 'farewell');
    expect(greeting?.voiceConfig?.instructions).toBe('Speak warmly.');
    expect(farewell?.voiceConfig).toEqual({
      instructions: 'Slow down on the final word.',
      plainText: 'Goodbye for now.',
      plain_text: 'Goodbye for now.',
    });
  });

  test('parses multi-format template with all format keys', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  booking:
    DEFAULT: "Booking confirmed"
    MARKDOWN: "## Booking Confirmed"
    ADAPTIVE_CARD: "card_json_content"
    HTML: "<h2>Booking Confirmed</h2>"
    SLACK: "slack_blocks_json"
    AG_UI: "agui_events_json"
    WHATSAPP: "whatsapp_msg_json"
`);
    const tpl = doc.templates.find((t) => t.name === 'booking');
    expect(tpl).toBeDefined();
    expect(tpl!.content).toBe('Booking confirmed');
    expect(tpl!.formats).toBeDefined();
    expect(tpl!.formats!.markdown).toBe('## Booking Confirmed');
    expect(tpl!.formats!.adaptiveCard).toBe('card_json_content');
    expect(tpl!.formats!.html).toBe('<h2>Booking Confirmed</h2>');
    expect(tpl!.formats!.slack).toBe('slack_blocks_json');
    expect(tpl!.formats!.agUi).toBe('agui_events_json');
    expect(tpl!.formats!.whatsapp).toBe('whatsapp_msg_json');
  });

  test('simple inline templates still work (backward compatibility)', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  farewell: "Goodbye!"
`);
    const tpl = doc.templates.find((t) => t.name === 'farewell');
    expect(tpl).toBeDefined();
    expect(tpl!.content).toBe('Goodbye!');
    expect(tpl!.formats).toBeUndefined();
  });

  test('mix of simple and multi-format templates', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  simple: "Just text"
  rich:
    DEFAULT: "Rich text"
    MARKDOWN: "# Rich text"
`);
    const simple = doc.templates.find((t) => t.name === 'simple');
    const rich = doc.templates.find((t) => t.name === 'rich');
    expect(simple).toBeDefined();
    expect(simple!.formats).toBeUndefined();
    expect(rich).toBeDefined();
    expect(rich!.formats).toBeDefined();
    expect(rich!.formats!.markdown).toBe('# Rich text');
  });

  test('multi-format template with multi-line MARKDOWN', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  info:
    DEFAULT: "Information provided"
    MARKDOWN: |
      ## Information
      Here is detailed info.
`);
    const tpl = doc.templates.find((t) => t.name === 'info');
    expect(tpl).toBeDefined();
    expect(tpl!.formats).toBeDefined();
    expect(tpl!.formats!.markdown).toContain('## Information');
    expect(tpl!.formats!.markdown).toContain('Here is detailed info.');
  });
});

describe('Rich Content Parser — Global Digression FORMATS', () => {
  test('parses FORMATS on global digression within FLOW', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hi"

  global_digressions:
    - INTENT: "off topic"
      RESPOND: "Let me help you refocus"
        FORMATS:
          MARKDOWN: "**Let me help you refocus**"
`);
    expect(doc.flow!.globalDigressions).toBeDefined();
    expect(doc.flow!.globalDigressions!.length).toBeGreaterThan(0);
    expect(doc.flow!.globalDigressions![0].richContent).toBeDefined();
    expect(doc.flow!.globalDigressions![0].richContent!.markdown).toBe(
      '**Let me help you refocus**',
    );
  });
});

describe('Rich Content Parser — Structured Widget Formats', () => {
  test('parses the rich widget inventory inside FORMATS', () => {
    const doc = parse(`
AGENT: Widget_Agent
GOAL: "Render widgets"
PERSONA: "Analyst"

FLOW:
  dashboard:
    REASONING: false
    RESPOND: "Operations dashboard"
      FORMATS:
        QUICK_REPLIES:
          - id: overview
            label: "Overview"
            icon_url: "https://example.com/icons/overview.svg"
          - id: incidents
            label: "Incidents"
        LIST:
          title: "Launch checklist"
          items:
            - title: "Capacity model"
              subtitle: "Validated in staging"
              image_url: "https://example.com/images/capacity.png"
              default_action_url: "https://example.com/runbook"
        IMAGE:
          url: "https://example.com/images/dashboard.png"
          alt: "Executive dashboard"
          caption: "Daily health snapshot"
        VIDEO:
          url: "https://example.com/videos/briefing.mp4"
          alt: "Weekly briefing"
        AUDIO:
          url: "https://example.com/audio/summary.mp3"
          caption: "Audio summary"
        FILE:
          url: "https://example.com/files/q2-brief.pdf"
          filename: "q2-brief.pdf"
          mime_type: "application/pdf"
        KPI:
          label: "Blocked launches"
          value: 3
          trend: up
          unit: "programs"
          icon_url: "https://example.com/icons/alert.svg"
        TABLE:
          columns:
            - key: name
              header: "Doctor"
              align: left
            - key: fee
              header: "Fee"
              align: right
          rows:
            - name: "Dr. Sharma"
              fee: 800
            - name: "Dr. Nair"
              fee: 1000
          max_visible_rows: 5
        CHART:
          type: bar
          title: "Resolution time"
          data:
            - label: "P1"
              value: 12
              color: "#ef4444"
            - label: "P2"
              value: 7
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
        PROGRESS:
          label: "Migration completion"
          value: 73
          max: 100
          variant: circle
        FEEDBACK:
          prompt: "Was this useful?"
          type: stars
          max: 5
`);

    const step = doc.flow!.definitions['dashboard'];
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.quickReplies).toHaveLength(2);
    expect(step.richContent!.quickReplies![0].iconUrl).toBe(
      'https://example.com/icons/overview.svg',
    );
    expect(step.richContent!.list?.items[0].defaultActionUrl).toBe('https://example.com/runbook');
    expect(step.richContent!.image?.alt).toBe('Executive dashboard');
    expect(step.richContent!.video?.url).toBe('https://example.com/videos/briefing.mp4');
    expect(step.richContent!.audio?.caption).toBe('Audio summary');
    expect(step.richContent!.file?.filename).toBe('q2-brief.pdf');
    expect(step.richContent!.kpi?.trend).toBe('up');
    expect(step.richContent!.table?.columns[1].align).toBe('right');
    expect(step.richContent!.table?.rows[1]).toEqual({ name: 'Dr. Nair', fee: 1000 });
    expect(step.richContent!.chart?.data[0].color).toBe('#ef4444');
    expect(step.richContent!.form?.fields[1].options?.[0].id).toBe('sev1');
    expect(step.richContent!.progress?.variant).toBe('circle');
    expect(step.richContent!.feedback?.type).toBe('stars');
  });

  test('parses shorthand TABLE columns and slash-delimited rows from FORMATS', () => {
    const doc = parse(`
AGENT: Doctor_Table
GOAL: "Show doctors"
PERSONA: "Helpful"

FLOW:
  start:
    REASONING: false
    RESPOND: "Doctor availability"
      FORMATS:
        TABLE:
          columns: [name, fee, rating]
          rows: ["Dr. Sharma/800/4.8", "Dr. Nair/1000/4.9"]
`);

    const table = doc.flow!.definitions['start'].richContent?.table;
    expect(table).toBeDefined();
    expect(table?.columns).toEqual([
      { key: 'name', header: 'name' },
      { key: 'fee', header: 'fee' },
      { key: 'rating', header: 'rating' },
    ]);
    expect(table?.rows).toEqual([
      { name: 'Dr. Sharma', fee: 800, rating: 4.8 },
      { name: 'Dr. Nair', fee: 1000, rating: 4.9 },
    ]);
  });

  test('parses structured template formats beyond markdown strings', () => {
    const doc = parse(`
AGENT: Template_Agent
GOAL: "Template test"
PERSONA: "Test"

TEMPLATES:
  doctor_dashboard:
    DEFAULT: "Doctor availability"
    KPI:
      label: "Available doctors"
      value: 2
      trend: up
    TABLE:
      columns:
        - key: name
          header: "Doctor"
        - key: rating
          header: "Rating"
      rows:
        - name: "Dr. Sharma"
          rating: 4.8
`);

    const template = doc.templates.find((entry) => entry.name === 'doctor_dashboard');
    expect(template?.content).toBe('Doctor availability');
    expect(template?.formats?.kpi).toEqual({
      label: 'Available doctors',
      value: 2,
      trend: 'up',
      unit: undefined,
      iconUrl: undefined,
    });
    expect(template?.formats?.table?.rows[0]).toEqual({ name: 'Dr. Sharma', rating: 4.8 });
  });
});

describe('Rich Content Parser — Backward Compatibility', () => {
  test('existing agent without any FORMATS parses correctly', () => {
    const doc = parse(`
AGENT: Legacy_Agent
GOAL: "Help users"
PERSONA: "Helpful assistant"

TOOLS:
  - search_web

COMPLETE:
  - WHEN: "task completed"
    RESPOND: "All done!"
`);
    expect(doc.name).toBe('Legacy_Agent');
    expect(doc.complete.length).toBeGreaterThan(0);
    expect(doc.complete[0].richContent).toBeUndefined();
  });

  test('full agent with VOICE but no FORMATS works unchanged', () => {
    const doc = parse(`
AGENT: Voice_Agent
GOAL: "Greet users"
PERSONA: "Friendly"

FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello!"
      VOICE:
        INSTRUCTIONS: "Be cheerful"
`);
    const step = doc.flow!.definitions['greeting'];
    expect(step).toBeDefined();
    expect(step.voiceConfig).toBeDefined();
    expect(step.richContent).toBeUndefined();
  });
});
