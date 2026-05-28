'use client';

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clsx } from 'clsx';
import { ExternalLink } from 'lucide-react';
import { CodeBlock } from '@/components/ui/CodeBlock';

interface ArchMarkdownProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

const STREAM_MIN_STEP = 2;
const STREAM_MAX_STEP = 28;
const STREAM_BOUNDARY_SCAN = 10;

function sanitizeHref(href: string | undefined): string | null {
  if (!href) return null;

  const trimmed = href.trim();
  if (!trimmed) return null;

  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function extractLanguage(className: string | undefined): string | undefined {
  if (!className) return undefined;
  const match = /language-([\w-]+)/i.exec(className);
  return match?.[1]?.toLowerCase();
}

function moveToReadableBoundary(content: string, nextIndex: number): number {
  if (nextIndex >= content.length) {
    return content.length;
  }

  const probeLimit = Math.min(content.length, nextIndex + STREAM_BOUNDARY_SCAN);
  for (let index = nextIndex; index < probeLimit; index += 1) {
    const char = content[index];
    if (char === ' ' || char === '\n' || char === '\t' || ',.;:!?)]}'.includes(char)) {
      return index + 1;
    }
  }

  return nextIndex;
}

function useSmoothedStreamingContent(content: string, isStreaming: boolean): string {
  const [displayContent, setDisplayContent] = useState(content);
  const targetRef = useRef(content);
  const frameRef = useRef<number | null>(null);
  const reduceMotionRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    reduceMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const stopAnimation = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    targetRef.current = content;
  }, [content]);

  useEffect(() => {
    if (!isStreaming || reduceMotionRef.current) {
      stopAnimation();
      setDisplayContent(content);
      return;
    }

    if (content.length < displayContent.length) {
      setDisplayContent(content);
      return;
    }

    if (content.length === displayContent.length || frameRef.current !== null) {
      return;
    }

    const tick = () => {
      setDisplayContent((previous) => {
        const target = targetRef.current;

        if (previous.length >= target.length) {
          frameRef.current = null;
          return previous;
        }

        const backlog = target.length - previous.length;
        const rawStep = Math.min(
          STREAM_MAX_STEP,
          Math.max(STREAM_MIN_STEP, Math.ceil(backlog / 8)),
        );
        const nextIndex = moveToReadableBoundary(target, previous.length + rawStep);
        const nextValue = target.slice(0, nextIndex);

        if (nextValue.length < target.length) {
          frameRef.current = requestAnimationFrame(tick);
        } else {
          frameRef.current = null;
        }

        return nextValue;
      });
    };

    frameRef.current = requestAnimationFrame(tick);
    return stopAnimation;
  }, [content, displayContent.length, isStreaming, stopAnimation]);

  useEffect(() => stopAnimation, [stopAnimation]);

  return displayContent;
}

function MarkdownLink({ href, children }: ComponentPropsWithoutRef<'a'>): React.ReactElement {
  const safeHref = sanitizeHref(href);
  if (!safeHref) {
    return <span>{children}</span>;
  }

  const opensExternally = /^https?:/i.test(safeHref);

  return (
    <a
      href={safeHref}
      target={opensExternally ? '_blank' : undefined}
      rel={opensExternally ? 'noopener noreferrer' : undefined}
      className={clsx(
        'inline-flex items-center gap-1 font-medium text-foreground underline decoration-accent/45 underline-offset-4 transition-colors',
        'hover:text-accent focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
      )}
    >
      <span>{children}</span>
      {opensExternally ? <ExternalLink className="h-3.5 w-3.5 shrink-0" /> : null}
    </a>
  );
}

export const ArchMarkdown = memo(function ArchMarkdown({
  content,
  isStreaming = false,
  className,
}: ArchMarkdownProps) {
  const renderedContent = useSmoothedStreamingContent(content, isStreaming);

  return (
    <div
      className={clsx(
        'space-y-4 text-[15px] leading-7 text-foreground/85',
        '[&_p]:m-0 [&_strong]:font-semibold [&_em]:italic',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold tracking-tight text-foreground">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground/70">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="text-[15px] leading-7 text-foreground/85">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="space-y-2 pl-5 marker:text-foreground/35">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="space-y-2 pl-5 marker:font-medium marker:text-foreground/45">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="pl-1 text-[15px] leading-7 text-foreground/85">{children}</li>
          ),
          a: MarkdownLink,
          blockquote: ({ children }) => (
            <blockquote
              className={clsx(
                'rounded-2xl border border-accent/15 bg-accent/[0.05] px-4 py-3 text-[14px] leading-6 text-foreground/75',
                'border-l-4 border-l-accent/45',
              )}
            >
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-border/70" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-2xl border border-border/70 bg-background/80 shadow-sm">
              <table className="min-w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-background-subtle">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-border/60">{children}</tbody>,
          tr: ({ children }) => <tr className="align-top">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/65">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2.5 text-sm leading-6 text-foreground/85">{children}</td>
          ),
          code: ({ children, className: codeClassName }) => {
            const language = extractLanguage(codeClassName);
            const code = String(children ?? '').replace(/\n$/, '');
            const isBlock = Boolean(language) || code.includes('\n');

            if (isBlock) {
              return (
                <CodeBlock code={code} language={language} className="my-3" maxHeight="320px" />
              );
            }

            return (
              <code className="rounded-md border border-border/60 bg-background-subtle px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
});
