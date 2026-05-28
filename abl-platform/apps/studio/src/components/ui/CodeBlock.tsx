/**
 * CodeBlock Component
 *
 * Syntax-highlighted readonly code display with copy and fullscreen actions.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Copy, Check, Maximize2, X } from 'lucide-react';
import { clsx } from 'clsx';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string;
  className?: string;
  wrapLines?: boolean;
  expandable?: boolean;
}

interface CodeFullscreenModalProps {
  code: string;
  languageLabel: string;
  maxHeight: string;
  onClose: () => void;
  wrapLines: boolean;
}

function CodeFullscreenModal({
  code,
  languageLabel,
  maxHeight,
  onClose,
  wrapLines,
}: CodeFullscreenModalProps) {
  const t = useTranslations('common');

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-[90vw] flex-col rounded-xl border border-default bg-background-elevated shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-default bg-background-muted px-4 py-3">
          <span className="text-sm font-semibold text-foreground">{languageLabel}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-muted transition-colors hover:bg-background-elevated hover:text-foreground"
            aria-label={t('close')}
            title={t('close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <CodeBlock
            code={code}
            language={languageLabel}
            maxHeight={maxHeight}
            wrapLines={wrapLines}
            expandable={false}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CodeBlock({
  code,
  language,
  maxHeight = '400px',
  className,
  wrapLines = false,
  expandable = true,
}: CodeBlockProps) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const languageLabel = language || t('code');

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      data-code-block
      data-code-language={languageLabel}
      className={clsx('relative group rounded-lg border border-default overflow-hidden', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-background-muted border-b border-default">
        <span className="text-xs text-muted">{languageLabel}</span>
        <div className="flex items-center gap-1">
          {expandable && (
            <button
              type="button"
              onClick={() => setFullscreenOpen(true)}
              className={clsx(
                'rounded p-1 text-muted transition-default hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
                'opacity-70 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
              )}
              aria-label={t('expand_fullscreen')}
              title={t('expand_fullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className={clsx(
              'rounded p-1 text-muted transition-default hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
              'opacity-70 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
            )}
            aria-label={t('copy')}
            title={t('copy')}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Code */}
      <pre
        data-code-block-pre
        className={clsx(
          'overflow-auto bg-background p-3 text-sm leading-relaxed',
          wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        )}
        style={{ maxHeight, fontFamily: 'var(--font-mono)' }}
      >
        <code data-code-block-source>{code}</code>
      </pre>

      {fullscreenOpen && (
        <CodeFullscreenModal
          code={code}
          languageLabel={languageLabel}
          maxHeight="70vh"
          onClose={() => setFullscreenOpen(false)}
          wrapLines={wrapLines}
        />
      )}
    </div>
  );
}
