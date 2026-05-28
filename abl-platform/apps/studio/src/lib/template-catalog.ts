/**
 * Template Catalog — Static catalog data for the Studio Template Catalog page.
 *
 * Each entry has: type, name, description, category, example JSON, DSL snippet.
 * Organized by category: Content, Media, Data, Input, Feedback.
 */

import { RICH_CONTENT_SUPPORT_SPECS } from '@agent-platform/web-sdk';

export type TemplateCategory = 'Content' | 'Media' | 'Data' | 'Input' | 'Feedback';
export type TemplateDslAuthoringMode = 'supported' | 'partial' | 'preview_only';

export interface TemplateCatalogEntry {
  type: string;
  name: string;
  description: string;
  category: TemplateCategory;
  exampleJson: Record<string, unknown>;
  dslSnippet: string;
  webRenderMode: 'native' | 'fallback';
  studioPreviewMode: 'native' | 'fallback' | 'limited';
  dslAuthoringMode: TemplateDslAuthoringMode;
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'Content',
  'Media',
  'Data',
  'Input',
  'Feedback',
];

const RICH_CONTENT_SUPPORT = Object.fromEntries(
  RICH_CONTENT_SUPPORT_SPECS.map((spec) => [spec.type, spec]),
);

const DSL_AUTHORING_MODES: Record<string, TemplateDslAuthoringMode> = {
  markdown: 'supported',
  html: 'supported',
  adaptive_card: 'supported',
  slack: 'supported',
  ag_ui: 'supported',
  whatsapp: 'supported',
  carousel: 'supported',
  actions: 'partial',
};

function getDslAuthoringMode(type: string): TemplateDslAuthoringMode {
  return DSL_AUTHORING_MODES[type] ?? 'preview_only';
}

function previewOnlySnippet(type: string, label: string): string {
  return [
    '# Preview only in Studio today.',
    `# ABL DSL authoring for ${label} is not yet supported.`,
    `# Use runtime-emitted rich_content.${type} payloads until the parser lane lands.`,
  ].join('\n');
}

function withSupport(
  entry: Omit<TemplateCatalogEntry, 'webRenderMode' | 'studioPreviewMode' | 'dslAuthoringMode'>,
  overrides?: Partial<
    Pick<TemplateCatalogEntry, 'webRenderMode' | 'studioPreviewMode' | 'dslAuthoringMode'>
  >,
): TemplateCatalogEntry {
  const support = RICH_CONTENT_SUPPORT[entry.type] ?? {
    webRenderMode: 'native',
    studioPreviewMode: 'native',
  };

  return {
    ...entry,
    webRenderMode: overrides?.webRenderMode ?? support.webRenderMode,
    studioPreviewMode: overrides?.studioPreviewMode ?? support.studioPreviewMode,
    dslAuthoringMode: overrides?.dslAuthoringMode ?? getDslAuthoringMode(entry.type),
  };
}

