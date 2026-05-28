'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface TaskDescriptionProps {
  content: string;
  className?: string;
}

const components: Components = {
  h1: ({ children }) => (
    <h4 className="text-sm font-semibold text-foreground mt-2 mb-1 first:mt-0">{children}</h4>
  ),
  h2: ({ children }) => (
    <h5 className="text-sm font-semibold text-foreground mt-2 mb-1 first:mt-0">{children}</h5>
  ),
  h3: ({ children }) => (
    <h6 className="text-xs font-semibold text-foreground mt-2 mb-1 first:mt-0">{children}</h6>
  ),
  h4: ({ children }) => (
    <h6 className="text-xs font-semibold text-foreground mt-2 mb-1 first:mt-0">{children}</h6>
  ),
  p: ({ children }) => (
    <p className="text-sm text-muted leading-relaxed my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-1.5 space-y-0.5 text-sm text-muted">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-1.5 space-y-0.5 text-sm text-muted">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
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
  code: ({ className, children }) => {
    const hasLang = typeof className === 'string' && className.startsWith('language-');
    const isBlock = hasLang || String(children).includes('\n');
    if (isBlock) {
      return (
        <pre className="my-2 p-2.5 rounded-md bg-background-muted border border-default overflow-x-auto text-xs font-mono text-foreground whitespace-pre-wrap">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="px-1 py-0.5 rounded bg-background-muted text-[0.8em] font-mono text-foreground">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/40 pl-3 my-2 text-sm text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-default" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold border border-default bg-background-muted">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2 py-1 border border-default text-muted">{children}</td>,
};

/** Compact markdown renderer for human-in-the-loop task descriptions. */
export const TaskDescription = memo(function TaskDescription({
  content,
  className,
}: TaskDescriptionProps) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
