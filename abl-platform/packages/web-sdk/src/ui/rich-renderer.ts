/**
 * Rich Content Renderer
 *
 * Renders RichContent (markdown, HTML, carousel) and ActionSet (buttons,
 * selects, inputs) into DOM elements for the chat widgets.
 */

import DOMPurify from 'isomorphic-dompurify';

import type {
  Message,
  ActionElement,
  ActionSet,
  ActionSubmitOptions,
  RichContent,
  Carousel,
} from '../core/types.js';
import { isSafeUrl, defaultRegistry, hasRenderableRichContentPayload } from '../templates/index.js';
import type { TemplateContext } from '../templates/types.js';

// =============================================================================
// PUBLIC API
// =============================================================================

export interface RenderOptions {
  onAction: (actionId: string, value?: string, options?: ActionSubmitOptions) => void;
  /**
   * Feedback submission callback (ABLP-1068). When provided, the rich-feedback
   * renderer prefers this over `onAction('feedback', ...)`. The host widget /
   * mounter is responsible for binding `messageId` + `actionRenderId` in the
   * closure — they pass through to the underlying ChatClient.submitFeedback.
   */
  submitFeedback?: (input: {
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText?: string;
  }) => Promise<{ feedbackId: string }>;
}

/**
 * Check whether a message has any rich content or actions to render.
 */
export function hasRichContent(message: Message): boolean {
  return (
    hasRenderableRichContentPayload(message.richContent) ||
    Boolean(message.actions && message.actions.elements.length > 0)
  );
}

/**
 * Render a message's rich content and actions into a container element.
 * Falls back to plain text content if no rich content is available.
 */
