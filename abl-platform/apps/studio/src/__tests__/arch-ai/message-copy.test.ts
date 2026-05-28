import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildRichTextClipboardHtml,
  getMessageCopyMarkdown,
} from '@/lib/arch-ai/components/arch/chat/message-copy';

describe('message-copy helpers', () => {
  it('serializes raw content blocks into markdown-friendly copy', () => {
    const markdown = getMessageCopyMarkdown({
      rawContent: [
        { type: 'text', text: '## Pattern\n\nUse a triage agent.' },
        {
          type: 'file_ref',
          blobId: 'blob-1',
          name: 'routing.json',
          mediaType: 'application/json',
          summary: '{\n  "route": "sales"\n}',
          tokenCost: 42,
        },
        {
          type: 'image_ref',
          blobId: 'blob-2',
          name: 'blueprint.png',
          mediaType: 'image/png',
          width: 1280,
          height: 720,
          tokenCost: 10,
        },
      ],
    });

    expect(markdown).toContain('## Pattern');
    expect(markdown).toContain('### routing.json');
    expect(markdown).toContain('```json');
    expect(markdown).toContain('"route": "sales"');
    expect(markdown).toContain('> Image: blueprint.png (1280x720)');
  });

  it('builds clipboard html without copy-button chrome for code blocks', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const root = dom.window.document.createElement('div');
    root.innerHTML = `
      <div class="space-y-4">
        <h2 class="heading">Pattern</h2>
        <div data-code-block="true" data-code-language="json">
          <div>
            <span>json</span>
            <button type="button">Copy code</button>
          </div>
          <pre data-code-block-pre="true"><code data-code-block-source="true">{
  "channel": "web"
}</code></pre>
        </div>
      </div>
    `;

    const html = buildRichTextClipboardHtml(root);

    expect(html).toContain('<h2');
    expect(html).toContain('Pattern</h2>');
    expect(html).toContain('<pre><code class="language-json">{');
    expect(html).not.toContain('Copy code');
    expect(html).not.toContain('data-code-block');
  });
});
