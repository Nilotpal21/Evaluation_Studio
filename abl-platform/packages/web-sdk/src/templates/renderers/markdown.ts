/**
 * Markdown Template Renderer
 *
 * Renders markdown rich content into HTML via renderMarkdown + sanitizeHtml.
 * Migrated from rich-renderer.ts to the pluggable template system.
 */

import React from 'react';
import type { Message } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { renderMarkdown, sanitizeHtml } from '../../ui/rich-renderer.js';

interface MarkdownData {
  html: string;
}

const markdownRenderer: TemplateRenderer<MarkdownData> = {
  type: 'markdown',

  extract(message: Message): MarkdownData | undefined {
    if (message.richContent?.markdown) {
      return { html: sanitizeHtml(renderMarkdown(message.richContent.markdown)) };
    }
    if (message.richContent?.html) {
      return { html: sanitizeHtml(message.richContent.html) };
    }
    return undefined;
  },

  render(data: MarkdownData, _ctx: TemplateContext): React.ReactElement {
    return React.createElement('div', {
      className: 'rich-text',
      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- MarkdownData.html is only produced by sanitizeHtml in extract().
      dangerouslySetInnerHTML: { __html: data.html },
    });
  },

  renderDOM(data: MarkdownData, _ctx: TemplateContext): HTMLElement {
    const el = document.createElement('div');
    el.className = 'rich-text';
    // nosemgrep: typescript.browser.security.insecure-document-method.insecure-document-method -- MarkdownData.html is sanitized with DOMPurify in extract().
    el.innerHTML = data.html;
    return el;
  },
};

defaultRegistry.register(markdownRenderer);

export { markdownRenderer };
