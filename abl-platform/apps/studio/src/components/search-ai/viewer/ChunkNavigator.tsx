'use client';

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import type { ChunkData } from './ExtractedContentView';

interface ChunkNavigatorProps {
  chunks: ChunkData[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function ChunkNavigator({ chunks, activeIndex, onSelect }: ChunkNavigatorProps) {
  const t = useTranslations('search_ai.viewer');
  return (
    <div className="flex items-center gap-2 px-5 py-2 border-t border-default shrink-0 overflow-x-auto">
      <span className="text-xs text-muted shrink-0">{t('chunks_label')}</span>
      {chunks.map((chunk, i) => (
        <button
          key={chunk._id}
          className={clsx(
            'px-2 py-0.5 rounded text-xs transition-default shrink-0',
            i === activeIndex
              ? 'bg-accent text-accent-foreground'
              : 'bg-surface-elevated text-muted hover:text-foreground',
          )}
          onClick={() => onSelect(i)}
        >
          {i + 1}
        </button>
      ))}
      <span className="text-xs text-muted shrink-0 ml-auto">
        {t('chunk_position', { n: activeIndex + 1, total: chunks.length })}
      </span>
    </div>
  );
}
