/**
 * TemplateDSLView — DSL snippet display with copy-to-clipboard.
 */

'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';

export interface TemplateDSLViewProps {
  snippet: string;
}

export function TemplateDSLView({ snippet }: TemplateDSLViewProps) {
  const t = useTranslations('templates');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(snippet).then(
      () => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard API may fail in non-secure contexts — do not show "Copied!"
      },
    );
  }, [snippet]);

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded border border-default bg-background-muted p-3 font-mono text-xs text-foreground">
        {snippet}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded border border-default bg-background px-2 py-1 text-xs text-muted hover:bg-background-hover"
      >
        {copied ? t('copied') : t('copy_dsl')}
      </button>
    </div>
  );
}
