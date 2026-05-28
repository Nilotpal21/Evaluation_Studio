/**
 * Rich Content IR Compilation Tests
 *
 * Verifies that RichContentAST → RichContentIR compilation works correctly,
 * including camelCase→snake_case conversion, template format compilation,
 * and resolveAllTemplateRefs rich_content propagation.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR, compileTemplateFormats } from '../../platform/ir/compiler.js';
import type {
  RichContentIR,
  ActionSetIR,
  ActionElementIR,
  ActionHandlerIR,
  QuickReplyIR,
  ListTemplateIR,
  MediaContentIR,
  FileContentIR,
  KPITemplateIR,
  TableTemplateIR,
  ChartTemplateIR,
  FormTemplateIR,
  ProgressTemplateIR,
  FeedbackTemplateIR,
} from '../../platform/ir/schema.js';

// Helper: parse + compile and return agent IR
function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('Rich Content Compilation — compileRichContent', () => {
  test('compiles MARKDOWN format to snake_case IR', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Hello"
      FORMATS:
        MARKDOWN: "**Hello**"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step).toBeDefined();
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.markdown).toBe('**Hello**');
  });

  test('compiles all 6 format fields with correct camelCase→snake_case', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Multi"
      FORMATS:
        MARKDOWN: "**Multi**"
        ADAPTIVE_CARD: "card_type_json"
        HTML: "<b>Multi</b>"
        SLACK: "slack_blocks"
        AG_UI: "agui_events"
        WHATSAPP: "whatsapp_text"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.markdown).toBe('**Multi**');
    expect(step.rich_content!.adaptive_card).toBe('card_type_json');
    expect(step.rich_content!.html).toBe('<b>Multi</b>');
    expect(step.rich_content!.slack).toBe('slack_blocks');
    expect(step.rich_content!.ag_ui).toBe('agui_events');
    expect(step.rich_content!.whatsapp).toBe('whatsapp_text');
  });

  test('compiles rich_content on COMPLETE conditions', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

COMPLETE:
  - WHEN: "task done"
    RESPOND: "Done!"
      FORMATS:
        MARKDOWN: "## Done!"
`,
      'Test_Agent',
    );

    expect(ir.completion).toBeDefined();
    expect(ir.completion!.conditions.length).toBeGreaterThan(0);
    expect(ir.completion!.conditions[0].rich_content).toBeDefined();
    expect(ir.completion!.conditions[0].rich_content!.markdown).toBe('## Done!');
  });

  test('compiles rich_content on ON_START', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

ON_START:
  RESPOND: "Welcome"
    FORMATS:
      MARKDOWN: "# Welcome"
`,
      'Test_Agent',
    );

    expect(ir.on_start).toBeDefined();
    expect(ir.on_start!.rich_content).toBeDefined();
    expect(ir.on_start!.rich_content!.markdown).toBe('# Welcome');
  });

  test('compiles rich_content on error handlers', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

ON_ERROR:
  tool_error:
    RESPOND: "Error occurred"
      FORMATS:
        MARKDOWN: "**Error** occurred"
`,
      'Test_Agent',
    );

    expect(ir.error_handling).toBeDefined();
    expect(ir.error_handling!.handlers.length).toBeGreaterThan(0);
    expect(ir.error_handling!.handlers[0].rich_content).toBeDefined();
    expect(ir.error_handling!.handlers[0].rich_content!.markdown).toBe('**Error** occurred');
  });

  test('undefined richContent AST compiles to undefined IR', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Plain text"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeUndefined();
  });

  test('empty FORMATS block (no valid keys) results in undefined rich_content', () => {
    // A RESPOND with FORMATS but no actual format keys inside should produce undefined
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Test"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeUndefined();
  });
});

describe('Rich Content Compilation — Template Formats', () => {
  test('compileTemplateFormats extracts format variants from templates', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  greeting:
    DEFAULT: "Hello!"
    MARKDOWN: "# Hello!"
    HTML: "<h1>Hello!</h1>"
`);
    expect(parseResult.errors).toHaveLength(0);
    const formats = compileTemplateFormats(parseResult.document!);
    expect(formats['greeting']).toBeDefined();
    expect(formats['greeting'].markdown).toBe('# Hello!');
    expect(formats['greeting'].html).toBe('<h1>Hello!</h1>');
  });

  test('compileTemplateFormats returns empty for simple templates', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  farewell: "Goodbye!"
`);
    expect(parseResult.errors).toHaveLength(0);
    const formats = compileTemplateFormats(parseResult.document!);
    expect(formats['farewell']).toBeUndefined();
  });

  test('compileTemplateFormats handles mix of simple and multi-format', () => {
    const parseResult = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  simple: "Plain text"
  rich:
    DEFAULT: "Rich"
    MARKDOWN: "## Rich"
`);
    expect(parseResult.errors).toHaveLength(0);
    const formats = compileTemplateFormats(parseResult.document!);
    expect(formats['simple']).toBeUndefined();
    expect(formats['rich']).toBeDefined();
    expect(formats['rich'].markdown).toBe('## Rich');
  });
});

describe('Rich Content Compilation — Template Resolution', () => {
  test('TEMPLATE(name) ref populates rich_content from template formats', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  welcome:
    DEFAULT: "Welcome aboard!"
    MARKDOWN: "# Welcome aboard!"

ON_START:
  RESPOND: TEMPLATE(welcome)
`,
      'Test_Agent',
    );

    expect(ir.on_start).toBeDefined();
    expect(ir.on_start!.respond).toBe('Welcome aboard!');
    expect(ir.on_start!.rich_content).toBeDefined();
    expect(ir.on_start!.rich_content!.markdown).toBe('# Welcome aboard!');
  });

  test('TEMPLATE(name) ref for COMPLETE populates rich_content', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  done:
    DEFAULT: "All done!"
    MARKDOWN: "## All done!"

COMPLETE:
  - WHEN: "finished"
    RESPOND: TEMPLATE(done)
`,
      'Test_Agent',
    );

    expect(ir.completion!.conditions[0].respond).toBe('All done!');
    expect(ir.completion!.conditions[0].rich_content).toBeDefined();
    expect(ir.completion!.conditions[0].rich_content!.markdown).toBe('## All done!');
  });

  test('TEMPLATE(name) without formats does not set rich_content', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

TEMPLATES:
  plain: "Just plain text"

ON_START:
  RESPOND: TEMPLATE(plain)
`,
      'Test_Agent',
    );

    expect(ir.on_start!.respond).toBe('Just plain text');
    expect(ir.on_start!.rich_content).toBeUndefined();
  });

  test('explicit rich_content is not overridden by template format', () => {
    // If the RESPOND already has its own FORMATS block, TEMPLATE format should not override
    const ir = compileFromDSL(
      `
AGENT: Test_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Direct content"
      FORMATS:
        MARKDOWN: "**Direct content**"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.markdown).toBe('**Direct content**');
  });

  test('compiles structured widget formats from FORMATS into rich_content IR', () => {
    const ir = compileFromDSL(
      `
AGENT: Widget_Agent

GOAL: "Test"
PERSONA: "Test"

FLOW:
  dashboard:
    REASONING: false
    RESPOND: "Operations dashboard"
      FORMATS:
        QUICK_REPLIES:
          - id: overview
            label: "Overview"
        IMAGE:
          url: "https://example.com/dashboard.png"
          alt: "Executive dashboard"
        KPI:
          label: "Blocked launches"
          value: 3
          trend: up
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
        CHART:
          type: line
          title: "Resolution time"
          data:
            - label: "P1"
              value: 12
        FORM:
          title: "Escalation handoff"
          fields:
            - id: owner
              type: input
              label: "Owner"
              input_type: text
              required: true
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
`,
      'Widget_Agent',
    );

    const step = ir.flow!.definitions['dashboard'];
    expect(step.rich_content).toEqual(
      expect.objectContaining({
        quick_replies: [{ id: 'overview', label: 'Overview', icon_url: undefined }],
        image: {
          url: 'https://example.com/dashboard.png',
          alt: 'Executive dashboard',
          thumbnail_url: undefined,
          caption: undefined,
        },
        kpi: {
          label: 'Blocked launches',
          value: 3,
          unit: undefined,
          trend: 'up',
          icon_url: undefined,
        },
        chart: {
          type: 'line',
          title: 'Resolution time',
          data: [{ label: 'P1', value: 12, color: undefined }],
        },
        progress: {
          label: 'Migration completion',
          value: 73,
          max: 100,
          variant: 'circle',
        },
        feedback: {
          prompt: 'Was this useful?',
          type: 'stars',
          max: 5,
        },
      }),
    );
    expect(step.rich_content?.table).toEqual({
      columns: [
        { key: 'name', header: 'Doctor', align: undefined },
        { key: 'fee', header: 'Fee', align: 'right' },
      ],
      rows: [{ name: 'Dr. Sharma', fee: 800 }],
      max_visible_rows: undefined,
    });
    expect(step.rich_content?.form).toEqual({
      title: 'Escalation handoff',
      fields: [
        {
          id: 'owner',
          type: 'input',
          label: 'Owner',
          value: undefined,
          description: undefined,
          options: undefined,
          input_type: 'text',
          placeholder: undefined,
          required: true,
        },
      ],
      submit_label: 'Create handoff',
    });
  });

  test('compiles shorthand TABLE rows authored in FORMATS', () => {
    const ir = compileFromDSL(
      `
AGENT: Doctor_Table

GOAL: "Test"
PERSONA: "Test"

FLOW:
  start:
    REASONING: false
    RESPOND: "Doctor availability"
      FORMATS:
        TABLE:
          columns: [name, fee, rating]
          rows: ["Dr. Sharma/800/4.8", "Dr. Nair/1000/4.9"]
`,
      'Doctor_Table',
    );

    expect(ir.flow!.definitions['start'].rich_content?.table).toEqual({
      columns: [
        { key: 'name', header: 'name', align: undefined },
        { key: 'fee', header: 'fee', align: undefined },
        { key: 'rating', header: 'rating', align: undefined },
      ],
      rows: [
        { name: 'Dr. Sharma', fee: 800, rating: 4.8 },
        { name: 'Dr. Nair', fee: 1000, rating: 4.9 },
      ],
      max_visible_rows: undefined,
    });
  });

  test('compiles dynamic collection bindings for structured widget arrays', () => {
    const ir = compileFromDSL(
      `
AGENT: Dynamic_Collections

GOAL: "Test"
PERSONA: "Test"

FLOW:
  start:
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
        QUICK_REPLIES:
          from: "{{actions}}"
          template:
            id: "{{id}}"
            label: "{{label}}"
        LIST:
          title: "Accounts"
          items: "{{accounts}}"
`,
      'Dynamic_Collections',
    );

    expect(ir.flow!.definitions['start'].rich_content?.table?.columns).toEqual({
      from: '{{account_columns}}',
      template: {
        key: '{{key}}',
        header: '{{header}}',
        align: undefined,
      },
    });
    expect(ir.flow!.definitions['start'].rich_content?.table?.rows).toEqual({
      from: '{{accounts}}',
      template: {
        account: '{{account_label}}',
        balance: '{{balance}}',
      },
    });
    expect(ir.flow!.definitions['start'].rich_content?.quick_replies).toEqual({
      from: '{{actions}}',
      template: {
        id: '{{id}}',
        label: '{{label}}',
        icon_url: undefined,
      },
    });
    expect(ir.flow!.definitions['start'].rich_content?.list?.items).toBe('{{accounts}}');
  });
});

describe('Rich Content IR Types — Structure Validation', () => {
  test('RichContentIR has correct field names (snake_case)', () => {
    const rc: RichContentIR = {
      markdown: '**bold**',
      adaptive_card: '{}',
      html: '<b>bold</b>',
      slack: '{}',
      ag_ui: '{}',
      whatsapp: '{}',
    };
    expect(rc.markdown).toBe('**bold**');
    expect(rc.adaptive_card).toBe('{}');
    expect(rc.html).toBe('<b>bold</b>');
    expect(rc.slack).toBe('{}');
    expect(rc.ag_ui).toBe('{}');
    expect(rc.whatsapp).toBe('{}');
  });

  test('ActionElementIR has correct structure', () => {
    const el: ActionElementIR = {
      id: 'btn_1',
      type: 'button',
      label: 'Click Me',
      value: 'clicked',
    };
    expect(el.id).toBe('btn_1');
    expect(el.type).toBe('button');
    expect(el.label).toBe('Click Me');
    expect(el.value).toBe('clicked');
  });

  test('ActionElementIR select type with options', () => {
    const el: ActionElementIR = {
      id: 'city_select',
      type: 'select',
      label: 'City',
      options: [
        { id: 'nyc', label: 'New York' },
        { id: 'lax', label: 'Los Angeles', description: 'California' },
      ],
    };
    expect(el.options).toHaveLength(2);
    expect(el.options![0].id).toBe('nyc');
    expect(el.options![1].description).toBe('California');
  });

  test('ActionElementIR input type', () => {
    const el: ActionElementIR = {
      id: 'email_field',
      type: 'input',
      label: 'Email',
      input_type: 'email',
      placeholder: 'you@example.com',
      required: true,
    };
    expect(el.input_type).toBe('email');
    expect(el.placeholder).toBe('you@example.com');
    expect(el.required).toBe(true);
  });

  test('ActionSetIR structure', () => {
    const set: ActionSetIR = {
      elements: [
        { id: 'btn_a', type: 'button', label: 'A' },
        { id: 'btn_b', type: 'button', label: 'B' },
      ],
      submit_label: 'Submit',
      submit_id: 'form_submit',
    };
    expect(set.elements).toHaveLength(2);
    expect(set.submit_label).toBe('Submit');
    expect(set.submit_id).toBe('form_submit');
  });

  test('ActionHandlerIR structure', () => {
    const handler: ActionHandlerIR = {
      action_id: 'btn_a',
      condition: 'value == "yes"',
      respond: 'Great choice!',
      rich_content: { markdown: '**Great choice!**' },
      set: { choice: 'yes' },
      transition: 'next_step',
    };
    expect(handler.action_id).toBe('btn_a');
    expect(handler.respond).toBe('Great choice!');
    expect(handler.rich_content!.markdown).toBe('**Great choice!**');
    expect(handler.set!.choice).toBe('yes');
    expect(handler.transition).toBe('next_step');
  });
});

// =============================================================================
// Rich Content Template IR Sub-Types — Type Shape & Structure Validation
// =============================================================================

describe('Rich Content Template IR Sub-Types', () => {
  test('RichContentIR accepts all 12 template fields', () => {
    const rc: RichContentIR = {
      markdown: '**hello**',
      quick_replies: [{ id: '1', label: 'Yes' }],
      list: { items: [{ title: 'Item 1' }] },
      image: { url: 'https://example.com/img.png' },
      video: { url: 'https://example.com/vid.mp4' },
      audio: { url: 'https://example.com/audio.mp3' },
      file: { url: 'https://example.com/doc.pdf', filename: 'doc.pdf' },
      kpi: { label: 'Revenue', value: 42000 },
      table: { columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] },
      chart: { type: 'bar', data: [{ label: 'Q1', value: 100 }] },
      form: { fields: [{ id: 'f1', type: 'input', label: 'Name' }] },
      progress: { value: 75 },
      feedback: { prompt: 'Rate this', type: 'stars' },
    };
    expect(rc.quick_replies).toHaveLength(1);
    expect(rc.kpi?.label).toBe('Revenue');
    expect(rc.table?.columns[0].header).toBe('A');
    expect(rc.chart?.type).toBe('bar');
    expect(rc.form?.fields[0].type).toBe('input');
    expect(rc.progress?.value).toBe(75);
    expect(rc.feedback?.type).toBe('stars');
  });

  test('QuickReplyIR structure with optional icon_url', () => {
    const qr: QuickReplyIR = {
      id: 'q1',
      label: 'Option A',
      icon_url: 'https://example.com/icon.png',
    };
    expect(qr.id).toBe('q1');
    expect(qr.label).toBe('Option A');
    expect(qr.icon_url).toBe('https://example.com/icon.png');
  });

  test('ListTemplateIR structure with items', () => {
    const list: ListTemplateIR = {
      title: 'My List',
      items: [
        { title: 'Item 1', subtitle: 'Sub 1', image_url: 'https://example.com/img.png' },
        { title: 'Item 2', default_action_url: 'https://example.com/action' },
      ],
    };
    expect(list.title).toBe('My List');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].image_url).toBe('https://example.com/img.png');
    expect(list.items[1].default_action_url).toBe('https://example.com/action');
  });

  test('MediaContentIR structure for image/video/audio', () => {
    const media: MediaContentIR = {
      url: 'https://example.com/photo.jpg',
      alt: 'A photo',
      thumbnail_url: 'https://example.com/thumb.jpg',
      caption: 'Photo caption',
    };
    expect(media.url).toBe('https://example.com/photo.jpg');
    expect(media.alt).toBe('A photo');
    expect(media.thumbnail_url).toBe('https://example.com/thumb.jpg');
    expect(media.caption).toBe('Photo caption');
  });

  test('FileContentIR structure', () => {
    const file: FileContentIR = {
      url: 'https://example.com/doc.pdf',
      filename: 'doc.pdf',
      size_bytes: 1024,
      mime_type: 'application/pdf',
    };
    expect(file.filename).toBe('doc.pdf');
    expect(file.size_bytes).toBe(1024);
    expect(file.mime_type).toBe('application/pdf');
  });

  test('KPITemplateIR structure with trend and unit', () => {
    const kpi: KPITemplateIR = {
      label: 'Revenue',
      value: 42000,
      unit: 'USD',
      trend: 'up',
      icon_url: 'https://example.com/icon.png',
    };
    expect(kpi.label).toBe('Revenue');
    expect(kpi.value).toBe(42000);
    expect(kpi.unit).toBe('USD');
    expect(kpi.trend).toBe('up');
  });

  test('TableTemplateIR structure with columns and rows', () => {
    const table: TableTemplateIR = {
      columns: [
        { key: 'name', header: 'Name', align: 'left' },
        { key: 'score', header: 'Score', align: 'right' },
      ],
      rows: [
        { name: 'Alice', score: 95 },
        { name: 'Bob', score: 87 },
      ],
      max_visible_rows: 10,
    };
    expect(table.columns).toHaveLength(2);
    expect(table.columns[0].align).toBe('left');
    expect(table.rows).toHaveLength(2);
    expect(table.max_visible_rows).toBe(10);
  });

  test('ChartTemplateIR structure', () => {
    const chart: ChartTemplateIR = {
      type: 'pie',
      title: 'Sales',
      data: [
        { label: 'Q1', value: 100, color: '#ff0000' },
        { label: 'Q2', value: 200 },
      ],
    };
    expect(chart.type).toBe('pie');
    expect(chart.title).toBe('Sales');
    expect(chart.data).toHaveLength(2);
    expect(chart.data[0].color).toBe('#ff0000');
  });

  test('FormTemplateIR structure with fields', () => {
    const form: FormTemplateIR = {
      title: 'Contact Form',
      fields: [
        { id: 'name', type: 'input', label: 'Name', required: true },
        { id: 'city', type: 'select', label: 'City', options: [{ id: 'nyc', label: 'NYC' }] },
      ],
      submit_label: 'Send',
    };
    expect(form.title).toBe('Contact Form');
    expect(form.fields).toHaveLength(2);
    expect(form.fields[0].required).toBe(true);
    expect(form.submit_label).toBe('Send');
  });

  test('ProgressTemplateIR structure', () => {
    const progress: ProgressTemplateIR = {
      label: 'Upload',
      value: 65,
      max: 100,
      variant: 'bar',
    };
    expect(progress.label).toBe('Upload');
    expect(progress.value).toBe(65);
    expect(progress.max).toBe(100);
    expect(progress.variant).toBe('bar');
  });

  test('FeedbackTemplateIR structure', () => {
    const feedback: FeedbackTemplateIR = {
      prompt: 'Rate our service',
      type: 'scale',
      max: 10,
    };
    expect(feedback.prompt).toBe('Rate our service');
    expect(feedback.type).toBe('scale');
    expect(feedback.max).toBe(10);
  });
});
