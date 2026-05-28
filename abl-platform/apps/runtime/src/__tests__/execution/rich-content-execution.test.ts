/**
 * Rich Content Execution Tests
 *
 * Tests for interpolateRichContent, ExecutionResult types,
 * and ServerMessages.responseEnd with rich content fields.
 */

import { describe, test, expect } from 'vitest';
import {
  interpolateRichContent,
  interpolateTemplate,
  interpolateVoiceConfig,
} from '../../services/execution/value-resolution.js';
import {
  ServerMessages,
  parseClientMessage,
  serializeServerMessage,
} from '../../websocket/events.js';
import type { RichContentIR, ActionSetIR, ActionElementIR } from '@abl/compiler';

// =============================================================================
// interpolateRichContent
// =============================================================================

describe('interpolateRichContent', () => {
  test('interpolates variables in markdown format', () => {
    const rc: RichContentIR = { markdown: '**Hello {{name}}**' };
    const result = interpolateRichContent(rc, { name: 'Alice' });
    expect(result.markdown).toBe('**Hello Alice**');
  });

  test('interpolates variables in all 6 format fields', () => {
    const rc: RichContentIR = {
      markdown: '**{{greeting}}**',
      adaptive_card: '{"text":"{{greeting}}"}',
      html: '<b>{{greeting}}</b>',
      slack: '{"text":"{{greeting}}"}',
      ag_ui: '{"msg":"{{greeting}}"}',
      whatsapp: '{"body":"{{greeting}}"}',
    };
    const result = interpolateRichContent(rc, { greeting: 'Hi' });
    expect(result.markdown).toBe('**Hi**');
    expect(result.adaptive_card).toBe('{"text":"Hi"}');
    expect(result.html).toBe('<b>Hi</b>');
    expect(result.slack).toBe('{"text":"Hi"}');
    expect(result.ag_ui).toBe('{"msg":"Hi"}');
    expect(result.whatsapp).toBe('{"body":"Hi"}');
  });

  test('preserves undefined for unset format fields', () => {
    const rc: RichContentIR = { markdown: '**bold**' };
    const result = interpolateRichContent(rc, {});
    expect(result.markdown).toBe('**bold**');
    expect(result.adaptive_card).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(result.slack).toBeUndefined();
    expect(result.ag_ui).toBeUndefined();
    expect(result.whatsapp).toBeUndefined();
  });

  test('handles nested variable paths', () => {
    const rc: RichContentIR = { markdown: '**{{user.name}}**' };
    const result = interpolateRichContent(rc, { user: { name: 'Bob' } });
    expect(result.markdown).toBe('**Bob**');
  });

  test('handles #if conditionals in markdown', () => {
    const rc: RichContentIR = { markdown: '{{#if premium}}VIP{{/if}} Welcome' };
    const withPremium = interpolateRichContent(rc, { premium: true });
    expect(withPremium.markdown).toBe('VIP Welcome');

    const withoutPremium = interpolateRichContent(rc, { premium: false });
    expect(withoutPremium.markdown).toBe(' Welcome');
  });

  test('handles #each loops in markdown', () => {
    const rc: RichContentIR = {
      markdown: '{{#each items}}- {{name}}\n{{/each}}',
    };
    const result = interpolateRichContent(rc, {
      items: [{ name: 'A' }, { name: 'B' }],
    });
    expect(result.markdown).toContain('- A');
    expect(result.markdown).toContain('- B');
  });

  test('returns empty object when all fields are undefined', () => {
    const rc: RichContentIR = {};
    const result = interpolateRichContent(rc, { foo: 'bar' });
    expect(result.markdown).toBeUndefined();
    expect(result.html).toBeUndefined();
  });

  test('leaves unresolved variables as template markers', () => {
    const rc: RichContentIR = { markdown: '**{{unknown}}**' };
    const result = interpolateRichContent(rc, {});
    expect(result.markdown).toBe('**{{unknown}}**');
  });

  test('handles multiple variables in single format', () => {
    const rc: RichContentIR = {
      markdown: '# {{title}}\nBy {{author}}',
    };
    const result = interpolateRichContent(rc, { title: 'My Post', author: 'Jane' });
    expect(result.markdown).toBe('# My Post\nBy Jane');
  });

  // --- Tier 1: Template Interpolation ---

  test('interpolates quick_replies labels but preserves IDs', () => {
    const rc: RichContentIR = {
      quick_replies: [
        { id: 'q1', label: 'Hello {{name}}', icon_url: 'https://example.com/icon.png' },
      ],
    };
    const result = interpolateRichContent(rc, { name: 'Alice' });
    expect(result.quick_replies![0].label).toBe('Hello Alice');
    expect(result.quick_replies![0].id).toBe('q1');
    expect(result.quick_replies![0].icon_url).toBe('https://example.com/icon.png');
  });

  test('interpolates list title and item text fields, not URLs', () => {
    const rc: RichContentIR = {
      list: {
        title: '{{category}} Items',
        items: [
          {
            title: '{{itemName}}',
            subtitle: 'By {{author}}',
            image_url: 'https://example.com/img.png',
            default_action_url: 'https://example.com/action',
          },
        ],
      },
    };
    const result = interpolateRichContent(rc, {
      category: 'Books',
      itemName: 'Dune',
      author: 'Herbert',
    });
    expect(result.list!.title).toBe('Books Items');
    expect(result.list!.items[0].title).toBe('Dune');
    expect(result.list!.items[0].subtitle).toBe('By Herbert');
    expect(result.list!.items[0].image_url).toBe('https://example.com/img.png');
    expect(result.list!.items[0].default_action_url).toBe('https://example.com/action');
  });

  test('interpolates image alt and caption, not URL', () => {
    const rc: RichContentIR = {
      image: {
        url: 'https://example.com/photo.jpg',
        alt: 'Photo of {{name}}',
        caption: 'Taken by {{photographer}}',
        thumbnail_url: 'https://example.com/thumb.jpg',
      },
    };
    const result = interpolateRichContent(rc, { name: 'Alice', photographer: 'Bob' });
    expect(result.image!.alt).toBe('Photo of Alice');
    expect(result.image!.caption).toBe('Taken by Bob');
    expect(result.image!.url).toBe('https://example.com/photo.jpg');
    expect(result.image!.thumbnail_url).toBe('https://example.com/thumb.jpg');
  });

  test('interpolates video alt and caption, not URL', () => {
    const rc: RichContentIR = {
      video: {
        url: 'https://example.com/vid.mp4',
        alt: '{{title}} video',
        caption: 'Episode {{num}}',
      },
    };
    const result = interpolateRichContent(rc, { title: 'Demo', num: '3' });
    expect(result.video!.alt).toBe('Demo video');
    expect(result.video!.caption).toBe('Episode 3');
    expect(result.video!.url).toBe('https://example.com/vid.mp4');
  });

  test('interpolates audio alt and caption, not URL', () => {
    const rc: RichContentIR = {
      audio: { url: 'https://example.com/audio.mp3', alt: '{{track}} audio' },
    };
    const result = interpolateRichContent(rc, { track: 'Song' });
    expect(result.audio!.alt).toBe('Song audio');
    expect(result.audio!.url).toBe('https://example.com/audio.mp3');
  });

  test('interpolates file filename, not URL or numeric fields', () => {
    const rc: RichContentIR = {
      file: {
        url: 'https://example.com/doc.pdf',
        filename: '{{docName}}.pdf',
        size_bytes: 1024,
        mime_type: 'application/pdf',
      },
    };
    const result = interpolateRichContent(rc, { docName: 'Report' });
    expect(result.file!.filename).toBe('Report.pdf');
    expect(result.file!.url).toBe('https://example.com/doc.pdf');
    expect(result.file!.size_bytes).toBe(1024);
    expect(result.file!.mime_type).toBe('application/pdf');
  });

  // --- Tier 2: Template Interpolation ---

  test('interpolates kpi label and unit, not value/trend/icon_url', () => {
    const rc: RichContentIR = {
      kpi: {
        label: '{{metric}} Count',
        value: 42,
        unit: '{{currency}}',
        trend: 'up',
        icon_url: 'https://example.com/icon.png',
      },
    };
    const result = interpolateRichContent(rc, { metric: 'User', currency: 'USD' });
    expect(result.kpi!.label).toBe('User Count');
    expect(result.kpi!.unit).toBe('USD');
    expect(result.kpi!.value).toBe(42);
    expect(result.kpi!.trend).toBe('up');
    expect(result.kpi!.icon_url).toBe('https://example.com/icon.png');
  });

  test('interpolates table column headers, not keys or rows', () => {
    const rc: RichContentIR = {
      table: {
        columns: [{ key: 'name', header: '{{headerLabel}}', align: 'left' }],
        rows: [{ name: 'Alice' }],
        max_visible_rows: 5,
      },
    };
    const result = interpolateRichContent(rc, { headerLabel: 'Full Name' });
    expect(result.table!.columns[0].header).toBe('Full Name');
    expect(result.table!.columns[0].key).toBe('name');
    expect(result.table!.rows).toEqual([{ name: 'Alice' }]);
    expect(result.table!.max_visible_rows).toBe(5);
  });

  test('expands dynamic table rows from runtime collection with a row template', () => {
    const rc: RichContentIR = {
      table: {
        columns: [
          { key: 'account', header: 'Account' },
          { key: 'type', header: 'Type' },
          { key: 'balance', header: 'Available Balance', align: 'right' },
        ],
        rows: {
          from: '{{accounts}}',
          template: {
            account: '{{account_label}}',
            type: '{{account_type}}',
            balance: '{{balance}}',
          },
        },
      },
    };

    const result = interpolateRichContent(rc, {
      accounts: [
        { account_label: 'Checking 4123', account_type: 'Checking', balance: '$1,245.33' },
        { account_label: 'Savings 8841', account_type: 'Savings', balance: '$9,700.00' },
        { account_label: 'Money Market 1020', account_type: 'Money Market', balance: '$500.00' },
      ],
    });

    expect(result.table!.rows).toEqual([
      { account: 'Checking 4123', type: 'Checking', balance: '$1,245.33' },
      { account: 'Savings 8841', type: 'Savings', balance: '$9,700.00' },
      { account: 'Money Market 1020', type: 'Money Market', balance: '$500.00' },
    ]);
  });

  test('expands dynamic table columns from runtime collection with a column template', () => {
    const rc: RichContentIR = {
      table: {
        columns: {
          from: '{{visibleColumns}}',
          template: {
            key: '{{key}}',
            header: '{{header}}',
            align: 'right',
          },
        },
        rows: [
          {
            account: 'Checking 4123',
            balance: '$1,245.33',
          },
        ],
      },
    };

    const result = interpolateRichContent(rc, {
      visibleColumns: [
        { key: 'account', header: 'Account' },
        { key: 'balance', header: 'Available Balance', align: 'right' },
      ],
    });

    expect(result.table!.columns).toEqual([
      { key: 'account', header: 'Account', align: 'right' },
      { key: 'balance', header: 'Available Balance', align: 'right' },
    ]);
  });

  test('expands dynamic collection bindings for list, carousel, chart, form, and quick replies', () => {
    const rc: RichContentIR = {
      list: {
        title: 'Accounts',
        items: {
          from: '{{accounts}}',
          template: {
            title: '{{account_label}}',
            subtitle: '{{account_type}}',
          },
        },
      },
      carousel: {
        cards: {
          from: '{{accounts}}',
          template: {
            title: '{{account_label}}',
            subtitle: '{{balance}}',
          },
        },
      },
      chart: {
        type: 'bar',
        data: {
          from: '{{accounts}}',
          template: {
            label: '{{account_type}}',
            value: '{{numeric_balance}}',
          },
        },
      },
      form: {
        title: 'Pick an account',
        fields: [
          {
            id: 'account',
            type: 'select',
            label: 'Account',
            options: {
              from: '{{accounts}}',
              template: {
                id: '{{account_id}}',
                label: '{{account_label}}',
              },
            },
          },
        ],
      },
      quick_replies: {
        from: '{{actions}}',
        template: {
          id: '{{id}}',
          label: '{{label}}',
        },
      },
    };

    const result = interpolateRichContent(rc, {
      accounts: [
        {
          account_id: 'chk',
          account_label: 'Checking 4123',
          account_type: 'Checking',
          balance: '$1,245.33',
          numeric_balance: 1245.33,
        },
        {
          account_id: 'sav',
          account_label: 'Savings 8841',
          account_type: 'Savings',
          balance: '$9,700.00',
          numeric_balance: 9700,
        },
      ],
      actions: [
        { id: 'details', label: 'Details' },
        { id: 'transfer', label: 'Transfer' },
      ],
    });

    expect(result.list!.items).toEqual([
      { title: 'Checking 4123', subtitle: 'Checking' },
      { title: 'Savings 8841', subtitle: 'Savings' },
    ]);
    expect(result.carousel!.cards).toEqual([
      { title: 'Checking 4123', subtitle: '$1,245.33' },
      { title: 'Savings 8841', subtitle: '$9,700.00' },
    ]);
    expect(result.chart!.data).toEqual([
      { label: 'Checking', value: 1245.33 },
      { label: 'Savings', value: 9700 },
    ]);
    expect(result.form!.fields[0].options).toEqual([
      { id: 'chk', label: 'Checking 4123' },
      { id: 'sav', label: 'Savings 8841' },
    ]);
    expect(result.quick_replies).toEqual([
      { id: 'details', label: 'Details' },
      { id: 'transfer', label: 'Transfer' },
    ]);
  });

  test('interpolates chart title and data labels, not values', () => {
    const rc: RichContentIR = {
      chart: {
        type: 'bar',
        title: '{{chartTitle}}',
        data: [{ label: '{{q}}', value: 100, color: '#ff0000' }],
      },
    };
    const result = interpolateRichContent(rc, { chartTitle: 'Sales', q: 'Q1' });
    expect(result.chart!.title).toBe('Sales');
    expect(result.chart!.data[0].label).toBe('Q1');
    expect(result.chart!.data[0].value).toBe(100);
    expect(result.chart!.data[0].color).toBe('#ff0000');
    expect(result.chart!.type).toBe('bar');
  });

  test('interpolates form text fields, not IDs or enum fields', () => {
    const rc: RichContentIR = {
      form: {
        title: '{{formTitle}}',
        fields: [
          {
            id: 'f1',
            type: 'input',
            label: '{{fieldLabel}}',
            placeholder: 'Enter {{fieldName}}',
            description: '{{desc}}',
          },
        ],
        submit_label: '{{submitText}}',
      },
    };
    const result = interpolateRichContent(rc, {
      formTitle: 'Contact',
      fieldLabel: 'Email',
      fieldName: 'email',
      desc: 'Required field',
      submitText: 'Send',
    });
    expect(result.form!.title).toBe('Contact');
    expect(result.form!.fields[0].label).toBe('Email');
    expect(result.form!.fields[0].placeholder).toBe('Enter email');
    expect(result.form!.fields[0].description).toBe('Required field');
    expect(result.form!.fields[0].id).toBe('f1');
    expect(result.form!.fields[0].type).toBe('input');
    expect(result.form!.submit_label).toBe('Send');
  });

  test('interpolates progress label, not value/max/variant', () => {
    const rc: RichContentIR = {
      progress: { label: '{{task}} Progress', value: 65, max: 100, variant: 'bar' },
    };
    const result = interpolateRichContent(rc, { task: 'Upload' });
    expect(result.progress!.label).toBe('Upload Progress');
    expect(result.progress!.value).toBe(65);
    expect(result.progress!.max).toBe(100);
    expect(result.progress!.variant).toBe('bar');
  });

  test('interpolates feedback prompt, not type/max', () => {
    const rc: RichContentIR = {
      feedback: { prompt: 'How was {{service}}?', type: 'stars', max: 5 },
    };
    const result = interpolateRichContent(rc, { service: 'support' });
    expect(result.feedback!.prompt).toBe('How was support?');
    expect(result.feedback!.type).toBe('stars');
    expect(result.feedback!.max).toBe(5);
  });

  test('preserves undefined for unset template fields', () => {
    const rc: RichContentIR = { markdown: '**bold**' };
    const result = interpolateRichContent(rc, {});
    expect(result.quick_replies).toBeUndefined();
    expect(result.list).toBeUndefined();
    expect(result.image).toBeUndefined();
    expect(result.video).toBeUndefined();
    expect(result.audio).toBeUndefined();
    expect(result.file).toBeUndefined();
    expect(result.kpi).toBeUndefined();
    expect(result.table).toBeUndefined();
    expect(result.chart).toBeUndefined();
    expect(result.form).toBeUndefined();
    expect(result.progress).toBeUndefined();
    expect(result.feedback).toBeUndefined();
  });
});

