/**
 * MarkdownContent Component
 *
 * Lightweight markdown renderer for LLM chat messages.
 * Handles: bold, italic, inline code, code blocks, lists, headings, links.
 * All text is rendered via React's normal escaping — no dangerouslySetInnerHTML.
 */

import { memo, useMemo } from 'react';
import clsx from 'clsx';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// ─── Inline parsing ──────────────────────────────────────────────────────────

/**
 * Parse inline markdown into React elements.
 * Supports: **bold**, *italic*, `code`, [links](url)
 */
function renderInline(text: string): React.ReactNode[] {
  // Match bold, italic, inline code, and markdown links
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith('*') && token.endsWith('*') && !token.startsWith('**')) {
      return (
        <em key={i} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 bg-background-muted rounded text-xs font-mono">
          {token.slice(1, -1)}
        </code>
      );
    }
    // [text](url)
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const url = linkMatch[2];
      if (!/^https?:|^mailto:/i.test(url)) {
        return <span key={i}>{linkMatch[1]}</span>;
      }
      return (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-info underline underline-offset-2 hover:text-info/80 transition-default"
        >
          {linkMatch[1]}
        </a>
      );
    }
    return token;
  });
}

// ─── Block parsing ───────────────────────────────────────────────────────────

interface Block {
  type: 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'code_block' | 'blank';
  content: string;
  indent?: number; // nesting depth (0 = top level)
  level?: number; // heading level
  language?: string; // code block language
  lines?: string[]; // code block lines
}

function parseBlocks(content: string): Block[] {
  const rawLines = content.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // Code block (fenced)
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const language = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < rawLines.length && !rawLines[i].startsWith('```')) {
        codeLines.push(rawLines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: 'code_block',
        content: codeLines.join('\n'),
        language,
        lines: codeLines,
      });
      continue;
    }

    // Measure indentation before trimming
    const indentMatch = line.match(/^(\s*)/);
    const indentSpaces = indentMatch ? indentMatch[1].length : 0;
    // Treat every 2 spaces (or 1 tab) as one indent level
    const indent = Math.floor(indentSpaces / 2);

    const trimmed = line.trim();

    // Blank line
    if (!trimmed) {
      blocks.push({ type: 'blank', content: '' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        content: headingMatch[2],
        level: headingMatch[1].length,
        indent: 0,
      });
      i++;
      continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
      blocks.push({ type: 'bullet', content: trimmed.slice(2), indent });
      i++;
      continue;
    }

    // Numbered list
    const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/);
    if (numberedMatch) {
      blocks.push({
        type: 'numbered',
        content: numberedMatch[2],
        indent,
      });
      i++;
      continue;
    }

    // Regular paragraph
    blocks.push({ type: 'paragraph', content: trimmed, indent: 0 });
    i++;
  }

  return blocks;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderBlock(block: Block, index: number): React.ReactNode {
  switch (block.type) {
    case 'blank':
      return <div key={index} className="h-2" />;

    case 'heading': {
      const Tag = `h${Math.min(block.level || 1, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
      const sizes: Record<string, string> = {
        h1: 'text-lg font-bold',
        h2: 'text-base font-bold',
        h3: 'text-sm font-semibold',
        h4: 'text-sm font-medium',
      };
      return (
        <Tag key={index} className={clsx(sizes[Tag], 'text-foreground')}>
          {renderInline(block.content)}
        </Tag>
      );
    }

    case 'bullet':
      return (
        <div
          key={index}
          className="flex gap-2"
          style={{ paddingLeft: `${(block.indent ?? 0) * 16 + 4}px` }}
        >
          <span className="text-muted mt-0.5 shrink-0 select-none">•</span>
          <span className="flex-1">{renderInline(block.content)}</span>
        </div>
      );

    case 'numbered':
      return (
        <div
          key={index}
          className="flex gap-2"
          style={{ paddingLeft: `${(block.indent ?? 0) * 16 + 4}px` }}
        >
          <span className="text-muted mt-0.5 shrink-0 select-none">{block.indent ? '◦' : ''}</span>
          <span className="flex-1">{renderInline(block.content)}</span>
        </div>
      );

    case 'code_block':
      return (
        <div key={index} className="rounded-lg border border-default overflow-hidden">
          {block.language && (
            <div className="px-3 py-1 bg-background-muted border-b border-default">
              <span className="text-xs text-muted font-mono">{block.language}</span>
            </div>
          )}
          <pre className="p-3 bg-background-subtle overflow-x-auto">
            <code className="text-xs font-mono text-foreground leading-relaxed">
              {block.content}
            </code>
          </pre>
        </div>
      );

    case 'paragraph':
    default:
      return (
        <p key={index} className="text-foreground">
          {renderInline(block.content)}
        </p>
      );
  }
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
}: MarkdownContentProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className={clsx('text-base leading-relaxed break-words space-y-1.5', className)}>
      {blocks.map(renderBlock)}
    </div>
  );
});
