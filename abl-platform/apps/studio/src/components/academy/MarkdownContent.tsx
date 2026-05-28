'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import type { Components } from 'react-markdown';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MarkdownContentProps {
  content: string;
  className?: string;
  onHeadingsExtracted?: (headings: Array<{ id: string; text: string; level: number }>) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert heading text to a URL-safe slug for anchor linking. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Extract plain text from React children (handles nested elements). */
function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (
    children !== null &&
    children !== undefined &&
    typeof children === 'object' &&
    'props' in children
  ) {
    return extractText(
      (children as React.ReactElement<{ children?: React.ReactNode }>).props.children,
    );
  }
  return '';
}

/** Detect callout type from the first line of blockquote content. */
function detectCalloutType(children: React.ReactNode): {
  border: string;
  bg: string;
} {
  const text = extractText(children);
  const first = text.slice(0, 80).toLowerCase();

  if (first.includes('tip:') || first.includes('best practice:')) {
    return { border: 'border-l-success', bg: 'bg-success-subtle' };
  }
  if (first.includes('warning:') || first.includes('caution:')) {
    return { border: 'border-l-warning', bg: 'bg-warning-subtle' };
  }
  if (first.includes('important:') || first.includes('danger:')) {
    return { border: 'border-l-error', bg: 'bg-error-subtle' };
  }
  // Default: note / key concept → accent blue
  return { border: 'border-l-accent', bg: 'bg-accent/5' };
}

// ─── CopyButton ─────────────────────────────────────────────────────────────

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-xs text-foreground-subtle hover:text-foreground transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// ─── Component map ──────────────────────────────────────────────────────────

const components: Components = {
  h1: ({ children }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h1 id={id} className="text-2xl font-bold text-foreground mt-8 mb-4">
        {children}
      </h1>
    );
  },
  h2: ({ children }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h2
        id={id}
        className="text-xl font-bold text-foreground mt-6 mb-3 pb-2 border-b border-border"
      >
        {children}
      </h2>
    );
  },
  h3: ({ children }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h3 id={id} className="text-lg font-semibold text-foreground mt-5 mb-2">
        {children}
      </h3>
    );
  },
  h4: ({ children }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h4 id={id} className="text-base font-medium text-foreground mt-4 mb-2">
        {children}
      </h4>
    );
  },

  // Tables
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-background-muted px-4 py-2 text-left font-semibold text-foreground border border-border">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 border border-border text-foreground">{children}</td>
  ),

  // Code blocks
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const isBlock =
      typeof className === 'string' &&
      (className.startsWith('language-') || className.includes('hljs'));
    if (isBlock) {
      const language = (className ?? '')
        .replace(/language-/g, '')
        .replace(/hljs/g, '')
        .trim();
      const codeStr = extractText(children);
      return (
        <div className="bg-background-elevated rounded-lg overflow-hidden my-4 border border-border">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <span className="text-xs font-mono text-foreground-subtle">{language}</span>
            <CopyButton code={codeStr} />
          </div>
          <pre className="p-4 overflow-x-auto">
            <code className={`text-sm font-mono ${className ?? ''}`}>{children}</code>
          </pre>
        </div>
      );
    }
    // Inline code
    return (
      <code className="px-1.5 py-0.5 bg-background-muted rounded text-xs font-mono">
        {children}
      </code>
    );
  },

  // Blockquotes with callout detection
  blockquote: ({ children }) => {
    const { border, bg } = detectCalloutType(children);
    return (
      <blockquote className={`border-l-4 ${border} ${bg} pl-4 py-2 my-4 rounded-r-lg`}>
        {children}
      </blockquote>
    );
  },

  // Links
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),

  // Lists
  ul: ({ children }) => <ul className="list-disc pl-6 my-3 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 my-3 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-foreground">{children}</li>,

  // Paragraphs
  p: ({ children }) => <p className="text-foreground my-3 leading-relaxed">{children}</p>,

  // Horizontal rules
  hr: () => <hr className="border-border my-6" />,

  // Images
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt ?? ''} className="rounded-lg my-4 max-w-full" />
  ),
};

// ─── MarkdownContent ────────────────────────────────────────────────────────

/**
 * Academy markdown renderer.
 *
 * Uses ReactMarkdown + remark-gfm for full GFM support including tables,
 * blockquote callouts, code blocks with copy buttons, and heading IDs
 * for Table of Contents linking.
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  onHeadingsExtracted,
}: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onHeadingsExtractedRef = useRef(onHeadingsExtracted);
  onHeadingsExtractedRef.current = onHeadingsExtracted;

  useEffect(() => {
    const el = containerRef.current;
    const cb = onHeadingsExtractedRef.current;
    if (!el || !cb) return;

    const headingEls = el.querySelectorAll('h2, h3');
    const headings: Array<{ id: string; text: string; level: number }> = [];
    headingEls.forEach((heading) => {
      const id = heading.id;
      const text = heading.textContent ?? '';
      const level = heading.tagName === 'H2' ? 2 : 3;
      if (id && text) {
        headings.push({ id, text, level });
      }
    });

    cb(headings);
  }, [content]);

  return (
    <div
      ref={containerRef}
      className={`rounded-lg border border-border bg-background-elevated p-6${className ? ` ${className}` : ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
