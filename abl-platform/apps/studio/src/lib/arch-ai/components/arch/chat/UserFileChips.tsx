'use client';

/**
 * UserFileChips — compact file attachment tags for sent user messages.
 *
 * Renders file_ref and image_ref blocks as small chips (like Claude/v0 style).
 * Images show a tiny thumbnail + name. Docs show a type icon + name.
 * Click: images open lightbox, docs trigger download.
 */

import { useState, useCallback } from 'react';
import { FileText, Image as ImageIcon, Download } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArchContentBlock } from '@agent-platform/arch-ai/types';
import { ImageLightbox } from './ImageLightbox';

interface UserFileChipsProps {
  blocks: ArchContentBlock[];
}

export function UserFileChips({ blocks }: UserFileChipsProps) {
  const [lightbox, setLightbox] = useState<{
    src: string;
    alt: string;
    name: string;
    dimensions?: { width: number; height: number };
  } | null>(null);

  const fileBlocks = blocks.filter(
    (
      b,
    ): b is
      | Extract<ArchContentBlock, { type: 'image_ref' }>
      | Extract<ArchContentBlock, { type: 'file_ref' }> =>
      b.type === 'image_ref' || b.type === 'file_ref',
  );

  const handleImageClick = useCallback(
    (block: Extract<ArchContentBlock, { type: 'image_ref' }>) => {
      setLightbox({
        src: `/api/arch-ai/files/${block.blobId}/content`,
        alt: block.name,
        name: block.name,
        dimensions:
          block.width > 0 && block.height > 0
            ? { width: block.width, height: block.height }
            : undefined,
      });
    },
    [],
  );

  const handleDocClick = useCallback((blobId: string, name: string) => {
    const link = document.createElement('a');
    link.href = `/api/arch-ai/files/${blobId}/content?download=true`;
    link.download = name;
    link.click();
  }, []);

  if (fileBlocks.length === 0) return null;

  return (
    <>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {fileBlocks.map((block, i) => {
          const isImage = block.type === 'image_ref';
          return (
            <button
              key={`${block.blobId}-${i}`}
              type="button"
              onClick={() => {
                if (isImage) {
                  handleImageClick(block as Extract<ArchContentBlock, { type: 'image_ref' }>);
                } else {
                  handleDocClick(block.blobId, block.name);
                }
              }}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
                'border-foreground/15 bg-foreground/5 text-foreground-muted hover:bg-foreground/10',
              )}
              title={isImage ? `View ${block.name}` : `Download ${block.name}`}
            >
              {isImage ? (
                <ImageIcon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="max-w-[120px] truncate">{block.name}</span>
            </button>
          );
        })}
      </div>

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          name={lightbox.name}
          dimensions={lightbox.dimensions}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