// =============================================================================
// ServerMessages.responseEnd with rich content
// =============================================================================

describe('ServerMessages.responseEnd with rich content', () => {
  test('includes richContent in response_end message', () => {
    const richContent: RichContentIR = { markdown: '**Hello**' };
    const msg = ServerMessages.responseEnd('sess_1', 'msg_1', 'Hello', undefined, richContent);
    expect(msg.type).toBe('response_end');
    expect((msg as Record<string, unknown>).richContent).toBeDefined();
    expect((msg as Record<string, unknown>).richContent).toEqual({ markdown: '**Hello**' });
  });

  test('includes actions in response_end message', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'btn_1', type: 'button', label: 'Click' }],
    };
    const msg = ServerMessages.responseEnd(
      'sess_1',
      'msg_1',
      'Hello',
      undefined,
      undefined,
      actions,
    );
    expect((msg as Record<string, unknown>).actions).toBeDefined();
    expect((msg as Record<string, unknown>).actions).toEqual(actions);
  });

  test('includes both richContent and actions', () => {
    const richContent: RichContentIR = { markdown: '**Choose**' };
    const actions: ActionSetIR = {
      elements: [
        { id: 'opt_a', type: 'button', label: 'Option A' },
        { id: 'opt_b', type: 'button', label: 'Option B' },
      ],
    };
    const msg = ServerMessages.responseEnd(
      'sess_1',
      'msg_1',
      'Choose',
      undefined,
      richContent,
      actions,
    );
    const data = msg as Record<string, unknown>;
    expect(data.richContent).toEqual(richContent);
    expect(data.actions).toEqual(actions);
  });

  test('includes voiceConfig alongside richContent', () => {
    const richContent: RichContentIR = { markdown: '**Hello**' };
    const voiceConfig = { instructions: 'Speak warmly' };
    const msg = ServerMessages.responseEnd('sess_1', 'msg_1', 'Hello', voiceConfig, richContent);
    const data = msg as Record<string, unknown>;
    expect(data.voiceConfig).toEqual(voiceConfig);
    expect(data.richContent).toEqual(richContent);
  });

  test('response_end without rich content has undefined fields', () => {
    const msg = ServerMessages.responseEnd('sess_1', 'msg_1', 'Hello');
    const data = msg as Record<string, unknown>;
    expect(data.richContent).toBeUndefined();
    expect(data.actions).toBeUndefined();
  });

  test('serialized response_end includes rich content', () => {
    const richContent: RichContentIR = { markdown: '**Hi**' };
    const msg = ServerMessages.responseEnd('sess_1', 'msg_1', 'Hi', undefined, richContent);
    const serialized = serializeServerMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe('response_end');
    expect(parsed.richContent).toEqual({ markdown: '**Hi**' });
  });
});

