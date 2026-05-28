/**
 * CodeBlock Component
 *
 * Syntax-highlighted readonly code display with copy button.
 */

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string;
  className?: string;
}

export function CodeBlock({ code, language, maxHeight = '400px', className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={clsx('relative group rounded-lg border border-default overflow-hidden', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-background-muted border-b border-default">
        <span className="text-xs text-muted">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="p-1 text-muted hover:text-foreground rounded transition-default opacity-0 group-hover:opacity-100"
          title="Copy code"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Code */}
      <pre
        className="overflow-auto p-3 text-sm leading-relaxed bg-background"
        style={{ maxHeight, fontFamily: 'var(--font-mono)' }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
