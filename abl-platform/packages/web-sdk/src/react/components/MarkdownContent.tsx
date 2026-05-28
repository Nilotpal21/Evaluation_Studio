'use client';

/**
 * MarkdownContent — Sanitized markdown renderer.
 *
 * Standalone SDK component — no Studio dependency.
 * Strips <script>, onerror, javascript: URLs for XSS safety.
 * Uses renderMarkdown + sanitizeHtml from the existing ui/rich-renderer.
 *
 * Injects .rich-text CSS once so tables, headings, code blocks, and lists
 * render properly in both the React ChatWidget and vanilla widget paths.
 */

import React, { useMemo } from 'react';
import { renderMarkdown, sanitizeHtml } from '../../ui/rich-renderer.js';
import * as styles from './sdk-styles.js';

// ---------------------------------------------------------------------------
// One-time CSS injection for .rich-text styles in the React path.
// The vanilla widget injects these via ui/styles.ts; the React path needs
// its own injection since it doesn't use the vanilla widget shell.
// ---------------------------------------------------------------------------

let richTextCssInjected = false;

function injectRichTextCSS(): void {
  if (richTextCssInjected || typeof document === 'undefined') return;
  richTextCssInjected = true;

  const style = document.createElement('style');
  style.setAttribute('data-sdk-rich-text', '');
  style.textContent = `
    .rich-text { word-wrap: break-word; overflow-wrap: break-word; }

    .rich-text h1, .rich-text h2, .rich-text h3,
    .rich-text h4, .rich-text h5, .rich-text h6 {
      margin: 8px 0 4px; line-height: 1.3; font-weight: 600;
    }
    .rich-text h1 { font-size: 1.4em; }
    .rich-text h2 { font-size: 1.25em; }
    .rich-text h3 { font-size: 1.1em; }
    .rich-text h4 { font-size: 1.05em; }

    .rich-text p { margin: 4px 0; }

    .rich-text a { color: var(--sdk-primary, #2563eb); text-decoration: underline; }

    .rich-text code {
      background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px;
      font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }

    .rich-text pre {
      background: rgba(0,0,0,0.06); padding: 10px 12px; border-radius: 8px;
      overflow-x: auto; margin: 8px 0; font-size: 0.85em;
    }
    .rich-text pre code { background: none; padding: 0; }

    .rich-text ul { padding-left: 20px; margin: 6px 0; list-style-type: disc; }
    .rich-text ol { padding-left: 20px; margin: 6px 0; list-style-type: decimal; }
    .rich-text li { margin: 2px 0; display: list-item; }

    .rich-text img { max-width: 100%; border-radius: 8px; margin: 6px 0; }

    .rich-text hr {
      border: none; border-top: 1px solid var(--sdk-border, #e2e8f0); margin: 8px 0;
    }

    .rich-text blockquote {
      border-left: 3px solid var(--sdk-primary, #2563eb);
      padding-left: 12px; margin: 6px 0; opacity: 0.85;
    }

    .rich-text-table-wrapper { overflow-x: auto; max-width: 100%; }
    .rich-text table {
      border-collapse: collapse; margin: 8px 0; font-size: 0.9em; min-width: 100%;
    }
    .rich-text th, .rich-text td {
      border: 1px solid var(--sdk-border, #e2e8f0);
      padding: 6px 10px; text-align: left; vertical-align: top;
    }
    .rich-text thead { background: rgba(0,0,0,0.04); font-weight: 600; }
    .rich-text tbody tr:nth-child(even) { background: rgba(0,0,0,0.02); }

    .sdk-citation-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--sdk-citation-pill-bg, rgba(37, 99, 235, 0.12));
      color: var(--sdk-primary, #2563eb);
      font-size: 10px;
      font-weight: 600;
      text-decoration: none;
      vertical-align: super;
      margin-left: 2px;
      margin-right: 1px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease;
      line-height: 1;
    }
    .sdk-citation-pill:hover {
      background: var(--sdk-primary, #2563eb);
      color: #fff;
      transform: scale(1.15);
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CitationRef {
  index: number;
  title: string;
  url: string;
}

interface MarkdownContentProps {
  /** Raw markdown or plain text to render */
  content: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
  /** Citation references — when present, [N] markers in content are replaced with pills */
  citations?: CitationRef[];
}

/**
 * Replace [N] markers in rendered HTML with citation pill anchors.
 * Must run AFTER renderMarkdown (which escapes raw HTML) but BEFORE sanitizeHtml
 * (which allows class/title on <a> tags).
 */
function injectCitationPills(html: string, citations: CitationRef[]): string {
  // Match [N] patterns — in rendered HTML these appear as text content.
  // The markdown escaper converts `[1]` to `[1]` (unchanged since no special chars).
  // After renderMarkdown, [N] appears as literal text inside <p> tags etc.
  return html.replace(/\s*\[(\d+)\]/g, (_match, num) => {
    const idx = parseInt(num, 10);
    const citation = citations.find((c) => c.index === idx);
    if (!citation) return _match;
    const title = citation.title || `Source ${idx}`;
    // Escape title for HTML attribute safety
    const safeTitle = title.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return (
      `<a href="${citation.url}" target="_blank" rel="noopener noreferrer" ` +
      `class="sdk-citation-pill" title="${safeTitle}">` +
      `${idx}</a>`
    );
  });
}

export function MarkdownContent({
  content,
  style,
  citations,
}: MarkdownContentProps): React.ReactElement {
  // Inject CSS once on first render
  injectRichTextCSS();

  const html = useMemo(() => {
    if (!content) return '';
    let rendered = renderMarkdown(content);
    // Inject citation pills after markdown rendering (so they don't get HTML-escaped)
    // but before sanitization (which preserves class/title on <a> tags).
    if (citations?.length) {
      rendered = injectCitationPills(rendered, citations);
    }
    return sanitizeHtml(rendered);
  }, [content, citations]);

  return React.createElement('div', {
    className: 'rich-text',
    style: { ...styles.markdownContent, ...style },
    // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- Markdown output is sanitized with DOMPurify before reaching React.
    dangerouslySetInnerHTML: { __html: html },
  });
}