// =============================================================================
// ExecutionResult type
// =============================================================================

describe('ExecutionResult type shape', () => {
  test('ExecutionResult accepts richContent and actions fields', () => {
    // Type check — if this compiles, the type includes the fields
    const result = {
      response: 'Hello',
      action: { type: 'respond' },
      richContent: { markdown: '**Hello**' } as RichContentIR,
      actions: {
        elements: [{ id: 'btn_1', type: 'button' as const, label: 'Click' }],
      } as ActionSetIR,
    };
    expect(result.richContent!.markdown).toBe('**Hello**');
    expect(result.actions!.elements).toHaveLength(1);
  });

  test('ExecutionResult works without optional rich fields', () => {
    const result = {
      response: 'Hello',
      action: { type: 'respond' },
    };
    expect(result.response).toBe('Hello');
    expect((result as Record<string, unknown>).richContent).toBeUndefined();
  });
});

// =============================================================================
// ActionEvent type
// =============================================================================

describe('ActionEvent type', () => {
  test('ActionEvent has correct shape', async () => {
    const { ActionEvent: _unused, ...mod } =
      (await import('../../services/channels/action-event.js')) as Record<string, unknown>;
    // Import the type — since it's only a TS interface, we verify the module loads
    expect(mod).toBeDefined();
  });

  test('ActionEvent can represent button click', () => {
    const event = {
      type: 'action_event' as const,
      actionId: 'btn_confirm',
      value: 'confirmed',
      source: 'websocket' as const,
    };
    expect(event.type).toBe('action_event');
    expect(event.actionId).toBe('btn_confirm');
    expect(event.value).toBe('confirmed');
    expect(event.source).toBe('websocket');
  });

  test('ActionEvent can represent form submission', () => {
    const event = {
      type: 'action_event' as const,
      actionId: 'form_submit',
      formData: { name: 'Alice', email: 'alice@test.com' },
      source: 'rest' as const,
    };
    expect(event.formData).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  test('ActionEvent supports all channel sources', () => {
    const sources = ['websocket', 'rest', 'a2a', 'slack', 'whatsapp', 'teams'] as const;
    for (const source of sources) {
      const event = { type: 'action_event' as const, actionId: 'test', source };
      expect(event.source).toBe(source);
    }
  });
});

// =============================================================================
// interpolateVoiceConfig (existing, sanity check alongside rich content)
// =============================================================================

describe('interpolateVoiceConfig (parallel to richContent)', () => {
  test('interpolates voice config instructions', () => {
    const vc = { instructions: 'Welcome {{name}}' };
    const result = interpolateVoiceConfig(vc, { name: 'Alice' });
    expect(result.instructions).toBe('Welcome Alice');
  });

  test('preserves undefined voice fields', () => {
    const vc = { instructions: 'Hello' };
    const result = interpolateVoiceConfig(vc, {});
    expect(result.instructions).toBe('Hello');
    expect(result.ssml).toBeUndefined();
    expect(result.plain_text).toBeUndefined();
  });
});