export const templateCatalog: TemplateCatalogEntry[] = [
  // --- Content ---
  withSupport({
    type: 'markdown',
    name: 'Markdown',
    description: 'Formatted text with rich markdown support.',
    category: 'Content',
    exampleJson: { markdown: '**Hello** world! Visit [our site](https://example.com).' },
    dslSnippet: `RESPOND: "Hello"
  FORMATS:
    MARKDOWN: "**Hello** world!"`,
  }),
  withSupport({
    type: 'html',
    name: 'HTML',
    description: 'Sanitized HTML rendered directly in the web chat preview.',
    category: 'Content',
    exampleJson: { html: '<strong>Hello</strong> <em>world</em>' },
    dslSnippet: `RESPOND: "Hello"
  FORMATS:
    HTML: "<strong>Hello</strong> <em>world</em>"`,
  }),
  withSupport({
    type: 'adaptive_card',
    name: 'Adaptive Card',
    description: 'Adaptive Card payload with a safe fallback preview in web surfaces.',
    category: 'Content',
    exampleJson: {
      adaptive_card:
        '{"type":"AdaptiveCard","body":[{"type":"TextBlock","text":"Approval required"}]}',
    },
    dslSnippet: `RESPOND: "Approval required"
  FORMATS:
    ADAPTIVE_CARD: '{"type":"AdaptiveCard","body":[{"type":"TextBlock","text":"Approval required"}]}'`,
  }),
  withSupport({
    type: 'slack',
    name: 'Slack Block Kit',
    description: 'Slack Block Kit payload with a safe fallback preview in web surfaces.',
    category: 'Content',
    exampleJson: {
      slack:
        '{"text":"Hello from Slack","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Hello* from Slack"}}]}',
    },
    dslSnippet: `RESPOND: "Hello from Slack"
  FORMATS:
    SLACK: '{"text":"Hello from Slack"}'`,
  }),
  withSupport({
    type: 'whatsapp',
    name: 'WhatsApp',
    description: 'WhatsApp interactive payload with a safe fallback preview in web surfaces.',
    category: 'Content',
    exampleJson: {
      whatsapp: '{"type":"interactive","body":{"text":"Choose an option"}}',
    },
    dslSnippet: `RESPOND: "Choose an option"
  FORMATS:
    WHATSAPP: '{"type":"interactive","body":{"text":"Choose an option"}}'`,
  }),
  withSupport({
    type: 'ag_ui',
    name: 'AG-UI',
    description: 'AG-UI event payload surfaced as a structured fallback preview.',
    category: 'Content',
    exampleJson: {
      ag_ui: '{"type":"card","title":"Loading","description":"Fetching account details"}',
    },
    dslSnippet: `RESPOND: "Loading"
  FORMATS:
    AG_UI: '{"type":"card","title":"Loading","description":"Fetching account details"}'`,
  }),
  withSupport({
    type: 'carousel',
    name: 'Carousel',
    description: 'Horizontal scrollable card carousel with images and buttons.',
    category: 'Content',
    exampleJson: {
      carousel: {
        cards: [
          {
            title: 'Card 1',
            subtitle: 'Description',
            image_url: 'https://via.placeholder.com/300x200',
          },
          {
            title: 'Card 2',
            subtitle: 'Description',
            image_url: 'https://via.placeholder.com/300x200',
          },
        ],
      },
    },
    dslSnippet: `RESPOND: "Browse options"
  CAROUSEL:
    - TITLE: "Card 1"
      SUBTITLE: "Description"
      IMAGE: "https://via.placeholder.com/300x200"
      BUTTONS:
        - BUTTON: "View details" -> view_card_1`,
  }),
  withSupport({
    type: 'quick_replies',
    name: 'Quick Replies',
    description: 'Inline pill buttons for rapid user responses.',
    category: 'Content',
    exampleJson: {
      quick_replies: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
        { id: 'maybe', label: 'Maybe' },
      ],
    },
    dslSnippet: previewOnlySnippet('quick_replies', 'Quick Replies'),
  }),
  withSupport({
    type: 'list',
    name: 'List',
    description: 'Structured list with titles, subtitles, and optional images.',
    category: 'Content',
    exampleJson: {
      list: {
        title: 'Search Results',
        items: [
          { title: 'Result 1', subtitle: 'First match' },
          { title: 'Result 2', subtitle: 'Second match' },
        ],
      },
    },
    dslSnippet: previewOnlySnippet('list', 'List'),
  }),

  // --- Media ---
  withSupport({
    type: 'image',
    name: 'Image',
    description: 'Displays an image with optional alt text and caption.',
    category: 'Media',
    exampleJson: {
      image: {
        url: 'https://via.placeholder.com/400x300',
        alt: 'Placeholder image',
        caption: 'Example image',
      },
    },
    dslSnippet: previewOnlySnippet('image', 'Image'),
  }),
  withSupport({
    type: 'video',
    name: 'Video',
    description: 'Embedded video player with optional caption.',
    category: 'Media',
    exampleJson: {
      video: { url: 'https://example.com/video.mp4', alt: 'Demo video' },
    },
    dslSnippet: previewOnlySnippet('video', 'Video'),
  }),
  withSupport({
    type: 'audio',
    name: 'Audio',
    description: 'Embedded audio player for sound clips or podcasts.',
    category: 'Media',
    exampleJson: {
      audio: { url: 'https://example.com/audio.mp3', alt: 'Audio clip' },
    },
    dslSnippet: previewOnlySnippet('audio', 'Audio'),
  }),
  withSupport({
    type: 'file',
    name: 'File',
    description: 'File download link with filename and optional metadata.',
    category: 'Media',
    exampleJson: {
      file: {
        url: 'https://example.com/report.pdf',
        filename: 'report.pdf',
        mime_type: 'application/pdf',
      },
    },
    dslSnippet: previewOnlySnippet('file', 'File'),
  }),

  // --- Data ---
  withSupport({
    type: 'kpi',
    name: 'KPI Card',
    description: 'Key performance indicator with value, unit, and trend arrow.',
    category: 'Data',
    exampleJson: {
      kpi: { label: 'Revenue', value: 42000, unit: 'USD', trend: 'up' },
    },
    dslSnippet: previewOnlySnippet('kpi', 'KPI cards'),
  }),
  withSupport({
    type: 'table',
    name: 'Table',
    description: 'Structured data table with semantic headers and expandable rows.',
    category: 'Data',
    exampleJson: {
      table: {
        columns: [
          { key: 'name', header: 'Name' },
          { key: 'score', header: 'Score', align: 'right' },
        ],
        rows: [
          { name: 'Alice', score: 95 },
          { name: 'Bob', score: 87 },
        ],
      },
    },
    dslSnippet: previewOnlySnippet('table', 'Table'),
  }),
  withSupport({
    type: 'chart',
    name: 'Chart',
    description: 'Visual chart (bar, line, or pie) for data visualization.',
    category: 'Data',
    exampleJson: {
      chart: {
        type: 'bar',
        title: 'Q1 Sales',
        data: [
          { label: 'Jan', value: 120 },
          { label: 'Feb', value: 180 },
          { label: 'Mar', value: 150 },
        ],
      },
    },
    dslSnippet: previewOnlySnippet('chart', 'Chart'),
  }),

  // --- Input ---
  withSupport({
    type: 'form',
    name: 'Form',
    description: 'Interactive form with input fields and submit button.',
    category: 'Input',
    exampleJson: {
      form: {
        title: 'Contact Form',
        fields: [
          { id: 'name', type: 'input', label: 'Name', required: true },
          { id: 'email', type: 'input', label: 'Email', input_type: 'email' },
        ],
        submit_label: 'Submit',
      },
    },
    dslSnippet: previewOnlySnippet('form', 'Form'),
  }),
  withSupport(
    {
      type: 'actions',
      name: 'Actions',
      description: 'Raw ActionSet payload with buttons, inputs, selects, and optional submit.',
      category: 'Input',
      exampleJson: {
        actions: {
          elements: [
            { id: 'approve', type: 'button', label: 'Approve', value: 'yes' },
            {
              id: 'reason',
              type: 'input',
              label: 'Reason',
              placeholder: 'Tell us why',
              required: true,
            },
          ],
          submit_id: 'submit_actions',
          submit_label: 'Submit',
        },
      },
      dslSnippet: `RESPOND: "Choose an action"
  ACTIONS:
    - BUTTON: "Approve" -> approve
    - SELECT: "Resolution"
      OPTIONS:
        - "Accepted" -> accepted
        - "Needs Review" -> needs_review`,
    },
    {
      webRenderMode: 'native',
      studioPreviewMode: 'native',
      dslAuthoringMode: 'partial',
    },
  ),

  // --- Feedback ---
  withSupport({
    type: 'progress',
    name: 'Progress Bar',
    description: 'Visual progress indicator (bar or circle).',
    category: 'Feedback',
    exampleJson: {
      progress: { label: 'Upload Progress', value: 65, max: 100, variant: 'bar' },
    },
    dslSnippet: previewOnlySnippet('progress', 'Progress indicators'),
  }),
  withSupport({
    type: 'feedback',
    name: 'Feedback',
    description: 'User feedback collector (thumbs, stars, or scale).',
    category: 'Feedback',
    exampleJson: {
      feedback: { prompt: 'How was your experience?', type: 'stars', max: 5 },
    },
    dslSnippet: previewOnlySnippet('feedback', 'Feedback controls'),
  }),
];

/** Get catalog entries filtered by category */
export function getCatalogByCategory(category: TemplateCategory): TemplateCatalogEntry[] {
  return templateCatalog.filter((entry) => entry.category === category);
}

/** Search catalog by name or description */
export function searchCatalog(query: string): TemplateCatalogEntry[] {
  const lower = query.toLowerCase();
  return templateCatalog.filter(
    (entry) =>
      entry.name.toLowerCase().includes(lower) || entry.description.toLowerCase().includes(lower),
  );
}

export function isTemplateInsertable(entry: TemplateCatalogEntry): boolean {
  return entry.dslAuthoringMode !== 'preview_only';
}
