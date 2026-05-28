'use client';

import { useState } from 'react';
import { clsx } from 'clsx';

interface PayloadViewerProps {
  content: string;
  payloadType: string;
}

export function PayloadViewer({ content, payloadType }: PayloadViewerProps) {
  const [wrap, setWrap] = useState(true);

  const isJson = content.trim().startsWith('{') || content.trim().startsWith('[');
  let formatted = content;
  if (isJson) {
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // keep raw
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase">{payloadType}</span>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setWrap(!wrap)}
        >
          {wrap ? 'No Wrap' : 'Wrap'}
        </button>
      </div>
      <pre
        className={clsx(
          'flex-1 overflow-auto p-3 text-xs font-mono text-foreground bg-muted/30',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        )}
      >
        {formatted}
      </pre>
    </div>
  );
}