export function renderRichMessage(
  container: HTMLElement,
  message: Message,
  options: RenderOptions,
): void {
  // Delegate to template registry for all rich content rendering
  const matches = defaultRegistry.match(message);
  const shouldRenderPlainText =
    message.content.trim().length > 0 &&
    !matches.some((match) => match.renderer.type === 'markdown');

  if (shouldRenderPlainText) {
    const textEl = document.createElement('div');
    textEl.className = 'rich-text';
    textEl.innerHTML = sanitizeHtml(renderMarkdown(message.content));
    container.appendChild(textEl);
  }

  if (matches.length > 0) {
    const ctx: TemplateContext = {
      theme: {},
      messageId: message.id,
      actionRenderId: message.actions?.renderId,
      ...(options.submitFeedback ? { submitFeedback: options.submitFeedback } : {}),
      onAction: (
        actionId: string,
        value?: string,
        actionOptions?: ActionSubmitOptions & { label?: string },
      ) => {
        const { label, ...submitOptions } = actionOptions ?? {};
        if (Object.keys(submitOptions).length > 0) {
          options.onAction(actionId, value, submitOptions);
        } else {
          options.onAction(actionId, value);
        }
        document.dispatchEvent(
          new CustomEvent('template:action', {
            detail: { actionId, value, label, messageId: message.id },
          }),
        );
      },
    };

    for (const { renderer, data } of matches) {
      try {
        container.appendChild(renderer.renderDOM(data, ctx));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[rich-content] renderer "${renderer.type}" failed:`, err);
      }
    }
  } else if (!shouldRenderPlainText && message.content) {
    // Fallback: no registry matches — render markdown from message.content
    const textEl = document.createElement('div');
    textEl.className = 'rich-text';
    textEl.innerHTML = sanitizeHtml(renderMarkdown(message.content));
    container.appendChild(textEl);
  }
}

// =============================================================================
// MARKDOWN RENDERING (lightweight, no dependencies)
// =============================================================================

/**
 * Convert a subset of Markdown to HTML. Handles:
 * - Headers (# through ######)
 * - Bold (**text** and __text__)
 * - Italic (*text* and _text_)
 * - Inline code (`code`)
 * - Code blocks (```...```)
 * - Links [text](url)
 * - Images ![alt](url)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Line breaks
 */
export function renderMarkdown(md: string): string {
  const escapedMarkdown = escapeHtml(md);
  const codeBlocks: string[] = [];
  const withCodePlaceholders = escapedMarkdown.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const token = createMarkdownToken('CODEBLOCK', codeBlocks.length);
      const langAttr = lang ? ` class="language-${lang}"` : '';
      codeBlocks.push(`<pre><code${langAttr}>${code}</code></pre>`);
      return token;
    },
  );

  const blocks: string[] = [];
  const paragraphLines: string[] = [];
  const lines = withCodePlaceholders.split('\n');

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${paragraphLines.map(renderInlineMarkdown).join('<br />')}</p>`);
    paragraphLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (isMarkdownToken(trimmed, 'CODEBLOCK')) {
      flushParagraph();
      blocks.push(trimmed);
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headerMatch) {
      flushParagraph();
      const level = headerMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headerMatch[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      blocks.push('<hr />');
      continue;
    }

    // Blockquote — match both raw `>` and HTML-escaped `&gt;`
    const blockquoteMatch = /^(?:&gt;|>)\s*(.*)$/.exec(line);
    if (blockquoteMatch) {
      flushParagraph();
      const quoteLines: string[] = [blockquoteMatch[1]];
      let currentIndex = index + 1;
      while (currentIndex < lines.length) {
        const nextMatch = /^(?:&gt;|>)\s*(.*)$/.exec(lines[currentIndex] ?? '');
        if (!nextMatch) break;
        quoteLines.push(nextMatch[1]);
        currentIndex += 1;
      }
      blocks.push(
        `<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br />')}</blockquote>`,
      );
      index = currentIndex - 1;
      continue;
    }

    const markdownTable = parseMarkdownTable(lines, index);
    if (markdownTable) {
      flushParagraph();
      blocks.push(markdownTable.html);
      index = markdownTable.lastLineIndex;
      continue;
    }

    const unorderedMatch = /^(\s*)[\-\*]\s+(.+)$/.exec(line);
    if (unorderedMatch) {
      flushParagraph();
      const buildNestedUl = (startIndex: number, baseIndent: number): [string, number] => {
        const items: string[] = [];
        let currentIndex = startIndex;
        while (currentIndex < lines.length) {
          const cur = lines[currentIndex] ?? '';
          const m = /^(\s*)[\-\*]\s+(.+)$/.exec(cur);
          if (!m) break;
          const indent = m[1].length;
          if (indent < baseIndent) break;
          if (indent > baseIndent) {
            const [nested, nextIndex] = buildNestedUl(currentIndex, indent);
            const last = items.pop() ?? '<li></li>';
            items.push(last.replace(/<\/li>$/, `${nested}</li>`));
            currentIndex = nextIndex;
          } else {
            items.push(`<li>${renderInlineMarkdown(m[2])}</li>`);
            currentIndex += 1;
          }
        }
        return [`<ul>${items.join('')}</ul>`, currentIndex];
      };
      const baseIndent = unorderedMatch[1].length;
      const [html, nextIndex] = buildNestedUl(index, baseIndent);
      blocks.push(html);
      index = nextIndex - 1;
      continue;
    }

    const orderedMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    if (orderedMatch) {
      flushParagraph();
      const buildNestedOl = (startIndex: number, baseIndent: number): [string, number] => {
        const items: string[] = [];
        let currentIndex = startIndex;
        while (currentIndex < lines.length) {
          const cur = lines[currentIndex] ?? '';
          const m = /^(\s*)\d+[.)]\s+(.+)$/.exec(cur);
          if (!m) break;
          const indent = m[1].length;
          if (indent < baseIndent) break;
          if (indent > baseIndent) {
            const [nested, nextIndex] = buildNestedOl(currentIndex, indent);
            const last = items.pop() ?? '<li></li>';
            items.push(last.replace(/<\/li>$/, `${nested}</li>`));
            currentIndex = nextIndex;
          } else {
            items.push(`<li>${renderInlineMarkdown(m[2])}</li>`);
            currentIndex += 1;
          }
        }
        return [`<ol>${items.join('')}</ol>`, currentIndex];
      };
      const baseIndent = orderedMatch[1].length;
      const [html, nextIndex] = buildNestedOl(index, baseIndent);
      blocks.push(html);
      index = nextIndex - 1;
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return restoreMarkdownTokens(blocks.join(''), 'CODEBLOCK', codeBlocks);
}

// =============================================================================
// HTML SANITIZATION (simple allowlist-based approach)
// =============================================================================

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'pre',
  'code',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'div',
  'span',
]);

const PER_TAG_ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'target', 'rel', 'class', 'title'],
  img: ['src', 'alt', 'width', 'height', 'style'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
};

const ALLOWED_ATTR_LIST: readonly string[] = [
  'href',
  'target',
  'rel',
  'class',
  'title',
  'src',
  'alt',
  'width',
  'height',
  'style',
  'colspan',
  'rowspan',
];

