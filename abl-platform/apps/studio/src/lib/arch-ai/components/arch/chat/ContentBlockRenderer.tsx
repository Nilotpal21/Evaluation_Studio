'use client';

/**
 * ContentBlockRenderer — B03 Phase 3: Renders ArchContentBlock[] in chat messages.
 *
 * Per-block rendering:
 * - text: shared ArchMarkdown renderer
 * - image_ref (active/no status): thumbnail, click opens lightbox
 * - image_ref (status: 'failed'): red badge
 * - file_ref: compact card with icon + filename + optional code preview
 * - tool_use / tool_result: skipped (handled by existing widget rendering)
 */

import { useState, useCallback } from 'react';
import { FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArchContentBlock } from '@agent-platform/arch-ai/types';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { ImageLightbox } from './ImageLightbox';
import { ArchMarkdown } from './ArchMarkdown';

interface ContentBlockRendererProps {
  blocks: ArchContentBlock[];
}

/** File extensions considered code for preview */
const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'sh',
  'bash',
  'zsh',
  'yaml',
  'yml',
  'json',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'sql',
  'graphql',
  'md',
  'txt',
]);

function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return CODE_EXTENSIONS.has(ext);
}

function getCodeLanguage(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext || undefined;
}

export function ContentBlockRenderer({ blocks }: ContentBlockRendererProps) {
  const [lightbox, setLightbox] = useState<{
    src: string;
    alt: string;
    name: string;
    dimensions?: { width: number; height: number };
  } | null>(null);

  const openLightbox = useCallback((block: Extract<ArchContentBlock, { type: 'image_ref' }>) => {
    // Build a URL to fetch the blob from the server
    const src = `/api/arch-ai/files/${block.blobId}/content`;
    setLightbox({
      src,
      alt: block.name,
      name: block.name,
      dimensions: { width: block.width, height: block.height },
    });
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return (
              <div key={index}>
                <ArchMarkdown content={block.text} />
              </div>
            );

          case 'image_ref': {
            if (block.status === 'failed') {
              return (
                <div
                  key={index}
                  className="my-2 inline-flex items-center gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-sm text-error"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>Could not be processed</span>
                  <span className="text-error/60">({block.name})</span>
                </div>
              );
            }

            const thumbnailSrc = `/api/arch-ai/files/${block.blobId}/content`;
            return (
              <div key={index} className="my-2">
                <button
                  type="button"
                  onClick={() => openLightbox(block)}
                  className={clsx(
                    'group relative block overflow-hidden rounded-lg border border-foreground/[0.08]',
                    'transition-all hover:border-foreground/15 hover:shadow-md',
                    'focus:outline-none focus:ring-2 focus:ring-border-focus',
                  )}
                  aria-label={`View ${block.name} full size`}
                >
                  <img
                    src={thumbnailSrc}
                    alt={block.name}
                    className="block max-w-[200px] rounded-lg object-contain"
                    style={
                      block.width > 0 && block.height > 0
                        ? { aspectRatio: `${block.width} / ${block.height}` }
                        : undefined
                    }
                  />
                  {/* Hover overlay */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                    <ImageIcon className="h-6 w-6 text-foreground/0 transition-colors group-hover:text-foreground/80" />
                  </div>
                </button>
                {/* Metadata below thumbnail */}
                <div className="mt-1 flex items-center gap-2 text-xs text-foreground-subtle">
                  <span>{block.name}</span>
                  <span>
                    {block.width}&times;{block.height}
                  </span>
                  {block.tokenCost > 500 && (
                    <span className="text-foreground/30">
                      {block.tokenCost.toLocaleString()} tokens
                    </span>
                  )}
                </div>
              </div>
            );
          }

          case 'file_ref': {
            const isCode = isCodeFile(block.name);
            return (
              <div
                key={index}
                className="my-2 rounded-lg border border-foreground/[0.08] bg-background-subtle p-3"
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <span className="text-sm font-medium text-foreground/90">{block.name}</span>
                  <span className="text-xs text-foreground-subtle">{block.mediaType}</span>
                  {block.tokenCost > 0 && (
                    <span className="text-xs text-foreground/30">
                      {block.tokenCost.toLocaleString()} tokens
                    </span>
                  )}
                </div>
                {/* Code preview: first 6 lines */}
                {isCode && block.summary && (
                  <CodeBlock
                    code={block.summary.split('\n').slice(0, 6).join('\n')}
                    language={getCodeLanguage(block.name)}
                    maxHeight="160px"
                    className="mt-2"
                  />
                )}
                {!isCode && (
                  <div className="mt-2 text-xs text-foreground-subtle">Preview ready</div>
                )}
              </div>
            );
          }

          case 'tool_use':
          case 'tool_result':
            // Handled by existing WidgetRenderer / tool rendering
            return null;

          default:
            return null;
        }
      })}

      {/* Lightbox portal */}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          name={lightbox.name}
          dimensions={lightbox.dimensions}
          onClose={closeLightbox}
        />
      )}
    </>
  );
}
