'use client';

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';

export interface ChunkData {
  _id: string;
  content: string;
  position: { order?: number; page?: number };
  tokenCount: number;
}

interface ExtractedContentViewProps {
  chunks: ChunkData[];
  extractedText: string | null;
  activeChunkIndex: number;
  onChunkClick: (index: number) => void;
}

export function ExtractedContentView({
  chunks,
  extractedText,
  activeChunkIndex,
  onChunkClick,
}: ExtractedContentViewProps) {
  const t = useTranslations('search_ai.viewer');
  if (chunks.length === 0 && !extractedText) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted">
        {t('no_extracted_content')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5 space-y-4">
      {chunks.length > 0
        ? chunks.map((chunk, i) => (
            <button
              key={chunk._id}
              className={clsx(
                'w-full text-left p-3 rounded-lg border transition-default text-sm',
                i === activeChunkIndex
                  ? 'border-accent bg-accent-subtle'
                  : 'border-default hover:border-accent-muted',
              )}
              onClick={() => onChunkClick(i)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted">
                  {t('chunk_label', { n: (chunk.position?.order ?? 0) + 1 })}
                </span>
                <span className="text-xs text-muted">
                  {t('token_count', { count: chunk.tokenCount })}
                </span>
              </div>
              <p className="text-foreground-subtle whitespace-pre-wrap">{chunk.content}</p>
            </button>
          ))
        : extractedText && (
            <div className="prose prose-sm max-w-none text-foreground-subtle whitespace-pre-wrap">
              {extractedText}
            </div>
          )}
    </div>
  );
}
