'use client';

import type { ChunkData } from './ExtractedContentView';
import { ExtractedContentView } from './ExtractedContentView';
import { OriginalPageView } from './OriginalPageView';

interface SideBySideViewProps {
  rawHtmlUrl: string | null;
  fallbackHtml: string | null;
  chunks: ChunkData[];
  extractedText: string | null;
  activeChunkIndex: number;
  onChunkClick: (index: number) => void;
}

export function SideBySideView({
  rawHtmlUrl,
  fallbackHtml,
  chunks,
  extractedText,
  activeChunkIndex,
  onChunkClick,
}: SideBySideViewProps) {
  return (
    <div className="flex h-full divide-x divide-default">
      <div className="flex-1 overflow-hidden">
        <OriginalPageView rawHtmlUrl={rawHtmlUrl} fallbackHtml={fallbackHtml} />
      </div>
      <div className="flex-1 overflow-hidden">
        <ExtractedContentView
          chunks={chunks}
          extractedText={extractedText}
          activeChunkIndex={activeChunkIndex}
          onChunkClick={onChunkClick}
        />
      </div>
    </div>
  );
}