let _hooksInstalled = false;
function installSanitizeHooks(): void {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  // Per-tag attribute allowlist. DOMPurify's `ALLOWED_ATTR` is global; this
  // narrows it so e.g. `style` survives only on `<img>` and `colspan` only
  // on `<td>`/`<th>`, matching the previous behaviour.
  DOMPurify.addHook('uponSanitizeAttribute', (currentNode, data) => {
    const tag = (currentNode as Element).tagName?.toLowerCase();
    if (!tag) return;
    const allowed = PER_TAG_ALLOWED_ATTRS[tag];
    if (!allowed || !allowed.includes(data.attrName)) {
      data.keepAttr = false;
    }
  });

  // Always force `target=_blank` and `rel=noopener noreferrer` on anchors
  // that survive sanitization, and re-validate href/src through the shared
  // `isSafeUrl` helper so the URL allowlist matches the rest of the SDK.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.tagName) return;
    const tag = el.tagName.toLowerCase();

    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !isSafeUrl(href)) {
        el.removeAttribute('href');
      }
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
      return;
    }

    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      if (src && !isSafeUrl(src, { allowDataImages: true })) {
        el.removeAttribute('src');
      }
    }
  });
}

/**
 * Sanitize untrusted HTML to the allowlisted tag/attribute set used by the
 * chat widgets. Uses DOMPurify under the hood and re-runs the SDK's
 * `isSafeUrl` allowlist on every anchor/image so URI scheme rules match the
 * rest of the codebase. Also forces `target=_blank` + `rel=noopener
 * noreferrer` on every surviving anchor.
 */
// Defence-in-depth: pre-strip the highest-risk tags textually before handing
// the input to DOMPurify. Some DOM hosts (notably happy-dom in our test
// environment) parse `<embed>` in a way that DOMPurify cannot see it as a
// separate element node, causing the tag to survive sanitisation. The regex
// strip is intentionally conservative — it removes only the open/close tags
// of the listed elements, preserving any text content between them which
// DOMPurify would have kept anyway via `KEEP_CONTENT`.
const HIGH_RISK_TAG_RE = /<\/?(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi;

export function sanitizeHtml(html: string): string {
  installSanitizeHooks();
  const preStripped = html.replace(HIGH_RISK_TAG_RE, '');
  return DOMPurify.sanitize(preStripped, {
    ALLOWED_TAGS: Array.from(ALLOWED_TAGS),
    ALLOWED_ATTR: ALLOWED_ATTR_LIST as string[],
    KEEP_CONTENT: true,
  });
}

// =============================================================================
// CAROUSEL RENDERING
// =============================================================================

function renderCarousel(carousel: Carousel, options: RenderOptions): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-carousel';

  const track = document.createElement('div');
  track.className = 'rich-carousel-track';

  for (const card of carousel.cards) {
    const cardEl = document.createElement('div');
    cardEl.className = 'rich-carousel-card';

    if (card.image_url && isSafeUrl(card.image_url, { allowDataImages: true })) {
      const img = document.createElement('img');
      img.className = 'rich-carousel-image';
      img.src = card.image_url;
      img.alt = card.title;
      img.loading = 'lazy';
      cardEl.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'rich-carousel-body';

    const title = document.createElement('div');
    title.className = 'rich-carousel-title';
    title.textContent = card.title;
    body.appendChild(title);

    if (card.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'rich-carousel-subtitle';
      subtitle.textContent = card.subtitle;
      body.appendChild(subtitle);
    }

    if (card.buttons && card.buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'rich-button-group';
      for (const btn of card.buttons) {
        btnGroup.appendChild(createButton(btn, options));
      }
      body.appendChild(btnGroup);
    }

    cardEl.appendChild(body);

    if (card.default_action_url && isSafeUrl(card.default_action_url)) {
      cardEl.style.cursor = 'pointer';
      cardEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.rich-btn')) return;
        window.open(card.default_action_url, '_blank', 'noopener');
      });
    }

    track.appendChild(cardEl);
  }

  wrapper.appendChild(track);

  // Scroll buttons for carousel navigation
  if (carousel.cards.length > 1) {
    const leftBtn = document.createElement('button');
    leftBtn.className = 'rich-carousel-nav rich-carousel-nav-left';
    leftBtn.innerHTML = '&#8249;';
    leftBtn.setAttribute('aria-label', 'Previous');
    leftBtn.addEventListener('click', () => {
      track.scrollBy({ left: -220, behavior: 'smooth' });
    });

    const rightBtn = document.createElement('button');
    rightBtn.className = 'rich-carousel-nav rich-carousel-nav-right';
    rightBtn.innerHTML = '&#8250;';
    rightBtn.setAttribute('aria-label', 'Next');
    rightBtn.addEventListener('click', () => {
      track.scrollBy({ left: 220, behavior: 'smooth' });
    });

    wrapper.appendChild(leftBtn);
    wrapper.appendChild(rightBtn);
  }

  return wrapper;
}

// =============================================================================
// ACTION RENDERING (buttons, selects, inputs)
// =============================================================================

function renderActions(actions: ActionSet, options: RenderOptions): HTMLElement {
  const container = document.createElement('div');
  container.className = 'rich-actions';
  const submitOnForm = Boolean(actions.submit_id);

  const buttons = actions.elements.filter((e) => e.type === 'button');
  const selects = actions.elements.filter((e) => e.type === 'select');
  const inputs = actions.elements.filter((e) => e.type === 'input');

  // Buttons
  if (buttons.length > 0) {
    const btnGroup = document.createElement('div');
    btnGroup.className = 'rich-button-group';
    for (const btn of buttons) {
      btnGroup.appendChild(createButton(btn, options, actions.renderId));
    }
    container.appendChild(btnGroup);
  }

  // Selects
  for (const sel of selects) {
    container.appendChild(createSelect(sel, options, submitOnForm, actions.renderId));
  }

  // Inputs
  for (const inp of inputs) {
    container.appendChild(createInput(inp, options, submitOnForm, actions.renderId));
  }

  // Submit button
  if (actions.submit_label && actions.submit_id) {
    const submitId = actions.submit_id;
    const submitBtn = document.createElement('button');
    submitBtn.className = 'rich-btn rich-btn-primary';
    submitBtn.textContent = actions.submit_label;
    submitBtn.addEventListener('click', () => {
      if (!validateActionInputs(container)) {
        return;
      }

      // Collect all input/select values in the actions container
      const formData: Record<string, string> = {};
      const inputEls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input[data-action-id], select[data-action-id]',
      );
      for (const el of inputEls) {
        const id = el.getAttribute('data-action-id');
        if (id) formData[id] = el.value;
      }
      options.onAction(submitId, JSON.stringify(formData), {
        formData,
        ...(actions.renderId ? { renderId: actions.renderId } : {}),
      });
    });
    container.appendChild(submitBtn);
  }

  return container;
}

function createButton(
  el: ActionElement,
  options: RenderOptions,
  renderId?: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'rich-btn';
  btn.textContent = el.label;
  btn.addEventListener('click', () => {
    if (renderId) {
      options.onAction(el.id, el.value || el.id, { renderId });
    } else {
      options.onAction(el.id, el.value || el.id);
    }
    btn.disabled = true;
    btn.classList.add('rich-btn-clicked');
  });
  return btn;
}

function createSelect(
  el: ActionElement,
  options: RenderOptions,
  deferToSubmit: boolean,
  renderId?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-select-wrapper';

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-select-label';
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const select = document.createElement('select');
  select.className = 'rich-select';
  select.setAttribute('data-action-id', el.id);
  if (el.required) select.required = true;

  // Placeholder option
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = el.placeholder || el.label || 'Select...';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const opt of el.options || []) {
    const option = document.createElement('option');
    option.value = opt.id;
    option.textContent = opt.label;
    select.appendChild(option);
  }

  if (!deferToSubmit) {
    select.addEventListener('change', () => {
      if (!select.value) return;
      if (!select.checkValidity()) {
        select.reportValidity();
        return;
      }
      if (renderId) {
        options.onAction(el.id, select.value, { renderId });
      } else {
        options.onAction(el.id, select.value);
      }
    });
  }

  wrapper.appendChild(select);
  return wrapper;
}

function createInput(
  el: ActionElement,
  options: RenderOptions,
  deferToSubmit: boolean,
  renderId?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-input-wrapper';

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-input-label';
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const input = document.createElement('input');
  input.className = 'rich-input';
  input.type = el.input_type || 'text';
  input.setAttribute('data-action-id', el.id);
  if (el.placeholder) input.placeholder = el.placeholder;
  if (el.required) input.required = true;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !deferToSubmit) {
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      if (renderId) {
        options.onAction(el.id, input.value, { renderId });
      } else {
        options.onAction(el.id, input.value);
      }
    }
  });

  wrapper.appendChild(input);
  return wrapper;
}

// =============================================================================
// UTILITY
// =============================================================================

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): { html: string; lastLineIndex: number } | null {
  const headerCells = splitMarkdownTableRow(lines[startIndex] ?? '');
  const separatorCells = splitMarkdownTableRow(lines[startIndex + 1] ?? '');

  if (
    headerCells.length === 0 ||
    separatorCells.length !== headerCells.length ||
    !separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    return null;
  }

  const bodyRows: string[][] = [];
  let currentIndex = startIndex + 2;

  while (currentIndex < lines.length) {
    const line = lines[currentIndex] ?? '';
    if (!line.trim()) {
      break;
    }

    const cells = splitMarkdownTableRow(line);
    if (cells.length !== headerCells.length) {
      break;
    }

    bodyRows.push(cells);
    currentIndex += 1;
  }

  const thead = `<thead><tr>${headerCells
    .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
    .join('')}</tr></thead>`;
  const tbody =
    bodyRows.length > 0
      ? `<tbody>${bodyRows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody>`
      : '';

  return {
    html: `<div class="rich-text-table-wrapper"><table>${thead}${tbody}</table></div>`,
    lastLineIndex: currentIndex - 1,
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return [];
  }

  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell, index, cells) => cell.length > 0 || index < cells.length - 1);
}

function renderInlineMarkdown(text: string): string {
  let html = text;
  const literalAsteriskRuns: string[] = [];

  html = html.replace(/\*{3,}/g, (match: string) => {
    const token = `@@LITERALASTERISKS${literalAsteriskRuns.length}@@`;
    literalAsteriskRuns.push(match);
    return token;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, url: string) => {
    const safeSource = isSafeUrl(url, { allowDataImages: true }) ? ` src="${url}"` : '';
    return `<img${safeSource} alt="${alt}" style="max-width:100%;border-radius:8px;" />`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const safeHref = isSafeUrl(url) ? ` href="${url}"` : '';
    return `<a${safeHref} target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Protect bare URLs from emphasis parsing — tokenize before bold/italic.
  const urlTokens: string[] = [];
  html = html.replace(/https?:\/\/[^\s<]+/g, (match: string, offset: number) => {
    // Skip if inside an already-rendered HTML attribute (preceded by =")
    if (offset >= 2 && html.slice(offset - 2, offset) === '="') return match;
    const token = `@@URL${urlTokens.length}@@`;
    urlTokens.push(match);
    return token;
  });

  // Protect rendered HTML tags from emphasis parsing — underscores in
  // href/src attributes must not be converted to <em>.
  const htmlTagTokens: string[] = [];
  html = html.replace(/<[^>]+>/g, (match: string) => {
    const token = `@@HTMLTAG${htmlTagTokens.length}@@`;
    htmlTagTokens.push(match);
    return token;
  });

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Restore HTML tags
  html = html.replace(/@@HTMLTAG(\d+)@@/g, (_match, index: string) => {
    return htmlTagTokens[Number(index)] ?? '';
  });

  // Restore bare URLs — render as clickable links
  html = html.replace(/@@URL(\d+)@@/g, (_match, index: string) => {
    const url = urlTokens[Number(index)] ?? '';
    const safeHref = isSafeUrl(url) ? ` href="${url}"` : '';
    return `<a${safeHref} target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  return html.replace(/@@LITERALASTERISKS(\d+)@@/g, (_match, index: string) => {
    return literalAsteriskRuns[Number(index)] ?? '';
  });
}

function createMarkdownToken(type: string, index: number): string {
  return `@@${type}_${index}@@`;
}

function isMarkdownToken(value: string, type: string): boolean {
  return new RegExp(`^@@${type}_\\d+@@$`).test(value);
}

function restoreMarkdownTokens(html: string, type: string, values: string[]): string {
  return html.replace(new RegExp(`@@${type}_(\\d+)@@`, 'g'), (_match, index: string) => {
    return values[Number(index)] ?? '';
  });
}

function validateActionInputs(container: HTMLElement): boolean {
  const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-action-id], select[data-action-id]',
  );

  for (const control of controls) {
    if (!control.checkValidity()) {
      control.reportValidity();
      return false;
    }
  }

  return true;
}

// Re-export isSafeUrl from its canonical location for co-location with sanitizeHtml
export { isSafeUrl } from '../templates/utils/safe-url.js';
